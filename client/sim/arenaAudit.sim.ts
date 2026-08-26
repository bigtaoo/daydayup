/**
 * Arena map audit (design/15) — a printed report over every map in `ARENA_CATALOG`, in two
 * halves: `arenaMetrics` (variety, cover, door graph, spawns, zone reach) and
 * `arenaGeometryMetrics` (where the content actually lands, and whether the rooms and doors
 * physically exist).
 *
 * Why this exists: `tools/map-editor`'s `validate.ts` answers "is this map structurally
 * loadable", which is a different question from "is this map designed". `arena_prototype_60`
 * passed the first and failed the second in two ways nothing had measured — 60 identical rooms
 * with `solids: []` everywhere (so no walls at all: its rects and all 71 doors were
 * logical-only and an actor crossed the map in a straight line), and pillars and loot markers
 * authored as ABSOLUTE coordinates where the engine expects room-relative, displacing every
 * one of them and throwing 90 of 120 off the map.
 *
 * The second was invisible to the variety half of this report, which is why the geometry half
 * exists: "60 identical rooms" and "60 rooms whose contents are all somewhere else" look the
 * same from a uniformity metric. `arena_launch` was then authored against both halves, and it
 * is what a real match now builds; `arena_prototype_60` is kept in the catalog as the
 * before-picture this report prints beside it.
 *
 * Still a REPORT and not a gate: the numbers a good map should hold are now KNOWN (see
 * ROADMAP's "The Seven Districts" table), so turning the load-bearing ones into thresholds is
 * a reasonable follow-up — it just should not be done by transcribing whatever the current map
 * happens to score. The two metrics test files pin that the numbers mean what they say, and
 * `world/arenas/launchArena.test.ts` already asserts the important ones for the shipped map.
 *
 * Run: `npm run audit:arena -w client`. Same harness shape as the two balance sims — kept
 * out of the default `npm test` glob because its output is a report to read, not an
 * assertion to pass.
 */
import { describe, it, expect } from 'vitest';
import { measureArena, type ArenaMetrics } from '@dd/engine/content/arenaMetrics';
import { measureEnclosure, measurePlacement } from '@dd/engine/content/arenaGeometryMetrics';
import type { ArenaMap } from '@dd/engine/content/arenas';
import { ARENA_CATALOG, ARENA_IDS } from '../src/game/match/arenaCatalog';

function pct(x: number): string {
  return `${(x * 100).toFixed(1)}%`;
}

function hops(n: number): string {
  return Number.isFinite(n) ? String(n) : 'unreachable';
}

/** `distinct / rooms`, plus the share the single most-repeated variant takes. The line
 *  that says "stamped, not authored" when it reads `1 distinct over 60 rooms`. */
function varietyLine(label: string, v: { rooms: number; distinct: number; dominantShare: number }): string {
  if (v.rooms === 0) return `  ${label.padEnd(22)} none`;
  return `  ${label.padEnd(22)} ${String(v.distinct).padStart(3)} distinct over ${String(v.rooms).padStart(3)} rooms` +
    `   (most common covers ${pct(v.dominantShare)})`;
}

/** The half of the audit that asks where the content physically LANDS — see
 *  arenaGeometryMetrics.ts for why a variety metric cannot see any of this. */
function geometryReport(map: ArenaMap): string {
  const p = measurePlacement(map);
  const e = measureEnclosure(map);
  const lines: string[] = [];
  const push = (s = '') => lines.push(s);

  push('PLACEMENT — where the authored content lands once the room offset is applied');
  for (const [feature, counts] of Object.entries(p.byFeature)) {
    if (counts.authored === 0) continue;
    const flag = counts.misplaced > 0 ? '  <-- OUTSIDE ITS OWN ROOM' : '';
    push(`  ${feature.padEnd(20)} ${String(counts.authored).padStart(3)} authored, ` +
      `${String(counts.misplaced).padStart(3)} misplaced${flag}`);
  }
  push(`  off the map entirely  ${p.offMap.length}`);
  for (const m of p.offMap.slice(0, 3)) {
    push(`      e.g. ${m.room} ${m.feature} -> (${m.at.x}, ${m.at.y})`);
  }
  push();

  push('ENCLOSURE — whether the rooms and doors are physically real');
  push(`  solid cells            ${e.solidCells}${e.solidCells === 0 ? '  <-- NO WALLS ANYWHERE' : ''}`);
  push(`  unenclosed rooms       ${e.unenclosedRooms.length}`);
  push(`  perimeter coverage     min ${pct(e.perimeterCoverage[0] ?? 0)}` +
    `  max ${pct(e.perimeterCoverage[e.perimeterCoverage.length - 1] ?? 0)}`);
  push(`  doors gating nothing   ${e.doorsWithoutWalls}`);
  push(`  undoored walk-throughs ${e.undoorLeaks}  (room pairs with no door and no wall)`);
  push();
  return lines.join('\n');
}

