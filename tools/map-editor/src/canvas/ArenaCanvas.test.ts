/**
 * `ArenaCanvas` had zero dedicated tests despite being the PvP map-scale editor
 * (design/15) — room draw/move/resize (overlap-rejecting), a two-click door-connect
 * state machine, EyeCandidate toggling, and double-click drill-down into a room's
 * detail view. Its `mount()` touches real DOM/`Application.init()`, unavailable in
 * plain vitest — but exactly like `DungeonFloorCanvas` (see that file's test header
 * for the full argument), the CONSTRUCTOR never touches `host`/`document`/`window`:
 * every field (`app`, `camera`, `world`, `shapes`, `labels`, `preview`) is a plain
 * Pixi object, constructible with zero renderer/canvas. `camera.addChild(world)` and
 * `world.position.set(PAD_PX, PAD_PX)` only happen inside `mount()`, so skipping
 * `mount()` entirely leaves `world` unparented with an identity transform — its
 * `toLocal()` is then a pure passthrough, so `toGrid(px, py)` reduces to the clean
 * `(px/GRID_PX, py/GRID_PX)`. Every pixel coordinate below is `gridCoord * 6`
 * (GRID_PX, an unexported module constant, matching the comment in the source).
 *
 * `shapes`/`labels`/`preview` are private fields, and `roomAt`/`cornerNear`/
 * `otherRooms`/`tryConnectDoor`/`toggleEyeCandidate`/`onPointerDown`/`onPointerMove`/
 * `onPointerUp` are private methods — both read via bracket-notation access, same
 * convention as `DungeonFloorCanvas.test.ts`/`Minimap.test.ts`. `context.instructions`
 * is read directly for draw-call assertions, same technique.
 *
 * NOT covered (same accepted exemption `DungeonFloorCanvas.test.ts` documents):
 * `onKeyDown`'s Delete/Backspace path (needs `document`/`HTMLInputElement`/a real
 * `window` keydown listener); `onWheel`/`onContextMenu`/pan (`button === 2`) — pure
 * DOM event wiring with no grid-space logic of its own; and `fitView`/`zoomAt`'s
 * exact camera scale/position math — cosmetic view-fitting, not authoring
 * correctness. `fitView()` is still exercised incidentally (via `setDocument`) since
 * skipping it isn't possible without also skipping `setDocument`, but its output is
 * never asserted on.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { Graphics, Container, Text } from 'pixi.js';
import type { ArenaMap, ArenaRoom } from '@dd/engine/content/arenas';
import { COLORS } from '../colors';
import { ArenaCanvas } from './ArenaCanvas';
import { ArenaDocument } from '../state/ArenaDocument';

const GRID_PX = 6; // matches the module's own unexported constant

const fakeHost = { clientWidth: 800, clientHeight: 600 } as unknown as HTMLElement;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function priv(c: ArenaCanvas): any {
  return c;
}

function room(id: string, x: number, y: number, w: number, h: number): ArenaRoom {
  return { id, rectGrid: { x, y, w, h }, solids: [] };
}

function makeCanvas(map: ArenaMap): { canvas: ArenaCanvas; doc: ArenaDocument } {
  const canvas = new ArenaCanvas(fakeHost);
  const doc = new ArenaDocument(map);
  canvas.setDocument(doc);
  return { canvas, doc };
}

function blankMap(rooms: ArenaRoom[] = []): ArenaMap {
  return { id: 'm', sizeGrid: { w: 200, h: 200 }, rooms, doors: [], spawns: [], eyeCandidates: [] };
}

interface DrawnInstruction { color: number; alpha: number; width: number; shape: unknown }
type RawInstruction = {
  action: 'fill' | 'stroke';
  data: { style?: { color: number; alpha: number; width?: number }; path?: { shapePath: { shapePrimitives: { shape: unknown }[] } } };
};

/** Same `context.instructions` read as `DungeonFloorCanvas.test.ts`/`Minimap.test.ts`
 * (Pixi v8's `Graphics` has no public "what did this draw" API). Most shapes here
 * are `.rect(...).fill(...).stroke(...)` (two raw instructions), but doors/spawns are
 * fill-only and the pending-door highlight is stroke-only — `drawnFills`/
 * `drawnStrokes` split by `action` so each test only sees the ones it cares about. */
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
function drawnStrokes(g: Graphics): DrawnInstruction[] {
  return rawInstructions(g).filter((i) => i.action === 'stroke').map(toDrawn);
}

