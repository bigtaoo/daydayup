// Loads a rig skin's runtime assets from a set of static files under
// client/public/skins/<name>/ — animation.json (bindings + animation clips,
// same shape as tools/animator's exported .tao `animation.json`) plus one
// loose PNG per bone-slot frame (`<slot>.png`, or `<slot>__<variantId>.png`
// for an alternate like the eye's front/back swap), instead of one packed
// spritesheet page. design/12's real `.tao` is a zip with a packed atlas;
// this loader intentionally skips packing (no image-manipulation lib on the
// Node side that generates these files) — see art/units/ + `frames.json`
// for how the loose files are produced. Swapping in a real packed atlas
// later only touches this file, not Rig/RigSkin.
import { Assets, Texture } from 'pixi.js';
import type { AnimationClip, BoneKeyframe, SpriteBinding } from './types';

interface SerializedBoneKeyframe extends BoneKeyframe {}

export interface SerializedKeyframe {
  time: number;
  bones: Record<string, SerializedBoneKeyframe>;
}

export interface SerializedClip {
  duration: number;
  loop: boolean;
  keyframes: SerializedKeyframe[];
}

export interface AnimationJson {
  version: number;
  bindings: Record<string, SpriteBinding>;
  animations: Record<string, SerializedClip>;
}

type FramesJson = Record<string, string[]>; // slotId -> variant ids ('default' = the base frame)

export interface RigSkinBundle {
  bindings: Map<string, SpriteBinding>;
  clips: Map<string, AnimationClip>;
  /** Keyed by frame id: '<slotId>' for the default/active frame, '<slotId>__<variantId>' for an alternate. */
  textures: Map<string, Texture>;
}

/** Exported for `rigComposition.test.ts`, which loads the shipped `animation.json` files
 *  straight off disk and needs them in the exact runtime shape this loader produces. */
export function deserializeClip(s: SerializedClip): AnimationClip {
  return {
    duration: s.duration,
    loop: s.loop,
    keyframes: s.keyframes.map(kf => ({
      time: kf.time,
      bones: new Map(Object.entries(kf.bones)),
    })),
  };
}

export async function loadRigSkinBundle(baseUrl: string): Promise<RigSkinBundle> {
  const [animJson, framesJson] = await Promise.all([
    fetch(`${baseUrl}/animation.json`).then(r => r.json()) as Promise<AnimationJson>,
    fetch(`${baseUrl}/frames.json`).then(r => r.json()) as Promise<FramesJson>,
  ]);

  const bindings = new Map(Object.entries(animJson.bindings));
  const clips = new Map(Object.entries(animJson.animations).map(([name, c]) => [name, deserializeClip(c)]));

  const textures = new Map<string, Texture>();
  await Promise.all(
    Object.entries(framesJson).flatMap(([slotId, variantIds]) =>
      variantIds.map(async variantId => {
        const frameId = variantId === 'default' ? slotId : `${slotId}__${variantId}`;
        // `autoGenerateMipmaps` (found 2026-08-12, live user report "can't tell what
        // this character is"): these source PNGs are authored at ~1250px but a rig
        // bone routinely renders at 10-30px on screen (an actor's gameplay radiusPx is
        // a small fraction of a decorative bone's own authoring-px footprint) — a
        // 90:1+ minification ratio. Pixi's default (no mip chain, plain bilinear) only
        // samples a 2x2 texel neighbourhood per output pixel at that ratio, which reads
        // essentially RANDOM texels off a detailed source (confirmed live: an isolated
        // `eye` sprite rendered as an unreadable colour smear, not its actual blue iris)
        // — classic un-mipmapped texture aliasing, not a flaw in the source art itself.
        // A generated mip chain lets the GPU sample a pre-downsampled level instead.
        const texture = await Assets.load<Texture>({
          src: `${baseUrl}/${frameId}.png`,
          data: { autoGenerateMipmaps: true },
        });
        textures.set(frameId, texture);
      }),
    ),
  );

  return { bindings, clips, textures };
}
