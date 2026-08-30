import { Graphics } from 'pixi.js';
import type { DamageType } from '@dd/engine';
import { THEME, ELEMENT_COLORS } from '../theme';
import { Entity } from './Entity';
import type { Faction } from './Actor';

// Bullet view. Pure presentation: a coloured dot with a shadow, positioned by the
// engine each tick. The engine may flip a bullet's faction (melee deflect: enemy →
// player); the view re-reads faction each reconcile and recolours to match.
//
// Per-element polish (design/03/07): an elemental bullet is drawn in its element
// hue with a soft additive glow halo, so a fire/ice/lightning/poison shot reads at a
// glance — distinct from a plain (faction-coloured) physical round. The world-space
// motion trail is spawned by Game (fx layer), keyed off the same element colour.
/**
 * How far (in world px of TRAVEL, not wall-clock time) a bullet eases from its shooter's
 * drawn muzzle onto its true sim line (setMuzzleOrigin) before the correction is fully spent.
 *
 * Was a fixed 120ms budget until 2026-08-30 (user report *"子弹的弹道，现在会从枪口曲线跑到角色
 * 身前再继续飞向目标"*): at the ~10 grid/s (320 world px/s) most weapons fire, 120ms covers
 * ~38 world px, which read fine — but a slow weapon like frostbrand (`bulletSpeed: 6`, 192
 * world px/s) only covers ~23 px in the same 120ms, so the ~12-14 px offset measured on real
 * shots (the commit that introduced this correction, "most of a body radius") ate over half of
 * its early flight instead of a third. A slow bullet lingered right in front of the shooter
 * while the offset drained, which read as the shot curving there before straightening out
 * toward the target, rather than as leaving the barrel cleanly.
 *
 * Budgeting by distance travelled instead keeps the correction's visual footprint (offset px
 * over budget px) the same fraction of early flight for every `bulletSpeed` — a slow bullet
 * just takes longer, in ms, to cover the same 40 px, instead of spending its whole time budget
 * over a shorter distance.
 */
const MUZZLE_EASE_DISTANCE_PX = 40;
/**
 * How long a bullet's spawn "pop" lasts (2026-08-30, user report *"子弹出现的也很突兀"*).
 *
 * A round used to appear at full size, full opacity, on one frame — nothing about the picture
 * distinguished the frame it came into existence from the frames it merely travelled through,
 * so it read as popping into the air rather than as being fired. Two overlapping cues fix
 * that, both purely temporal: the core is thrown a little OVERSIZE and settles to its true
 * radius, and a bright additive flare rides the round out of the barrel and collapses.
 *
 * ~2.7 sim ticks — comfortably inside how long even the SLOWEST weapon takes to spend
 * `MUZZLE_EASE_DISTANCE_PX`'s own correction, so the whole "leaving the gun" read (barrel-tip
 * origin + pop) is over within the first few frames of flight and the bullet spends the rest
 * of its life drawn exactly as before.
 */
const SPAWN_POP_MS = 90;
/** How much oversize the core starts at, as a fraction of its radius. Small on purpose — this
 *  is a punch, not a growing ball; at much more than this the round reads as changing size
 *  mid-flight, which is a lie about a bullet whose hitbox never changes. */
const SPAWN_POP_SCALE = 0.9;
/** The departure flare's radius, in bullet radii. Bigger than the pop because it is a glow
 *  around the round rather than the round itself. */
const SPAWN_FLARE_R = 3.2;

export class Bullet extends Entity {
  private glow = new Graphics(); // additive halo, behind the core (elemental only)
  private gfx = new Graphics();
  private flare = new Graphics(); // one-shot departure glow (see SPAWN_POP_MS)
  private popMs = SPAWN_POP_MS; // remaining spawn-pop time; 0 = drawn at its true size
  private radiusPx: number;
  private faction: Faction | null = null;
  private damageType: DamageType = 'physical';
  private originDx = 0; // muzzle-origin correction (see setMuzzleOrigin)
  private originDy = 0;
  private originRemainingPx = 0; // world px of travel left to spend; 0 = drawn exactly at the sim position
  // Last-seen un-offset (sim-interpolated) position, for measuring how far the bullet has
  // actually travelled since `setMuzzleOrigin` — seeded there from curX/curY, not lazily on
  // the first interpolate() call, so a fast-forwarded catch-up (several sim ticks landing
  // before the view's first render frame) is measured too instead of read as "no travel yet".
  private lastBaseX = 0;
  private lastBaseY = 0;

  constructor(radiusPx: number) {
    super();
    this.radiusPx = radiusPx;
    this.glow.blendMode = 'add';
    // The flare's geometry never changes (it is sized off the radius alone, which is fixed for
    // a given bullet), so it is drawn once here — only its scale and alpha animate. Drawn in
    // white rather than in `color`, because `setFaction`/`setElement` land AFTER construction
    // and a departure flash is a value spike either way.
    this.flare.circle(0, 0, radiusPx * SPAWN_FLARE_R).fill({ color: 0xffffff, alpha: 0.5 });
    this.flare.circle(0, 0, radiusPx * SPAWN_FLARE_R * 0.45).fill({ color: 0xffffff, alpha: 0.5 });
    this.flare.blendMode = 'add';
    this.addChild(this.glow, this.gfx, this.flare);
    this.makeShadow(radiusPx * 0.8);
  }