function labelTexts(labels: Container): string[] {
  return labels.children.map((t) => (t as Text).text);
}

describe('ArenaCanvas — redraw (design/15 PvP map editor)', () => {
  it('draws a ground rect for the map bounds, then one rect per room', () => {
    const { canvas } = makeCanvas(blankMap([room('a', 0, 0, 10, 10), room('b', 20, 0, 10, 10)]));
    const fills = drawnFills(priv(canvas).shapes);
    expect(fills).toHaveLength(3); // ground + 2 rooms
    expect(fills[0]!.color).toBe(COLORS.ground);
    expect(fills[1]!.color).toBe(COLORS.roomBounds);
    expect(fills[1]!.alpha).toBe(0.6);
    expect(fills[2]!.color).toBe(COLORS.roomBounds);
  });

  it('labels each room with its bare id (no entrance/capstone concept here, unlike a PvE floor)', () => {
    const { canvas } = makeCanvas(blankMap([room('a', 0, 0, 10, 10), room('b', 20, 0, 10, 10)]));
    expect(labelTexts(priv(canvas).labels)).toEqual(['a', 'b']);
  });

  it('tints an EyeCandidate room distinctly (color + alpha) from a normal room', () => {
    const map = blankMap([room('a', 0, 0, 10, 10), room('b', 20, 0, 10, 10)]);
    map.eyeCandidates.push({ roomId: 'b' });
    const { canvas } = makeCanvas(map);
    const fills = drawnFills(priv(canvas).shapes);
    expect(fills[1]).toMatchObject({ color: COLORS.roomBounds, alpha: 0.6 }); // 'a', not an eye candidate
    expect(fills[2]).toMatchObject({ color: COLORS.eyeCandidate, alpha: 0.35 }); // 'b', is
  });

  it('draws one filled rect per door, after every room rect, fill-only (no stroke)', () => {
    const map = blankMap([room('a', 0, 0, 10, 10), room('b', 10, 0, 10, 10)]);
    map.doors.push({ roomA: 'a', roomB: 'b', passageGrid: { x: 9, y: 0, w: 2, h: 10 } });
    const { canvas } = makeCanvas(map);
    const fills = drawnFills(priv(canvas).shapes);
    expect(fills).toHaveLength(4); // ground + 2 rooms + 1 door
    expect(fills[3]!.color).toBe(COLORS.door);
  });

  it('draws a small filled circle for every map-level spawn', () => {
    const map = blankMap([]);
    map.spawns.push({ x: 5, y: 5 });
    const { canvas } = makeCanvas(map);
    const fills = drawnFills(priv(canvas).shapes);
    expect(fills).toHaveLength(2); // ground + 1 spawn
    expect(fills[1]!.color).toBe(COLORS.player);
    expect(fills[1]!.shape).toMatchObject({ radius: 4 });
  });

  it('gives the selected room a thicker, selection-colored stroke than an unselected one', () => {
    const { canvas } = makeCanvas(blankMap([room('a', 0, 0, 10, 10), room('b', 20, 0, 10, 10)]));
    const before = drawnStrokes(priv(canvas).shapes);
    // before[0] is the ground-rect stroke (gridLine); rooms follow.
    expect(before.slice(1).every((s) => s.color === COLORS.wallEdge && s.width === 1.5)).toBe(true);

    canvas.setSelection({ kind: 'room', id: 'b' });
    const after = drawnStrokes(priv(canvas).shapes);
    expect(after[1]).toMatchObject({ color: COLORS.wallEdge, width: 1.5 }); // room 'a', still unselected
    expect(after[2]).toMatchObject({ color: COLORS.selection, width: 3 }); // room 'b', selected
  });

  it('highlights the pending first-click room of a door connection with a thick door-colored stroke-only outline', () => {
    const { canvas } = makeCanvas(blankMap([room('a', 0, 0, 10, 10), room('b', 20, 0, 10, 10)]));
    canvas.setTool('door');
    priv(canvas).onPointerDown(5 * GRID_PX, 5 * GRID_PX, 0); // first click on 'a' — sets pendingDoorRoomId
    const strokes = drawnStrokes(priv(canvas).shapes);
    const last = strokes[strokes.length - 1]!;
    expect(last).toMatchObject({ color: COLORS.door, width: 3 });
  });

  it('clears and redraws on every setDocument — a second, smaller map leaves no stale fills behind', () => {
    const canvas = new ArenaCanvas(fakeHost);
    canvas.setDocument(new ArenaDocument(blankMap([room('a', 0, 0, 10, 10), room('b', 20, 0, 10, 10)])));
    expect(drawnFills(priv(canvas).shapes)).toHaveLength(3);
    canvas.setDocument(new ArenaDocument(blankMap([room('a', 0, 0, 10, 10)])));
    expect(drawnFills(priv(canvas).shapes)).toHaveLength(2);
  });

  it('a mutation on the document (via .mutate) triggers a live redraw through the on() subscription', () => {
    const { canvas, doc } = makeCanvas(blankMap([room('a', 0, 0, 10, 10)]));
    expect(drawnFills(priv(canvas).shapes)).toHaveLength(2);
    doc.mutate((map) => map.rooms.push(room('b', 20, 0, 10, 10)));
    expect(drawnFills(priv(canvas).shapes)).toHaveLength(3);
  });
});

