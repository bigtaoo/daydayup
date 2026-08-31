/**
 * Offline analysis of a recorded run (`engine/replayFile.ts`), aimed at the one
 * question the engine's own sweeps cannot answer: did the client OFFER something the
 * sim then REFUSED?
 *
 * ROADMAP's v50 entry settled the sim half — 903 measured drops across 16 bot-driven
 * runs, zero unreachable, zero embedded in stone — so another sweep over generated
 * content is not the missing evidence. What was missing was the reported MOMENT. This
 * reads one, and reports two things per drop that no sweep can:
 *
 *   - how close a player ever actually got to it, against the gate for ITS kind, and
 *   - whether it was ever collectible at all while it existed.
 *
 * The gate is read from the client's own `pickupDebugGate` rather than restated here,
 * for the reason design/18 calls G6: a harness that re-derives the rule it is checking
 * agrees with itself and with nothing else. That function is already pinned against the
 * real `PickupSystem.tick` and the real weapon panel in `PickupDebugOverlay.test.ts`.
 *
 * Pure — no fs, no env, no printing. `replayInspect.sim.ts` is the shell that reads a
 * file and formats this; `inspect.test.ts` drives it on synthetic runs.
 */
import {
  hashState,
  ReplayInputSource,
  SIM,
  createGameEngine,
  type Fp,
  type GameState,
  type PickupItem,
  type ReplayFile,
} from '@dd/engine';
import { fpToPx } from '../../src/game/coords';
import { pickupDebugGate, pickupGatePx } from '../../src/game/scene/PickupDebugOverlay';

/**
 * "The player would say they were standing on it." Deliberately the game's OWN
 * near-loot radius (`SIM.lootRevealRadius`, 2.5 grid = 80 px — the weapon panel's
 * reveal ring) rather than an invented number: it is the distance at which the game
 * itself declares a drop to be at your feet. It is also 2.6x the auto-collect gate
 * (`pickupRadius` 15 px + a player's 16 px radius = 31 px), which is the asymmetry
 * this whole investigation is circling: a weapon drop is claimable from 80 px away
 * while a heal lying at the same apparent distance is not.
 */
export const APPARENT_CONTACT_PX = fpToPx(SIM.lootRevealRadius);

export interface PickupTrace {
  id: number;
  kind: PickupItem['kind'];
  /** Where it lay, in world px (a drop never moves once it lands). */
  x: number;
  y: number;
  firstTick: number;
  lastTick: number;
  /** Nearest any live player ever got, world px, and when. Sampled per tick — which is
   *  also exactly what the sim compares, since `PickupSystem` runs once per tick. */
  closestPx: number;
  closestTick: number;
  /**
   * Nearest the player's PATH ever came, treating each tick as a straight segment from
   * the previous position. Strictly <= `closestPx`, and the difference is the answer to
   * "did I walk right over it between two ticks?" — a player moves 6.4 px/tick
   * (PLAYER_BASE.speedPerTick), so a tangential pass can miss every sample and still
   * cross the ring. When this is inside the gate and `closestPx` is not, the drop was
   * unreachable for a discrete-sampling reason and no amount of standing still would
   * have helped.
   */
  sweptClosestPx: number;
  /** The gate this drop was actually judged against, world px (kind- and player-dependent). */
  gatePx: number;
  /** Was its gate EVER satisfied at an OBSERVED tick? See the pre/post note in
   *  `inspectReplay` — on its own this is not the same question as "was it collected". */
  everCollectible: boolean;
  /** The tick a `pickup` event fired for it, from the engine's own event stream — the
   *  authoritative answer to "did somebody collect this", independent of geometry. */
  collectedTick: number | null;
  /** It stopped being alive. Together with a null `collectedTick` that is an anomaly
   *  worth a second look, not a normal collection. */
  disappeared: boolean;
}

export interface MarkPlayerReadout {
  id: number;
  x: number;
  y: number;
  /** The auto-collect gate for THIS player (radius is per-skin). */
  autoGatePx: number;
}

export interface MarkPickupReadout {
  id: number;
  kind: PickupItem['kind'];
  x: number;
  y: number;
  nearestPx: number;
  collectible: boolean;
}

export interface MarkReadout {
  tick: number;
  note: string;
  players: MarkPlayerReadout[];
  pickups: MarkPickupReadout[];
}

export interface InspectReport {
  label: string;
  engineVersion: number;
  /** Ticks actually advanced (a stream that ends early ends the run). */
  ticks: number;
  finalHash: number;
  marks: MarkReadout[];
  traces: PickupTrace[];
  /** Never collected, never collectible, yet a player came within APPARENT_CONTACT_PX —
   *  the report's own shape ("I was standing on it and it did not pick up"), closest
   *  first. */
  suspects: PickupTrace[];
  /** Gone from the state with no `pickup` event to explain it. Should be empty; anything
   *  here is its own bug, not a near-miss. */
  vanished: PickupTrace[];
}

