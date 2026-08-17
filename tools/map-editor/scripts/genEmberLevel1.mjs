#!/usr/bin/env node
/**
 * Seed generator for level 1 ("the Ember descent") — writes the hand-tunable JSON
 * content under `world/dungeons/ember/`: 14 `RoomPiece` files plus 5
 * `DungeonFloorMap` files (5 floors of 5/6/7/6/5 rooms).
 *
 * This is a ONE-SHOT SEEDER, not a build step. It exists so the first pass of a
 * 29-room level is principled and reproducible rather than typed by hand; once the
 * JSON is committed it is the source of truth and is meant to be tweaked in the map
 * editor (`npm run dev:map-editor` → "PvE Room Library" / "PvE Dungeon Floor" tabs).
 * Re-running it OVERWRITES those tweaks — it is deliberately not wired into any npm
 * script for that reason.
 *
 * Design constraints it encodes (the level-1 spec):
 *   - 5 floors, room counts 5 / 6 / 7 / 6 / 5 (capstone included in each count).
 *   - Every room is between 15x15 and 20x20 grid cells.
 *   - Enemy count per room scales with the room's cell count, 15x15→8 enemies
 *     up to 20x20→14 enemies (`enemyCountForArea`). The extraction capstone is the
 *     one deliberate exception (0 enemies — it is the checkpoint/portal room).
 *   - Every door is validated for real, physical passability before anything is
 *     written: shared-wall geometry, then a flood fill over the rasterised floor
 *     proving every room's entrance and every spawn point is walkable from the
 *     floor's spawn room.
 *
 * Determinism: a local LCG seeded per floor, so re-running produces byte-identical
 * output. Nothing here runs at match time — the engine only ever reads the JSON.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT_DIR = join(HERE, '..', '..', '..', 'world', 'dungeons', 'ember');
const PIECES_DIR = join(OUT_DIR, 'pieces');

// Placement constants, mirrored from engine/world/dungeon/placementConstants.ts —
// this script writes the same door shape `pickDoorAnchor2d` draws at runtime.
const DOOR_WIDTH_GRID = 4;
const DOOR_EDGE_MARGIN_GRID = 1.5;
const DOOR_ANCHOR_COUNT = 5;
const ENTRANCE_INSET_GRID = 1.5;

/** How far interior decor (solids/pillars) must stay from a room's own perimeter, so
 * a door carved anywhere along a wall always opens onto clear floor. Comfortably
 * larger than `ENTRANCE_INSET_GRID` — the flood fill below is what actually proves
 * it, this is just the authoring rule that makes the proof pass. */
const DECOR_MARGIN = 4;
/** How far a spawn point stays off a wall, and off any decor. */
const SPAWN_MARGIN = 2.5;
/**
 * How far every enemy spawn point stays from every player spawn point. Must exceed
 * `DEFAULT_ENEMY_ENGAGE_RANGE_FP` (engine/content/enemies.ts — 5.6 grid, the range a
 * mob stops and shoots from), or the entrance room places mobs already in firing
 * position on the tick the player appears, which no amount of engine-side aggro
 * pacing can undo. Was 3 in the level's first pass: `r1_cell` put its nearest mob 3.2
 * grid from the spawn point, i.e. inside engage range before the run began.
 */
const PLAYER_SPAWN_CLEARANCE = 6;

// ── Deterministic PRNG (local to this script — NOT the engine's Prng) ────────────
function makeRng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
}
const pick = (rng, arr) => arr[Math.floor(rng() * arr.length) % arr.length];

// ── Piece catalogue ─────────────────────────────────────────────────────────────

