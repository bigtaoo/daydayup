import { Application, Container, Graphics, Rectangle, Text } from 'pixi.js';
import { COLORS } from '../colors';
import { nextId, type RoomEditTarget, type Selection, type SelectionLayer, type ToolKind } from './RoomEditTarget';

const GRID_PX = 24;
const PAD_PX = 24;
const POINT_HIT_RADIUS = 0.6; // grid units

type AnyShape = {
  x?: number;
  y?: number;
  w?: number;
  h?: number;
  center?: { x: number; y: number };
  point?: { x: number; y: number };
  rectGrid?: { x: number; y: number; w: number; h: number };
};

/** A shape's "position" for hit-testing/move — a pillar's center, a loot marker's
 * point, a cellTrait's nested rectGrid origin, or a flat x/y (solids/props/spawns). */
function shapePos(item: AnyShape): { x: number; y: number } {
  if (item.center) return item.center;
  if (item.point) return item.point;
  if (item.rectGrid) return item.rectGrid;
  return { x: item.x ?? 0, y: item.y ?? 0 };
}

function setShapePos(item: AnyShape, x: number, y: number): void {
  if (item.center) {
    item.center.x = x;
    item.center.y = y;
  } else if (item.point) {
    item.point.x = x;
    item.point.y = y;
  } else if (item.rectGrid) {
    item.rectGrid.x = x;
    item.rectGrid.y = y;
  } else {
    item.x = x;
    item.y = y;
  }
}

/** The mutable rect (x/y/w/h) a rect-type shape (solid or cellTrait) actually
 * stores its bounds on — itself for a solid, `.rectGrid` for a cellTrait. */
function shapeRect(item: AnyShape): { x: number; y: number; w: number; h: number } {
  const base = item.rectGrid ?? item;
  return { x: base.x ?? 0, y: base.y ?? 0, w: base.w ?? 0, h: base.h ?? 0 };
}

type DragMode =
  | { kind: 'drawRect'; layer: 'solids' | 'cellTraits'; startX: number; startY: number; curX: number; curY: number }
  | { kind: 'drawPillar'; index: number }
  | { kind: 'moveShape'; sel: Selection; offsetX: number; offsetY: number }
  | { kind: 'resizeRect'; sel: Selection; corner: 'nw' | 'ne' | 'sw' | 'se'; fixedX: number; fixedY: number }
  | null;

/** The shared room-detail canvas — draws + edits solids/pillars/props/spawns for
 * either a PvE RoomPiece or one PvP ArenaRoom, via the `RoomEditTarget` adapter
 * (see RoomEditTarget.ts for why one component covers both schemas). */
export class RoomCanvas {
  readonly app = new Application();
  private world = new Container();
  private shapes = new Graphics();
  private labels = new Container();
  private preview = new Graphics();
  private target: RoomEditTarget | null = null;
  private tool: ToolKind = 'select';
  private selection: Selection | null = null;
  private unsubscribe: (() => void) | null = null;
  private drag: DragMode = null;
  private onSelectionChangeCb: ((sel: Selection | null) => void) | null = null;

  constructor(private host: HTMLElement) {}

  async mount(): Promise<void> {
    await this.app.init({ background: COLORS.ground, resizeTo: this.host, antialias: true });
    this.host.appendChild(this.app.canvas);
    this.app.stage.addChild(this.world);
    this.world.position.set(PAD_PX, PAD_PX);
    this.world.addChild(this.shapes, this.labels, this.preview);

    this.app.stage.eventMode = 'static';
    this.app.stage.hitArea = new Rectangle(0, 0, 4000, 4000);
    this.app.stage.on('pointerdown', (e) => this.onPointerDown(e.global.x, e.global.y));
    this.app.stage.on('globalpointermove', (e) => this.onPointerMove(e.global.x, e.global.y));
    this.app.stage.on('pointerup', () => this.onPointerUp());
    this.app.stage.on('pointerupoutside', () => this.onPointerUp());
    window.addEventListener('keydown', this.onKeyDown);
  }

  destroy(): void {
    window.removeEventListener('keydown', this.onKeyDown);
    this.unsubscribe?.();
  }

  setTarget(target: RoomEditTarget | null): void {
    this.unsubscribe?.();
    this.target = target;
    this.selection = null;
    this.onSelectionChangeCb?.(null);
    this.unsubscribe = target?.on(() => this.redraw()) ?? null;
    this.redraw();
  }

  setTool(tool: ToolKind): void {
    this.tool = tool;
    this.drag = null;
  }

  setSelection(sel: Selection | null): void {
    this.selection = sel;
    this.onSelectionChangeCb?.(sel);
    this.redraw();
  }

  getSelection(): Selection | null {
    return this.selection;
  }