function report(m: ArenaMetrics): string {
  const lines: string[] = [];
  const push = (s = '') => lines.push(s);

  push(`=== ${m.id} — ${m.roomCount} rooms, ${m.doorCount} doors, ${m.sizeGrid.w}x${m.sizeGrid.h} grid ===`);
  push();
  push('VARIETY — how much of this map is the same thing repeated');
  push(varietyLine('room footprints', m.footprints));
  push(varietyLine('interiors (as read)', m.interiors));
  push(varietyLine('interior SHAPES', m.interiorShapes));
  push(varietyLine('loot layouts', m.lootLayouts));
  push(varietyLine('encounters', m.encounters));
  push(varietyLine('hazard tiles', m.traits));
  push(`  loot tables            ${JSON.stringify(m.lootTables)}`);
  push(`  hazard kinds           ${JSON.stringify(m.traitKinds)}`);
  push();

  const c = m.cover;
  const mid = c.coverFractions[Math.floor(c.coverFractions.length / 2)] ?? 0;
  push('COVER — what breaks line of sight, AS AUTHORED (see PLACEMENT for where it lands)');
  push(`  wall-run rects         ${c.totalSolids} across the whole map`);
  push(`  pillars                ${c.totalPillars}`);
  push(`  rooms with no authored cover  ${c.roomsWithNoCover.length} / ${m.roomCount}`);
  push(`  rooms with no authored walls  ${c.roomsWithNoWalls.length} / ${m.roomCount}`);
  push(
    `  cover / floor area     min ${pct(c.coverFractions[0] ?? 0)}` +
      `  median ${pct(mid)}  max ${pct(c.coverFractions[c.coverFractions.length - 1] ?? 0)}`,
  );
  push();

  const g = m.graph;
  push('LAYOUT — the door graph');
  push(`  connected              ${g.connected}`);
  push(`  diameter               ${hops(g.diameter)} hops`);
  push(`  degree histogram       ${JSON.stringify(g.degreeHistogram)}`);
  push(`  dead ends              ${g.deadEnds.length}${g.deadEnds.length ? ` (${g.deadEnds.join(', ')})` : ''}`);
  push(`  isolated rooms         ${g.isolated.length}${g.isolated.length ? ` (${g.isolated.join(', ')})` : ''}`);
  push(`  chokepoints            ${g.chokepoints.length}${g.chokepoints.length ? ` (${g.chokepoints.join(', ')})` : ''}`);
  push();

  const s = m.spawns;
  push('DROP — where the seats start');
  push(`  spawn points           ${s.count}`);
  push(`  outside every room     ${s.orphans}`);
  push(`  sharing a room         ${s.colliding}`);
  push(`  pairwise separation    min ${hops(s.minPairHops)} hops, max ${hops(s.maxPairHops)} hops`);
  push();

  push('ZONE');
  push(`  eye candidates         ${m.eyeCandidates} / ${m.roomCount} rooms`);
  push(`  furthest room from an eye candidate: ${hops(m.maxHopsToEye)} hops`);
  push();
  return lines.join('\n');
}

describe('arena map audit', () => {
  for (const id of ARENA_IDS) {
    it(`reports ${id}`, () => {
      const arena = ARENA_CATALOG[id];
      const metrics = measureArena(arena);
      console.log(`\n${report(metrics)}${geometryReport(arena)}`);
      // The report is the point, but a run that measured NOTHING must not read as a pass —
      // the same "a zero is not a result until something fires" rule the perf probes use.
      expect(metrics.roomCount).toBeGreaterThan(0);
      expect(metrics.doorCount).toBeGreaterThan(0);
    });
  }
});
