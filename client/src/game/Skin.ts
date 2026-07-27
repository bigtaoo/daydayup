import { Container, Graphics } from 'pixi.js';
import { RigSkin } from '../render/RigSkin';
import { getRigSkin } from '../render/skinRegistry';
import { ORB_CORE_REFERENCE_RADIUS } from '../render/orbCoreRig';
import type { WeaponVisualKind } from '../render/weaponSkins';

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
  private clock = 0;

  constructor(bodyColor: number, frontColor: number, radius: number, skinName?: string) {
    const loaded = skinName ? getRigSkin(skinName) : undefined;

    if (loaded) {
      this.rig = new RigSkin(loaded.rig, loaded.bundle);
      // Normalize the rig's authoring-px footprint to this actor's gameplay radius
      // on a separate wrapper — RigSkin.view's own scale.x is its L/R flip toggle
      // (facingFromAim), so scaling that same node here would get overwritten
      // (sign-only) every time setAim() runs, silently un-sizing the sprite.
      const wrapper = new Container();
      wrapper.scale.set(radius / ORB_CORE_REFERENCE_RADIUS);
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

  // `rad` is world-space aim angle (radians); `frameDt`/`clipName` drive a real
  // rig's animation clock + which clip plays (design/12's "render clock" —
  // idle/move only for now; attack/hurt/death need GameState signals Actor
  // doesn't carry yet, deliberately left for later). Both are ignored by the
  // Graphics placeholder.
  setFacing(rad: number, frameDt = 0, clipName = 'idle') {
    if (this.rig) {
      this.clock += frameDt;
      this.rig.playClip(clipName, this.clock);
      this.rig.setAim(rad);
      this.rig.update();
    } else {
      this.front!.rotation = rad;
    }
  }

  // Hand anchor (in actor-local coords). Fixed in the demo; later driven by animation frames.
  handAnchor(): { x: number; y: number } {
    return { x: 0, y: 2 };
  }

  /** Whether a real `.tao` rig is active (vs. the Graphics placeholder) — lets Actor
   *  decide whether its own cosmetic weapon Graphics is still needed. */
  get hasRig(): boolean {
    return !!this.rig;
  }

  /** Forward the equipped weapon's kind to the rig's socket mount (design/03/12/13).
   *  No-op on the Graphics placeholder (no socket to mount onto). */
  setWeaponKind(kind: WeaponVisualKind | null): void {
    this.rig?.setWeaponKind(kind);
  }
}
