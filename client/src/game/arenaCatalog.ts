/**
 * Client-side arena catalog (design/15, ROADMAP Phase 4 closeout) — the id → ArenaMap
 * lookup a real PvP match start resolves against. Today it holds exactly one entry: a
 * small synthetic 3-room map (the same fixture shape as the engine's own
 * content/arenas.test.ts), standing in for the real ~60-room hand-authored map that the
 * map editor (tools/map-editor) is used to build separately. Swapping in the real map is
 * meant to be a one-line addition here (load its JSON, add a catalog entry) — no change
 * to the matchmaking/assembly wiring that reads this catalog.
 */
import type { ArenaMap } from '@dd/engine/content/arenas';

export type ArenaId = 'landing_basic';

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
};
