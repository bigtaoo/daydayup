import { Container, Graphics } from 'pixi.js';
import { RigSkin } from '../../render/RigSkin';
import { getRigSkin } from '../../render/skinRegistry';
import type { WeaponVisualKind } from '../../render/weaponSkins';

// Appearance layer (see design/02-entity-model.md).
// A skin is either the Graphics placeholder (default — no real art preloaded
// for this name yet) or a real `.tao` rig (design/12) once one has been
// preloaded via render/skinRegistry — same public interface either way, so
// callers (Actor.ts) never need to know which they got ("Placeholder-first,
// atlas-later... same interface", design/12).
// Key: handAnchor() provides the weapon mount point — later driven by animation frames.
export class Skin {
  readonly view = new Container();
  private front?: Graphics;
  private rig?: RigSkin;
  private rigScale = 1; // the wrapper's authoring-px -> gameplay-radius factor (see below)
  private clock = 0;

  // `rigTint` is a Pixi multiply-tint applied to the rig's sprites (design/13's
  // "one neutral-grey critter body, re-tinted per elemental variant at RUNTIME" —
  // never used for a character skin, which already carries its own real colours).
  constructor(bodyColor: number, frontColor: number, radius: number, skinName?: string, rigTint?: number) {
    const loaded = skinName ? getRigSkin(skinName) : undefined;

    if (loaded) {
      this.rig = new RigSkin(loaded.rig, loaded.bundle);
      if (rigTint !== undefined) this.rig.setTint(rigTint);
      // Normalize the rig's authoring-px footprint to this actor's gameplay radius
      // on a separate wrapper — RigSkin.view's own scale.x is its L/R flip toggle
      // (facingFromAim), so scaling that same node here would get overwritten
      // (sign-only) every time setAim() runs, silently un-sizing the sprite.
      const wrapper = new Container();
      this.rigScale = radius / loaded.referenceRadius;
      wrapper.scale.set(this.rigScale);
      wrapper.addChild(this.rig.view);
      this.view.addChild(wrapper);
    } else {
      const body = new Graphics();
      // Tilted view: draw the body as a capsule with thickness (not a flat circle) to read volume
      body.roundRect(-radius, -radius * 0.7, radius * 2, radius * 1.9, radius * 0.7)
        .fill({ color: bodyColor });
      body.circle(0, -radius * 0.4, radius * 0.85).fill({ color: bodyColor });

      // "Front / facing" indicator, rotates with facing
      this.front = new Graphics();
      this.front.moveTo(0, 0).lineTo(radius * 1.1, -radius * 0.35)
        .lineTo(radius * 1.1, radius * 0.35).closePath()
        .fill({ color: frontColor });

      this.view.addChild(body, this.front);
    }
    this.view.zIndex = 0;
  }

  // `bodyRad` is the body/legs orientation (world-space radians, movement direction
  // for a player — see Actor's upper/lower body split); `aimRad` is the weapon's own
  // aim/shot direction, tracked independently of the body. `frameDt`/`clipName` drive
  // a real rig's animation clock + which clip plays (design/12's "render clock" —
  // idle/move only for now; attack/hurt/death need GameState signals Actor doesn't
  // carry yet, deliberately left for later). The Graphics placeholder only has a body
  // front-indicator (its cosmetic weapon Graphics is rotated separately by Actor), so
  // it ignores `aimRad`/`frameDt`/`clipName`.
  setFacing(bodyRad: number, aimRad: number, frameDt = 0, clipName = 'idle') {
    if (this.rig) {
      this.clock += frameDt;
      this.rig.playClip(clipName, this.clock);
      this.rig.setBodyFacing(bodyRad);
      this.rig.setAim(aimRad);
      this.rig.update();
    } else {
      this.front!.rotation = bodyRad;
    }
  }

  // Hand anchor (in actor-local coords). Fixed in the demo; later driven by animation frames.
  handAnchor(): { x: number; y: number } {
    return { x: 0, y: 2 };
  }

  /** The mounted weapon's business end in `view`-local coords (see `RigSkin.muzzleLocal`
   *  for why this exists and how the point is derived). Null on the Graphics placeholder
   *  and on any rig with no weapon module mounted — the placeholder's own barrel already
   *  ends at `radiusPx * 1.3`, which is within a pixel of the enemy gun's sim muzzle
   *  offset, so those bullets never needed correcting. Only valid after `setFacing` has
   *  laid the rig out for this frame. */
  muzzleAnchor(): { x: number; y: number } | null {
    const local = this.rig?.muzzleLocal();
    if (!local) return null;
    // `wrapper` (the constructor's authoring-px -> gameplay-radius normalization) sits
    // between the rig and `view`, so its uniform scale still has to be applied.
    const s = this.rigScale;
    return { x: local.x * s, y: local.y * s };
  }

  /** Whether a real `.tao` rig is active (vs. the Graphics placeholder) — lets Actor
   *  decide whether its own cosmetic weapon Graphics is still needed. */
  get hasRig(): boolean {
    return !!this.rig;
  }

  /** Forward the equipped weapon's kind to the rig's socket mount (design/03/12/13).
   *  No-op on the Graphics placeholder (no socket to mount onto). */
  setWeaponKind(kind: WeaponVisualKind | null, name?: string): void {
    this.rig?.setWeaponKind(kind, name);
  }

  /** Re-tint the mounted weapon sprite to its element hue (design/03/13 "element =
   *  colour"). No-op on the Graphics placeholder. */
  setWeaponTint(color: number): void {
    this.rig?.setWeaponTint(color);
  }
}
