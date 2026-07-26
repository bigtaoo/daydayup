import { Application, Container, Graphics, Rectangle, Text } from 'pixi.js';
import { COLORS } from '../colors';
import { ArenaDocument } from '../state/ArenaDocument';
import type { ArenaRoom } from '@dd/engine/content/arenas';

const GRID_PX = 6; // arena maps are ~100-200 grid units across — zoomed further out than a RoomCanvas
const PAD_PX = 24;
const DBLCLICK_MS = 350;

export type ArenaTool = 'select' | 'room' | 'door' | 'eye' | 'spawn';

export type ArenaSelection = { kind: 'room'; id: string } | { kind: 'spawn'; index: number } | null;

type DragMode =
  | { kind: 'drawRoom'; startX: number; startY: number; curX: number; curY: number }
  | { kind: 'moveRoom'; id: string; offsetX: number; offsetY: number; lastValid: { x: number; y: number } }
  | { kind: 'resizeRoom'; id: string; corner: 'nw' | 'ne' | 'sw' | 'se'; fixedX: number; fixedY: number; lastValid: { w: number; h: number; x: number; y: number } }
  | null;

function rectsOverlap(a: { x: number; y: number; w: number; h: number }, b: { x: number; y: number; w: number; h: number }): boolean {
  return a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;
}

/** Map-scale view of an ArenaMap: place/move/resize ArenaRoom rects (rejecting
 * overlap), author explicit Doors between adjacent rooms, toggle EyeCandidates,
 * and place map-level player spawns. Double-click a room to drill into it (the
 * caller wires that into a shared RoomCanvas via ArenaRoomTarget). */
// A 60-room map (design/15) is far larger on screen than this tool was built
// against (its only prior fixtures were 2-3-room tests) — zoomed to 1:1 it
// overflows any reasonable window, so panning/zoom is required, not cosmetic.
const MIN_ZOOM = 0.15;
const MAX_ZOOM = 6;

export class ArenaCanvas {
  readonly app = new Application();
  private camera = new Container(); // pan (position) + zoom (scale); world sits inside it at a fixed PAD_PX offset
  private world = new Container();
  private shapes = new Graphics();
  private labels = new Container();
  private preview = new Graphics();
  private doc: ArenaDocument | null = null;
  private unsubscribe: (() => void) | null = null;
  private tool: ArenaTool = 'select';
  private selection: ArenaSelection = null;
  private drag: DragMode = null;
  private panDrag: { lastX: number; lastY: number } | null = null;
  private pendingDoorRoomId: string | null = null;
  private lastClick: { id: string; at: number } | null = null;
  private onSelectionChangeCb: ((sel: ArenaSelection) => void) | null = null;
  private onDrillDownCb: ((roomId: string) => void) | null = null;

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

  setDocument(doc: ArenaDocument | null): void {
    this.unsubscribe?.();
    this.doc = doc;
    this.selection = null;
    this.pendingDoorRoomId = null;
    this.unsubscribe = doc?.on(() => this.redraw()) ?? null;
    this.redraw();
    this.fitView();
  }

