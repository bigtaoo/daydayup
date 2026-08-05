/**
 * `RoomCanvas` had zero dedicated tests despite being the shared room-detail canvas
 * for BOTH a PvE `RoomPiece` (via `RoomPieceTarget`) and one PvP `ArenaRoom` (via
 * `ArenaRoomTarget`) — solids/pillars/props/spawns/cellTraits/lootMarkers, all
 * routed through the `RoomEditTarget` adapter (see `RoomEditTarget.ts`). Its
 * `mount()` touches real DOM/`Application.init()`, unavailable in plain vitest —
 * but exactly like `DungeonFloorCanvas`/`ArenaCanvas` (see those files' test
 * headers), the CONSTRUCTOR never touches `host`/`document`/`window`: every field
 * (`app`, `world`, `shapes`, `labels`, `preview`) is a plain Pixi object,
 * constructible with zero renderer/canvas. `world.position.set(PAD_PX, PAD_PX)` and
 * `app.stage.addChild(world)` only happen inside `mount()`, so skipping `mount()`
 * leaves `world` unparented with an identity transform — `toGrid(px, py)` reduces to
 * the clean `(px/GRID_PX, py/GRID_PX)`. Every pixel coordinate below is
 * `gridCoord * 24` (GRID_PX, an unexported module constant, matching the source).
 *
 * `shapes`/`labels`/`preview` are private fields, and `hitTest`/`cornerNear`/
 * `layerArray`/`rectOf`/`onPointerDown`/`onPointerMove`/`onPointerUp` are private
 * methods — both read via bracket-notation access, same convention as the sibling
 * canvas test files. `context.instructions` is read directly for draw-call
 * assertions, same technique.
 *
 * Two `RoomEditTarget` implementations are exercised directly against real state
 * (no hand-rolled fake target) — `RoomPieceTarget` over a `RoomDocument`/`RoomPiece`
 * for the PvE-only assertions (playerSpawn tool; no cellTraits/lootMarkers), and
 * `ArenaRoomTarget` over an `ArenaDocument`/`ArenaMap` room for the PvP-only ones
 * (lootMarker tool; cellTraits) — matching how `RoomEditTarget.ts` says the "one
 * component, two schemas" split is actually meant to be exercised.
 *
 * NOT covered (same accepted exemption the sibling canvas test files document):
 * `onKeyDown`'s Delete/Backspace path (needs `document`/`HTMLInputElement`/a real
 * `window` keydown listener).
 */
import { describe, it, expect } from 'vitest';
import type { Graphics, Container, Text } from 'pixi.js';
import type { RoomPiece } from '@dd/engine';
import type { ArenaMap } from '@dd/engine/content/arenas';
import { COLORS } from '../colors';
import { RoomCanvas } from './RoomCanvas';
import { RoomPieceTarget, ArenaRoomTarget } from './RoomEditTarget';
import { RoomDocument } from '../state/RoomDocument';
import { ArenaDocument } from '../state/ArenaDocument';

const GRID_PX = 24; // matches the module's own unexported constant

const fakeHost = { clientWidth: 800, clientHeight: 600 } as unknown as HTMLElement;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function priv(c: RoomCanvas): any {
  return c;
}

function blankPiece(): RoomPiece {
  return { id: 'p', sizeGrid: { w: 20, h: 20 }, solids: [], spawns: { player: [], enemy: [] }, exits: [] };
}

function makePveCanvas(piece: RoomPiece = blankPiece()): { canvas: RoomCanvas; target: RoomPieceTarget; doc: RoomDocument } {
  const canvas = new RoomCanvas(fakeHost);
  const doc = new RoomDocument(piece);
  const target = new RoomPieceTarget(doc);
  canvas.setTarget(target);
  return { canvas, target, doc };
}

function blankArenaMap(roomW = 20, roomH = 20): ArenaMap {
  return {
    id: 'm',
    sizeGrid: { w: 100, h: 100 },
    rooms: [{ id: 'r', rectGrid: { x: 0, y: 0, w: roomW, h: roomH }, solids: [] }],
    doors: [],
    spawns: [],
    eyeCandidates: [],
  };
}

