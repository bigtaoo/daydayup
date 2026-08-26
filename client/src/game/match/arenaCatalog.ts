/**
 * Client-side arena catalog (design/15, ROADMAP Phase 4 closeout) — the id → ArenaMap
 * lookup a real PvP match start resolves against.
 *
 * `arena_launch` is THE launch map: hand-authored (`@dd/engine/world/arenas`, seven
 * districts joined by a short list of arteries), and what a real PvP match resolves to.
 * `landing_basic` is a small synthetic 3-room fixture kept ONLY for the lightweight
 * `?arenaDemo=1` dev harness (Game.beginArenaDemoRun) — three rooms with no walls at all,
 * which is why it is a harness and not a map.
 *
 * `arena_prototype_60` used to sit here as the audit's before-picture and was retired
 * 2026-08-26 (`world/arenas/arena_prototype_60.json` deleted): a generated 60-room lattice
 * with `solids: []` everywhere, so its rooms and all 71 of its doors were logical-only and
 * its pillars and loot markers were authored in the wrong coordinate space. Its numbers are
 * kept in ROADMAP's "The Seven Districts" comparison table, and every defect it exhibited has
 * a fixture in `arenaMetrics.test.ts`/`arenaGeometryMetrics.test.ts` — nothing needed the map
 * itself to stay loadable.
 */
import type { ArenaMap } from '@dd/engine/content/arenas';
import { LAUNCH_ARENA } from '@dd/engine/world/arenas';

export type ArenaId = 'landing_basic' | 'arena_launch';

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
  arena_launch: LAUNCH_ARENA,
};

/** Every catalog id, as a value — the `?arena=` parser validates against this rather
 *  than against a hand-kept second list. */
export const ARENA_IDS = Object.keys(ARENA_CATALOG) as ArenaId[];

/**
 * The ids that are dev HARNESS fixtures rather than maps a real PvP match resolves to.
 *
 * Exists so the arena quality gate (`@dd/engine/content/arenaQuality`) can hold every OTHER
 * catalog entry to the bar BY DEFAULT: adding a map puts it under the gate automatically, and
 * exempting one is a visible edit to this line rather than a silent omission. That direction
 * matters — a gate scoped by a property the broken content happens to lack (say "has spawns")
 * would quietly excuse exactly the maps it exists to catch.
 *
 * `landing_basic` qualifies on its own terms: three rooms with `solids: []`, so it has no
 * walls, no cover and no authored spawns, and `arenaCatalogQuality.test.ts` asserts that it
 * really does fail the gate — the fixture doubles as proof the gate can fire on real content.
 */
export const DEV_FIXTURE_ARENA_IDS: readonly ArenaId[] = ['landing_basic'];

/** The catalog minus the dev fixtures — every map a real match can build, and the set the
 *  quality gate applies to. */
export const MATCH_ARENA_IDS: ArenaId[] = ARENA_IDS.filter(
  (id) => !DEV_FIXTURE_ARENA_IDS.includes(id),
);

/** `?arena=<id>` → a real catalog id, or `null` for absent AND for unknown. An unknown
 *  id must not reach `EngineConfig.arena` as `undefined`: that silently boots a run with
 *  no arena at all instead of naming the typo, so it is rejected here and the caller
 *  keeps its default. */
export function resolveArenaId(raw: string | null): ArenaId | null {
  return raw !== null && (ARENA_IDS as string[]).includes(raw) ? (raw as ArenaId) : null;
}
