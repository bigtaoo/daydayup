import { Container, Sprite } from 'pixi.js';
import type { Rig } from './Rig';
import type { RigSkinBundle } from './taoBundle';
import type { AnimationClip, ResolvedBoneTransform, WorldPose } from './types';
import { sampleClip } from './interpolate';
import { facingFromAim } from './facing';
import { getWeaponAnchor, getWeaponScale, getWeaponTexture, type WeaponVisualKind } from './weaponSkins';

// The socket that visibly carries the mounted weapon sprite (design/03 "swapping the
// active slot swaps which socket fires" — the demo's `attack` clip already privileges
// this socket for its recoil kick, so mounting here keeps the two in sync). Both
// sockets still track aim rotation below; only this one shows a weapon module.
const ACTIVE_WEAPON_SOCKET = 'socket_r';
const SOCKET_IDS = new Set(['socket_l', 'socket_r']);

// The game-side .tao runtime renderer (design/12): bone FK + sprite binding +
// animation playback, ported from tools/animator/src/rendering/Renderer.ts's
// `updateSprites` (rewritten for Pixi v8's API — the editor is still on v7).
//
// Facing model (design/12 "Facing model (twin-stick 360° aim)"): a 2D bone rig
// gives L/R flip + part rotation, not a true 3D turn.
//   - L/R mirror: the WHOLE rig flips by the horizontal sign of the aim vector
//     (`view.scale.x`) — cheap and correct for a radially-ish symmetric orb.
//   - Front/back hemisphere: aim toward the bottom of the screen (dy >= 0, toward
//     the camera) shows each slot's default frame; aim toward the top (dy < 0,
//     away) swaps in that slot's 'back' variant where one exists (today: only
//     `eye` has one — the concept turnaround's eye/vent swap).
//   - Aim-tracking socket rotation: socket_l/socket_r's WORLD rotation is
//     overridden every frame to the live aim angle (design/03/12/13 "following
//     that socket's aim rotation every frame") instead of playing only their
//     authored clip. The rig is authored assuming it faces right (rest pose
//     `wa`/binding.rotation are canonical, unflipped); when `view.scale.x` mirrors
//     the whole rig for a leftward aim, a socket's LOCAL rotation must be the
//     mirror image of the true aim angle so the flip renders it pointing at the
//     real reticle — see `canonicalSocketAngleRad` below.
export class RigSkin {
  readonly view = new Container();
  private readonly sprites = new Map<string, Sprite>();
  private clip: AnimationClip | null = null;
  private clipT = 0;
  private showBack = false;
  private flipX: 1 | -1 = 1;
  private aimRad = 0;
  private weaponKind: WeaponVisualKind | null = null;
  private weaponSprite: Sprite | null = null;
  private weaponTint = 0xffffff;

  constructor(
    private readonly rig: Rig,
    private readonly bundle: RigSkinBundle,
  ) {
    for (const boneId of rig.drawOrder) {
      const binding = bundle.bindings.get(boneId);
      const texture = bundle.textures.get(boneId);
      if (!binding || !texture) continue;

      const sprite = new Sprite(texture);
      sprite.anchor.set(binding.anchorX, binding.anchorY);
      sprite.zIndex = binding.zOrder;
      this.sprites.set(boneId, sprite);
      this.view.addChild(sprite);
    }
    this.view.sortableChildren = true;
  }

  /** Select which clip plays and at what local time (ms — converted to the seconds
   *  clip.duration/keyframe.time are authored in, tools/animator's AnimationController). */
  playClip(name: string, tMs: number): void {
    this.clip = this.bundle.clips.get(name) ?? null;
    const tSec = tMs / 1000;
    this.clipT = this.clip?.loop && this.clip.duration > 0 ? tSec % this.clip.duration : tSec;
  }

  /** Aim direction (radians, standard math convention, y-down screen space) — drives
   *  L/R flip + front/back hemisphere + socket aim-tracking. */
  setAim(rad: number): void {
    const { flipX, showBack } = facingFromAim(rad);
    this.view.scale.x = flipX;
    this.showBack = showBack;
    this.flipX = flipX;
    this.aimRad = rad;
  }

  /** Multiply-tint every bone sprite (design/13: a neutral-grey body re-tinted per
   *  elemental variant at runtime, e.g. critter-core — never called for a character
   *  skin, which already carries its own real colours). The weapon sprite (mounted
   *  separately, not a bone) is deliberately left untinted. */
  setTint(color: number): void {
    this.sprites.forEach(sprite => {
      sprite.tint = color;
    });
  }

