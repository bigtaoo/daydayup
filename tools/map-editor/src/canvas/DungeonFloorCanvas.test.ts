/**
 * `DungeonFloorCanvas` had zero dedicated tests when first shipped — "add tests
 * for everything mechanically testable" (daydayup memory) — despite being the
 * single most complex new file in the "Hand-authored PvE floors" pass (design/05,
 * 2026-08-05): overlap-rejecting placement, a two-click door-connect state
 * machine, drag-move-with-revert, and dangling-piece-reference rendering.
 *
 * `ArenaCanvas`/`RoomCanvas` have no test files at all (their `mount()` touches
 * real DOM/`Application.init()`, unavailable in plain vitest) — but this class's
 * CONSTRUCTOR never touches `host`, `document`, or `window`; every field it sets
 * (`app`, `camera`, `world`, `shapes`, `labels`, `preview`) is a plain Pixi
 * object, constructible with zero renderer/canvas. Confirmed empirically before
 * writing this file: an unparented `Container`'s `toLocal()` still applies its
 * own `position` correctly with no render pass ever run — so `mount()` (which
 * only sets `world.position`/wires DOM events/starts the renderer) can be
 * skipped entirely for everything except pixel-accurate on-screen coordinates.
 * Skipping it means `world.position` stays its default (0,0), so `toGrid(px,py)`
 * reduces to the clean, predictable `(px/GRID_PX, py/GRID_PX)` — every pixel
 * coordinate below is chosen as `gridCoord * 6` (GRID_PX, an unexported module
 * constant) for exactly this reason.
 *
 * `shapes`/`labels`/`preview` are private `Graphics`/`Container` fields, and
 * `roomRect`/`roomAt`/`doorAt`/`otherRoomRects`/`tryConnectDoor`/`nextRoomId`/
 * `onPointerDown`/`onPointerMove`/`onPointerUp` are private methods — both read
 * via bracket-notation access, the same "no public API, reach in" convention
 * `Minimap.test.ts`/`HudView.test.ts` already use. `context.instructions` is read
 * directly for draw-call assertions, same as `Minimap.test.ts`.
 *
 * NOT covered: `onKeyDown`'s Delete/Backspace path (needs `document`,
 * `HTMLInputElement`/`HTMLTextAreaElement`, and a real `window` keydown
 * listener — this plain-Node vitest environment has none of those, and
 * `vi.stubGlobal`-ing all three for one code path wasn't worth the fragility);
 * `onWheel`/`onContextMenu`/pan (`button === 2`) — pure DOM event wiring with no
 * grid-space logic of its own; and `fitView`/`contentBounds`'s exact camera
 * scale/position math — cosmetic view-fitting, not authoring correctness.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { Graphics, Container, Text } from 'pixi.js';
import type { RoomPiece, DungeonFloorMap } from '@dd/engine';
import { COLORS } from '../colors';
import { DungeonFloorCanvas } from './DungeonFloorCanvas';
import { DungeonFloorDocument } from '../state/DungeonFloorDocument';

const GRID_PX = 6; // matches the module's own unexported constant

const PIECE_A: RoomPiece = {
  id: 'piece_a',
  sizeGrid: { w: 10, h: 10 },
  solids: [],
  spawns: { player: [{ x: 5, y: 5 }], enemy: [] },
  exits: [],
};
const PIECE_B: RoomPiece = { ...PIECE_A, id: 'piece_b', role: 'extraction' };
const LIB: RoomPiece[] = [PIECE_A, PIECE_B];

const fakeHost = { clientWidth: 800, clientHeight: 600 } as unknown as HTMLElement;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function priv(c: DungeonFloorCanvas): any {
  return c;
}

function makeCanvas(map: DungeonFloorMap, library: readonly RoomPiece[] = LIB): { canvas: DungeonFloorCanvas; doc: DungeonFloorDocument } {
  const canvas = new DungeonFloorCanvas(fakeHost);
  const doc = new DungeonFloorDocument(map);
  canvas.setLibrary(library);
  canvas.setDocument(doc);
  return { canvas, doc };
}

interface DrawnInstruction { color: number; alpha: number; width: number; shape: unknown }
type RawInstruction = {
  action: 'fill' | 'stroke';
  data: { style?: { color: number; alpha: number; width?: number }; path?: { shapePath: { shapePrimitives: { shape: unknown }[] } } };
};

/** Same `context.instructions` read as `Minimap.test.ts` (Pixi v8's `Graphics` has
 * no public "what did this draw" API and no renderer is attached here) — EXCEPT
 * every shape in this file is drawn `.rect(...).fill(...).stroke(...)` (always
 * both, unlike `Minimap`'s fill-only rooms), so each shape contributes TWO raw
 * instructions. `drawnFills`/`drawnStrokes` split them; most assertions only
 * care about the fill. */
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

