import { Container, Graphics } from 'pixi.js';
import { RigSkin } from '../../render/RigSkin';
import { getRigSkin } from '../../render/skinRegistry';
import type { WeaponVisualKind } from '../../render/weaponSkins';
import { resolveWeaponMount } from '../../render/rigWeaponMount';
import type { AttackKind, ShotShape, SwingShape } from '../../render/rigAttackMotion';

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
  /** The `Rig` behind `this.rig` — kept so `weaponMount` can ask the rig def how (or whether)
   *  this body plan carries a weapon without RigSkin having to re-expose it. */
  private rigDef!: Parameters<typeof resolveWeaponMount>[0];
  private rigScale = 1; // the wrapper's authoring-px -> gameplay-radius factor (see below)
  /** Half-width of the DRAWN body in world px — the gameplay radius scaled by how much of its
   *  declared radius this bundle's art actually paints (`skinRegistry.BODY_FILL`). This, not
   *  the collision radius, is what anything sized against the character's silhouette has to
   *  use; `Actor` sizes its ground shadow from it. Equals `radius` for the Graphics
   *  placeholder, whose capsule really is one radius wide. */
  readonly bodyDrawnR: number;
  /** Height of the DRAWN body in world px, measured off the assembled skin at its rest pose.
   *  Sibling of `bodyDrawnR` and used the same way: the occlusion x-ray asks what FRACTION of
   *  the character a standing block is covering (`scene/occlusion.ts`), and the body's own
   *  height is the only honest denominator for that. Measured rather than derived from
   *  `radius` — a rig's decorative bones hang off its body bone's tip, so the assembled
   *  silhouette is taller than the shell alone. */
  readonly bodyDrawnH: number;
  private clock = 0;

  // `rigTint` is a Pixi multiply-tint applied to the rig's sprites (design/13's
  // "one neutral-grey critter body, re-tinted per elemental variant at RUNTIME" —
  // never used for a character skin, which already carries its own real colours).
  constructor(bodyColor: number, frontColor: number, radius: number, skinName?: string, rigTint?: number) {
    const loaded = skinName ? getRigSkin(skinName) : undefined;
    this.bodyDrawnR = radius * (loaded?.bodyFill ?? 1);

    if (loaded) {
      this.rig = new RigSkin(loaded.rig, loaded.bundle, loaded.bodyFill);
      this.rigDef = loaded.rig;
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
    // Lay the rig out at rest before measuring (a no-op for the placeholder), same reason
    // `Actor` does before reading its own filter bounds: an unposed rig reports nothing.
    this.setFacing(0, 0, 0, 'idle');
    const rest = this.view.getLocalBounds();
    this.bodyDrawnH = rest.height > 0 ? rest.height : radius * 2;
  }

  /** Half-width and height of the DRAWN body in world px — the character's silhouette, not its
   *  collision circle. See `bodyDrawnR`/`bodyDrawnH`. */
  get silhouette(): { halfW: number; bodyH: number } {
    return { halfW: this.bodyDrawnR, bodyH: this.bodyDrawnH };
  }

  // `bodyRad` is the body/legs orientation (world-space radians, movement direction
  // for a player — see Actor's upper/lower body split); `aimRad` is the weapon's own
  // aim/shot direction, tracked independently of the body. `frameDt`/`clipName` drive
  // a real rig's animation clock + which clip plays (design/12's "render clock").
  // `clipName` is the GROUND clip only — idle/move, i.e. "what is this body doing on the
  // floor". The other four clips of the vocabulary are driven by their own signals and
  // outrank or overlay it inside `render/rigClipLayer.ts`: `attack`/`hurt` fold on top, and
  // `spawn`/`death` take over the base layer, so this caller never has to know which of them
  // is in flight. The Graphics placeholder only has a body front-indicator (its cosmetic
  // weapon Graphics is rotated separately by Actor), so it ignores `aimRad`/`frameDt`/`clipName`.
  setFacing(bodyRad: number, aimRad: number, frameDt = 0, clipName = 'idle') {
    if (this.rig) {
      this.clock += frameDt;
      this.rig.advanceClips(frameDt);
      this.rig.playClip(clipName, this.clock);
      this.rig.setBodyFacing(bodyRad);
      this.rig.setAim(aimRad);
      this.rig.update();
    } else {
      this.front!.rotation = bodyRad;
    }
  }

  /** An attack just left this skin (`Actor.onAttack`, driven by the engine's `bullet_fired`
   *  or `melee_swing` event — design/08's one render channel). ONE entry point for both, by
   *  design: either kind starts the same authored `attack` clip layered over idle/move
   *  (`render/rigClipLayer.ts`) and the same aim-relative envelope, which only differs by kind
   *  (`render/rigAttackMotion.ts` — a gun kicks back, a blade sweeps forward), and which the
   *  attacking WEAPON sizes and paces through the shape passed with it. No-op on the Graphics
   *  placeholder, which has neither a clip nor a mounted module to move. */
  attack(kind: 'ranged', shot?: ShotShape): void;
  attack(kind: 'melee', swing?: SwingShape): void;
  attack(kind: AttackKind, shape?: ShotShape | SwingShape): void {
    if (kind === 'melee') this.rig?.attack(kind, shape as SwingShape | undefined);
    else this.rig?.attack(kind, shape as ShotShape | undefined);
  }

  /** The other three engine signals a rig animates (`Actor.onHurt`/`onSpawn`/`onDeath`), each
   *  one authored clip and no procedural half — none of them points along the aim ray, which is
   *  the whole reason `attack` needs one. `hurt` overlays whatever the body is doing; `spawn` and
   *  `death` take over the base layer, because their own first/last poses are far from identity
   *  and an additive layer would step the character twice (`render/rigClipLayer.ts`'s header).
   *  All three are no-ops on the Graphics placeholder, which has no clips at all. */
  hurt(): void { this.rig?.hurt(); }
  spawn(): void { this.rig?.spawn(); }
  die(): void { this.rig?.die(); }

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
  muzzleAnchor(): { x: number; y: number; heightPx: number } | null {
    const local = this.rig?.muzzleLocal();
    if (!local) return null;
    // `wrapper` (the constructor's authoring-px -> gameplay-radius normalization) sits
    // between the rig and `view`, so its uniform scale still has to be applied — to the
    // height as much as to the point, since both are in the rig's authoring px.
    const s = this.rigScale;
    return { x: local.x * s, y: local.y * s, heightPx: local.heightPx * s };
  }

  /** Whether a real `.tao` rig is active (vs. the Graphics placeholder). */
  get hasRig(): boolean {
    return !!this.rig;
  }

  /**
   * How this skin shows an equipped weapon — the single question `Actor` has to answer before
   * deciding whether to draw its own cosmetic `Graphics` bar:
   *
   *   'sprite'      — the rig mounts the real weapon texture itself (`RigSkin`, either mount
   *                   path). Actor must draw nothing, or the two render on top of each other.
   *   'none'        — the rig deliberately shows no weapon (design/13's boss). Actor must
   *                   draw nothing here EITHER, which is the whole point of the distinction.
   *   'placeholder' — no rig loaded, so nothing can mount anything and the Graphics bar is
   *                   the only thing standing in for a weapon.
   *
   * This replaced a `hasRig && faction === 'player'` gate (fixed 2026-08-21). That gate made
   * mounting a property of the FACTION when it is a property of the RIG, and the consequence
   * was that every enemy — all of which do load a real rig — fell through to the placeholder
   * forever: `gun_enemygun.png` shipped fully calibrated in `WEAPON_DEFS` and was never once
   * rendered in the world, while the bar it fell back to drew at the actor's GROUND origin,
   * 11-28 world px below a rig body that floats above that origin. Measured on a real frame,
   * it read as a white rectangle lying on the floor beside the creature, not as a weapon.
   */
  get weaponMount(): 'sprite' | 'placeholder' | 'none' {
    if (!this.rig) return 'placeholder';
    return resolveWeaponMount(this.rigDef) === 'none' ? 'none' : 'sprite';
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