describe('ArenaCanvas — pure geometry/lookup helpers', () => {
  it('roomAt hit-tests the topmost (last-placed) room at a grid point, inclusive of its boundary, null off any room', () => {
    const { canvas } = makeCanvas(blankMap([room('a', 0, 0, 10, 10), room('b', 5, 5, 10, 10)])); // overlapping
    expect(priv(canvas).roomAt(7, 7)?.id).toBe('b'); // both cover (7,7); 'b' is last-placed
    expect(priv(canvas).roomAt(0, 0)?.id).toBe('a'); // only 'a' covers this corner
    expect(priv(canvas).roomAt(10, 10)?.id).toBe('b'); // boundary point of both — inclusive test, last wins
    expect(priv(canvas).roomAt(100, 100)).toBeNull();
  });

  it('cornerNear finds the nearest of a rect\'s 4 corners within radius, else null', () => {
    const { canvas } = makeCanvas(blankMap());
    const rect = { x: 0, y: 0, w: 10, h: 10 };
    expect(priv(canvas).cornerNear(0, 0, rect)).toBe('nw');
    expect(priv(canvas).cornerNear(10, 0, rect)).toBe('ne');
    expect(priv(canvas).cornerNear(0, 10, rect)).toBe('sw');
    expect(priv(canvas).cornerNear(10, 10, rect)).toBe('se');
    expect(priv(canvas).cornerNear(10.5, 10.5, rect)).toBe('se'); // within the 1.2 radius
    expect(priv(canvas).cornerNear(5, 5, rect)).toBeNull(); // center, far from every corner
  });

  it('otherRooms excludes the named room and includes every other room verbatim', () => {
    const b = room('b', 20, 0, 10, 10);
    const { canvas } = makeCanvas(blankMap([room('a', 0, 0, 10, 10), b]));
    expect(priv(canvas).otherRooms('a')).toEqual([b]);
  });
});

describe('ArenaCanvas — tryConnectDoor', () => {
  beforeEach(() => vi.stubGlobal('alert', vi.fn()));
  afterEach(() => vi.unstubAllGlobals());

  it('connects two rooms sharing a vertical (east/west) boundary with a passage centered on their Y-overlap', () => {
    const { canvas, doc } = makeCanvas(blankMap([room('a', 0, 0, 10, 10), room('b', 10, 0, 10, 10)]));
    priv(canvas).tryConnectDoor('a', 'b');
    expect(doc.map.doors).toEqual([{ roomA: 'a', roomB: 'b', passageGrid: { x: 9, y: 0, w: 2, h: 10 } }]);
  });

  it('connects two rooms sharing a horizontal (north/south) boundary', () => {
    const { canvas, doc } = makeCanvas(blankMap([room('a', 0, 0, 10, 10), room('b', 0, 10, 10, 10)]));
    priv(canvas).tryConnectDoor('a', 'b');
    expect(doc.map.doors).toEqual([{ roomA: 'a', roomB: 'b', passageGrid: { x: 0, y: 9, w: 10, h: 2 } }]);
  });

  it('rejects (alert, no door) two rooms that share no boundary', () => {
    const { canvas, doc } = makeCanvas(blankMap([room('a', 0, 0, 10, 10), room('b', 50, 50, 10, 10)]));
    priv(canvas).tryConnectDoor('a', 'b');
    expect(doc.map.doors).toHaveLength(0);
    expect(alert).toHaveBeenCalledWith(expect.stringContaining("don't share a boundary"));
  });

  it('silently no-ops (no alert) when either room id doesn\'t resolve — unlike DungeonFloorCanvas, an ArenaRoom is full geometry, not a library reference, so there is no "unresolvable piece" alert here', () => {
    const { canvas, doc } = makeCanvas(blankMap([room('a', 0, 0, 10, 10)]));
    priv(canvas).tryConnectDoor('a', 'ghost');
    expect(doc.map.doors).toHaveLength(0);
    expect(alert).not.toHaveBeenCalled();
  });

  it('silently no-ops connecting a room to itself (no alert, no self-door)', () => {
    const { canvas, doc } = makeCanvas(blankMap([room('a', 0, 0, 10, 10)]));
    priv(canvas).tryConnectDoor('a', 'a');
    expect(doc.map.doors).toHaveLength(0);
    expect(alert).not.toHaveBeenCalled();
  });
});