describe('DungeonFloorCanvas — redraw (design/05 "Hand-authored PvE floors", 2026-08-05)', () => {
  it('draws one rect per room, tinting the entrance and capstone distinctly from a normal middle room', () => {
    const { canvas } = makeCanvas({
      id: 'f',
      rooms: [
        { id: 'a', pieceId: 'piece_a', offsetXGrid: 0, offsetYGrid: 0 },
        { id: 'b', pieceId: 'piece_a', offsetXGrid: 10, offsetYGrid: 0 },
        { id: 'c', pieceId: 'piece_b', offsetXGrid: 20, offsetYGrid: 0 },
      ],
      doors: [],
    });
    const rects = drawnFills(priv(canvas).shapes);
    expect(rects).toHaveLength(3);
    expect(rects[0]!.color).toBe(COLORS.player); // rooms[0] — entrance
    expect(rects[1]!.color).toBe(COLORS.roomBounds); // middle — no endpoint tint
    expect(rects[2]!.color).toBe(COLORS.extractGlow); // rooms[last] — capstone
  });

  it('labels each room with its id, pieceId, and an (entrance)/(capstone) tag', () => {
    const { canvas } = makeCanvas({
      id: 'f',
      rooms: [
        { id: 'a', pieceId: 'piece_a', offsetXGrid: 0, offsetYGrid: 0 },
        { id: 'b', pieceId: 'piece_b', offsetXGrid: 10, offsetYGrid: 0 },
      ],
      doors: [],
    });
    const texts = labelTexts(priv(canvas).labels);
    expect(texts).toContain('a: piece_a (entrance)');
    expect(texts).toContain('b: piece_b (capstone)');
  });

  it('a single-room floor labels that one room BOTH entrance and capstone (same id)', () => {
    const { canvas } = makeCanvas({
      id: 'f',
      rooms: [{ id: 'only', pieceId: 'piece_b', offsetXGrid: 0, offsetYGrid: 0 }],
      doors: [],
    });
    expect(drawnFills(priv(canvas).shapes)[0]!.color).toBe(COLORS.extractGlow); // capstoneId wins the fill tie-break
    expect(labelTexts(priv(canvas).labels)).toContain('only: piece_b (capstone)');
  });

  it('renders a dangling piece reference as a visible red placeholder with a MISSING label, not a silent skip', () => {
    const { canvas } = makeCanvas({
      id: 'f',
      rooms: [{ id: 'a', pieceId: 'ghost_piece', offsetXGrid: 2, offsetYGrid: 3 }],
      doors: [],
    });
    const rects = drawnFills(priv(canvas).shapes);
    expect(rects).toHaveLength(1);
    expect(rects[0]!.color).toBe(COLORS.overlapError);
    expect(labelTexts(priv(canvas).labels).some((t) => t.includes('MISSING') && t.includes('ghost_piece'))).toBe(true);
  });

  it('draws one filled rect per door, after every room rect', () => {
    const { canvas } = makeCanvas({
      id: 'f',
      rooms: [
        { id: 'a', pieceId: 'piece_a', offsetXGrid: 0, offsetYGrid: 0 },
        { id: 'b', pieceId: 'piece_a', offsetXGrid: 10, offsetYGrid: 0 },
      ],
      doors: [{ roomA: 'a', roomB: 'b', passageGrid: { x: 9, y: 3, w: 2, h: 4 } }],
    });
    const all = drawnFills(priv(canvas).shapes);
    expect(all).toHaveLength(3); // 2 rooms + 1 door
    expect(all[2]!.color).toBe(COLORS.door);
  });

  it('gives the selected room a thicker, selection-colored stroke than an unselected one', () => {
    const { canvas } = makeCanvas({
      id: 'f',
      rooms: [
        { id: 'a', pieceId: 'piece_a', offsetXGrid: 0, offsetYGrid: 0 },
        { id: 'b', pieceId: 'piece_a', offsetXGrid: 10, offsetYGrid: 0 },
      ],
      doors: [],
    });
    const before = drawnStrokes(priv(canvas).shapes);
    expect(before.every((s) => s.color === COLORS.wallEdge && s.width === 1.5)).toBe(true);

    canvas.setSelection({ kind: 'room', id: 'b' });
    const after = drawnStrokes(priv(canvas).shapes);
    expect(after[0]).toMatchObject({ color: COLORS.wallEdge, width: 1.5 }); // room 'a', still unselected
    expect(after[1]).toMatchObject({ color: COLORS.selection, width: 3 }); // room 'b', selected
  });

  it('clears and redraws on every setDocument — a second, smaller floor leaves no stale fills behind', () => {
    const canvas = new DungeonFloorCanvas(fakeHost);
    canvas.setLibrary(LIB);
    canvas.setDocument(
      new DungeonFloorDocument({
        id: 'f',
        rooms: [
          { id: 'a', pieceId: 'piece_a', offsetXGrid: 0, offsetYGrid: 0 },
          { id: 'b', pieceId: 'piece_a', offsetXGrid: 10, offsetYGrid: 0 },
        ],
        doors: [],
      }),
    );
    expect(drawnFills(priv(canvas).shapes)).toHaveLength(2);
    canvas.setDocument(new DungeonFloorDocument({ id: 'f2', rooms: [{ id: 'a', pieceId: 'piece_a', offsetXGrid: 0, offsetYGrid: 0 }], doors: [] }));
    expect(drawnFills(priv(canvas).shapes)).toHaveLength(1);
  });

  it('a mutation on the document (via .mutate) triggers a live redraw through the on() subscription', () => {
    const { canvas, doc } = makeCanvas({ id: 'f', rooms: [{ id: 'a', pieceId: 'piece_a', offsetXGrid: 0, offsetYGrid: 0 }], doors: [] });
    expect(drawnFills(priv(canvas).shapes)).toHaveLength(1);
    doc.mutate((map) => map.rooms.push({ id: 'b', pieceId: 'piece_a', offsetXGrid: 20, offsetYGrid: 0 }));
    expect(drawnFills(priv(canvas).shapes)).toHaveLength(2);
  });
});