/**
 * The spec's size→enemy-count ramp: 15x15 (225 cells) → 8, 20x20 (400) → 14, linear
 * in between and clamped at both ends.
 *
 * Was 15→30 in the level's first pass (2026-08-16), which `client/sim/
 * pveLevelSim.sim.ts` then measured as unsurvivable at any skill level: 15 mobs at
 * one 1-damage shot per 1.5s each is 10 damage/second against a starter character's
 * 9.2 effective HP, and the bot died in the entrance room in 100% of runs. Halving
 * the ramp is the content half of that rebalance; the engine half is the per-room
 * concurrent-fire budget (engine/balance/encounter.ts, ENGINE_VERSION 41), which is
 * what actually caps incoming damage. This half is about CLEAR TIME instead: with the
 * starter blaster at 5 damage/second, 15 mobs averaging 3.5 HP is ~11 seconds of
 * uninterrupted shooting per room, 29 rooms deep — a slog, not a fight.
 *
 * Re-run `npm run test:pve-sim` after changing this: its balance gates are what hold
 * the ramp honest, and difficulty is intentionally tuned to the harder end (floor 1
 * clearable by careful play, full 5-floor extraction uncommon).
 */
function enemyCountForArea(area) {
  const t = (area - 225) / (400 - 225);
  return Math.max(8, Math.min(14, Math.round(8 + 6 * t)));
}

/** Interior decor generators. Every shape is authored inside
 * `[DECOR_MARGIN, size - DECOR_MARGIN]` on both axes — see DECOR_MARGIN. */
const DECOR = {
  open: () => ({ solids: [], pillars: [] }),
  pillars4: (w, h) => ({
    solids: [],
    pillars: [
      { center: { x: DECOR_MARGIN + 1, y: DECOR_MARGIN + 1 }, radius: 1 },
      { center: { x: w - DECOR_MARGIN - 1, y: DECOR_MARGIN + 1 }, radius: 1 },
      { center: { x: DECOR_MARGIN + 1, y: h - DECOR_MARGIN - 1 }, radius: 1 },
      { center: { x: w - DECOR_MARGIN - 1, y: h - DECOR_MARGIN - 1 }, radius: 1 },
    ],
  }),
  blocks2: (w, h) => ({
    solids: [
      { x: DECOR_MARGIN, y: Math.floor(h / 2) - 3, w: 3, h: 2 },
      { x: w - DECOR_MARGIN - 3, y: Math.floor(h / 2) + 1, w: 3, h: 2 },
    ],
    pillars: [],
  }),
  cross: (w, h) => ({
    solids: [
      { x: Math.floor(w / 2) - 3, y: Math.floor(h / 2) - 1, w: 6, h: 2 },
      { x: Math.floor(w / 2) - 1, y: Math.floor(h / 2) - 3, w: 2, h: 6 },
    ],
    pillars: [],
  }),
  corners: (w, h) => ({
    solids: [
      { x: DECOR_MARGIN, y: DECOR_MARGIN, w: 2, h: 2 },
      { x: w - DECOR_MARGIN - 2, y: DECOR_MARGIN, w: 2, h: 2 },
      { x: DECOR_MARGIN, y: h - DECOR_MARGIN - 2, w: 2, h: 2 },
      { x: w - DECOR_MARGIN - 2, y: h - DECOR_MARGIN - 2, w: 2, h: 2 },
    ],
    pillars: [],
  }),
};

/** The normal-room pool, ordered small→large; a floor's own plan (FLOOR_PLANS) picks
 * from it, so difficulty ramps by room size across the descent. */
