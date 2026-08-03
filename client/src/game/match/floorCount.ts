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
