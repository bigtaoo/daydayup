import { Container, Sprite } from 'pixi.js';
import type { Rig } from './Rig';
import type { RigSkinBundle } from './taoBundle';
import type { AnimationClip, ResolvedBoneTransform } from './types';
import { sampleClip } from './interpolate';
import { facingFromAim } from './facing';

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
// Aim-driven weapon-socket rotation is a separate, still-deferred piece of work
// (design/12 lists it apart from the front/back swap) — sockets here only ever
// play their authored clip, they don't track the reticle yet.
export class RigSkin {
  readonly view = new Container();
  private readonly sprites = new Map<string, Sprite>();
  private clip: AnimationClip | null = null;
  private clipT = 0;
  private showBack = false;

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

  /** Aim direction (radians, standard math convention, y-down screen space) — drives L/R flip + front/back hemisphere. */
  setAim(rad: number): void {
    const { flipX, showBack } = facingFromAim(rad);
    this.view.scale.x = flipX;
    this.showBack = showBack;
  }

  /** Recompute FK from the current clip sample and push it onto the sprites. Call once per render frame. */
  update(): void {
    const transforms: Map<string, ResolvedBoneTransform> = this.clip
      ? sampleClip(this.clip, this.clipT)
      : new Map();
    const worldPose = this.rig.computeFK(0, 0, transforms);

    this.sprites.forEach((sprite, boneId) => {
      const pose = worldPose.get(boneId);
      const binding = this.bundle.bindings.get(boneId)!;
      if (!pose) return;

      const backTexture = this.showBack ? this.bundle.textures.get(`${boneId}__back`) : undefined;
      sprite.texture = backTexture ?? this.bundle.textures.get(boneId)!;

      const transform = transforms.get(boneId);
      sprite.x = pose.sx + (transform?.translateX ?? 0);
      sprite.y = pose.sy + (transform?.translateY ?? 0);
      sprite.rotation = ((pose.wa + binding.rotation) * Math.PI) / 180;
      sprite.scale.set(
        (binding.flipX ? -1 : 1) * (transform?.scaleX ?? 1) * binding.scaleX,
        (transform?.scaleY ?? 1) * binding.scaleY,
      );
      sprite.alpha = transform?.alpha ?? 1;
    });
  }
}