const PIECE_SPECS = [
  { id: 'ember_l1_cell', w: 15, h: 15, decor: 'open', mix: ['basic', 'emberling'] },
  { id: 'ember_l1_alcove', w: 16, h: 15, decor: 'blocks2', mix: ['basic', 'emberling', 'floater'] },
  { id: 'ember_l1_gallery', w: 15, h: 18, decor: 'pillars4', mix: ['basic', 'floater', 'emberling'] },
  { id: 'ember_l1_forge', w: 17, h: 16, decor: 'cross', mix: ['basic', 'emberling', 'brute'] },
  { id: 'ember_l1_kiln', w: 18, h: 16, decor: 'corners', mix: ['basic', 'emberling', 'frostling'] },
  { id: 'ember_l1_span', w: 16, h: 19, decor: 'blocks2', mix: ['basic', 'floater', 'galvanist'] },
  { id: 'ember_l1_court', w: 18, h: 18, decor: 'pillars4', mix: ['basic', 'brute', 'emberling', 'floater'] },
  { id: 'ember_l1_furnace', w: 20, h: 17, decor: 'corners', mix: ['basic', 'emberling', 'ironclad'] },
  { id: 'ember_l1_bastion', w: 19, h: 18, decor: 'cross', mix: ['basic', 'brute', 'ironclad'] },
  { id: 'ember_l1_crucible', w: 19, h: 19, decor: 'pillars4', mix: ['basic', 'galvanist', 'frostling', 'floater'] },
  { id: 'ember_l1_rampart', w: 20, h: 19, decor: 'blocks2', mix: ['basic', 'ironclad', 'brute', 'galvanist'] },
  { id: 'ember_l1_caldera', w: 20, h: 20, decor: 'open', mix: ['basic', 'brute', 'ironclad', 'frostling', 'floater'] },
];

const EXTRACTION_SPEC = { id: 'ember_l1_extraction', w: 16, h: 16, decor: 'open', mix: [], role: 'extraction' };
const BOSS_SPEC = { id: 'ember_l1_boss', w: 20, h: 20, decor: 'open', mix: ['brute', 'ironclad', 'galvanist'], role: 'boss' };

/** A 1-thick border on all 4 edges. Door gaps are NOT cut here — `carveDoorGaps`
 * (engine/world/dungeon/floorGeometry.ts) is the only place a wall is ever opened,
 * at placement time, from the actual authored door rect. */
function perimeterWalls(w, h) {
  return [
    { x: 0, y: 0, w, h: 1 },
    { x: 0, y: h - 1, w, h: 1 },
    { x: 0, y: 1, w: 1, h: h - 2 },
    { x: w - 1, y: 1, w: 1, h: h - 2 },
  ];
}

const pointInRects = (x, y, rects, pad) =>
  rects.some((r) => x >= r.x - pad && x <= r.x + r.w + pad && y >= r.y - pad && y <= r.y + r.h + pad);
const pointInCircles = (x, y, circles, pad) =>
  circles.some((c) => Math.hypot(x - c.center.x, y - c.center.y) <= c.radius + pad);

/**
 * Lay `count` enemy spawn points out on an even lattice inside the room, skipping
 * anything too close to decor or to a player spawn, then thin the surviving
 * candidates down to exactly `count` by an even stride so they stay spread across
 * the whole room instead of clustering in the first rows.
 */
function scatterSpawns(w, h, count, decor, playerSpawns, mix) {
  const candidates = [];
  for (let y = SPAWN_MARGIN; y <= h - SPAWN_MARGIN; y += 2) {
    for (let x = SPAWN_MARGIN; x <= w - SPAWN_MARGIN; x += 2) {
      if (pointInRects(x, y, decor.solids, 0.75)) continue;
      if (pointInCircles(x, y, decor.pillars, 0.75)) continue;
      if (playerSpawns.some((p) => Math.hypot(x - p.x, y - p.y) < PLAYER_SPAWN_CLEARANCE)) continue;
      candidates.push({ x, y });
    }
  }
  if (candidates.length < count) {
    throw new Error(`scatterSpawns: ${w}x${h} only fits ${candidates.length} spawn points, needs ${count}`);
  }
  const stride = candidates.length / count;
  const chosen = [];
  for (let i = 0; i < count; i++) chosen.push(candidates[Math.floor(i * stride)]);
  return chosen.map((p, i) => ({ x: p.x, y: p.y, type: mix[i % mix.length] }));
}

