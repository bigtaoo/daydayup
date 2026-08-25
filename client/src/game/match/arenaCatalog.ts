/**
 * Client-side arena catalog (design/15, ROADMAP Phase 4 closeout) — the id → ArenaMap
 * lookup a real PvP match start resolves against.
 *
 * `arena_prototype_60` is the real hand-authored (well, map-editor-authored:
 * procedurally generated + validated in the editor, tools/map-editor) 60-room launch
 * map — `world/arenas/arena_prototype_60.json`, produced and validated separately from
 * this client. `landing_basic` is a small synthetic 3-room fixture (same shape as the
 * engine's own content/arenas.test.ts) kept ONLY for the lightweight `?arenaDemo=1` dev
 * harness (Game.beginArenaDemoRun) — a real PvP match always resolves to the real map.
 */
import type { ArenaMap } from '@dd/engine/content/arenas';
import arenaPrototype60 from '../../../../world/arenas/arena_prototype_60.json';

export type ArenaId = 'landing_basic' | 'arena_prototype_60';

/** An L-shaped 3-room layout connected by doors, no encounter/loot markers — enough for
 * ZoneSystem's shrink and the placement win condition to run for real, not enough to be
 * a tuned, playable map. All three rooms are eye-candidates so the shrink is visible. */
function buildLandingBasic(): ArenaMap {
  return {
    id: 'landing_basic',
    sizeGrid: { w: 50, h: 50 },
    rooms: [
      { id: 'A', rectGrid: { x: 0, y: 0, w: 10, h: 10 }, solids: [] },
      { id: 'B', rectGrid: { x: 30, y: 0, w: 10, h: 10 }, solids: [] },
      { id: 'C', rectGrid: { x: 0, y: 30, w: 10, h: 10 }, solids: [] },
    ],
    doors: [
      { roomA: 'A', roomB: 'B', passageGrid: { x: 10, y: 4, w: 20, h: 2 } },
      { roomA: 'A', roomB: 'C', passageGrid: { x: 4, y: 10, w: 2, h: 20 } },
    ],
    spawns: [],
    eyeCandidates: [{ roomId: 'A' }, { roomId: 'B' }, { roomId: 'C' }],
  };
}

export const ARENA_CATALOG: Record<ArenaId, ArenaMap> = {
  landing_basic: buildLandingBasic(),
  arena_prototype_60: arenaPrototype60 as ArenaMap,
};

/** Every catalog id, as a value — the `?arena=` parser validates against this rather
 *  than against a hand-kept second list. */
export const ARENA_IDS = Object.keys(ARENA_CATALOG) as ArenaId[];

/** `?arena=<id>` → a real catalog id, or `null` for absent AND for unknown. An unknown
 *  id must not reach `EngineConfig.arena` as `undefined`: that silently boots a run with
 *  no arena at all instead of naming the typo, so it is rejected here and the caller
 *  keeps its default. */
export function resolveArenaId(raw: string | null): ArenaId | null {
  return raw !== null && (ARENA_IDS as string[]).includes(raw) ? (raw as ArenaId) : null;
}