describe('DungeonFloorCanvas — pure geometry/lookup helpers', () => {
  it('roomRect resolves a placed room\'s rect from the library, or null for an unresolved piece', () => {
    const canvas = new DungeonFloorCanvas(fakeHost);
    canvas.setLibrary(LIB);
    expect(priv(canvas).roomRect({ pieceId: 'piece_a', offsetXGrid: 5, offsetYGrid: 7 })).toEqual({ x: 5, y: 7, w: 10, h: 10 });
    expect(priv(canvas).roomRect({ pieceId: 'ghost', offsetXGrid: 0, offsetYGrid: 0 })).toBeNull();
  });

  it('roomAt hit-tests the topmost (last-placed) room at a grid point, null off any room', () => {
    const { canvas } = makeCanvas({
      id: 'f',
      rooms: [
        { id: 'a', pieceId: 'piece_a', offsetXGrid: 0, offsetYGrid: 0 },
        { id: 'b', pieceId: 'piece_a', offsetXGrid: 30, offsetYGrid: 0 },
      ],
      doors: [],
    });
    expect(priv(canvas).roomAt(5, 5)?.id).toBe('a');
    expect(priv(canvas).roomAt(35, 5)?.id).toBe('b');
    expect(priv(canvas).roomAt(20, 20)).toBeNull();
  });

  it('doorAt hit-tests a door\'s passageGrid by index, null off any door', () => {
    const { canvas } = makeCanvas({
      id: 'f',
      rooms: [
        { id: 'a', pieceId: 'piece_a', offsetXGrid: 0, offsetYGrid: 0 },
        { id: 'b', pieceId: 'piece_a', offsetXGrid: 10, offsetYGrid: 0 },
      ],
      doors: [{ roomA: 'a', roomB: 'b', passageGrid: { x: 9, y: 3, w: 2, h: 4 } }],
    });
    expect(priv(canvas).doorAt(10, 5)).toBe(0);
    expect(priv(canvas).doorAt(50, 50)).toBeNull();
  });

  it('otherRoomRects excludes the named room and resolves every other room\'s real size', () => {
    const { canvas } = makeCanvas({
      id: 'f',
      rooms: [
        { id: 'a', pieceId: 'piece_a', offsetXGrid: 0, offsetYGrid: 0 },
        { id: 'b', pieceId: 'piece_a', offsetXGrid: 10, offsetYGrid: 0 },
      ],
      doors: [],
    });
    expect(priv(canvas).otherRoomRects('a')).toEqual([{ x: 10, y: 0, w: 10, h: 10 }]);
  });

  it('nextRoomId skips ids already in use, not just counting length + 1', () => {
    const { canvas } = makeCanvas({ id: 'f', rooms: [{ id: 'room_2', pieceId: 'piece_a', offsetXGrid: 0, offsetYGrid: 0 }], doors: [] });
    // length=1 -> naive guess "room_2" collides with the existing room -> must skip to "room_3".
    expect(priv(canvas).nextRoomId()).toBe('room_3');
  });
});

