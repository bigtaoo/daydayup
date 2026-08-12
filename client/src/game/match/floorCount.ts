import { EMBER_DUNGEON, type GameState } from '@dd/engine';

/**
 * The run's total floor count, derived from the SAME state fields
 * `ExtractionSystem.ts`'s own (correct) `isLastFloor` check already reads —
 * `state.dungeonEnabled ? state.dungeonConfig.floorCount : state.extraFloors.length`.
 * Three render-side call sites (Game.ts's checkpoint-eligibility gate, HudView's floor
 * chip, RunOutcome's result-screen floor line) used to hardcode `EMBER_DUNGEON.
 * floorCount` directly instead of reading the real config — harmless while the ember
 * dungeon was the only floored content in the game, but wrong for any other
 * floors-enabled config (e.g. a flat, non-dungeon `EngineConfig.floors` run, like the
 * tutorial level). Falls back to `EMBER_DUNGEON.floorCount` when neither `dungeonEnabled`
 * nor `floorsEnabled` is set (a bare, no-floor-concept state, e.g. a minimal test
 * fixture) — this preserves every pre-existing "no floors config at all" fixture's
 * output exactly; it only diverges for a config that genuinely opts into `floors`.
 */
export function totalFloorCount(s: GameState): number {
  if (s.dungeonEnabled) return s.dungeonConfig?.floorCount ?? EMBER_DUNGEON.floorCount;
  if (s.floorsEnabled) return s.extraFloors.length + 1;
  return EMBER_DUNGEON.floorCount;
}

/**
 * Mirrors `ExtractionSystem.tick`'s per-mode "checkpoint reached" condition
 * (engine/systems/ExtractionSystem.ts) — same reasoning as `totalFloorCount` above,
 * this is the render-side half of a condition the engine already computes correctly
 * for itself but doesn't expose. `GameLoop.ts` needs its own copy to gate the
 * portal's open/closed visual and the extract/descend popup identically to what
 * `ExtractionSystem` will actually accept.
 *
 * Dungeon mode's old `wavesExhausted` flag (a floor-wide "last sequential stage
 * cleared" flag) is never set once every room is co-resident and independently
 * activated (see SpawnSystem.tick's early `dungeonEnabled` return) — checking it here
 * left the portal permanently closed and the popup permanently hidden on any
 * non-final floor. The dungeon-aware check instead reads the floor's own capstone
 * (extraction/boss) room directly: reached (`activated`) and cleared (no live enemy)
 * — deliberately NOT `state.enemies.length === 0` globally, since co-resident rooms
 * elsewhere on the floor may still have live enemies while the capstone is clear
 * (matches `ExtractionSystem`'s dungeon branch, which only checks `capstoneCleared`).
 * The flat `floors` list keeps the original floor-wide `wavesExhausted &&
 * enemies.length === 0` pair untouched.
 */
export function checkpointReached(s: GameState): boolean {
  if (s.dungeonEnabled) {
    const rt = s.dungeonRoomRuntime[s.dungeonRoomRuntime.length - 1];
    return rt !== undefined && rt.activated && !rt.hasLiveEnemy;
  }
  return s.wavesExhausted && s.enemies.length === 0;
}