describe('ArenaCanvas — toggleEyeCandidate ("eye" tool)', () => {
  it('toggles a room in and out of eyeCandidates on repeated clicks', () => {
    const { canvas, doc } = makeCanvas(blankMap([room('a', 0, 0, 10, 10)]));
    canvas.setTool('eye');
    priv(canvas).onPointerDown(5 * GRID_PX, 5 * GRID_PX, 0);
    expect(doc.map.eyeCandidates).toEqual([{ roomId: 'a', weight: 1 }]);
    priv(canvas).onPointerDown(5 * GRID_PX, 5 * GRID_PX, 0);
    expect(doc.map.eyeCandidates).toHaveLength(0);
  });

  it('clicking empty space with the eye tool does nothing', () => {
    const { canvas, doc } = makeCanvas(blankMap([room('a', 0, 0, 10, 10)]));
    canvas.setTool('eye');
    priv(canvas).onPointerDown(50 * GRID_PX, 50 * GRID_PX, 0);
    expect(doc.map.eyeCandidates).toHaveLength(0);
  });
});

describe('ArenaCanvas — onPointerDown/onPointerMove/onPointerUp ("room" tool draw)', () => {
  it('draws and commits a new room on a clean drag, selecting it', () => {
    const { canvas, doc } = makeCanvas(blankMap());
    canvas.setTool('room');
    priv(canvas).onPointerDown(0, 0, 0); // grid (0,0)
    priv(canvas).onPointerMove(10 * GRID_PX, 10 * GRID_PX); // grid (10,10)
    priv(canvas).onPointerUp();
    expect(doc.map.rooms).toHaveLength(1);
    expect(doc.map.rooms[0]).toMatchObject({ id: 'room_1', rectGrid: { x: 0, y: 0, w: 10, h: 10 }, solids: [] });
    expect(canvas.getSelection()).toEqual({ kind: 'room', id: 'room_1' });
  });

  it('previews overlap in COLORS.overlapError while dragging over an existing room', () => {
    const { canvas } = makeCanvas(blankMap([room('a', 0, 0, 10, 10)]));
    canvas.setTool('room');
    priv(canvas).onPointerDown(5 * GRID_PX, 5 * GRID_PX, 0);
    priv(canvas).onPointerMove(15 * GRID_PX, 15 * GRID_PX); // (5,5)-(15,15) overlaps 'a'
    const fills = drawnFills(priv(canvas).preview);
    expect(fills[0]).toMatchObject({ color: COLORS.overlapError, alpha: 0.25 });
  });

  it('previews COLORS.selection (no overlap) while dragging in open space', () => {
    const { canvas } = makeCanvas(blankMap([room('a', 0, 0, 10, 10)]));
    canvas.setTool('room');
    priv(canvas).onPointerDown(30 * GRID_PX, 30 * GRID_PX, 0);
    priv(canvas).onPointerMove(40 * GRID_PX, 40 * GRID_PX);
    const fills = drawnFills(priv(canvas).preview);
    expect(fills[0]).toMatchObject({ color: COLORS.selection, alpha: 0.25 });
  });

  it('silently rejects (no alert, no room added) a completed drag that overlaps an existing room', () => {
    vi.stubGlobal('alert', vi.fn());
    const { canvas, doc } = makeCanvas(blankMap([room('a', 0, 0, 10, 10)]));
    canvas.setTool('room');
    priv(canvas).onPointerDown(5 * GRID_PX, 5 * GRID_PX, 0);
    priv(canvas).onPointerMove(15 * GRID_PX, 15 * GRID_PX);
    priv(canvas).onPointerUp();
    expect(doc.map.rooms).toHaveLength(1); // unchanged
    expect(alert).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });
});