function makePvpCanvas(map: ArenaMap = blankArenaMap()): { canvas: RoomCanvas; target: ArenaRoomTarget; doc: ArenaDocument } {
  const canvas = new RoomCanvas(fakeHost);
  const doc = new ArenaDocument(map);
  const target = new ArenaRoomTarget(doc, 'r');
  canvas.setTarget(target);
  return { canvas, target, doc };
}

interface DrawnInstruction { color: number; alpha: number; width: number; shape: unknown }
type RawInstruction = {
  action: 'fill' | 'stroke';
  data: { style?: { color: number; alpha: number; width?: number }; path?: { shapePath: { shapePrimitives: { shape: unknown }[] } } };
};

/** Same `context.instructions` read as the sibling canvas test files. */
function rawInstructions(g: Graphics): RawInstruction[] {
  return (g.context as unknown as { instructions: RawInstruction[] }).instructions;
}
function toDrawn(ins: RawInstruction): DrawnInstruction {
  return {
    color: ins.data.style!.color,
    alpha: ins.data.style!.alpha,
    width: ins.data.style!.width ?? 0,
    shape: ins.data.path!.shapePath.shapePrimitives[0]!.shape,
  };
}
function drawnFills(g: Graphics): DrawnInstruction[] {
  return rawInstructions(g).filter((i) => i.action === 'fill').map(toDrawn);
}
/** Skips index 0 — `redraw()` always emits one stroke-only instruction for the
 * background grid-line mesh (`moveTo`/`lineTo` loops finished by a single
 * `.stroke()`) before any per-shape stroke, unlike `drawnFills` which has no such
 * leading entry (the grid-line mesh has no matching `.fill()` call). */
function drawnStrokes(g: Graphics): DrawnInstruction[] {
  return rawInstructions(g)
    .filter((i) => i.action === 'stroke')
    .slice(1)
    .map(toDrawn);
}

function labelTexts(labels: Container): string[] {
  return labels.children.map((t) => (t as Text).text);
}