  /** Which weapon module (if any) the active socket (`ACTIVE_WEAPON_SOCKET`) mounts —
   *  null hides it (unarmed / no rig / texture not preloaded yet). design/13's
   *  universal mount: one neutral sprite per KIND, not per weapon frame. */
  setWeaponKind(kind: WeaponVisualKind | null): void {
    this.weaponKind = kind;
  }

  /** Re-tint the mounted weapon sprite (design/03/13 "element = colour" — a fire/ice/
   *  lightning/poison weapon reads in its element hue, physical stays neutral). Applied
   *  immediately if the sprite already exists; otherwise picked up the next time
   *  `updateWeaponSprite` (re)creates it. */
  setWeaponTint(color: number): void {
    this.weaponTint = color;
    if (this.weaponSprite) this.weaponSprite.tint = color;
  }

  /** The canonical (pre-mirror) local rotation, in RADIANS, that renders as the true
   *  world aim angle once `view.scale.x` possibly flips the whole rig (see class doc). */
  private canonicalSocketAngleRad(): number {
    return this.flipX === 1 ? this.aimRad : Math.PI - this.aimRad;
  }

  /** Recompute FK from the current clip sample and push it onto the sprites. Call once per render frame. */
  update(): void {
    const transforms: Map<string, ResolvedBoneTransform> = this.clip
      ? sampleClip(this.clip, this.clipT)
      : new Map();
    const worldPose = this.rig.computeFK(0, 0, transforms);
    const canonicalSocketDeg = (this.canonicalSocketAngleRad() * 180) / Math.PI;

    this.sprites.forEach((sprite, boneId) => {
      const pose = worldPose.get(boneId);
      const binding = this.bundle.bindings.get(boneId)!;
      if (!pose) return;

      const backTexture = this.showBack ? this.bundle.textures.get(`${boneId}__back`) : undefined;
      sprite.texture = backTexture ?? this.bundle.textures.get(boneId)!;

      const transform = transforms.get(boneId);
      sprite.x = pose.sx + (transform?.translateX ?? 0);
      sprite.y = pose.sy + (transform?.translateY ?? 0);
      const worldAngleDeg = SOCKET_IDS.has(boneId) ? canonicalSocketDeg : pose.wa;
      sprite.rotation = ((worldAngleDeg + binding.rotation + (transform?.rotation ?? 0)) * Math.PI) / 180;
      sprite.scale.set(
        (binding.flipX ? -1 : 1) * (transform?.scaleX ?? 1) * binding.scaleX,
        (transform?.scaleY ?? 1) * binding.scaleY,
      );
      sprite.alpha = transform?.alpha ?? 1;
    });

    this.updateWeaponSprite(worldPose.get(ACTIVE_WEAPON_SOCKET));
  }

  /** Mount/move/hide the equipped weapon's business-end sprite on the active socket's
   *  world transform (design/03 universal mount — render-only, never touches the sim). */
  private updateWeaponSprite(socketPose: WorldPose | undefined): void {
    if (!this.weaponKind || !socketPose) {
      if (this.weaponSprite) this.weaponSprite.visible = false;
      return;
    }
    const texture = getWeaponTexture(this.weaponKind);
    if (!texture) {
      if (this.weaponSprite) this.weaponSprite.visible = false;
      return;
    }

    if (!this.weaponSprite) {
      this.weaponSprite = new Sprite(texture);
      this.weaponSprite.zIndex = (this.bundle.bindings.get(ACTIVE_WEAPON_SOCKET)?.zOrder ?? 0) + 1;
      this.weaponSprite.tint = this.weaponTint;
      this.view.addChild(this.weaponSprite);
      this.view.sortableChildren = true;
    }
    const anchor = getWeaponAnchor(this.weaponKind);
    const scale = getWeaponScale(this.weaponKind);
    this.weaponSprite.texture = texture;
    this.weaponSprite.anchor.set(anchor.x, anchor.y);
    this.weaponSprite.scale.set(scale);
    this.weaponSprite.visible = true;
    this.weaponSprite.x = socketPose.sx;
    this.weaponSprite.y = socketPose.sy;
    this.weaponSprite.rotation = this.canonicalSocketAngleRad();
  }
}