function buildPiece(spec) {
  const { w, h } = spec;
  const decor = DECOR[spec.decor](w, h);
  // Two player spawns (a co-op run seats two) tucked against the west wall, clear of
  // the decor band and of every enemy spawn (`scatterSpawns` keeps its distance).
  const playerSpawns = [
    { x: 2.5, y: Math.floor(h / 2) - 2 },
    { x: 2.5, y: Math.floor(h / 2) + 2 },
  ];
  const count = spec.role === 'extraction' ? 0 : enemyCountForArea(w * h);
  const piece = {
    id: spec.id,
    ...(spec.role ? { role: spec.role } : { tags: ['ember_l1'] }),
    sizeGrid: { w, h },
    solids: [...decor.solids, ...perimeterWalls(w, h)],
    ...(decor.pillars.length > 0 ? { pillars: decor.pillars } : {}),
    spawns: {
      player: playerSpawns,
      enemy: count === 0 ? [] : scatterSpawns(w, h, count, decor, playerSpawns, spec.mix),
    },
    // Every piece offers all 4 edges: a hand-authored floor connects rooms by
    // geometry, not by exit matching, and full symmetry keeps the map editor free
    // to drag a room to any neighbour without re-authoring the piece.
    exits: [{ edge: 'west' }, { edge: 'east' }, { edge: 'north' }, { edge: 'south' }],
  };
  // The boss room's first spawn point is the blightlord finale; the rest are its
  // garrison. No `encounter` script anywhere in this level — an absent encounter is
  // the engine's "every spawn point at tick 0" hand-authored default
  // (engine/systems/SpawnSystem.ts `expandEncounter`), which is what makes a room
  // genuinely cleared the moment it is empty (DoorSystem's unlock rule).
  if (spec.role === 'boss') piece.spawns.enemy[0] = { ...piece.spawns.enemy[0], type: 'blightlord' };
  return piece;
}

// ── Floor plans ─────────────────────────────────────────────────────────────────

/** Room counts 5/6/7/6/5, capstone included. Piece choice ramps by size with depth;
 * no piece repeats within a floor, so every room on a floor reads distinctly. */
const FLOOR_PLANS = [
  { id: 'ember_l1_floor_1', seed: 0x51a1, pieces: ['ember_l1_cell', 'ember_l1_alcove', 'ember_l1_gallery', 'ember_l1_forge'] },
  { id: 'ember_l1_floor_2', seed: 0x51a2, pieces: ['ember_l1_alcove', 'ember_l1_kiln', 'ember_l1_span', 'ember_l1_forge', 'ember_l1_court'] },
  {
    id: 'ember_l1_floor_3',
    seed: 0x51a3,
    pieces: ['ember_l1_gallery', 'ember_l1_kiln', 'ember_l1_court', 'ember_l1_furnace', 'ember_l1_bastion', 'ember_l1_crucible'],
  },
  {
    id: 'ember_l1_floor_4',
    seed: 0x51a4,
    pieces: ['ember_l1_furnace', 'ember_l1_bastion', 'ember_l1_crucible', 'ember_l1_rampart', 'ember_l1_caldera'],
  },
  { id: 'ember_l1_floor_5', seed: 0x51a5, pieces: ['ember_l1_court', 'ember_l1_crucible', 'ember_l1_rampart', 'ember_l1_caldera'] },
];

const DIRECTIONS = ['east', 'south', 'north', 'west'];

/** Where `piece` lands adjacent to `anchor`, centred on the shared axis (the same
 * convention `placeAdjacent2d` uses at runtime) and rounded to whole grid units so
 * every offset stays integral. */
function adjacentTo(anchor, piece, dir) {
  const cx = anchor.x + anchor.w / 2;
  const cy = anchor.y + anchor.h / 2;
  switch (dir) {
    case 'east':
      return { x: anchor.x + anchor.w, y: Math.round(cy - piece.h / 2) };
    case 'west':
      return { x: anchor.x - piece.w, y: Math.round(cy - piece.h / 2) };
    case 'south':
      return { x: Math.round(cx - piece.w / 2), y: anchor.y + anchor.h };
    default:
      return { x: Math.round(cx - piece.w / 2), y: anchor.y - piece.h };
  }
}

const overlaps = (a, b) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;

