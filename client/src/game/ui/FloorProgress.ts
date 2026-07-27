import { Container, Graphics } from 'pixi.js';
import { computeFloorProgress, type StageStatus } from './floorProgressMath';

const STATUS_COLOR: Record<StageStatus, number> = {
  done: 0x68d391, // matches the extract/heal green used elsewhere in the HUD
  current: 0xf6ad55, // amber — matches the PvP minimap's 'closing' telegraph tint
  upcoming: 0x2a3140, // matches the PvP minimap's 'safe' room fill
};

/** PvE dungeon-floor progress track (design/10 "a real PvE minimap") — a thin Pixi
 * wrapper over the pure `computeFloorProgress` (floorProgressMath.ts; see that
 * file's header for why this is a track, not a spatial map like the PvP room-graph
 * `Minimap`). No-op/hidden when `stageCount` is 0 (a non-dungeon config). */
export class FloorProgress {
  readonly view = new Container();
  private g = new Graphics();
  private static readonly NODE_R = 6;
  private static readonly SPACING = 20;

  constructor() {
    this.view.addChild(this.g);
  }

  update(stageCount: number, roomIndex: number) {
    const steps = computeFloorProgress(stageCount, roomIndex);
    this.view.visible = steps.length > 0;
    this.g.clear();
    const r = FloorProgress.NODE_R;
    for (const s of steps) {
      const cx = s.index * FloorProgress.SPACING + r;
      const color = STATUS_COLOR[s.status];
      if (s.capstone) {
        // A small diamond marks the checkpoint/boss room — the one stage every floor
        // guarantees (dungeon.ts), so it's always the visually distinct final node.
        this.g
          .poly([cx, 0, cx + r, r, cx, r * 2, cx - r, r])
          .fill({ color });
      } else {
        this.g.circle(cx, r, r).fill({ color });
      }
    }
  }
}
