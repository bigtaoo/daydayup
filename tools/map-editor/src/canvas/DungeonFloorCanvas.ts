import { Application, Container, Graphics, Rectangle, Text } from 'pixi.js';
import { COLORS } from '../colors';
import { DungeonFloorDocument } from '../state/DungeonFloorDocument';
import type { RoomPiece } from '@dd/engine';

const GRID_PX = 6; // same zoom scale as ArenaCanvas — a hand-authored floor can span many rooms
const PAD_PX = 24;

export type DungeonFloorTool = 'select' | 'place' | 'door';

export type DungeonFloorSelection = { kind: 'room'; id: string } | { kind: 'door'; index: number } | null;

type Rect = { x: number; y: number; w: number; h: number };

type DragMode = { kind: 'moveRoom'; id: string; offsetX: number; offsetY: number; lastValid: { x: number; y: number } } | null;

function rectsOverlap(a: Rect, b: Rect): boolean {
  return a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;
}

/**
 * Map-scale view of a `DungeonFloorMap` (design/05 "Hand-authored PvE floors",
 * 2026-08-05) — a sibling to `ArenaCanvas`, not a variant of it: the one real
 * difference is what "place a room" means. An `ArenaMap` room is freehand-drawn
 * (its own solids authored inline); a `DungeonFloorMap` room is an INSTANCE of an
 * already-authored, fixed-size `RoomPiece` (picked from whatever's open in the
 * "PvE Room Library" tab, via `setPendingPieceId`) dropped at a position, never
 * resized. Move/reject-overlap/pan/zoom/door-connect-tool machinery otherwise
 * mirrors `ArenaCanvas` exactly.
 */
export class DungeonFloorCanvas {
  readonly app = new Application();
  private camera = new Container();
  private world = new Container();
  private shapes = new Graphics();
  private labels = new Container();
  private preview = new Graphics();
  private doc: DungeonFloorDocument | null = null;
  private library: readonly RoomPiece[] = [];
  private unsubscribe: (() => void) | null = null;
  private tool: DungeonFloorTool = 'select';
  private pendingPieceId: string | null = null;
  private selection: DungeonFloorSelection = null;
  private drag: DragMode = null;
  private panDrag: { lastX: number; lastY: number } | null = null;
  private pendingDoorRoomId: string | null = null;
  private lastCursorGrid: { x: number; y: number } | null = null;
  private onSelectionChangeCb: ((sel: DungeonFloorSelection) => void) | null = null;

  constructor(private host: HTMLElement) {}

  async mount(): Promise<void> {
    await this.app.init({ background: COLORS.ground, resizeTo: this.host, antialias: true });
    this.host.appendChild(this.app.canvas);
    this.app.stage.addChild(this.camera);
    this.camera.addChild(this.world);
    this.world.position.set(PAD_PX, PAD_PX);
    this.world.addChild(this.shapes, this.labels, this.preview);

    this.app.stage.eventMode = 'static';
    this.app.stage.hitArea = new Rectangle(0, 0, 4000, 4000);
    this.app.stage.on('pointerdown', (e) => this.onPointerDown(e.global.x, e.global.y, e.button));
    this.app.stage.on('globalpointermove', (e) => this.onPointerMove(e.global.x, e.global.y));
    this.app.stage.on('pointerup', () => this.onPointerUp());
    this.app.stage.on('pointerupoutside', () => this.onPointerUp());
    this.app.canvas.addEventListener('wheel', this.onWheel, { passive: false });
    this.app.canvas.addEventListener('contextmenu', this.onContextMenu);
    window.addEventListener('keydown', this.onKeyDown);
  }

  destroy(): void {
    window.removeEventListener('keydown', this.onKeyDown);
    this.app.canvas.removeEventListener('wheel', this.onWheel);
    this.app.canvas.removeEventListener('contextmenu', this.onContextMenu);
    this.unsubscribe?.();
  }

  setDocument(doc: DungeonFloorDocument | null): void {
    this.unsubscribe?.();
    this.doc = doc;
    this.selection = null;
    this.pendingDoorRoomId = null;
    this.unsubscribe = doc?.on(() => this.redraw()) ?? null;
    this.redraw();
    this.fitView();
  }