describe('RoomCanvas — redraw, PvE RoomPiece target', () => {
  it('draws a ground rect sized to getSize(), then one rect per solid, filled+stroked', () => {
    const piece = blankPiece();
    piece.solids.push({ x: 2, y: 3, w: 4, h: 5 });
    const { canvas } = makePveCanvas(piece);
    const fills = drawnFills(priv(canvas).shapes);
    expect(fills).toHaveLength(2); // ground + 1 solid
    expect(fills[0]!.color).toBe(COLORS.ground);
    expect(fills[1]!.color).toBe(COLORS.wall);
    const strokes = drawnStrokes(priv(canvas).shapes);
    expect(strokes[0]).toMatchObject({ color: COLORS.wallEdge, width: 2 }); // unselected
  });

  it('draws a filled+stroked circle per pillar', () => {
    const piece = blankPiece();
    piece.pillars = [{ center: { x: 5, y: 5 }, radius: 2 }];
    const { canvas } = makePveCanvas(piece);
    const fills = drawnFills(priv(canvas).shapes);
    expect(fills[1]).toMatchObject({ color: COLORS.pillar });
    expect(fills[1]!.shape).toMatchObject({ radius: 2 * GRID_PX });
  });

  it('draws a filled+stroked mini-rect per prop, labeled with its id', () => {
    const piece = blankPiece();
    piece.props = [{ id: 'prop_9', x: 6, y: 6 }];
    const { canvas } = makePveCanvas(piece);
    const fills = drawnFills(priv(canvas).shapes);
    expect(fills[1]).toMatchObject({ color: COLORS.prop });
    expect(labelTexts(priv(canvas).labels)).toContain('prop_9');
  });

  it('draws a filled+stroked circle per player spawn (pve only) and per enemy spawn', () => {
    const piece = blankPiece();
    piece.spawns.player.push({ x: 1, y: 1 });
    piece.spawns.enemy.push({ x: 2, y: 2, type: 'grunt' });
    const { canvas } = makePveCanvas(piece);
    const fills = drawnFills(priv(canvas).shapes);
    expect(fills.some((f) => f.color === COLORS.player)).toBe(true);
    expect(fills.some((f) => f.color === COLORS.enemy)).toBe(true);
    expect(labelTexts(priv(canvas).labels)).toContain('grunt'); // enemy spawn's optional type label
  });

  it('a pve target always draws zero cellTraits and zero lootMarkers', () => {
    const { canvas } = makePveCanvas();
    expect(priv(canvas).target.getCellTraits()).toEqual([]);
    expect(priv(canvas).target.getLootMarkers()).toEqual([]);
  });

  it('gives the selected solid a thicker, selection-colored stroke than an unselected one', () => {
    const piece = blankPiece();
    piece.solids.push({ x: 0, y: 0, w: 2, h: 2 }, { x: 10, y: 10, w: 2, h: 2 });
    const { canvas } = makePveCanvas(piece);
    canvas.setSelection({ layer: 'solids', index: 1 });
    const strokes = drawnStrokes(priv(canvas).shapes);
    expect(strokes[0]).toMatchObject({ color: COLORS.wallEdge, width: 2 }); // solid 0, unselected
    expect(strokes[1]).toMatchObject({ color: COLORS.selection, width: 3 }); // solid 1, selected
  });

  it('clears and redraws on every setTarget — switching pieces leaves no stale fills behind', () => {
    const canvas = new RoomCanvas(fakeHost);
    const pieceA = blankPiece();
    pieceA.solids.push({ x: 0, y: 0, w: 2, h: 2 }, { x: 5, y: 5, w: 2, h: 2 });
    canvas.setTarget(new RoomPieceTarget(new RoomDocument(pieceA)));
    expect(drawnFills(priv(canvas).shapes)).toHaveLength(3); // ground + 2 solids
    const pieceB = blankPiece();
    pieceB.solids.push({ x: 0, y: 0, w: 2, h: 2 });
    canvas.setTarget(new RoomPieceTarget(new RoomDocument(pieceB)));
    expect(drawnFills(priv(canvas).shapes)).toHaveLength(2); // ground + 1 solid
  });

  it('a mutation on the target (via .mutate) triggers a live redraw through the on() subscription', () => {
    const { canvas, target } = makePveCanvas();
    expect(drawnFills(priv(canvas).shapes)).toHaveLength(1); // ground only
    target.mutate(() => target.getSolids().push({ x: 0, y: 0, w: 1, h: 1 }));
    expect(drawnFills(priv(canvas).shapes)).toHaveLength(2);
  });
});

describe('RoomCanvas — redraw, PvP ArenaRoom target (cellTraits + lootMarkers)', () => {
  it('draws a filled+stroked rect per cellTrait, labeled with its kind', () => {
    const map = blankArenaMap();
    map.rooms[0]!.cellTraits = [{ id: 't1', rectGrid: { x: 1, y: 1, w: 3, h: 3 }, kind: 'spike', timed: false }];
    const { canvas } = makePvpCanvas(map);
    const fills = drawnFills(priv(canvas).shapes);
    expect(fills[1]).toMatchObject({ color: COLORS.cellTrait, alpha: 0.3 });
    expect(labelTexts(priv(canvas).labels)).toContain('spike');
  });

  it('draws a filled+stroked diamond (poly) per lootMarker, labeled with its tableId', () => {
    const map = blankArenaMap();
    map.rooms[0]!.lootMarkers = [{ point: { x: 4, y: 4 }, tableId: 'rare_table' }];
    const { canvas } = makePvpCanvas(map);
    const fills = drawnFills(priv(canvas).shapes);
    expect(fills[fills.length - 1]).toMatchObject({ color: COLORS.lootMarker });
    expect(labelTexts(priv(canvas).labels)).toContain('rare_table');
  });

  it('a pvp target always draws zero player spawns, even if the tool tried to add one', () => {
    const { canvas, target } = makePvpCanvas();
    expect(target.getPlayerSpawns()).toEqual([]);
    canvas.setTool('playerSpawn');
    priv(canvas).onPointerDown(1 * GRID_PX, 1 * GRID_PX);
    expect(target.getPlayerSpawns()).toEqual([]); // tool no-ops for a pvp target
  });
});