/** The band two touching rooms share on their common wall, already inset by
 * `DOOR_EDGE_MARGIN_GRID`, or null if they don't touch (or touch too briefly to fit
 * a door). Mirrors `pickDoorAnchor2d`'s own band math. */
function sharedBand(a, b) {
  const vertical = a.x + a.w === b.x || b.x + b.w === a.x;
  const horizontal = a.y + a.h === b.y || b.y + b.h === a.y;
  if (!vertical && !horizontal) return null;
  const lo = vertical ? Math.max(a.y, b.y) : Math.max(a.x, b.x);
  const hi = vertical ? Math.min(a.y + a.h, b.y + b.h) : Math.min(a.x + a.w, b.x + b.w);
  const bandLo = lo + DOOR_EDGE_MARGIN_GRID;
  const bandHi = hi - DOOR_EDGE_MARGIN_GRID;
  if (bandHi - bandLo < DOOR_WIDTH_GRID) return null;
  const boundary = vertical ? (a.x + a.w === b.x ? b.x : a.x) : a.y + a.h === b.y ? b.y : a.y;
  return { vertical, bandLo, bandHi, boundary };
}

/** An authored door rect on the shared wall — same shape the editor's door tool and
 * `pickDoorAnchor2d` both produce: 2 deep (spanning BOTH rooms' 1-thick perimeter
 * walls) by DOOR_WIDTH_GRID wide, and never dead-centre on the wall (design/05). */
function doorRect(band, rng) {
  const span = band.bandHi - band.bandLo - DOOR_WIDTH_GRID;
  const step = span / (DOOR_ANCHOR_COUNT - 1);
  const anchors = [0, 1, 3, 4]; // deliberately excludes the centre anchor (index 2)
  const idx = span < 1 ? 2 : pick(rng, anchors);
  const centre = Math.round(band.bandLo + DOOR_WIDTH_GRID / 2 + step * idx);
  const clamped = Math.max(band.bandLo + DOOR_WIDTH_GRID / 2, Math.min(band.bandHi - DOOR_WIDTH_GRID / 2, centre));
  return band.vertical
    ? { x: band.boundary - 1, y: clamped - DOOR_WIDTH_GRID / 2, w: 2, h: DOOR_WIDTH_GRID }
    : { x: clamped - DOOR_WIDTH_GRID / 2, y: band.boundary - 1, w: DOOR_WIDTH_GRID, h: 2 };
}

/**
 * Arrange one floor's rooms into a connected 2D graph: each new room attaches to an
 * already-placed one (most-recent first, so the floor reads as a path that wanders
 * rather than a star), in a direction drawn from the floor's own RNG, rejecting any
 * placement that overlaps. The attachment edges form a spanning tree, so
 * reachability is structural; any OTHER pair that happens to end up flush gets an
 * extra door, which is what turns the path into a real graph with loops.
 */
