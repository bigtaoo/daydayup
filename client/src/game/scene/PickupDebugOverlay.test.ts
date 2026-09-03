/**
 * `pickupDebugGate` (the pure readout behind `?pickupDebug=1`) has exactly one job: agree
 * with whatever `PickupSystem`/`nearbyWeaponPickups` actually do, so a green dot on screen
 * really means "the sim would collect this." Restating the formula here (`pickupRadius +
 * player.radius`, `lootRevealRadius`) would pass even if the overlay and the real gate
 * drifted apart together — same trap `pickupProximity.test.ts` calls out — so every test
 * below runs the REAL system (`PickupSystem.tick` / `nearbyWeaponPickups`) alongside the
 * readout and asserts they agree, swept across the boundary rather than at one guessed
 * distance.
 */
import { describe, it, expect } from 'vitest';
import type { Graphics } from 'pixi.js';
import { createGameState, PickupSystem, SIM } from '@dd/engine';
import type { PickupItem, Fp } from '@dd/engine';
import { nearbyWeaponPickups, WEAPON_PROMPT_RADIUS_FP } from '../ui/pickupProximity';
import { PickupDebugOverlay, pickupDebugGate, pickupGatePx } from './PickupDebugOverlay';

function stateWithPickupAt(kind: PickupItem['kind'], dx: number, dy = 0): { s: ReturnType<typeof createGameState>; item: PickupItem } {
  const s = createGameState({ seed: 1, worldW: 40000, worldH: 40000, waves: [] });
  const p = s.players[0]!;
  p.gx = 20000 as Fp;
  p.gy = 20000 as Fp;
  // Damaged on purpose: since ENGINE_VERSION 54 a heal is not collectible AT ALL while the
  // player is at full HP (design/05 "only when useful"), so a full-HP fixture would make
  // every `heal` distance sweep below vacuously "never collectible" — which is what the
  // sweep's own anti-vacuity guard caught. The DISTANCE gate is what these tests measure;
  // the usefulness gate gets its own test at the end of this block.
  p.hp = 1;
  const item: PickupItem = {
    id: s.nextId(),
    kind,
    gx: (20000 + dx) as Fp,
    gy: (20000 + dy) as Fp,
    spawnTick: 0,
    alive: true,
    ...(kind === 'weapon' ? { weaponId: 'repeater' } : {}),
    ...(kind === 'material' ? { materialId: 'scrap', qty: 1, tier: 0 } : {}),
  };
  s.pickups.push(item);
  return { s, item };
}

/** Does PickupSystem actually collect an auto-collect-kind item standing there? */
function simAutoCollects(kind: PickupItem['kind'], dx: number): boolean {
  const { s, item } = stateWithPickupAt(kind, dx);
  s.tick = 1; // past the spawn-tick guard — a separate rule from proximity
  new PickupSystem().tick(s);
  return !s.pickups.some((q) => q.id === item.id && q.alive);
}