  /** Whatever `RoomPiece`s are currently open in the "PvE Room Library" tab —
   * the palette a room instance's fixed size/id is resolved against. Re-supplied
   * by main.ts on every room-doc list change (new/opened/closed), not just once. */
  setLibrary(library: readonly RoomPiece[]): void {
    this.library = library;
    this.redraw();
  }

  setPendingPieceId(pieceId: string | null): void {
    this.pendingPieceId = pieceId;
  }

  fitView(): void {
    if (!this.doc) return;
    const bounds = this.contentBounds();
    const contentW = bounds.w + PAD_PX * 2;
    const contentH = bounds.h + PAD_PX * 2;
    const hostW = this.host.clientWidth || contentW;
    const hostH = this.host.clientHeight || contentH;
    const scale = Math.min(6, Math.max(0.15, Math.min(hostW / contentW, hostH / contentH)));
    this.camera.scale.set(scale);
    this.camera.position.set((hostW - contentW * scale) / 2 - bounds.x * scale, (hostH - contentH * scale) / 2 - bounds.y * scale);
  }

  private contentBounds(): Rect {
    if (!this.doc || this.doc.map.rooms.length === 0) return { x: 0, y: 0, w: 100, h: 100 };
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (const room of this.doc.map.rooms) {
      const r = this.roomRect(room);
      if (!r) continue;
      minX = Math.min(minX, r.x * GRID_PX);
      minY = Math.min(minY, r.y * GRID_PX);
      maxX = Math.max(maxX, (r.x + r.w) * GRID_PX);
      maxY = Math.max(maxY, (r.y + r.h) * GRID_PX);
    }
    if (!Number.isFinite(minX)) return { x: 0, y: 0, w: 100, h: 100 };
    return { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
  }

  private zoomAt(gx: number, gy: number, factor: number): void {
    const oldScale = this.camera.scale.x;
    const newScale = Math.min(6, Math.max(0.15, oldScale * factor));
    if (newScale === oldScale) return;
    const local = this.camera.toLocal({ x: gx, y: gy });
    this.camera.scale.set(newScale);
    this.camera.position.set(gx - local.x * newScale, gy - local.y * newScale);
  }

  private onWheel = (e: WheelEvent): void => {
    e.preventDefault();
    const rect = this.app.canvas.getBoundingClientRect();
    const factor = e.deltaY < 0 ? 1.1 : 1 / 1.1;
    this.zoomAt(e.clientX - rect.left, e.clientY - rect.top, factor);
  };

  private onContextMenu = (e: MouseEvent): void => {
    e.preventDefault();
  };

  setTool(tool: DungeonFloorTool): void {
    this.tool = tool;
    this.pendingDoorRoomId = null;
    this.drag = null;
    this.preview.clear();
  }

  setSelection(sel: DungeonFloorSelection): void {
    this.selection = sel;
    this.onSelectionChangeCb?.(sel);
    this.redraw();
  }

  getSelection(): DungeonFloorSelection {
    return this.selection;
  }

  onSelectionChange(fn: (sel: DungeonFloorSelection) => void): void {
    this.onSelectionChangeCb = fn;
  }

  private toGrid(px: number, py: number): { x: number; y: number } {
    const local = this.world.toLocal({ x: px, y: py });
    return { x: local.x / GRID_PX, y: local.y / GRID_PX };
  }

  /** A room instance's placed rect, resolved against `library` by `pieceId` —
   * `null` if the piece isn't currently open (a dangling reference, rendered as a
   * visible placeholder rather than silently dropped — design/09 "fail loud"). */
  private roomRect(room: { pieceId: string; offsetXGrid: number; offsetYGrid: number }): Rect | null {
    const piece = this.library.find((p) => p.id === room.pieceId);
    if (!piece) return null;
    return { x: room.offsetXGrid, y: room.offsetYGrid, w: piece.sizeGrid.w, h: piece.sizeGrid.h };
  }

  private roomAt(gx: number, gy: number): { id: string; pieceId: string; offsetXGrid: number; offsetYGrid: number } | null {
    if (!this.doc) return null;
    const rooms = this.doc.map.rooms;
    for (let i = rooms.length - 1; i >= 0; i--) {
      const room = rooms[i]!;
      const r = this.roomRect(room) ?? { x: room.offsetXGrid, y: room.offsetYGrid, w: 4, h: 4 }; // missing-piece placeholder size
      if (gx >= r.x && gx <= r.x + r.w && gy >= r.y && gy <= r.y + r.h) return room;
    }
    return null;
  }

  private doorAt(gx: number, gy: number): number | null {
    if (!this.doc) return null;
    const doors = this.doc.map.doors;
    for (let i = doors.length - 1; i >= 0; i--) {
      const p = doors[i]!.passageGrid;
      if (gx >= p.x && gx <= p.x + p.w && gy >= p.y && gy <= p.y + p.h) return i;
    }
    return null;
  }

  private otherRoomRects(id: string): Rect[] {
    if (!this.doc) return [];
    return this.doc.map.rooms
      .filter((r) => r.id !== id)
      .map((r) => this.roomRect(r))
      .filter((r): r is Rect => r !== null);
  }

  private tryConnectDoor(idA: string, idB: string): void {
    if (!this.doc || idA === idB) return;
    const roomA = this.doc.map.rooms.find((r) => r.id === idA);
    const roomB = this.doc.map.rooms.find((r) => r.id === idB);
    const ra = roomA && this.roomRect(roomA);
    const rb = roomB && this.roomRect(roomB);
    if (!ra || !rb) {
      alert('Both rooms need a resolvable piece (open it in the Room Library tab) before connecting a door.');
      return;
    }
    let passage: Rect | null = null;
    const vTouch = ra.x + ra.w === rb.x || rb.x + rb.w === ra.x;
    if (vTouch) {
      const boundaryX = ra.x + ra.w === rb.x ? rb.x : ra.x;
      const overlapY0 = Math.max(ra.y, rb.y);
      const overlapY1 = Math.min(ra.y + ra.h, rb.y + rb.h);
      if (overlapY1 > overlapY0) passage = { x: boundaryX - 1, y: overlapY0, w: 2, h: overlapY1 - overlapY0 };
    }
    const hTouch = !passage && (ra.y + ra.h === rb.y || rb.y + rb.h === ra.y);
    if (hTouch) {
      const boundaryY = ra.y + ra.h === rb.y ? rb.y : ra.y;
      const overlapX0 = Math.max(ra.x, rb.x);
      const overlapX1 = Math.min(ra.x + ra.w, rb.x + rb.w);
      if (overlapX1 > overlapX0) passage = { x: overlapX0, y: boundaryY - 1, w: overlapX1 - overlapX0, h: 2 };
    }
    if (!passage) {
      alert(`Rooms "${idA}" and "${idB}" don't share a boundary — move them adjacent before connecting a door.`);
      return;
    }
    this.doc.mutate((map) => {
      map.doors.push({ roomA: idA, roomB: idB, passageGrid: passage! });
    });
  }

  private nextRoomId(): string {
    let n = (this.doc?.map.rooms.length ?? 0) + 1;
    const existing = new Set(this.doc?.map.rooms.map((r) => r.id) ?? []);
    while (existing.has(`room_${n}`)) n++;
    return `room_${n}`;
  }

  private onPointerDown(px: number, py: number, button: number): void {
    if (button === 2) {
      this.panDrag = { lastX: px, lastY: py };
      return;
    }
    if (!this.doc) return;
    const g = this.toGrid(px, py);
    const gx = Math.round(g.x);
    const gy = Math.round(g.y);

    if (this.tool === 'place') {
      if (!this.pendingPieceId) {
        alert('Pick a RoomPiece to place first (the piece picker above the canvas).');
        return;
      }
      const piece = this.library.find((p) => p.id === this.pendingPieceId);
      if (!piece) {
        alert(`"${this.pendingPieceId}" isn't open in the Room Library tab.`);
        return;
      }
      const candidate: Rect = { x: gx, y: gy, w: piece.sizeGrid.w, h: piece.sizeGrid.h };
      if (this.doc.map.rooms.some((r) => { const rr = this.roomRect(r); return rr && rectsOverlap(rr, candidate); })) {
        return; // silently rejected, same convention as ArenaCanvas's overlap-drawing reject
      }
      const id = this.nextRoomId();
      this.doc.mutate((map) => {
        map.rooms.push({ id, pieceId: piece.id, offsetXGrid: gx, offsetYGrid: gy });
      });
      this.setSelection({ kind: 'room', id });
      return;
    }

    const hitRoom = this.roomAt(g.x, g.y);

    if (this.tool === 'door') {
      if (!hitRoom) return;
      if (!this.pendingDoorRoomId) {
        this.pendingDoorRoomId = hitRoom.id;
        this.setSelection({ kind: 'room', id: hitRoom.id });
      } else {
        this.tryConnectDoor(this.pendingDoorRoomId, hitRoom.id);
        this.pendingDoorRoomId = null;
      }
      return;
    }

    // select tool
    if (!hitRoom) {
      const hitDoor = this.doorAt(g.x, g.y);
      this.setSelection(hitDoor !== null ? { kind: 'door', index: hitDoor } : null);
      return;
    }
    this.setSelection({ kind: 'room', id: hitRoom.id });
    this.drag = {
      kind: 'moveRoom',
      id: hitRoom.id,
      offsetX: g.x - hitRoom.offsetXGrid,
      offsetY: g.y - hitRoom.offsetYGrid,
      lastValid: { x: hitRoom.offsetXGrid, y: hitRoom.offsetYGrid },
    };
  }

  private onPointerMove(px: number, py: number): void {
    if (this.panDrag) {
      this.camera.position.x += px - this.panDrag.lastX;
      this.camera.position.y += py - this.panDrag.lastY;
      this.panDrag = { lastX: px, lastY: py };
      return;
    }
    const g = this.toGrid(px, py);
    this.lastCursorGrid = g;

    if (this.tool === 'place' && !this.drag) {
      this.drawPlacePreview(g);
      return;
    }

    if (!this.drag || !this.doc) return;

    if (this.drag.kind === 'moveRoom') {
      const dragId = this.drag.id;
      const target = this.doc.map.rooms.find((r) => r.id === dragId);
      if (!target) return;
      const nx = Math.round(g.x - this.drag.offsetX);
      const ny = Math.round(g.y - this.drag.offsetY);
      const size = this.roomRect(target);
      const candidate: Rect = { x: nx, y: ny, w: size?.w ?? 4, h: size?.h ?? 4 };
      const blocked = this.otherRoomRects(target.id).some((r) => rectsOverlap(r, candidate));
      if (!blocked) {
        target.offsetXGrid = nx;
        target.offsetYGrid = ny;
        this.drag.lastValid = { x: nx, y: ny };
      } else {
        target.offsetXGrid = this.drag.lastValid.x;
        target.offsetYGrid = this.drag.lastValid.y;
      }
      this.redraw();
      return;
    }
  }

  private drawPlacePreview(g: { x: number; y: number }): void {
    this.preview.clear();
    if (!this.pendingPieceId) return;
    const piece = this.library.find((p) => p.id === this.pendingPieceId);
    if (!piece) return;
    const gx = Math.round(g.x);
    const gy = Math.round(g.y);
    const candidate: Rect = { x: gx, y: gy, w: piece.sizeGrid.w, h: piece.sizeGrid.h };
    const overlaps = (this.doc?.map.rooms ?? []).some((r) => { const rr = this.roomRect(r); return rr && rectsOverlap(rr, candidate); });
    this.preview
      .rect(candidate.x * GRID_PX, candidate.y * GRID_PX, candidate.w * GRID_PX, candidate.h * GRID_PX)
      .fill({ color: overlaps ? COLORS.overlapError : COLORS.selection, alpha: 0.25 })
      .stroke({ color: overlaps ? COLORS.overlapError : COLORS.selection, width: 2 });
  }

  private onPointerUp(): void {
    if (this.panDrag) {
      this.panDrag = null;
      return;
    }
    if (!this.drag || !this.doc) {
      this.drag = null;
      return;
    }
    this.doc.mutate(() => {}); // autosave + emit after a move drag
    this.drag = null;
  }

  private onKeyDown = (e: KeyboardEvent): void => {
    if ((e.key === 'Delete' || e.key === 'Backspace') && this.selection && this.doc) {
      const isInput = document.activeElement instanceof HTMLInputElement || document.activeElement instanceof HTMLTextAreaElement;
      if (isInput) return;
      if (!confirm('Delete selected item?')) return;
      const sel = this.selection;
      this.doc.mutate((map) => {
        if (sel.kind === 'room') {
          const i = map.rooms.findIndex((r) => r.id === sel.id);
          if (i >= 0) map.rooms.splice(i, 1);
          map.doors = map.doors.filter((d) => d.roomA !== sel.id && d.roomB !== sel.id);
        } else {
          map.doors.splice(sel.index, 1);
        }
      });
      this.setSelection(null);
    }
  };

  redraw(): void {
    this.shapes.clear();
    this.labels.removeChildren();
    if (!this.tool || this.tool !== 'place') this.preview.clear();
    if (!this.doc) return;
    const map = this.doc.map;
    const entranceId = map.rooms[0]?.id;
    const capstoneId = map.rooms[map.rooms.length - 1]?.id;

    for (const room of map.rooms) {
      const r = this.roomRect(room);
      const selected = this.selection?.kind === 'room' && this.selection.id === room.id;
      if (!r) {
        // Dangling piece reference — a small red placeholder, not a silent skip.
        const px = room.offsetXGrid * GRID_PX;
        const py = room.offsetYGrid * GRID_PX;
        this.shapes
          .rect(px, py, 4 * GRID_PX, 4 * GRID_PX)
          .fill({ color: COLORS.overlapError, alpha: 0.4 })
          .stroke({ color: selected ? COLORS.selection : COLORS.overlapError, width: selected ? 3 : 1.5 });
        this.addLabel(`${room.id} — MISSING "${room.pieceId}"`, px + 3, py + 2);
        continue;
      }
      const isEndpoint = room.id === entranceId || room.id === capstoneId;
      const fill = room.id === capstoneId ? COLORS.extractGlow : room.id === entranceId ? COLORS.player : COLORS.roomBounds;
      this.shapes
        .rect(r.x * GRID_PX, r.y * GRID_PX, r.w * GRID_PX, r.h * GRID_PX)
        .fill({ color: fill, alpha: isEndpoint ? 0.35 : 0.6 })
        .stroke({ color: selected ? COLORS.selection : COLORS.wallEdge, width: selected ? 3 : 1.5 });
      const tag = room.id === capstoneId ? ' (capstone)' : room.id === entranceId ? ' (entrance)' : '';
      this.addLabel(`${room.id}: ${room.pieceId}${tag}`, r.x * GRID_PX + 3, r.y * GRID_PX + 2);
    }

    map.doors.forEach((door, i) => {
      const p = door.passageGrid;
      const selected = this.selection?.kind === 'door' && this.selection.index === i;
      this.shapes
        .rect(p.x * GRID_PX, p.y * GRID_PX, p.w * GRID_PX, p.h * GRID_PX)
        .fill({ color: COLORS.door })
        .stroke({ color: selected ? COLORS.selection : COLORS.door, width: selected ? 2 : 0 });
    });

    if (this.pendingDoorRoomId) {
      const room = map.rooms.find((r) => r.id === this.pendingDoorRoomId);
      const r = room && this.roomRect(room);
      if (r) this.shapes.rect(r.x * GRID_PX, r.y * GRID_PX, r.w * GRID_PX, r.h * GRID_PX).stroke({ color: COLORS.door, width: 3 });
    }

    if (this.tool === 'place' && this.lastCursorGrid) this.drawPlacePreview(this.lastCursorGrid);
  }

  private addLabel(text: string, x: number, y: number): void {
    const t = new Text({ text, style: { fill: 0xd8dee9, fontSize: 9, fontFamily: 'monospace' } });
    t.position.set(x, y);
    this.labels.addChild(t);
  }
}