  setFaction(faction: Faction): void {
    if (faction === this.faction) return;
    this.faction = faction;
    this.redraw();
  }

  setElement(type: DamageType): void {
    if (type === this.damageType) return;
    this.damageType = type;
    this.redraw();
  }

  /** The bullet's fx colour: its element hue, or the faction colour if physical. */
  get color(): number {
    return (
      ELEMENT_COLORS[this.damageType] ??
      (this.faction === 'enemy' ? THEME.colors.bulletEnemy : THEME.colors.bulletPlayer)
    );
  }

  private redraw(): void {
    const color = this.color;
    const r = this.radiusPx;
    this.gfx.clear();
    this.gfx.circle(0, 0, r).fill({ color });

    // Elemental rounds get a halo; physical rounds stay a clean dot.
    this.glow.clear();
    if (ELEMENT_COLORS[this.damageType] !== undefined) {
      for (let i = 3; i >= 1; i--) {
        this.glow.circle(0, 0, r * (1 + i * 0.5)).fill({ color, alpha: 0.12 });
      }
    }
  }

  /**
   * Draw this bullet leaving the shooter's actual barrel tip (`Scene` supplies the
   * offset from the engine's spawn point to the drawn muzzle) and ease onto the
   * authoritative sim line over `MUZZLE_EASE_DISTANCE_PX` of travel. Render-only,
   * applied on top of the interpolated sim position — nothing here is ever read back
   * into the sim.
   *
   * A decaying offset rather than just a different starting point, because the two
   * lines are PARALLEL, not merely offset at their origins: the sim places its muzzle
   * `muzzleOffset` along the aim ray on the GROUND plane and then lifts it by `bulletZ`,
   * while the rig rotates the gun in screen space at the socket bone's own height. Aim
   * downward and the sim's spawn slides "south" across the floor while the drawn barrel
   * swings down the screen — so a bullet that merely STARTED at the muzzle would still
   * fly along a visibly separate line below it (~16 world px, and this camera zooms 4x).
   * Easing the offset out instead lets the shot leave the barrel and rejoin its true
   * path within the first `MUZZLE_EASE_DISTANCE_PX` of flight, by which point the gap
   * is invisible.
   *
   * The shadow is deliberately left on the un-offset ground point: it marks where the
   * bullet actually is in the world, which is the sim position, not the drawn one.
   */
  setMuzzleOrigin(dx: number, dy: number): void {
    this.originDx = dx;
    this.originDy = dy;
    this.originRemainingPx = MUZZLE_EASE_DISTANCE_PX;
    this.lastBaseX = this.curX;
    this.lastBaseY = this.curY;
  }

  override interpolate(alpha: number, frameDt: number): void {
    super.interpolate(alpha, frameDt);
    if (this.popMs > 0) {
      this.popMs = Math.max(0, this.popMs - frameDt);
      const k = this.popMs / SPAWN_POP_MS; // 1 at the shot → 0 once settled
      const ease = k * k; // same ease-out shape as the muzzle correction below
      const s = 1 + SPAWN_POP_SCALE * ease;
      this.gfx.scale.set(s);
      this.glow.scale.set(s);
      // The flare runs the other way: it starts at full size and collapses into the round.
      this.flare.scale.set(0.25 + 0.75 * ease);
      this.flare.alpha = ease;
      this.flare.visible = this.popMs > 0;
    }
    if (this.originRemainingPx <= 0) return;
    // The GROUND-space interpolated position (same formula `Entity.interpolate` used to write
    // `this.x/y`, computed again here rather than read back off `this.x/y`): the latter is
    // already screen space, `y` shifted up by this frame's `z` lift, which would read every
    // z-height change as extra "travel" and drain the budget for a reason that has nothing to
    // do with how far the bullet has actually flown. Diffing against the same point last frame
    // (or, on the first call, against the spawn position `setMuzzleOrigin` seeded from
    // curX/curY) measures actual world-px travel, not elapsed time, so the budget below drains
    // at the bullet's own speed rather than a fixed wall-clock rate.
    const baseX = this.prevX + (this.curX - this.prevX) * alpha;
    const baseY = this.prevY + (this.curY - this.prevY) * alpha;
    const traveled = Math.hypot(baseX - this.lastBaseX, baseY - this.lastBaseY);
    this.originRemainingPx = Math.max(0, this.originRemainingPx - traveled);
    this.lastBaseX = baseX;
    this.lastBaseY = baseY;
    if (this.originRemainingPx <= 0) return;
    const k = this.originRemainingPx / MUZZLE_EASE_DISTANCE_PX;
    const ease = k * k; // ease-out: most of the correction is spent in the first frames
    this.x += this.originDx * ease;
    this.y += this.originDy * ease;
  }
}