describe('pickupDebugGate — auto-collect kinds (heal/material/buff/bandage)', () => {
  it('collectible agrees with PickupSystem across the whole boundary', () => {
    // Swept in 5 fp steps (fine enough to catch an off-by-one at the boundary) across a
    // range comfortably either side of SIM.pickupRadius + PLAYER_BASE.radius.
    const disagreements: number[] = [];
    let sawTrue = false;
    let sawFalse = false;
    for (let dx = 0; dx <= 1200; dx += 5) {
      const { s, item } = stateWithPickupAt('heal', dx);
      const { collectible } = pickupDebugGate(s, item);
      const collected = simAutoCollects('heal', dx);
      if (collectible) sawTrue = true;
      else sawFalse = true;
      if (collectible !== collected) disagreements.push(dx);
    }
    expect(sawTrue, 'the sweep never reached a collectible distance').toBe(true);
    expect(sawFalse, 'the sweep never reached an uncollectible distance').toBe(true);
    expect(disagreements, 'pickupDebugGate disagrees with PickupSystem at these fp distances').toEqual([]);
  });

  it('reports the nearest player, not an arbitrary one', () => {
    const s = createGameState({ seed: 1, worldW: 40000, worldH: 40000, waves: [] });
    s.players[0]!.gx = 20000 as Fp;
    s.players[0]!.gy = 20000 as Fp;
    // Second seat, far away — createGameState with one player leaves only seat 0, so build
    // a minimal second one by cloning the shape PickupSystem itself only reads (alive/gx/
    // gy/radius) rather than a full second createGameState.
    s.players.push({ ...s.players[0]!, id: 2, gx: 21000 as Fp });
    const item: PickupItem = {
      id: s.nextId(),
      kind: 'heal',
      gx: 20900 as Fp, // 900fp from seat 0, 100fp from seat 1
      gy: 20000 as Fp,
      spawnTick: 0,
      alive: true,
    };
    s.pickups.push(item);
    const { nearestPx } = pickupDebugGate(s, item);
    // 100fp, not 900fp — the nearer of the two seats.
    expect(nearestPx).toBeCloseTo((100 / 1000) * 32, 5);
  });

  it('ignores a dead player entirely', () => {
    const { s, item } = stateWithPickupAt('heal', 0); // standing exactly on it
    s.players[0]!.alive = false;
    const { nearestPx, collectible } = pickupDebugGate(s, item);
    expect(collectible).toBe(false);
    expect(nearestPx).toBe(Infinity);
  });

  // design/05's "only when useful" rule (ENGINE_VERSION 54) makes distance NOT the only
  // gate, so the overlay had to learn it too — otherwise a heal under a full-HP player
  // draws green while the sim walks straight past it, and the tool built to tell "looks
  // reachable" from "the sim agrees" lies about exactly that. Asserted against the real
  // system, like every other case here, not against a restated rule.
  it('a heal under a FULL-HP player is not collectible, and the sim agrees', () => {
    const { s, item } = stateWithPickupAt('heal', 0); // standing exactly on it
    const p = s.players[0]!;
    p.hp = p.maxHp;

    expect(pickupDebugGate(s, item).collectible).toBe(false);
    expect(pickupDebugGate(s, item).nearestPx).toBe(0); // still reported as right here
    s.tick = 1;
    new PickupSystem().tick(s);
    expect(s.pickups.some((q) => q.id === item.id && q.alive)).toBe(true); // sim left it too
  });

  it('the same heal, one point of damage later, is collectible again', () => {
    const { s, item } = stateWithPickupAt('heal', 0);
    const p = s.players[0]!;
    p.hp = p.maxHp - 1;
    expect(pickupDebugGate(s, item).collectible).toBe(true);
  });
});

describe('pickupDebugGate — weapon kind', () => {
  it('collectible agrees with the render panel (nearbyWeaponPickups), not the wider sim-accept radius', () => {
    // The panel's own gate (WEAPON_PROMPT_RADIUS_FP === SIM.lootRevealRadius) is the
    // binding constraint for a weapon in practice — nothing is clickable until the panel
    // lists it — and pickupDebugGate is documented to track exactly that, not the looser
    // `lootRevealRadius + player.radius` PickupSystem itself would still accept a click at.
    const disagreements: number[] = [];
    for (let dx = 0; dx <= 3500; dx += 25) {
      const { s, item } = stateWithPickupAt('weapon', dx);
      const { collectible } = pickupDebugGate(s, item);
      const p = s.players[0]!;
      const offered = nearbyWeaponPickups([item], p.gx, p.gy, WEAPON_PROMPT_RADIUS_FP).length > 0;
      if (collectible !== offered) disagreements.push(dx);
    }
    expect(disagreements, 'pickupDebugGate disagrees with the panel at these fp distances').toEqual([]);
  });

  it('the weapon gate is unpadded — SIM.lootRevealRadius itself is the boundary', () => {
    const justInside = stateWithPickupAt('weapon', (SIM.lootRevealRadius as number) - 1);
    const justOutside = stateWithPickupAt('weapon', (SIM.lootRevealRadius as number) + 1);
    expect(pickupDebugGate(justInside.s, justInside.item).collectible).toBe(true);
    expect(pickupDebugGate(justOutside.s, justOutside.item).collectible).toBe(false);
  });
});