  onSelectionChange(fn: (sel: Selection | null) => void): void {
    this.onSelectionChangeCb = fn;
  }

  private toGrid(px: number, py: number): { x: number; y: number } {
    const local = this.world.toLocal({ x: px, y: py });
    return { x: local.x / GRID_PX, y: local.y / GRID_PX };
  }

  private layerArray(layer: SelectionLayer) {
    if (!this.target) return [];
    switch (layer) {
      case 'solids':
        return this.target.getSolids();
      case 'pillars':
        return this.target.getPillars();
      case 'props':
        return this.target.getProps();
      case 'playerSpawns':
        return this.target.getPlayerSpawns();
      case 'enemySpawns':
        return this.target.getEnemySpawns();
      case 'cellTraits':
        return this.target.getCellTraits();
      case 'lootMarkers':
        return this.target.getLootMarkers();
    }
  }

  private hitTest(gx: number, gy: number): Selection | null {
    if (!this.target) return null;
    // Point-ish layers first (small precise targets), reverse order (last-placed on top).
    const pointLayers: SelectionLayer[] = ['lootMarkers', 'enemySpawns', 'playerSpawns', 'props', 'pillars'];
    for (const layer of pointLayers) {
      const arr = this.layerArray(layer) as AnyShape[];
      for (let i = arr.length - 1; i >= 0; i--) {
        const pos = shapePos(arr[i]!);
        if (Math.hypot(gx - pos.x, gy - pos.y) <= POINT_HIT_RADIUS) return { layer, index: i };
      }
    }
    // Rect layers, reverse order.
    const rectLayers: SelectionLayer[] = ['cellTraits', 'solids'];
    for (const layer of rectLayers) {
      const arr = this.layerArray(layer) as AnyShape[];
      for (let i = arr.length - 1; i >= 0; i--) {
        const r = shapeRect(arr[i]!);
        if (gx >= r.x && gx <= r.x + r.w && gy >= r.y && gy <= r.y + r.h) return { layer, index: i };
      }
    }
    return null;
  }

  private rectOf(sel: Selection): { x: number; y: number; w: number; h: number } | null {
    const arr = this.layerArray(sel.layer) as AnyShape[];
    const item = arr[sel.index];
    return item ? shapeRect(item) : null;
  }

  private cornerNear(gx: number, gy: number, rect: { x: number; y: number; w: number; h: number }): 'nw' | 'ne' | 'sw' | 'se' | null {
    const corners: { c: 'nw' | 'ne' | 'sw' | 'se'; x: number; y: number }[] = [
      { c: 'nw', x: rect.x, y: rect.y },
      { c: 'ne', x: rect.x + rect.w, y: rect.y },
      { c: 'sw', x: rect.x, y: rect.y + rect.h },
      { c: 'se', x: rect.x + rect.w, y: rect.y + rect.h },
    ];
    for (const c of corners) {
      if (Math.hypot(gx - c.x, gy - c.y) <= POINT_HIT_RADIUS) return c.c;
    }
    return null;
  }

  private onPointerDown(px: number, py: number): void {
    if (!this.target) return;
    const g = this.toGrid(px, py);
    const gx = Math.round(g.x);
    const gy = Math.round(g.y);

    if (this.tool === 'select') {
      if (this.selection) {
        const rect = this.rectOf(this.selection);
        if (rect && (this.selection.layer === 'solids' || this.selection.layer === 'cellTraits')) {
          const corner = this.cornerNear(g.x, g.y, rect);
          if (corner) {
            const fixedX = corner === 'nw' || corner === 'sw' ? rect.x + rect.w : rect.x;
            const fixedY = corner === 'nw' || corner === 'ne' ? rect.y + rect.h : rect.y;
            this.drag = { kind: 'resizeRect', sel: this.selection, corner, fixedX, fixedY };
            return;
          }
        }
      }
      const hit = this.hitTest(g.x, g.y);
      this.setSelection(hit);
      if (hit) {
        const arr = this.layerArray(hit.layer) as AnyShape[];
        const item = arr[hit.index]!;
        const pos = shapePos(item);
        this.drag = { kind: 'moveShape', sel: hit, offsetX: g.x - pos.x, offsetY: g.y - pos.y };
      }
      return;
    }

    if (this.tool === 'solid' || this.tool === 'cellTrait') {
      this.drag = { kind: 'drawRect', layer: this.tool === 'solid' ? 'solids' : 'cellTraits', startX: gx, startY: gy, curX: gx, curY: gy };
      return;
    }

    if (this.tool === 'pillar') {
      this.target.mutate(() => {
        this.target!.getPillars().push({ center: { x: gx, y: gy }, radius: 1 });
      });
      const index = this.target.getPillars().length - 1;
      this.drag = { kind: 'drawPillar', index };
      this.setSelection({ layer: 'pillars', index });
      return;
    }

    if (this.tool === 'prop') {
      this.target.mutate(() => {
        this.target!.getProps().push({ id: nextId('prop'), x: gx, y: gy });
      });
      this.setSelection({ layer: 'props', index: this.target.getProps().length - 1 });
      return;
    }

    if (this.tool === 'playerSpawn') {
      if (this.target.kind !== 'pve') return;
      this.target.mutate(() => {
        this.target!.getPlayerSpawns().push({ x: gx, y: gy });
      });
      this.setSelection({ layer: 'playerSpawns', index: this.target.getPlayerSpawns().length - 1 });
      return;
    }

    if (this.tool === 'enemySpawn') {
      this.target.mutate(() => {
        this.target!.getEnemySpawns().push({ x: gx, y: gy });
      });
      this.setSelection({ layer: 'enemySpawns', index: this.target.getEnemySpawns().length - 1 });
      return;
    }

    if (this.tool === 'lootMarker') {
      if (this.target.kind !== 'pvp') return;
      this.target.mutate(() => {
        this.target!.getLootMarkers().push({ point: { x: gx, y: gy }, tableId: 'default' });
      });
      this.setSelection({ layer: 'lootMarkers', index: this.target.getLootMarkers().length - 1 });
      return;
    }
  }

