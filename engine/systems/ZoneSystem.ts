/**
 * Step — PvP zone stage machine (design/15, ROADMAP 4.2d). A room-graph BFS shrink
 * from a per-match-drawn eye, NOT a geometric circle — `dist <= R` is always a
 * connected region and strictly shrinks as `R` decreases, so it can never carve
 * through a wall a player physically cannot reach, nor trap a safe room behind
 * poison with no path out (design/15's "why this rule" section).
 *
 * Strict no-op when `!state.zoneEnabled` (every pre-4.2d config, and any PvE config)
 * — ExtractionSystem's precedent for "an added step that doesn't bump ENGINE_VERSION"
 * (GameEngine.ts). Runs before `EnvironmentSystem` so this tick's `state.zone.safe`
 * is current for the per-actor damage check.
 */
import { computeRoomDistances, maxFiniteDistance, safeRoomIds, ZONE } from '../content/arenas';
import type { GameState, ZoneState } from '../state/GameState';

export class ZoneSystem {
  tick(state: GameState): void {
    if (!state.zoneEnabled || !state.arenaMap) return;
    if (!state.zone) {
      state.zone = this.drawInitialZone(state);
      return;
    }

    const zone = state.zone;
    zone.ticksToPhaseEnd--;
    if (zone.ticksToPhaseEnd > 0) return;

    const map = state.arenaMap;
    const dist = computeRoomDistances(map, zone.eye);
    const maxDist = maxFiniteDistance(dist);

    if (zone.phase === 'warn') {
      // WARN's telegraph period is over: CLOSE — the announced set is now poison.
      zone.stage++;
      const R = Math.max(0, maxDist - zone.stage * ZONE.shrinkStep);
      zone.safe = safeRoomIds(map, dist, R);
      zone.closing = [];
      zone.phase = 'hold';
      zone.ticksToPhaseEnd = ZONE.holdTicks;
      state.events.push({ type: 'zone_close', stage: zone.stage });
      return;
    }

    // HOLD's stable period is over. Is there anything left to shrink?
    const currentR = Math.max(0, maxDist - zone.stage * ZONE.shrinkStep);
    if (currentR <= 0) {
      // Final stage already reached (design/15: "no further shrink — only escalating
      // damage", the structural time bound that makes indefinite stalling impossible
      // without a separate timeout/draw branch in WinConditionSystem).
      zone.escalation++;
      zone.ticksToPhaseEnd = ZONE.holdTicks;
      return;
    }
    const nextR = Math.max(0, currentR - ZONE.shrinkStep);
    const currentSafe = safeRoomIds(map, dist, currentR);
    const nextSafe = safeRoomIds(map, dist, nextR);
    zone.closing = currentSafe.filter((id) => !nextSafe.includes(id));
    zone.phase = 'warn';
    zone.ticksToPhaseEnd = ZONE.warnTicks;
    state.events.push({ type: 'zone_warn', stage: zone.stage + 1, closing: zone.closing });
  }

  private drawInitialZone(state: GameState): ZoneState {
    const map = state.arenaMap!;
    const weights = map.eyeCandidates.map((c) => Math.max(0, c.weight ?? 1));
    const totalWeight = weights.reduce((sum, w) => sum + w, 0);
    // A well-formed map always has >0 total weight; a malformed one (empty/all-zero
    // eyeCandidates) falls back to the first authored room rather than throwing mid-
    // match — validate-at-load (content tooling) is the right place to reject that,
    // not the sim (design/09's "unknown/absent → forward-compat default" precedent).
    const eye =
      totalWeight > 0
        ? map.eyeCandidates[state.ringPrng.weightedIndex(weights)]!.roomId
        : (map.rooms[0]?.id ?? '');
    const dist = computeRoomDistances(map, eye);
    const maxDist = maxFiniteDistance(dist);
    return {
      eye,
      stage: 0,
      // Stage 0 starts already "held" (every reachable room safe) — its first shrink
      // is announced (WARN) exactly like every later stage, once this initial HOLD
      // expires; no special-cased first transition needed.
      phase: 'hold',
      ticksToPhaseEnd: ZONE.holdTicks,
      safe: safeRoomIds(map, dist, maxDist),
      closing: [],
      escalation: 0,
    };
  }
}
