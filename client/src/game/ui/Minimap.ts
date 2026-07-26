import { Container, Graphics } from 'pixi.js';
import type { ArenaMap, RoomId } from '@dd/engine/content/arenas';
import type { ZoneState } from '@dd/engine';
import { computeMinimapLayout, roomStatus, type RoomStatus } from './minimapLayout';

const STATUS_COLOR: Record<RoomStatus, number> = {
  safe: 0x2a3140,
  closing: 0xf6ad55, // WARN telegraph tint (matches CONFIG's amber-family fx colours)
  danger: 0x9b2c2c, // already poison
};

export interface MinimapPlayer {
  roomId: RoomId | undefined;
  alive: boolean;
  isLocal: boolean;
}

/** PvP room-graph minimap (design/10 "room progress"), thin Pixi wrapper over the pure
 * `computeMinimapLayout`/`roomStatus` (minimapLayout.ts). No-op/hidden for PvE — see
 * that file's header for why. */
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

  update(map: ArenaMap, zone: ZoneState | undefined, players: readonly MinimapPlayer[]) {
    const layout = computeMinimapLayout(map, this.box);
    const byId = new Map(layout.rooms.map((r) => [r.id, r]));

    this.doors.clear();
    for (const d of layout.doors) {
      this.doors.moveTo(d.x1, d.y1).lineTo(d.x2, d.y2).stroke({ width: 1, color: 0x4c566a, alpha: 0.8 });
    }

    this.rooms.clear();
    for (const r of layout.rooms) {
      const status = roomStatus(zone, r.id);
      this.rooms
        .rect(r.x, r.y, Math.max(1, r.w), Math.max(1, r.h))
        .fill({ color: STATUS_COLOR[status], alpha: status === 'danger' ? 0.5 : 0.9 });
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