  private onPointerMove(px: number, py: number): void {
    if (!this.drag || !this.target) return;
    const g = this.toGrid(px, py);

    if (this.drag.kind === 'drawRect') {
      this.drag.curX = Math.round(g.x);
      this.drag.curY = Math.round(g.y);
      const rect = this.normalizedDrawRect(this.drag);
      this.preview.clear();
      this.preview
        .rect(rect.x * GRID_PX, rect.y * GRID_PX, rect.w * GRID_PX, rect.h * GRID_PX)
        .fill({ color: COLORS.selection, alpha: 0.25 })
        .stroke({ color: COLORS.selection, width: 2 });
      return;
    }

    if (this.drag.kind === 'drawPillar') {
      const pillars = this.target.getPillars();
      const p = pillars[this.drag.index];
      if (!p) return;
      const r = Math.max(0.5, Math.hypot(g.x - p.center.x, g.y - p.center.y));
      p.radius = Math.round(r * 10) / 10;
      this.redraw();
      return;
    }

    if (this.drag.kind === 'moveShape') {
      const arr = this.layerArray(this.drag.sel.layer) as AnyShape[];
      const item = arr[this.drag.sel.index];
      if (!item) return;
      const nx = Math.round(g.x - this.drag.offsetX);
      const ny = Math.round(g.y - this.drag.offsetY);
      setShapePos(item, nx, ny);
      this.redraw();
      return;
    }

    if (this.drag.kind === 'resizeRect') {
      const arr = this.layerArray(this.drag.sel.layer) as AnyShape[];
      const item = arr[this.drag.sel.index];
      if (!item) return;
      const rect = item.rectGrid ?? item;
      const gxr = Math.round(g.x);
      const gyr = Math.round(g.y);
      rect.x = Math.min(this.drag.fixedX, gxr);
      rect.y = Math.min(this.drag.fixedY, gyr);
      rect.w = Math.max(1, Math.abs(gxr - this.drag.fixedX));
      rect.h = Math.max(1, Math.abs(gyr - this.drag.fixedY));
      this.redraw();
      return;
    }
  }

  private normalizedDrawRect(drag: { startX: number; startY: number; curX: number; curY: number }) {
    const x = Math.min(drag.startX, drag.curX);
    const y = Math.min(drag.startY, drag.curY);
    const w = Math.max(1, Math.abs(drag.curX - drag.startX));
    const h = Math.max(1, Math.abs(drag.curY - drag.startY));
    return { x, y, w, h };
  }

  private onPointerUp(): void {
    if (!this.drag || !this.target) {
      this.drag = null;
      return;
    }
    if (this.drag.kind === 'drawRect') {
      const rect = this.normalizedDrawRect(this.drag);
      this.preview.clear();
      const layer = this.drag.layer;
      this.target.mutate(() => {
        if (layer === 'cellTraits') {
          this.target!.getCellTraits().push({ id: nextId('trait'), rectGrid: rect, kind: 'spike', timed: false });
        } else {
          this.target!.getSolids().push(rect);
        }
      });
      const index = this.layerArray(layer).length - 1;
      this.setSelection({ layer, index });
      this.drag = null;
      return;
    }
    this.target.mutate(() => {}); // trigger autosave + emit for move/resize/pillar-radius drags
    this.drag = null;
  }