function layoutFloor(plan, pieceById) {
  const rng = makeRng(plan.seed);
  const ids = [...plan.pieces, plan.capstone];
  const rooms = [];
  const doors = [];

  ids.forEach((pieceId, i) => {
    const piece = pieceById.get(pieceId);
    const size = { w: piece.sizeGrid.w, h: piece.sizeGrid.h };
    if (i === 0) {
      rooms.push({ id: `r${i + 1}_${pieceId.replace('ember_l1_', '')}`, pieceId, x: 0, y: 0, ...size });
      return;
    }
    for (let a = rooms.length - 1; a >= 0; a--) {
      const anchor = rooms[a];
      const dirs = DIRECTIONS.slice().sort(() => rng() - 0.5);
      for (const dir of dirs) {
        const at = adjacentTo(anchor, size, dir);
        const candidate = { id: `r${i + 1}_${pieceId.replace('ember_l1_', '')}`, pieceId, ...at, ...size };
        if (rooms.some((r) => overlaps(candidate, r))) continue;
        const band = sharedBand(anchor, candidate);
        if (!band) continue;
        rooms.push(candidate);
        doors.push({ roomA: anchor.id, roomB: candidate.id, passageGrid: doorRect(band, rng) });
        return;
      }
    }
    throw new Error(`layoutFloor: '${plan.id}' could not place room ${i} ('${pieceId}') anywhere`);
  });

  // Extra doors wherever two rooms ended up flush without being tree neighbours —
  // the floor becomes a graph with loops instead of a bare corridor.
  const linked = new Set(doors.map((d) => `${d.roomA}|${d.roomB}`));
  for (let i = 0; i < rooms.length; i++) {
    for (let j = i + 1; j < rooms.length; j++) {
      const a = rooms[i];
      const b = rooms[j];
      if (linked.has(`${a.id}|${b.id}`) || linked.has(`${b.id}|${a.id}`)) continue;
      const band = sharedBand(a, b);
      if (!band) continue;
      doors.push({ roomA: a.id, roomB: b.id, passageGrid: doorRect(band, rng) });
    }
  }

  // Normalise to the origin: every downstream consumer (worldW/worldH, the movement
  // clamp) assumes the floor's playable area starts at (0,0) — the same translation
  // `placeFloorGraph2d` applies for its own negative offsets.
  const shiftX = Math.min(...rooms.map((r) => r.x));
  const shiftY = Math.min(...rooms.map((r) => r.y));
  for (const r of rooms) {
    r.x -= shiftX;
    r.y -= shiftY;
  }
  for (const d of doors) {
    d.passageGrid = { ...d.passageGrid, x: d.passageGrid.x - shiftX, y: d.passageGrid.y - shiftY };
  }

  return {
    id: plan.id,
    rooms: rooms.map((r) => ({ id: r.id, pieceId: r.pieceId, offsetXGrid: r.x, offsetYGrid: r.y })),
    doors,
  };
}

// ── Validation: doors must be physically passable, not just declared ─────────────

/**
 * Rasterise the whole floor at 1 cell per grid unit — solid everywhere outside a
 * room, solid wherever a piece's own solids/pillars sit, then carve every door rect
 * — and flood-fill from the spawn room's entrance. Every room's entrance point and
 * every authored spawn point must be reachable, which is the real "can a player
 * actually walk through this door" check the shared-wall geometry test alone cannot
 * make (a door can sit perfectly on a shared wall and still open into a solid).
 */
