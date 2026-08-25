/**
 * Arena map audit (design/15) — a printed report over every map in `ARENA_CATALOG`,
 * measured by `@dd/engine/content/arenaMetrics`.
 *
 * Why this is a report and not a gate: `tools/map-editor`'s `validate.ts` already answers
 * "is this map structurally loadable", and `arena_prototype_60.json` passes it. What
 * nothing measured is whether the map is DESIGNED — and it is not: it is 60 identical
 * 10x10 rooms on a regular lattice, every one with `solids: []`, one dead-centre pillar and
 * one `arena_common` loot marker. Turning those observations into pass/fail thresholds now
 * would just pin the placeholder's own numbers as the standard; the thresholds belong with
 * the map that can meet them (ROADMAP: the arena-map authoring pass). Until then this
 * prints the numbers, and `arenaMetrics.test.ts` pins that the numbers mean what they say.
 *
 * Run: `npm run audit:arena -w client`. Same harness shape as the two balance sims — kept
 * out of the default `npm test` glob because its output is a report to read, not an
 * assertion to pass.
 */
import { describe, it, expect } from 'vitest';
import { measureArena, type ArenaMetrics } from '@dd/engine/content/arenaMetrics';
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

function report(m: ArenaMetrics): string {
  const lines: string[] = [];
  const push = (s = '') => lines.push(s);

  push(`=== ${m.id} — ${m.roomCount} rooms, ${m.doorCount} doors, ${m.sizeGrid.w}x${m.sizeGrid.h} grid ===`);
  push();
  push('VARIETY — how much of this map is the same thing repeated');
  push(varietyLine('room footprints', m.footprints));
  push(varietyLine('interiors (cover)', m.interiors));
  push(varietyLine('loot layouts', m.lootLayouts));
  push(varietyLine('encounters', m.encounters));
  push(varietyLine('hazard tiles', m.traits));
  push(`  loot tables            ${JSON.stringify(m.lootTables)}`);
  push(`  hazard kinds           ${JSON.stringify(m.traitKinds)}`);
  push();

  const c = m.cover;
  const mid = c.coverFractions[Math.floor(c.coverFractions.length / 2)] ?? 0;
  push('COVER — what breaks line of sight');
  push(`  wall-run rects         ${c.totalSolids} across the whole map`);
  push(`  pillars                ${c.totalPillars}`);
  push(`  rooms with NO cover    ${c.roomsWithNoCover.length} / ${m.roomCount}`);
  push(`  rooms with NO walls    ${c.roomsWithNoWalls.length} / ${m.roomCount}`);
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
      const metrics = measureArena(ARENA_CATALOG[id]);
      console.log(`\n${report(metrics)}`);
      // The report is the point, but a run that measured NOTHING must not read as a pass —
      // the same "a zero is not a result until something fires" rule the perf probes use.
      expect(metrics.roomCount).toBeGreaterThan(0);
      expect(metrics.doorCount).toBeGreaterThan(0);
    });
  }
});