export function inspectReplay(file: ReplayFile): InspectReport {
  const engine = createGameEngine(file.replay.config, new ReplayInputSource(file.replay));
  const wanted = new Map<number, string>();
  for (const m of file.marks) wanted.set(m.tick, m.note);

  const traces = new Map<number, PickupTrace>();
  // Carried across ticks so each observation can measure the SEGMENT the player just
  // walked, not only the point they ended on (see PickupTrace.sweptClosestPx).
  const prevPositions = new Map<number, [number, number]>();
  const marks: MarkReadout[] = [];
  let lastTick = 0;

  for (let frame = 1; frame <= file.ticks; frame++) {
    // Observed BEFORE and AFTER the step, and this is not belt-and-braces. `PickupSystem`
    // collects DURING the tick, so a drop is already `alive: false` by the time the
    // post-step state is readable: the very tick a player stood inside the gate is the one
    // tick the drop cannot be seen being collectible. Measured — the first run of this
    // harness reported 7 of 8 drops "never collectible", four of which had plainly been
    // picked up. Reading both sides brackets the moment the sim compared (movement runs
    // before collection, so the truth lies between the two), and the `pickup` event below
    // settles it outright.
    observePickups(engine.state, traces, prevPositions);
    const events = engine.advance(frame);
    if (events === null) break;
    const s = engine.state;
    lastTick = s.tick;
    observePickups(s, traces, prevPositions);
    for (const e of events) if (e.type === 'pickup') markCollected(traces, e, s.tick);
    const note = wanted.get(s.tick);
    if (note !== undefined) marks.push(readout(s, s.tick, note));
    if (s.phase === 'gameover') break;
  }

  // A drop still lying there at the end never disappeared; one that left the array did.
  const seenNow = new Set(engine.state.pickups.filter((p) => p.alive).map((p) => p.id));
  for (const t of traces.values()) t.disappeared = !seenNow.has(t.id);

  const all = [...traces.values()].sort((a, b) => a.id - b.id);

  return {
    label: file.label,
    engineVersion: file.engineVersion,
    ticks: lastTick,
    finalHash: hashState(engine.state),
    marks,
    traces: all,
    suspects: selectSuspects(all),
    vanished: all.filter((t) => t.disappeared && t.collectedTick === null),
  };
}

/**
 * Attribute one `pickup` event to a trace. The event carries kind + position but no id
 * (state/events.ts), and a drop never moves, so exact fp position + kind identifies it.
 * Two drops of one kind at the identical fp point would be ambiguous — the first
 * unattributed match wins, which is why `vanished` exists to surface anything this
 * failed to explain rather than assuming it got them all.
 */
function markCollected(traces: Map<number, PickupTrace>, e: { kind: string; gx: Fp; gy: Fp }, tick: number): void {
  const x = fpToPx(e.gx);
  const y = fpToPx(e.gy);
  for (const t of traces.values()) {
    if (t.collectedTick === null && t.kind === e.kind && t.x === x && t.y === y) {
      t.collectedTick = tick;
      return;
    }
  }
}

/**
 * Fold one tick of state into the per-drop traces. Exported so `inspect.test.ts` can
 * prove the suspect rule actually discriminates on hand-placed drops — a replay cannot
 * be made to produce a specific near-miss on demand, and a detector that has never
 * been shown to fire is not evidence of anything.
 */
export function observePickups(
  s: GameState,
  traces: Map<number, PickupTrace>,
  prevPositions: Map<number, [number, number]> = new Map(),
): void {
  for (const item of s.pickups) {
    if (!item.alive || item.kind === 'crate') continue; // a crate has no collect gate
    const { nearestPx, collectible } = pickupDebugGate(s, item);
    const prev = traces.get(item.id);
    if (!prev) {
      traces.set(item.id, {
        id: item.id,
        kind: item.kind,
        x: fpToPx(item.gx),
        y: fpToPx(item.gy),
        firstTick: s.tick,
        lastTick: s.tick,
        closestPx: nearestPx,
        closestTick: s.tick,
        sweptClosestPx: sweptPx(s, item, prevPositions),
        gatePx: gateFor(s, item),
        everCollectible: collectible,
        collectedTick: null,
        disappeared: false,
      });
      continue;
    }
    prev.lastTick = s.tick;
    prev.everCollectible ||= collectible;
    if (nearestPx < prev.closestPx) {
      prev.closestPx = nearestPx;
      prev.closestTick = s.tick;
    }
    const swept = sweptPx(s, item, prevPositions);
    if (swept < prev.sweptClosestPx) prev.sweptClosestPx = swept;
  }
  for (const p of s.players) if (p.alive) prevPositions.set(p.id, [fpToPx(p.gx), fpToPx(p.gy)]);
}