describe('DungeonFloorCanvas — tryConnectDoor', () => {
  beforeEach(() => vi.stubGlobal('alert', vi.fn()));
  afterEach(() => vi.unstubAllGlobals());

  it('connects two rooms sharing a vertical (east/west) boundary with a passage centered on their Y-overlap', () => {
    const { canvas, doc } = makeCanvas({
      id: 'f',
      rooms: [
        { id: 'a', pieceId: 'piece_a', offsetXGrid: 0, offsetYGrid: 0 },
        { id: 'b', pieceId: 'piece_a', offsetXGrid: 10, offsetYGrid: 0 },
      ],
      doors: [],
    });
    priv(canvas).tryConnectDoor('a', 'b');
    expect(doc.map.doors).toEqual([{ roomA: 'a', roomB: 'b', passageGrid: { x: 9, y: 0, w: 2, h: 10 } }]);
  });

  it('connects two rooms sharing a horizontal (north/south) boundary', () => {
    const { canvas, doc } = makeCanvas({
      id: 'f',
      rooms: [
        { id: 'a', pieceId: 'piece_a', offsetXGrid: 0, offsetYGrid: 0 },
        { id: 'b', pieceId: 'piece_a', offsetXGrid: 0, offsetYGrid: 10 },
      ],
      doors: [],
    });
    priv(canvas).tryConnectDoor('a', 'b');
    expect(doc.map.doors).toEqual([{ roomA: 'a', roomB: 'b', passageGrid: { x: 0, y: 9, w: 10, h: 2 } }]);
  });

  it('rejects (alert, no door) two rooms that share no boundary', () => {
    const { canvas, doc } = makeCanvas({
      id: 'f',
      rooms: [
        { id: 'a', pieceId: 'piece_a', offsetXGrid: 0, offsetYGrid: 0 },
        { id: 'b', pieceId: 'piece_a', offsetXGrid: 50, offsetYGrid: 50 },
      ],
      doors: [],
    });
    priv(canvas).tryConnectDoor('a', 'b');
    expect(doc.map.doors).toHaveLength(0);
    expect(alert).toHaveBeenCalledWith(expect.stringContaining("don't share a boundary"));
  });

  it('rejects (alert, no door) when either room\'s piece is not open in the library', () => {
    const { canvas, doc } = makeCanvas({
      id: 'f',
      rooms: [
        { id: 'a', pieceId: 'piece_a', offsetXGrid: 0, offsetYGrid: 0 },
        { id: 'b', pieceId: 'ghost', offsetXGrid: 10, offsetYGrid: 0 },
      ],
      doors: [],
    });
    priv(canvas).tryConnectDoor('a', 'b');
    expect(doc.map.doors).toHaveLength(0);
    expect(alert).toHaveBeenCalledWith(expect.stringContaining('resolvable piece'));
  });

  it('silently no-ops connecting a room to itself (no alert, no self-door)', () => {
    const { canvas, doc } = makeCanvas({ id: 'f', rooms: [{ id: 'a', pieceId: 'piece_a', offsetXGrid: 0, offsetYGrid: 0 }], doors: [] });
    priv(canvas).tryConnectDoor('a', 'a');
    expect(doc.map.doors).toHaveLength(0);
    expect(alert).not.toHaveBeenCalled();
  });
});