describe('RoomCanvas — hitTest / "select" tool priority ordering', () => {
  it('checks point layers before rect layers: a prop wins over a cellTrait at the same point', () => {
    const map = blankArenaMap();
    map.rooms[0]!.props = [{ id: 'prop_1', x: 5, y: 5 }];
    map.rooms[0]!.cellTraits = [{ id: 't1', rectGrid: { x: 3, y: 3, w: 4, h: 4 }, kind: 'spike', timed: false }]; // covers (5,5) too
    const { canvas } = makePvpCanvas(map);
    canvas.setTool('select');
    priv(canvas).onPointerDown(5 * GRID_PX, 5 * GRID_PX);
    expect(canvas.getSelection()).toEqual({ layer: 'props', index: 0 });
  });

  it('within point layers, checks playerSpawns before props at the same point (pve target)', () => {
    const piece = blankPiece();
    piece.spawns.player.push({ x: 5, y: 5 });
    piece.props = [{ id: 'prop_1', x: 5, y: 5 }];
    const { canvas } = makePveCanvas(piece);
    canvas.setTool('select');
    priv(canvas).onPointerDown(5 * GRID_PX, 5 * GRID_PX);
    expect(canvas.getSelection()).toEqual({ layer: 'playerSpawns', index: 0 });
  });

  it('within rect layers, checks cellTraits before solids at the same point', () => {
    const map = blankArenaMap();
    map.rooms[0]!.solids = [{ x: 0, y: 0, w: 10, h: 10 }];
    map.rooms[0]!.cellTraits = [{ id: 't1', rectGrid: { x: 0, y: 0, w: 10, h: 10 }, kind: 'spike', timed: false }];
    const { canvas } = makePvpCanvas(map);
    canvas.setTool('select');
    priv(canvas).onPointerDown(5 * GRID_PX, 5 * GRID_PX);
    expect(canvas.getSelection()).toEqual({ layer: 'cellTraits', index: 0 });
  });

  it('clicking truly empty space selects nothing', () => {
    const { canvas } = makePveCanvas();
    canvas.setTool('select');
    priv(canvas).onPointerDown(15 * GRID_PX, 15 * GRID_PX);
    expect(canvas.getSelection()).toBeNull();
  });
});

