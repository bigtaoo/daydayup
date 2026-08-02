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
  private lastStepCount = 0;
  private static readonly NODE_R = 6;
  private static readonly SPACING = 20;

  constructor() {
    this.view.addChild(this.g);
  }

  // Icon-first, not a text legend (design/10 legibility fix, 2026-08-02): a spelled-out
  // "green=done amber=now diamond=checkpoint" sentence was tried first (2026-08-01) but
  // reads as debug text next to the rest of the HUD's chrome — this bakes the same
  // meaning into the dots themselves (a checkmark stroke = done, a bright ring = the
  // room you're in, the diamond shape = checkpoint), so no separate key is needed at all.
  update(stageCount: number, roomIndex: number) {
    const steps = computeFloorProgress(stageCount, roomIndex);
    this.view.visible = steps.length > 0;
    this.g.clear();
    const r = FloorProgress.NODE_R;
    for (const s of steps) {
      const cx = s.index * FloorProgress.SPACING + r;
      const cy = r;
      const color = STATUS_COLOR[s.status];
      if (s.capstone) {
        // A diamond marks the checkpoint/boss room — the one stage every floor
        // guarantees (dungeon.ts), so it's always the visually distinct final node.
        this.g.poly([cx, 0, cx + r, r, cx, r * 2, cx - r, r]).fill({ color });
        this.g.poly([cx, 0, cx + r, r, cx, r * 2, cx - r, r]).stroke({ color: 0xfff8e1, alpha: 0.7, width: 1 });
      } else {
        this.g.circle(cx, cy, r).fill({ color });
        if (s.status === 'done') {
          // A small checkmark reads as "cleared" without a word next to it.
          this.g
            .moveTo(cx - r * 0.5, cy)
            .lineTo(cx - r * 0.1, cy + r * 0.4)
            .lineTo(cx + r * 0.55, cy - r * 0.4)
            .stroke({ color: 0x0b2016, alpha: 0.85, width: 1.6 });
        } else if (s.status === 'current') {
          // A bright outer ring reads as "you are here" without a word either.
          this.g.circle(cx, cy, r + 2).stroke({ color: 0xfff3e0, alpha: 0.85, width: 1.6 });
        }
      }
    }
    this.lastStepCount = steps.length;
  }

  /** Cheap, canvas-free width estimate for HudView's backing-panel sizing — see
   * `textWidth.ts` for why this avoids `view.width`/`getBounds()`. */
  estimatedWidth(): number {
    if (this.lastStepCount === 0) return 0;
    return this.lastStepCount * FloorProgress.SPACING + 8;
  }
}