  /** Reset pan/zoom so the whole map (sizeGrid, plus a little padding) fits the
   * host's current size — the starting view for a freshly loaded/opened map, and
   * a manual reset the user can reach for after scrolling/zooming around. */
  fitView(): void {
    if (!this.doc) return;
    const map = this.doc.map;
    const contentW = map.sizeGrid.w * GRID_PX + PAD_PX * 2;
    const contentH = map.sizeGrid.h * GRID_PX + PAD_PX * 2;
    const hostW = this.host.clientWidth || contentW;
    const hostH = this.host.clientHeight || contentH;
    const scale = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, Math.min(hostW / contentW, hostH / contentH)));
    this.camera.scale.set(scale);
    this.camera.position.set((hostW - contentW * scale) / 2, (hostH - contentH * scale) / 2);
  }

  private zoomAt(gx: number, gy: number, factor: number): void {
    const oldScale = this.camera.scale.x;
    const newScale = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, oldScale * factor));
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
    e.preventDefault(); // right-drag is pan (below), not a browser context menu
  };

  setTool(tool: ArenaTool): void {
    this.tool = tool;
    this.pendingDoorRoomId = null;
    this.drag = null;
  }

  setSelection(sel: ArenaSelection): void {
    this.selection = sel;
    this.onSelectionChangeCb?.(sel);
    this.redraw();
  }

  getSelection(): ArenaSelection {
    return this.selection;
  }

  onSelectionChange(fn: (sel: ArenaSelection) => void): void {
    this.onSelectionChangeCb = fn;
  }

  onDrillDown(fn: (roomId: string) => void): void {
    this.onDrillDownCb = fn;
  }

  private toGrid(px: number, py: number): { x: number; y: number } {
    const local = this.world.toLocal({ x: px, y: py });
    return { x: local.x / GRID_PX, y: local.y / GRID_PX };
  }

  private roomAt(gx: number, gy: number): ArenaRoom | null {
    if (!this.doc) return null;
    const rooms = this.doc.map.rooms;
    for (let i = rooms.length - 1; i >= 0; i--) {
      const r = rooms[i]!.rectGrid;
      if (gx >= r.x && gx <= r.x + r.w && gy >= r.y && gy <= r.y + r.h) return rooms[i]!;
    }
    return null;
  }

  private cornerNear(gx: number, gy: number, rect: { x: number; y: number; w: number; h: number }): 'nw' | 'ne' | 'sw' | 'se' | null {
    const radius = 1.2;
    const corners: { c: 'nw' | 'ne' | 'sw' | 'se'; x: number; y: number }[] = [
      { c: 'nw', x: rect.x, y: rect.y },
      { c: 'ne', x: rect.x + rect.w, y: rect.y },
      { c: 'sw', x: rect.x, y: rect.y + rect.h },
      { c: 'se', x: rect.x + rect.w, y: rect.y + rect.h },
    ];
    for (const c of corners) if (Math.hypot(gx - c.x, gy - c.y) <= radius) return c.c;
    return null;
  }

  private otherRooms(id: string): ArenaRoom[] {
    return this.doc ? this.doc.map.rooms.filter((r) => r.id !== id) : [];
  }

  private tryConnectDoor(idA: string, idB: string): void {
    if (!this.doc || idA === idB) return;
    const a = this.doc.map.rooms.find((r) => r.id === idA);
    const b = this.doc.map.rooms.find((r) => r.id === idB);
    if (!a || !b) return;
    const ra = a.rectGrid;
    const rb = b.rectGrid;
    // Vertical shared boundary (a's east edge touches b's west edge, or vice versa).
    let passage: { x: number; y: number; w: number; h: number } | null = null;
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

  private toggleEyeCandidate(roomId: string): void {
    if (!this.doc) return;
    this.doc.mutate((map) => {
      const i = map.eyeCandidates.findIndex((e) => e.roomId === roomId);
      if (i >= 0) map.eyeCandidates.splice(i, 1);
      else map.eyeCandidates.push({ roomId, weight: 1 });
    });
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

    if (this.tool === 'room') {
      this.drag = { kind: 'drawRoom', startX: gx, startY: gy, curX: gx, curY: gy };
      return;
    }

    if (this.tool === 'spawn') {
      this.doc.mutate((map) => map.spawns.push({ x: gx, y: gy }));
      this.setSelection({ kind: 'spawn', index: this.doc.map.spawns.length - 1 });
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

    if (this.tool === 'eye') {
      if (hitRoom) this.toggleEyeCandidate(hitRoom.id);
      return;
    }

    // select tool
    if (this.selection?.kind === 'room') {
      const selectedId = this.selection.id;
      const sel = this.doc.map.rooms.find((r) => r.id === selectedId);
      if (sel) {
        const corner = this.cornerNear(g.x, g.y, sel.rectGrid);
        if (corner) {
          const rect = sel.rectGrid;
          const fixedX = corner === 'nw' || corner === 'sw' ? rect.x + rect.w : rect.x;
          const fixedY = corner === 'nw' || corner === 'ne' ? rect.y + rect.h : rect.y;
          this.drag = { kind: 'resizeRoom', id: sel.id, corner, fixedX, fixedY, lastValid: { ...rect } };
          return;
        }
      }
    }

    if (!hitRoom) {
      this.setSelection(null);
      return;
    }

    const now = Date.now();
    if (this.lastClick && this.lastClick.id === hitRoom.id && now - this.lastClick.at < DBLCLICK_MS) {
      this.onDrillDownCb?.(hitRoom.id);
      this.lastClick = null;
      return;
    }
    this.lastClick = { id: hitRoom.id, at: now };
    this.setSelection({ kind: 'room', id: hitRoom.id });
    this.drag = {
      kind: 'moveRoom',
      id: hitRoom.id,
      offsetX: g.x - hitRoom.rectGrid.x,
      offsetY: g.y - hitRoom.rectGrid.y,
      lastValid: { x: hitRoom.rectGrid.x, y: hitRoom.rectGrid.y },
    };
  }

  private onPointerMove(px: number, py: number): void {
    if (this.panDrag) {
      this.camera.position.x += px - this.panDrag.lastX;
      this.camera.position.y += py - this.panDrag.lastY;
      this.panDrag = { lastX: px, lastY: py };
      return;
    }
    if (!this.drag || !this.doc) return;
    const g = this.toGrid(px, py);

    if (this.drag.kind === 'drawRoom') {
      this.drag.curX = Math.round(g.x);
      this.drag.curY = Math.round(g.y);
      const rect = this.normalizedRect(this.drag);
      this.preview.clear();
      const overlaps = this.doc.map.rooms.some((r) => rectsOverlap(r.rectGrid, rect));
      this.preview
        .rect(rect.x * GRID_PX, rect.y * GRID_PX, rect.w * GRID_PX, rect.h * GRID_PX)
        .fill({ color: overlaps ? COLORS.overlapError : COLORS.selection, alpha: 0.25 })
        .stroke({ color: overlaps ? COLORS.overlapError : COLORS.selection, width: 2 });
      return;
    }

    if (this.drag.kind === 'moveRoom') {
      const dragId = this.drag.id;
      const target = this.doc.map.rooms.find((r) => r.id === dragId);
      if (!target) return;
      const nx = Math.round(g.x - this.drag.offsetX);
      const ny = Math.round(g.y - this.drag.offsetY);
      const candidate = { x: nx, y: ny, w: target.rectGrid.w, h: target.rectGrid.h };
      const blocked = this.otherRooms(target.id).some((r) => rectsOverlap(r.rectGrid, candidate));
      if (!blocked) {
        target.rectGrid.x = nx;
        target.rectGrid.y = ny;
        this.drag.lastValid = { x: nx, y: ny };
      } else {
        target.rectGrid.x = this.drag.lastValid.x;
        target.rectGrid.y = this.drag.lastValid.y;
      }
      this.redraw();
      return;
    }

    if (this.drag.kind === 'resizeRoom') {
      const dragId = this.drag.id;
      const target = this.doc.map.rooms.find((r) => r.id === dragId);
      if (!target) return;
      const gxr = Math.round(g.x);
      const gyr = Math.round(g.y);
      const x = Math.min(this.drag.fixedX, gxr);
      const y = Math.min(this.drag.fixedY, gyr);
      const w = Math.max(1, Math.abs(gxr - this.drag.fixedX));
      const h = Math.max(1, Math.abs(gyr - this.drag.fixedY));
      const candidate = { x, y, w, h };
      const blocked = this.otherRooms(target.id).some((r) => rectsOverlap(r.rectGrid, candidate));
      if (!blocked) {
        Object.assign(target.rectGrid, candidate);
        this.drag.lastValid = candidate;
      } else {
        Object.assign(target.rectGrid, this.drag.lastValid);
      }
      this.redraw();
      return;
    }
  }

  private normalizedRect(drag: { startX: number; startY: number; curX: number; curY: number }) {
    const x = Math.min(drag.startX, drag.curX);
    const y = Math.min(drag.startY, drag.curY);
    const w = Math.max(1, Math.abs(drag.curX - drag.startX));
    const h = Math.max(1, Math.abs(drag.curY - drag.startY));
    return { x, y, w, h };
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
    if (this.drag.kind === 'drawRoom') {
      const rect = this.normalizedRect(this.drag);
      this.preview.clear();
      const overlaps = this.doc.map.rooms.some((r) => rectsOverlap(r.rectGrid, rect));
      if (overlaps) {
        this.drag = null;
        return; // rejected — reuse the room tool to try again elsewhere
      }
      let id = '';
      this.doc.mutate((map) => {
        id = `room_${map.rooms.length + 1}`;
        map.rooms.push({ id, rectGrid: rect, solids: [] });
      });
      this.setSelection({ kind: 'room', id });
      this.drag = null;
      return;
    }
    this.doc.mutate(() => {}); // autosave + emit for move/resize
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
          // Cascade-clean dangling references, matching validate.ts's rules.
          map.doors = map.doors.filter((d) => d.roomA !== sel.id && d.roomB !== sel.id);
          map.eyeCandidates = map.eyeCandidates.filter((c) => c.roomId !== sel.id);
        } else if (sel.kind === 'spawn') {
          map.spawns.splice(sel.index, 1);
        }
      });
      this.setSelection(null);
    }
  };

  redraw(): void {
    this.shapes.clear();
    this.labels.removeChildren();
    this.preview.clear();
    if (!this.doc) return;
    const map = this.doc.map;

    this.shapes.rect(0, 0, map.sizeGrid.w * GRID_PX, map.sizeGrid.h * GRID_PX).fill({ color: COLORS.ground }).stroke({ color: COLORS.gridLine, width: 1 });

    for (const room of map.rooms) {
      const r = room.rectGrid;
      const selected = this.selection?.kind === 'room' && this.selection.id === room.id;
      const isEye = map.eyeCandidates.some((e) => e.roomId === room.id);
      this.shapes
        .rect(r.x * GRID_PX, r.y * GRID_PX, r.w * GRID_PX, r.h * GRID_PX)
        .fill({ color: isEye ? COLORS.eyeCandidate : COLORS.roomBounds, alpha: isEye ? 0.35 : 0.6 })
        .stroke({ color: selected ? COLORS.selection : COLORS.wallEdge, width: selected ? 3 : 1.5 });
      this.addLabel(room.id, r.x * GRID_PX + 3, r.y * GRID_PX + 2);
    }

    for (const door of map.doors) {
      const p = door.passageGrid;
      this.shapes.rect(p.x * GRID_PX, p.y * GRID_PX, p.w * GRID_PX, p.h * GRID_PX).fill({ color: COLORS.door });
    }

    for (const spawn of map.spawns) {
      this.shapes.circle(spawn.x * GRID_PX, spawn.y * GRID_PX, 4).fill({ color: COLORS.player });
    }

    if (this.pendingDoorRoomId) {
      const room = map.rooms.find((r) => r.id === this.pendingDoorRoomId);
      if (room) {
        const r = room.rectGrid;
        this.shapes.rect(r.x * GRID_PX, r.y * GRID_PX, r.w * GRID_PX, r.h * GRID_PX).stroke({ color: COLORS.door, width: 3 });
      }
    }
  }

  private addLabel(text: string, x: number, y: number): void {
    const t = new Text({ text, style: { fill: 0xd8dee9, fontSize: 9, fontFamily: 'monospace' } });
    t.position.set(x, y);
    this.labels.addChild(t);
  }
}