/**
 * The RINGS, i.e. what a human actually reads off the screen. Everything above drives
 * `pickupDebugGate` and nothing drove `update()`, which until this section re-derived both
 * thresholds inline (`fpToPx(SIM.pickupRadius + p.radius)`, `fpToPx(SIM.lootRevealRadius)`)
 * twenty-five lines below `pickupGatePx`'s own doc comment claiming to be "the single
 * definition of the threshold, so nothing anywhere re-derives it (design/18 G6)".
 *
 * Consequence of that gap, not a style complaint: dropping `+ p.radius` from the drawn ring
 * survived the whole client suite, and it makes the overlay disagree with the dot colour it
 * draws in the same frame — a drop shown OUTSIDE the blue ring yet coloured green. This tool
 * exists to tell "looks reachable" from "the sim agrees it is reachable", so a ring that is
 * wrong by a player radius is worse than no ring: it is the instrument confirming the bug
 * report it was sent to disprove.
 *
 * Asserted against `pickupGatePx` (the production function) rather than against a restated
 * formula — `update()` now calls it, so this pins the CALL, and any change to the threshold
 * moves both sides together on purpose instead of one side by accident.
 */
describe('PickupDebugOverlay.update — the drawn rings are the same threshold the dots are coloured by', () => {
  type PathInstr = { action: string; data: unknown[] };
  type Instr = { action: string; data: { style?: { color?: number }; path?: { instructions: PathInstr[] } } };

  /** Every STROKED circle in the rings Graphics, in draw order, as `{ r, color }`. The filled
   *  circles (the ground point, and one dot per pickup) are deliberately excluded — a ring is
   *  the only thing drawn as a stroke. */
  function strokedRings(overlay: PickupDebugOverlay): Array<{ r: number; color: number }> {
    const g = overlay.view.children[0] as Graphics;
    return (g.context.instructions as unknown as Instr[])
      .filter((ins) => ins.action === 'stroke')
      .flatMap((ins) =>
        (ins.data.path?.instructions ?? [])
          .filter((pi) => pi.action === 'circle')
          .map((pi) => {
            const nums = pi.data.filter((v): v is number => typeof v === 'number');
            return { r: nums[2]!, color: ins.data.style?.color ?? 0 };
          }),
      );
  }

  it('draws exactly the auto-collect gate and the weapon gate, per alive player', () => {
    const { s, item } = stateWithPickupAt('heal', 0);
    const p = s.players[0]!;
    const weapon: PickupItem = { ...item, id: s.nextId(), kind: 'weapon', weaponId: 'repeater' };
    const overlay = new PickupDebugOverlay();

    overlay.update(s);

    const rings = strokedRings(overlay);
    expect(rings.map((r) => r.r)).toEqual([pickupGatePx(item, p), pickupGatePx(weapon, p)]);
  });

  it('the two rings are genuinely different sizes — otherwise the case above proves nothing', () => {
    // Anti-vacuity: if the auto and weapon gates happened to coincide, drawing either one
    // twice would satisfy the assertion above and the "wrong ring" mutation would survive.
    const { s, item } = stateWithPickupAt('heal', 0);
    const p = s.players[0]!;
    const weapon: PickupItem = { ...item, kind: 'weapon', weaponId: 'repeater' };
    expect(pickupGatePx(item, p)).toBeGreaterThan(0);
    expect(pickupGatePx(weapon, p)).not.toBe(pickupGatePx(item, p));
  });

  it("the auto ring includes the PLAYER's own radius, so it tracks a wider body", () => {
    // The specific survivor: `fpToPx(SIM.pickupRadius)` instead of
    // `fpToPx(SIM.pickupRadius + p.radius)`. Stated as a measured consequence — widen the
    // body and the drawn ring has to widen with it — rather than as the sum, which would
    // just restate the arithmetic the code performs.
    const { s } = stateWithPickupAt('heal', 0);
    const narrow = new PickupDebugOverlay();
    narrow.update(s);
    const narrowAuto = strokedRings(narrow)[0]!.r;

    s.players[0]!.radius = ((s.players[0]!.radius as number) + 1000) as Fp;
    const wide = new PickupDebugOverlay();
    wide.update(s);
    const wideAuto = strokedRings(wide)[0]!.r;

    expect(wideAuto).toBeGreaterThan(narrowAuto);
    // And the WEAPON ring must NOT move — it is gated on the panel's unpadded ring, which
    // is the asymmetry that makes the two rings mean different things.
    expect(strokedRings(wide)[1]!.r).toBe(strokedRings(narrow)[1]!.r);
  });

  it('skips a dead player entirely — no rings for a body that cannot collect', () => {
    const { s } = stateWithPickupAt('heal', 0);
    s.players[0]!.alive = false;
    const overlay = new PickupDebugOverlay();
    overlay.update(s);
    expect(strokedRings(overlay)).toEqual([]);
  });
});