describe('DungeonFloorCanvas — onPointerDown/onPointerMove ("place" tool)', () => {
  beforeEach(() => vi.stubGlobal('alert', vi.fn()));
  afterEach(() => vi.unstubAllGlobals());

  it('places a fixed-size room instance at the clicked grid position and selects it', () => {
    const { canvas, doc } = makeCanvas({ id: 'f', rooms: [], doors: [] });
    canvas.setTool('place');
    canvas.setPendingPieceId('piece_a');
    priv(canvas).onPointerDown(5 * GRID_PX, 5 * GRID_PX, 0);
    expect(doc.map.rooms).toHaveLength(1);
    expect(doc.map.rooms[0]).toMatchObject({ pieceId: 'piece_a', offsetXGrid: 5, offsetYGrid: 5 });
    expect(canvas.getSelection()).toEqual({ kind: 'room', id: doc.map.rooms[0]!.id });
  });

  it('alerts and places nothing when no piece is picked yet', () => {
    const { canvas, doc } = makeCanvas({ id: 'f', rooms: [], doors: [] });
    canvas.setTool('place');
    canvas.setPendingPieceId(null);
    priv(canvas).onPointerDown(30, 30, 0);
    expect(doc.map.rooms).toHaveLength(0);
    expect(alert).toHaveBeenCalled();
  });

  it('alerts and places nothing when the pending piece id isn\'t open in the library', () => {
    const { canvas, doc } = makeCanvas({ id: 'f', rooms: [], doors: [] });
    canvas.setTool('place');
    canvas.setPendingPieceId('not_open');
    priv(canvas).onPointerDown(30, 30, 0);
    expect(doc.map.rooms).toHaveLength(0);
    expect(alert).toHaveBeenCalled();
  });

  it('silently rejects a placement that would overlap an existing room (no alert, no room added)', () => {
    const { canvas, doc } = makeCanvas({ id: 'f', rooms: [{ id: 'a', pieceId: 'piece_a', offsetXGrid: 0, offsetYGrid: 0 }], doors: [] });
    canvas.setTool('place');
    canvas.setPendingPieceId('piece_a');
    priv(canvas).onPointerDown(5 * GRID_PX, 5 * GRID_PX, 0); // (5,5)-(15,15) overlaps room a (0,0)-(10,10)
    expect(doc.map.rooms).toHaveLength(1); // unchanged
    expect(alert).not.toHaveBeenCalled();
  });
});

