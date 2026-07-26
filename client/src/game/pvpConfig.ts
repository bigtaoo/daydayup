/**
 * Shared PvP arena EngineConfig builder (design/15, ROADMAP Phase 4 closeout). Pulled out
 * of `Game.buildOnlineConfig` so there is exactly ONE place that turns `(seed,
 * playerCount)` into the arena run config — the same anti-drift lesson design/06 already
 * states for the wire protocol ("two hand-mirrored copies inevitably drift") applies here
 * too, now that a headless bot client (server/src/BotClient.ts) needs to build the
 * byte-identical config independently, without importing the Pixi-heavy Game.ts.
 *
 * MUST stay a pure function of `seed`/`playerCount` (determinism, design/06): seats are
 * skinned by index and each gets its OWN distinct teamId (solo battle royale, ROADMAP
 * 4.2a); neither a chosen character nor a crafted loadout enters here, real or bot.
 */
import { SKIN_DEFS, type EngineConfig } from '@dd/engine';
import { ARENA_CATALOG } from './arenaCatalog';

// Ignored once `arena` is set (each arena's own geometry defines the bounds) — mirrors
// the PLACEHOLDER_WORLD literal Game.ts uses for its own (non-PvP) online/offline configs.
const PLACEHOLDER_WORLD = 800;

export function buildPvpEngineConfig(seed: number, playerCount: number): EngineConfig {
  const ids = Object.keys(SKIN_DEFS);
  return {
    seed,
    worldW: PLACEHOLDER_WORLD,
    worldH: PLACEHOLDER_WORLD,
    waves: [],
    players: Array.from({ length: playerCount }, (_, i) => ({
      skinId: ids[i % ids.length]!,
      teamId: i,
    })),
    arena: ARENA_CATALOG.arena_prototype_60,
  };
}