describe('ArenaCanvas — onPointerDown/onPointerMove/onPointerUp ("select" tool: move + resize)', () => {
  it('clicking a room selects it and starts a move drag; moving updates its rectGrid offset', () => {
    const { canvas, doc } = makeCanvas(blankMap([room('a', 0, 0, 10, 10), room('b', 30, 0, 10, 10)]));
    canvas.setTool('select');
    priv(canvas).onPointerDown(5 * GRID_PX, 5 * GRID_PX, 0); // grabs 'a' at its own local (5,5)
    expect(canvas.getSelection()).toEqual({ kind: 'room', id: 'a' });

    priv(canvas).onPointerMove(12 * GRID_PX, 12 * GRID_PX); // pointer now at grid (12,12)
    expect(doc.map.rooms[0]!.rectGrid).toMatchObject({ x: 7, y: 7 }); // 12 - (grab offset 5)

    priv(canvas).onPointerUp();
    expect(doc.map.rooms[0]!.rectGrid).toMatchObject({ x: 7, y: 7 }); // committed, unchanged by pointerUp itself
  });

  it('reverts a move drag to the last valid position when the candidate would overlap another room', () => {
    const { canvas, doc } = makeCanvas(blankMap([room('a', 0, 0, 10, 10), room('b', 30, 0, 10, 10)]));
    canvas.setTool('select');
    priv(canvas).onPointerDown(5 * GRID_PX, 5 * GRID_PX, 0);
    priv(canvas).onPointerMove(12 * GRID_PX, 12 * GRID_PX); // valid: (7,7)-(17,17)
    expect(doc.map.rooms[0]!.rectGrid).toMatchObject({ x: 7, y: 7 });

    priv(canvas).onPointerMove(30 * GRID_PX, 5 * GRID_PX); // candidate (25,0)-(35,10) overlaps 'b'
    expect(doc.map.rooms[0]!.rectGrid).toMatchObject({ x: 7, y: 7 }); // reverted, not jumped
  });

  it('grabbing a corner of the already-selected room starts a resize that keeps the opposite corner fixed', () => {
    const { canvas, doc } = makeCanvas(blankMap([room('a', 0, 0, 10, 10), room('b', 50, 50, 5, 5)]));
    canvas.setTool('select');
    priv(canvas).onPointerDown(5 * GRID_PX, 5 * GRID_PX, 0); // select 'a'
    priv(canvas).onPointerUp(); // commit the move (no actual move)
    priv(canvas).onPointerDown(10 * GRID_PX, 10 * GRID_PX, 0); // grab the 'se' corner (exactly on it)
    priv(canvas).onPointerMove(15 * GRID_PX, 15 * GRID_PX); // drag se corner out to grid (15,15)
    expect(doc.map.rooms[0]!.rectGrid).toEqual({ x: 0, y: 0, w: 15, h: 15 }); // nw corner (0,0) stayed fixed
  });

  it('reverts a resize to the last valid rect when the candidate would overlap another room', () => {
    const { canvas, doc } = makeCanvas(blankMap([room('a', 0, 0, 10, 10), room('b', 12, 0, 5, 5)]));
    canvas.setTool('select');
    priv(canvas).onPointerDown(5 * GRID_PX, 5 * GRID_PX, 0);
    priv(canvas).onPointerUp();
    priv(canvas).onPointerDown(10 * GRID_PX, 10 * GRID_PX, 0); // grab 'se' corner
    priv(canvas).onPointerMove(15 * GRID_PX, 15 * GRID_PX); // candidate (0,0)-(15,15) overlaps 'b' (12,0)-(17,5)
    expect(doc.map.rooms[0]!.rectGrid).toEqual({ x: 0, y: 0, w: 10, h: 10 }); // reverted
  });

  it('clicking truly empty space clears the selection', () => {
    const { canvas } = makeCanvas(blankMap([room('a', 0, 0, 10, 10)]));
    canvas.setTool('select');
    priv(canvas).onPointerDown(5 * GRID_PX, 5 * GRID_PX, 0);
    expect(canvas.getSelection()).toEqual({ kind: 'room', id: 'a' });
    priv(canvas).onPointerDown(100 * GRID_PX, 100 * GRID_PX, 0);
    expect(canvas.getSelection()).toBeNull();
  });

  it('double-clicking the same room within DBLCLICK_MS fires the drill-down callback instead of re-selecting', () => {
    const { canvas } = makeCanvas(blankMap([room('a', 0, 0, 10, 10)]));
    canvas.setTool('select');
    const drillDown = vi.fn();
    canvas.onDrillDown(drillDown);
    const nowSpy = vi.spyOn(Date, 'now');
    nowSpy.mockReturnValue(1000);
    priv(canvas).onPointerDown(2 * GRID_PX, 2 * GRID_PX, 0); // first click, off any corner
    nowSpy.mockReturnValue(1100); // 100ms later, well under DBLCLICK_MS (350)
    priv(canvas).onPointerDown(2 * GRID_PX, 2 * GRID_PX, 0);
    expect(drillDown).toHaveBeenCalledWith('a');
    nowSpy.mockRestore();
  });

  it('clicking the same room again after DBLCLICK_MS has elapsed does NOT drill down', () => {
    const { canvas } = makeCanvas(blankMap([room('a', 0, 0, 10, 10)]));
    canvas.setTool('select');
    const drillDown = vi.fn();
    canvas.onDrillDown(drillDown);
    const nowSpy = vi.spyOn(Date, 'now');
    nowSpy.mockReturnValue(1000);
    priv(canvas).onPointerDown(2 * GRID_PX, 2 * GRID_PX, 0);
    nowSpy.mockReturnValue(2000); // 1000ms later, over DBLCLICK_MS
    priv(canvas).onPointerDown(2 * GRID_PX, 2 * GRID_PX, 0);
    expect(drillDown).not.toHaveBeenCalled();
    nowSpy.mockRestore();
  });
});