function assertFloorTraversable(map, pieceById) {
  const rooms = map.rooms.map((r) => ({ ...r, piece: pieceById.get(r.pieceId) }));
  const W = Math.max(...rooms.map((r) => r.offsetXGrid + r.piece.sizeGrid.w));
  const H = Math.max(...rooms.map((r) => r.offsetYGrid + r.piece.sizeGrid.h));
  const solid = new Uint8Array(W * H).fill(1);
  const at = (x, y) => y * W + x;

  for (const r of rooms) {
    for (let y = 0; y < r.piece.sizeGrid.h; y++) {
      for (let x = 0; x < r.piece.sizeGrid.w; x++) solid[at(r.offsetXGrid + x, r.offsetYGrid + y)] = 0;
    }
    for (const s of r.piece.solids) {
      for (let y = s.y; y < s.y + s.h; y++) {
        for (let x = s.x; x < s.x + s.w; x++) solid[at(r.offsetXGrid + x, r.offsetYGrid + y)] = 1;
      }
    }
    for (const p of r.piece.pillars ?? []) {
      const cx = r.offsetXGrid + p.center.x;
      const cy = r.offsetYGrid + p.center.y;
      for (let y = Math.floor(cy - p.radius); y <= Math.ceil(cy + p.radius); y++) {
        for (let x = Math.floor(cx - p.radius); x <= Math.ceil(cx + p.radius); x++) {
          if (x >= 0 && y >= 0 && x < W && y < H && Math.hypot(x + 0.5 - cx, y + 0.5 - cy) <= p.radius + 0.5) {
            solid[at(x, y)] = 1;
          }
        }
      }
    }
  }
  for (const d of map.doors) {
    const g = d.passageGrid;
    for (let y = Math.floor(g.y); y < Math.ceil(g.y + g.h); y++) {
      for (let x = Math.floor(g.x); x < Math.ceil(g.x + g.w); x++) {
        if (x >= 0 && y >= 0 && x < W && y < H) solid[at(x, y)] = 0;
      }
    }
  }

  const first = rooms[0];
  const start = { x: Math.floor(first.offsetXGrid + first.piece.spawns.player[0].x), y: Math.floor(first.offsetYGrid + first.piece.spawns.player[0].y) };
  const seen = new Uint8Array(W * H);
  const queue = [at(start.x, start.y)];
  seen[queue[0]] = 1;
  while (queue.length > 0) {
    const cur = queue.pop();
    const cx = cur % W;
    const cy = (cur - cx) / W;
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const nx = cx + dx;
      const ny = cy + dy;
      if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
      const n = at(nx, ny);
      if (seen[n] || solid[n]) continue;
      seen[n] = 1;
      queue.push(n);
    }
  }

  const unreachable = [];
  for (const r of rooms) {
    const points = [
      { label: 'entrance', x: r.offsetXGrid + ENTRANCE_INSET_GRID, y: r.offsetYGrid + r.piece.sizeGrid.h / 2 },
      ...r.piece.spawns.player.map((p, i) => ({ label: `player spawn ${i}`, x: r.offsetXGrid + p.x, y: r.offsetYGrid + p.y })),
      ...r.piece.spawns.enemy.map((p, i) => ({ label: `enemy spawn ${i}`, x: r.offsetXGrid + p.x, y: r.offsetYGrid + p.y })),
    ];
    for (const pt of points) {
      if (!seen[at(Math.floor(pt.x), Math.floor(pt.y))]) unreachable.push(`${r.id} ${pt.label} @ (${pt.x}, ${pt.y})`);
    }
  }
  if (unreachable.length > 0) {
    throw new Error(`assertFloorTraversable: '${map.id}' has unreachable points:\n  ${unreachable.join('\n  ')}`);
  }
  return { W, H, reachable: seen.reduce((n, v) => n + v, 0) };
}

// ── Emit ────────────────────────────────────────────────────────────────────────

const writeJson = (path, value) => writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, 'utf8');

mkdirSync(PIECES_DIR, { recursive: true });

const pieces = [...PIECE_SPECS, EXTRACTION_SPEC, BOSS_SPEC].map(buildPiece);
const pieceById = new Map(pieces.map((p) => [p.id, p]));
for (const piece of pieces) writeJson(join(PIECES_DIR, `${piece.id}.json`), piece);

const plans = FLOOR_PLANS.map((plan, i) => ({
  ...plan,
  capstone: i === FLOOR_PLANS.length - 1 ? BOSS_SPEC.id : EXTRACTION_SPEC.id,
}));

let totalRooms = 0;
let totalEnemies = 0;
for (const plan of plans) {
  const map = layoutFloor(plan, pieceById);
  const { W, H } = assertFloorTraversable(map, pieceById);
  writeJson(join(OUT_DIR, `${plan.id}.json`), map);
  const enemies = map.rooms.reduce((n, r) => n + pieceById.get(r.pieceId).spawns.enemy.length, 0);
  totalRooms += map.rooms.length;
  totalEnemies += enemies;
  console.log(
    `${plan.id}: ${map.rooms.length} rooms, ${map.doors.length} doors, ${enemies} enemies, floor extent ${W}x${H} grid`,
  );
}

console.log(`\n${pieces.length} pieces → ${PIECES_DIR}`);
for (const p of pieces) {
  console.log(`  ${p.id.padEnd(22)} ${`${p.sizeGrid.w}x${p.sizeGrid.h}`.padEnd(7)} ${String(p.sizeGrid.w * p.sizeGrid.h).padStart(3)} cells  ${String(p.spawns.enemy.length).padStart(2)} enemies`);
}
console.log(`\n${plans.length} floors, ${totalRooms} rooms, ${totalEnemies} enemies total → ${OUT_DIR}`);