  private onKeyDown = (e: KeyboardEvent): void => {
    if ((e.key === 'Delete' || e.key === 'Backspace') && this.selection && this.target) {
      const isInput = document.activeElement instanceof HTMLInputElement || document.activeElement instanceof HTMLTextAreaElement;
      if (isInput) return;
      if (!confirm('Delete selected item?')) return;
      const sel = this.selection;
      this.target.mutate(() => {
        const arr = this.layerArray(sel.layer) as unknown[];
        arr.splice(sel.index, 1);
      });
      this.setSelection(null);
    }
  };

  redraw(): void {
    this.shapes.clear();
    this.labels.removeChildren();
    this.preview.clear();
    if (!this.target) return;

    const size = this.target.getSize();
    this.shapes.rect(0, 0, size.w * GRID_PX, size.h * GRID_PX).fill({ color: COLORS.ground });
    for (let x = 0; x <= size.w; x++) this.shapes.moveTo(x * GRID_PX, 0).lineTo(x * GRID_PX, size.h * GRID_PX);
    for (let y = 0; y <= size.h; y++) this.shapes.moveTo(0, y * GRID_PX).lineTo(size.w * GRID_PX, y * GRID_PX);
    this.shapes.stroke({ color: COLORS.gridLine, width: 1 });

    const isSelected = (layer: SelectionLayer, i: number) => this.selection?.layer === layer && this.selection.index === i;

    this.target.getCellTraits().forEach((t, i) => {
      const r = t.rectGrid;
      const sel = isSelected('cellTraits', i);
      this.shapes
        .rect(r.x * GRID_PX, r.y * GRID_PX, r.w * GRID_PX, r.h * GRID_PX)
        .fill({ color: COLORS.cellTrait, alpha: 0.3 })
        .stroke({ color: sel ? COLORS.selection : COLORS.cellTrait, width: sel ? 3 : 1.5 });
      this.addLabel(t.kind, r.x * GRID_PX + 2, r.y * GRID_PX + 2);
    });

    this.target.getSolids().forEach((s, i) => {
      const sel = isSelected('solids', i);
      this.shapes
        .rect(s.x * GRID_PX, s.y * GRID_PX, s.w * GRID_PX, s.h * GRID_PX)
        .fill({ color: COLORS.wall })
        .stroke({ color: sel ? COLORS.selection : COLORS.wallEdge, width: sel ? 3 : 2 });
    });

    this.target.getPillars().forEach((p, i) => {
      const sel = isSelected('pillars', i);
      this.shapes
        .circle(p.center.x * GRID_PX, p.center.y * GRID_PX, p.radius * GRID_PX)
        .fill({ color: COLORS.pillar })
        .stroke({ color: sel ? COLORS.selection : COLORS.pillarTop, width: sel ? 3 : 1.5 });
    });

    this.target.getProps().forEach((p, i) => {
      const sel = isSelected('props', i);
      this.shapes
        .rect(p.x * GRID_PX - 6, p.y * GRID_PX - 6, 12, 12)
        .fill({ color: COLORS.prop })
        .stroke({ color: sel ? COLORS.selection : COLORS.prop, width: sel ? 3 : 1 });
      this.addLabel(p.id, p.x * GRID_PX + 8, p.y * GRID_PX - 6);
    });

    this.target.getPlayerSpawns().forEach((p, i) => {
      const sel = isSelected('playerSpawns', i);
      this.shapes
        .circle(p.x * GRID_PX, p.y * GRID_PX, 8)
        .fill({ color: COLORS.player })
        .stroke({ color: sel ? COLORS.selection : COLORS.player, width: sel ? 3 : 1 });
    });

    this.target.getEnemySpawns().forEach((p, i) => {
      const sel = isSelected('enemySpawns', i);
      this.shapes
        .circle(p.x * GRID_PX, p.y * GRID_PX, 8)
        .fill({ color: COLORS.enemy })
        .stroke({ color: sel ? COLORS.selection : COLORS.enemy, width: sel ? 3 : 1 });
      if (p.type) this.addLabel(p.type, p.x * GRID_PX + 8, p.y * GRID_PX - 6);
    });

    this.target.getLootMarkers().forEach((m, i) => {
      const sel = isSelected('lootMarkers', i);
      const cx = m.point.x * GRID_PX;
      const cy = m.point.y * GRID_PX;
      this.shapes
        .poly([cx, cy - 9, cx + 9, cy, cx, cy + 9, cx - 9, cy])
        .fill({ color: COLORS.lootMarker })
        .stroke({ color: sel ? COLORS.selection : COLORS.lootMarker, width: sel ? 3 : 1 });
      this.addLabel(m.tableId, cx + 10, cy - 6);
    });
  }

  private addLabel(text: string, x: number, y: number): void {
    const t = new Text({ text, style: { fill: 0xd8dee9, fontSize: 10, fontFamily: 'monospace' } });
    t.position.set(x, y);
    this.labels.addChild(t);
  }
}
