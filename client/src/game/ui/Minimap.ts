import { Container, Graphics } from 'pixi.js';
import type { ArenaMap, RoomId } from '@dd/engine/content/arenas';
import { computeMinimapLayout, type RoomStatus } from './minimapLayout';

const STATUS_COLOR: Record<RoomStatus, number> = {
  safe: 0x2a3140,
  closing: 0xf6ad55, // WARN telegraph tint (matches CONFIG's amber-family fx colours)
  danger: 0x9b2c2c, // already poison
  unvisited: 0x384258, // PvE-only (dungeonRoomStatus) — dim/muted, never a zone read
};

export interface MinimapPlayer {
  roomId: RoomId | undefined;
  alive: boolean;
  isLocal: boolean;
}

/** Shared room-graph minimap for both PvP arenas and PvE dungeon floors (design/10
 * "room progress"; PvE wiring 2026-08-05, retiring the old `FloorProgress` track), a
 * thin Pixi wrapper over the pure `computeMinimapLayout` (minimapLayout.ts). Mode-
 * specific room-status logic (PvP zone read vs PvE activation/combat) lives entirely
 * in the caller's `statusOf` resolver — this widget doesn't know which mode it's
 * drawing, only that every room has SOME `RoomStatus`. */
export class Minimap {
  readonly view = new Container();
  private bg = new Graphics();
  private doors = new Graphics();
  private rooms = new Graphics();
  private dots = new Graphics();
  private box: { w: number; h: number };

  constructor(box: { w: number; h: number }) {
    this.box = box;
    this.bg.roundRect(0, 0, box.w, box.h, 6).fill({ color: 0x0b0e14, alpha: 0.7 });
    this.view.addChild(this.bg, this.doors, this.rooms, this.dots);
  }

  update(map: ArenaMap, statusOf: (roomId: RoomId) => RoomStatus, players: readonly MinimapPlayer[]) {
    const layout = computeMinimapLayout(map, this.box);
    const byId = new Map(layout.rooms.map((r) => [r.id, r]));

    this.doors.clear();
    for (const d of layout.doors) {
      this.doors.moveTo(d.x1, d.y1).lineTo(d.x2, d.y2).stroke({ width: 1, color: 0x4c566a, alpha: 0.8 });
    }

    this.rooms.clear();
    for (const r of layout.rooms) {
      const status = statusOf(r.id);
      this.rooms
        .rect(r.x, r.y, Math.max(1, r.w), Math.max(1, r.h))
        .fill({ color: STATUS_COLOR[status], alpha: status === 'danger' ? 0.5 : status === 'unvisited' ? 0.4 : 0.9 });
    }

    this.dots.clear();
    for (const p of players) {
      if (!p.roomId) continue;
      const r = byId.get(p.roomId);
      if (!r) continue;
      const color = p.isLocal ? 0x68d391 : p.alive ? 0xe2e8f0 : 0x718096;
      this.dots.circle(r.x + r.w / 2, r.y + r.h / 2, p.isLocal ? 4 : 3).fill({ color });
    }
  }
}