describe('DungeonFloorCanvas — onPointerDown/onPointerMove/onPointerUp ("select" tool)', () => {
  it('clicking a room selects it and starts a move drag; moving updates its offset', () => {
    const { canvas, doc } = makeCanvas({
      id: 'f',
      rooms: [
        { id: 'a', pieceId: 'piece_a', offsetXGrid: 0, offsetYGrid: 0 },
        { id: 'b', pieceId: 'piece_a', offsetXGrid: 30, offsetYGrid: 0 }, // far enough not to collide below
      ],
      doors: [],
    });
    canvas.setTool('select');
    priv(canvas).onPointerDown(5 * GRID_PX, 5 * GRID_PX, 0); // grabs room 'a' at its own local (5,5)
    expect(canvas.getSelection()).toEqual({ kind: 'room', id: 'a' });

    priv(canvas).onPointerMove(12 * GRID_PX, 12 * GRID_PX); // pointer now at grid (12,12)
    expect(doc.map.rooms[0]).toMatchObject({ offsetXGrid: 7, offsetYGrid: 7 }); // 12 - (grab offset 5)

    priv(canvas).onPointerUp();
    expect(doc.map.rooms[0]).toMatchObject({ offsetXGrid: 7, offsetYGrid: 7 }); // committed, unchanged by pointerUp itself
  });

  it('reverts to the last valid position when a move drag would overlap another room', () => {
    const { canvas, doc } = makeCanvas({
      id: 'f',
      rooms: [
        { id: 'a', pieceId: 'piece_a', offsetXGrid: 0, offsetYGrid: 0 },
        { id: 'b', pieceId: 'piece_a', offsetXGrid: 30, offsetYGrid: 0 },
      ],
      doors: [],
    });
    canvas.setTool('select');
    priv(canvas).onPointerDown(5 * GRID_PX, 5 * GRID_PX, 0);
    priv(canvas).onPointerMove(12 * GRID_PX, 12 * GRID_PX); // valid: (7,7)-(17,17), no overlap with b (30,0)-(40,10)
    expect(doc.map.rooms[0]).toMatchObject({ offsetXGrid: 7, offsetYGrid: 7 });

    priv(canvas).onPointerMove(30 * GRID_PX, 5 * GRID_PX); // candidate (25,0)-(35,10) DOES overlap b
    expect(doc.map.rooms[0]).toMatchObject({ offsetXGrid: 7, offsetYGrid: 7 }); // reverted, not jumped
  });

  it('clicking a door that sits off any room rect selects the door instead of clearing selection', () => {
    // A real tryConnectDoor-produced door always straddles the shared boundary of two
    // TOUCHING rooms, so its passageGrid is always fully covered by one room or the
    // other — there is no "door but no room" point to click for that shape. This uses
    // a hand-edited door (a valid DungeonFloorMap value even if the tool itself never
    // produces it — e.g. the Inspector's numeric passageGrid fields let an author move
    // one) sitting in genuinely empty space between two distant rooms instead.
    const { canvas } = makeCanvas({
      id: 'f',
      rooms: [
        { id: 'a', pieceId: 'piece_a', offsetXGrid: 0, offsetYGrid: 0 },
        { id: 'b', pieceId: 'piece_a', offsetXGrid: 50, offsetYGrid: 50 },
      ],
      doors: [{ roomA: 'a', roomB: 'b', passageGrid: { x: 20, y: 20, w: 2, h: 4 } }],
    });
    canvas.setTool('select');
    priv(canvas).onPointerDown(21 * GRID_PX, 21 * GRID_PX, 0); // inside the door rect, off both rooms
    expect(canvas.getSelection()).toEqual({ kind: 'door', index: 0 });
  });

  it('clicking truly empty space clears the selection', () => {
    const { canvas } = makeCanvas({ id: 'f', rooms: [{ id: 'a', pieceId: 'piece_a', offsetXGrid: 0, offsetYGrid: 0 }], doors: [] });
    canvas.setTool('select');
    priv(canvas).onPointerDown(5 * GRID_PX, 5 * GRID_PX, 0);
    expect(canvas.getSelection()).toEqual({ kind: 'room', id: 'a' });
    priv(canvas).onPointerDown(50 * GRID_PX, 50 * GRID_PX, 0);
    expect(canvas.getSelection()).toBeNull();
  });
});

describe('DungeonFloorCanvas — onPointerDown ("door" tool two-click state machine)', () => {
  it('connects two DIFFERENT rooms across two clicks', () => {
    const { canvas, doc } = makeCanvas({
      id: 'f',
      rooms: [
        { id: 'a', pieceId: 'piece_a', offsetXGrid: 0, offsetYGrid: 0 },
        { id: 'b', pieceId: 'piece_a', offsetXGrid: 10, offsetYGrid: 0 },
      ],
      doors: [],
    });
    canvas.setTool('door');
    priv(canvas).onPointerDown(5 * GRID_PX, 5 * GRID_PX, 0); // first click: room a
    expect(doc.map.doors).toHaveLength(0);
    priv(canvas).onPointerDown(15 * GRID_PX, 5 * GRID_PX, 0); // second click: room b
    expect(doc.map.doors).toHaveLength(1);
    expect(doc.map.doors[0]).toMatchObject({ roomA: 'a', roomB: 'b' });
  });

  it('clicking the SAME room twice never creates a self-connecting door', () => {
    vi.stubGlobal('alert', vi.fn());
    const { canvas, doc } = makeCanvas({ id: 'f', rooms: [{ id: 'a', pieceId: 'piece_a', offsetXGrid: 0, offsetYGrid: 0 }], doors: [] });
    canvas.setTool('door');
    priv(canvas).onPointerDown(5 * GRID_PX, 5 * GRID_PX, 0);
    priv(canvas).onPointerDown(5 * GRID_PX, 5 * GRID_PX, 0);
    expect(doc.map.doors).toHaveLength(0);
    vi.unstubAllGlobals();
  });
});