describe('RoomCanvas — onPointerDown/onPointerMove ("select" tool: move + resize)', () => {
  it('clicking a solid selects it and starts a move drag; moving updates its x/y in place', () => {
    const piece = blankPiece();
    piece.solids.push({ x: 0, y: 0, w: 4, h: 4 });
    const { canvas, target } = makePveCanvas(piece);
    canvas.setTool('select');
    priv(canvas).onPointerDown(2 * GRID_PX, 2 * GRID_PX); // grabs it at its own local (2,2)
    expect(canvas.getSelection()).toEqual({ layer: 'solids', index: 0 });
    priv(canvas).onPointerMove(10 * GRID_PX, 10 * GRID_PX); // pointer now at grid (10,10)
    expect(target.getSolids()[0]).toMatchObject({ x: 8, y: 8 }); // 10 - (grab offset 2)
  });

  it('moving a pillar updates its .center, not top-level x/y', () => {
    const piece = blankPiece();
    piece.pillars = [{ center: { x: 5, y: 5 }, radius: 1 }];
    const { canvas, target } = makePveCanvas(piece);
    canvas.setTool('select');
    priv(canvas).onPointerDown(5 * GRID_PX, 5 * GRID_PX);
    priv(canvas).onPointerMove(8 * GRID_PX, 8 * GRID_PX);
    expect(target.getPillars()[0]!.center).toEqual({ x: 8, y: 8 });
  });

  it('moving a lootMarker updates its .point, not top-level x/y', () => {
    const map = blankArenaMap();
    map.rooms[0]!.lootMarkers = [{ point: { x: 5, y: 5 }, tableId: 'default' }];
    const { canvas, target } = makePvpCanvas(map);
    canvas.setTool('select');
    priv(canvas).onPointerDown(5 * GRID_PX, 5 * GRID_PX);
    priv(canvas).onPointerMove(9 * GRID_PX, 9 * GRID_PX);
    expect(target.getLootMarkers()[0]!.point).toEqual({ x: 9, y: 9 });
  });

  it('moving a cellTrait updates its .rectGrid origin, not top-level x/y', () => {
    const map = blankArenaMap();
    map.rooms[0]!.cellTraits = [{ id: 't1', rectGrid: { x: 2, y: 2, w: 3, h: 3 }, kind: 'spike', timed: false }];
    const { canvas, target } = makePvpCanvas(map);
    canvas.setTool('select');
    priv(canvas).onPointerDown(3 * GRID_PX, 3 * GRID_PX); // inside the rect, not on a corner
    priv(canvas).onPointerMove(6 * GRID_PX, 6 * GRID_PX);
    expect(target.getCellTraits()[0]!.rectGrid).toMatchObject({ x: 5, y: 5 });
  });

  it('grabbing a corner of the already-selected solid starts a resize that keeps the opposite corner fixed', () => {
    const piece = blankPiece();
    piece.solids.push({ x: 0, y: 0, w: 4, h: 4 });
    const { canvas, target } = makePveCanvas(piece);
    canvas.setTool('select');
    priv(canvas).onPointerDown(2 * GRID_PX, 2 * GRID_PX); // select it (center, not a corner)
    priv(canvas).onPointerUp();
    priv(canvas).onPointerDown(4 * GRID_PX, 4 * GRID_PX); // grab the 'se' corner exactly
    priv(canvas).onPointerMove(8 * GRID_PX, 8 * GRID_PX);
    expect(target.getSolids()[0]).toEqual({ x: 0, y: 0, w: 8, h: 8 }); // nw corner (0,0) stayed fixed
  });

  it('resizing a cellTrait resizes its .rectGrid (not a solid-only feature)', () => {
    const map = blankArenaMap();
    map.rooms[0]!.cellTraits = [{ id: 't1', rectGrid: { x: 0, y: 0, w: 4, h: 4 }, kind: 'spike', timed: false }];
    const { canvas, target } = makePvpCanvas(map);
    canvas.setTool('select');
    priv(canvas).onPointerDown(2 * GRID_PX, 2 * GRID_PX);
    priv(canvas).onPointerUp();
    priv(canvas).onPointerDown(4 * GRID_PX, 4 * GRID_PX); // 'se' corner
    priv(canvas).onPointerMove(9 * GRID_PX, 9 * GRID_PX);
    expect(target.getCellTraits()[0]!.rectGrid).toEqual({ x: 0, y: 0, w: 9, h: 9 });
  });

  it('resizing does NOT reject overlap with another shape — RoomCanvas has no overlap rule, unlike ArenaCanvas rooms', () => {
    const piece = blankPiece();
    piece.solids.push({ x: 0, y: 0, w: 4, h: 4 }, { x: 5, y: 5, w: 2, h: 2 });
    const { canvas, target } = makePveCanvas(piece);
    canvas.setTool('select');
    priv(canvas).onPointerDown(2 * GRID_PX, 2 * GRID_PX);
    priv(canvas).onPointerUp();
    priv(canvas).onPointerDown(4 * GRID_PX, 4 * GRID_PX); // 'se' corner
    priv(canvas).onPointerMove(20 * GRID_PX, 20 * GRID_PX); // grows to fully cover solid[1] too
    expect(target.getSolids()[0]).toEqual({ x: 0, y: 0, w: 20, h: 20 }); // allowed, no revert
  });
});