/** The narrowest gate any live player offers this drop (the one that would collect it). */
function gateFor(s: GameState, item: PickupItem): number {
  let gate = Infinity;
  for (const p of s.players) if (p.alive) gate = Math.min(gate, pickupGatePx(item, p));
  return gate;
}

/**
 * Closest approach of any player's path THIS tick, as a segment from where they were to
 * where they are. First sighting of a player has no previous point, so the segment
 * degenerates to the current position — the same value the sampled distance reports.
 */
function sweptPx(s: GameState, item: PickupItem, prevPositions: Map<number, [number, number]>): number {
  const ix = fpToPx(item.gx);
  const iy = fpToPx(item.gy);
  let best = Infinity;
  for (const p of s.players) {
    if (!p.alive) continue;
    const cx = fpToPx(p.gx);
    const cy = fpToPx(p.gy);
    const from = prevPositions.get(p.id) ?? [cx, cy];
    best = Math.min(best, pointToSegmentPx(ix, iy, from[0], from[1], cx, cy));
  }
  return best;
}

function pointToSegmentPx(px: number, py: number, ax: number, ay: number, bx: number, by: number): number {
  const dx = bx - ax;
  const dy = by - ay;
  const len2 = dx * dx + dy * dy;
  if (len2 === 0) return Math.hypot(px - ax, py - ay);
  const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / len2));
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

/**
 * Never collected AND never seen collectible, yet within apparent contact — closest
 * approach first. Both clauses matter: `collectedTick` comes from the engine's own event
 * stream and is authoritative, `everCollectible` catches a drop that was reachable and
 * simply not taken (a full inventory, a player who walked on).
 */
export function selectSuspects(traces: readonly PickupTrace[]): PickupTrace[] {
  return traces
    .filter((t) => t.collectedTick === null && !t.everCollectible && t.closestPx <= APPARENT_CONTACT_PX)
    .sort((a, b) => a.closestPx - b.closestPx);
}

function readout(s: GameState, tick: number, note: string): MarkReadout {
  return {
    tick,
    note,
    players: s.players
      .filter((p) => p.alive)
      .map((p) => ({
        id: p.id,
        x: fpToPx(p.gx),
        y: fpToPx(p.gy),
        autoGatePx: fpToPx((SIM.pickupRadius + p.radius) as Fp),
      })),
    pickups: s.pickups
      .filter((item) => item.alive && item.kind !== 'crate')
      .map((item) => {
        const { nearestPx, collectible } = pickupDebugGate(s, item);
        return {
          id: item.id,
          kind: item.kind,
          x: fpToPx(item.gx),
          y: fpToPx(item.gy),
          nearestPx,
          collectible,
        };
      }),
  };
}

/** Human-readable report — the harness prints exactly this. */
export function formatInspectReport(r: InspectReport): string {
  const out: string[] = [];
  out.push(`replay: label=${r.label} engineVersion=${r.engineVersion} ticks=${r.ticks} finalHash=${r.finalHash}`);
  out.push(`drops seen: ${r.traces.length}  (auto-collect gate ~31px, apparent-contact band ${APPARENT_CONTACT_PX}px)`);

  for (const m of r.marks) {
    out.push('');
    out.push(`--- MARK tick ${m.tick} (${m.note}) ---`);
    for (const p of m.players) {
      out.push(`  player ${p.id} at (${p.x.toFixed(1)}, ${p.y.toFixed(1)})  autoGate=${p.autoGatePx.toFixed(1)}px`);
    }
    if (!m.pickups.length) out.push('  no live pickups at this tick');
    for (const k of m.pickups) {
      out.push(
        `  ${k.collectible ? 'OK  ' : 'MISS'} #${k.id} ${k.kind} at (${k.x.toFixed(1)}, ${k.y.toFixed(1)}) nearest=${k.nearestPx.toFixed(1)}px`,
      );
    }
  }

  out.push('');
  if (!r.suspects.length) {
    out.push('no suspects: every drop the player came near was collectible at some point.');
  } else {
    out.push(`SUSPECTS (never collected, player got within ${APPARENT_CONTACT_PX}px), closest first:`);
    for (const t of r.suspects) {
      const tunnelled = t.sweptClosestPx <= t.gatePx ? '  WALKED-THROUGH-THE-GATE' : '';
      out.push(
        `  #${t.id} ${t.kind} at (${t.x.toFixed(1)}, ${t.y.toFixed(1)}) sampled=${t.closestPx.toFixed(1)}px` +
          ` swept=${t.sweptClosestPx.toFixed(1)}px gate=${t.gatePx.toFixed(1)}px at tick ${t.closestTick}` +
          `  alive ${t.firstTick}..${t.lastTick}${t.disappeared ? ' (gone by the end)' : ' (still there)'}${tunnelled}`,
      );
    }
  }
  return out.join('\n');
}