describe('ArenaCanvas — onPointerDown ("door" tool two-click state machine)', () => {
  it('connects two DIFFERENT rooms across two clicks and clears pendingDoorRoomId afterward', () => {
    const { canvas, doc } = makeCanvas(blankMap([room('a', 0, 0, 10, 10), room('b', 10, 0, 10, 10)]));
    canvas.setTool('door');
    priv(canvas).onPointerDown(5 * GRID_PX, 5 * GRID_PX, 0); // first click: room a
    expect(doc.map.doors).toHaveLength(0);
    priv(canvas).onPointerDown(15 * GRID_PX, 5 * GRID_PX, 0); // second click: room b
    expect(doc.map.doors).toHaveLength(1);
    expect(doc.map.doors[0]).toMatchObject({ roomA: 'a', roomB: 'b' });
    expect(priv(canvas).pendingDoorRoomId).toBeNull();
  });

  it('clicking the SAME room twice never creates a self-connecting door', () => {
    const { canvas, doc } = makeCanvas(blankMap([room('a', 0, 0, 10, 10)]));
    canvas.setTool('door');
    priv(canvas).onPointerDown(5 * GRID_PX, 5 * GRID_PX, 0);
    priv(canvas).onPointerDown(5 * GRID_PX, 5 * GRID_PX, 0);
    expect(doc.map.doors).toHaveLength(0);
  });

  it('clicking empty space on the first click leaves pendingDoorRoomId unset', () => {
    const { canvas } = makeCanvas(blankMap([room('a', 0, 0, 10, 10)]));
    canvas.setTool('door');
    priv(canvas).onPointerDown(100 * GRID_PX, 100 * GRID_PX, 0); // off any room
    expect(priv(canvas).pendingDoorRoomId).toBeNull();
  });
});

describe('ArenaCanvas — onPointerDown ("spawn" tool)', () => {
  it('places a map-level spawn at the clicked grid position and selects it', () => {
    const { canvas, doc } = makeCanvas(blankMap());
    canvas.setTool('spawn');
    priv(canvas).onPointerDown(7 * GRID_PX, 8 * GRID_PX, 0);
    expect(doc.map.spawns).toEqual([{ x: 7, y: 8 }]);
    expect(canvas.getSelection()).toEqual({ kind: 'spawn', index: 0 });
  });
});
