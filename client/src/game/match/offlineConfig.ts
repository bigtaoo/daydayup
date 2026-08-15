import { EMBER_DUNGEON, EMBER_L1_ROOMS, type EngineConfig } from '@dd/engine';
import { toFpGrid } from '@dd/engine/content/convert';
import { ARENA_CATALOG } from './arenaCatalog';
import { fpToPx } from '../coords';

// Ignored in dungeon/arena mode (each room/arena sets its own bounds) — mirrors the
// PLACEHOLDER_WORLD literal Game.ts uses for its own online configs.
const PLACEHOLDER_WORLD = 800;

/**
 * The offline PvE dungeon run config (beginRun). Local co-op (ROADMAP 3.1) opts in a
 * second seat — the bot ally, a distinct free character — via EngineConfig.players;
 * single-player passes the top-level skin/loadout and is byte-identical (an absent
 * `players` list → the same one-seat construction). Pulled out of Game.ts 2026-07-28.
 */
export function buildDungeonRunConfig(opts: {
  seed: number;
  coop: boolean;
  localSeat: { skinId: string; loadout: string[] };
  allySkinId: string;
}): EngineConfig {
  return {
    seed: opts.seed,
    worldW: PLACEHOLDER_WORLD,
    worldH: PLACEHOLDER_WORLD,
    waves: [],
    ...(opts.coop
      ? { players: [opts.localSeat, { skinId: opts.allySkinId }] }
      : { skinId: opts.localSeat.skinId, loadout: opts.localSeat.loadout }),
    dungeon: { config: EMBER_DUNGEON, library: EMBER_L1_ROOMS },
  };
}

/**
 * Dev-only (`?arenaDemo=1`, see Game.arenaDemo's field doc comment): a tiny synthetic
 * 3-room ArenaMap + two local seats on distinct teams, with zero matchmaking round-trip.
 */
export function buildArenaDemoConfig(opts: { seed: number; localSkinId: string; allySkinId: string }): EngineConfig {
  const px = (grid: number) => fpToPx(toFpGrid(grid));
  return {
    seed: opts.seed,
    worldW: PLACEHOLDER_WORLD,
    worldH: PLACEHOLDER_WORLD,
    waves: [],
    players: [
      { skinId: opts.localSkinId, teamId: 0, start: [px(5), px(5)] }, // room A centre
      { skinId: opts.allySkinId, teamId: 1, start: [px(5), px(35)] }, // room C centre
    ],
    arena: ARENA_CATALOG.landing_basic,
  };
}