describe('RoomCanvas — onPointerDown ("solid"/"cellTrait" draw-rect tools)', () => {
  it('drags out and commits a new solid as a plain AabbGrid, selecting it', () => {
    const { canvas, target } = makePveCanvas();
    canvas.setTool('solid');
    priv(canvas).onPointerDown(2 * GRID_PX, 2 * GRID_PX);
    priv(canvas).onPointerMove(6 * GRID_PX, 5 * GRID_PX);
    priv(canvas).onPointerUp();
    expect(target.getSolids()).toEqual([{ x: 2, y: 2, w: 4, h: 3 }]);
    expect(canvas.getSelection()).toEqual({ layer: 'solids', index: 0 });
  });

  it('drags out and commits a new cellTrait as a wrapped {id, rectGrid, kind, timed} object (pvp only)', () => {
    const { canvas, target } = makePvpCanvas();
    canvas.setTool('cellTrait');
    priv(canvas).onPointerDown(1 * GRID_PX, 1 * GRID_PX);
    priv(canvas).onPointerMove(3 * GRID_PX, 4 * GRID_PX);
    priv(canvas).onPointerUp();
    expect(target.getCellTraits()).toEqual([{ id: expect.stringMatching(/^trait_\d+$/), rectGrid: { x: 1, y: 1, w: 2, h: 3 }, kind: 'spike', timed: false }]);
    expect(canvas.getSelection()).toEqual({ layer: 'cellTraits', index: 0 });
  });
});

describe('RoomCanvas — onPointerDown ("pillar" tool)', () => {
  it('places a radius-1 pillar immediately on click, then grows/shrinks its radius on drag', () => {
    const { canvas, target } = makePveCanvas();
    canvas.setTool('pillar');
    priv(canvas).onPointerDown(5 * GRID_PX, 5 * GRID_PX);
    expect(target.getPillars()).toEqual([{ center: { x: 5, y: 5 }, radius: 1 }]);
    expect(canvas.getSelection()).toEqual({ layer: 'pillars', index: 0 });
    priv(canvas).onPointerMove(8 * GRID_PX, 5 * GRID_PX); // 3 grid units east of center
    expect(target.getPillars()[0]!.radius).toBe(3);
  });
});

describe('RoomCanvas — onPointerDown ("prop"/"enemySpawn" tools, both targets)', () => {
  it('places a prop with a freshly-generated id and selects it', () => {
    const { canvas, target } = makePveCanvas();
    canvas.setTool('prop');
    priv(canvas).onPointerDown(4 * GRID_PX, 4 * GRID_PX);
    expect(target.getProps()).toEqual([{ id: expect.stringMatching(/^prop_\d+$/), x: 4, y: 4 }]);
    expect(canvas.getSelection()).toEqual({ layer: 'props', index: 0 });
  });

  it('places an enemy spawn for a pve target', () => {
    const { canvas, target } = makePveCanvas();
    canvas.setTool('enemySpawn');
    priv(canvas).onPointerDown(3 * GRID_PX, 3 * GRID_PX);
    expect(target.getEnemySpawns()).toEqual([{ x: 3, y: 3 }]);
  });

  it('places an enemy spawn for a pvp target too — enemySpawn is not kind-restricted', () => {
    const { canvas, target } = makePvpCanvas();
    canvas.setTool('enemySpawn');
    priv(canvas).onPointerDown(3 * GRID_PX, 3 * GRID_PX);
    expect(target.getEnemySpawns()).toEqual([{ x: 3, y: 3 }]);
  });
});

describe('RoomCanvas — onPointerDown ("playerSpawn"/"lootMarker" tools, kind-restricted)', () => {
  it('playerSpawn works for a pve target', () => {
    const { canvas, target } = makePveCanvas();
    canvas.setTool('playerSpawn');
    priv(canvas).onPointerDown(2 * GRID_PX, 2 * GRID_PX);
    expect(target.getPlayerSpawns()).toEqual([{ x: 2, y: 2 }]);
  });

  it('lootMarker no-ops for a pve target (kind !== "pvp")', () => {
    const { canvas, target } = makePveCanvas();
    canvas.setTool('lootMarker');
    priv(canvas).onPointerDown(2 * GRID_PX, 2 * GRID_PX);
    expect(target.getLootMarkers()).toEqual([]);
  });

  it('lootMarker works for a pvp target, defaulting tableId to "default"', () => {
    const { canvas, target } = makePvpCanvas();
    canvas.setTool('lootMarker');
    priv(canvas).onPointerDown(6 * GRID_PX, 6 * GRID_PX);
    expect(target.getLootMarkers()).toEqual([{ point: { x: 6, y: 6 }, tableId: 'default' }]);
  });
});
