// Universal-mount weapon business-end textures (design/03/12/13): the socket base is
// identical for every weapon, so the render layer only ever needs ONE sprite per
// weapon KIND (ranged/melee), never one per frame — a "fire rifle" and an "ice rifle"
// share the same neutral gun_default art (element is a crystal-colour tint, not yet
// wired — see art/units/gun_default.png's header prompt). Preloaded like skinRegistry's
// character bundles: best-effort, never blocks gameplay if it fails.
import { Assets, Texture } from 'pixi.js';

export type WeaponVisualKind = 'ranged' | 'melee';

const TEXTURE_PATHS: Record<WeaponVisualKind, string> = {
  ranged: '/weapons/gun_default.png',
  melee: '/weapons/sword_default.png',
};

// Anchor = the socket-connector nub at the art's back end (art/units/gun_default.png
// and sword_default.png are authored "pointing right, plugging in from the left",
// matching the rig's canonical facing-right convention, design/12) — approximated
// from each texture's alpha bounding box, not hand-tuned in the editor like character
// bindings are, so treat as a first pass.
//
// Re-measured precisely (a prior session's eyeballed "a few px above the ring" note,
// judged from a magnified DOM-overlay screenshot, turned out to overstate it):
// `weaponSprite.getGlobalPosition()` vs `socket_r`'s own rendered-bounds centre are
// ~0.56 world-px apart at aim=0° — sub-pixel at real gameplay scale (the character
// renders ~50-60px), confirmed by a crosshair-marked 30×-zoomed extract-canvas crop
// showing the gun's rear cap sitting inside the ring decal with no visible seam. Also
// worth remembering for next time: this gap is NOT something these ANCHOR fractions
// control at all — they only decide which part of the GUN texture aligns with the
// fixed socket pivot (`socketPose`), not whether that pivot coincides with where the
// ring decal itself renders (a separate, tiny offset in the ring's own SpriteBinding).
// No fix applied — there's nothing left to correct at this precision.
const ANCHORS: Record<WeaponVisualKind, { x: number; y: number }> = {
  ranged: { x: 0.25, y: 0.44 },
  melee: { x: 0.2, y: 0.455 },
};

// Static scale offset (same idea as a rig bone's SpriteBinding.scaleX/scaleY, design/12) —
// normalizes each texture's authored native px down to the rig's authoring-px convention
// (RigSkin.view is later scaled again by Skin's radius/ORB_CORE_REFERENCE_RADIUS wrapper,
// same as every bone sprite). Both business-ends are 1536×1024 native; target the mounted
// weapon's long axis at ~2× socket_r's authoring length (52px, orbCoreRig.ts) — comparable
// reach to a held gun/sword, not hand-tuned in the editor yet (first pass, like ANCHORS).
const SCALES: Record<WeaponVisualKind, number> = {
  ranged: 104 / 1536,
  melee: 104 / 1536,
};

const textures = new Map<WeaponVisualKind, Texture>();

export async function preloadWeaponSkins(): Promise<void> {
  await Promise.all(
    (Object.entries(TEXTURE_PATHS) as Array<[WeaponVisualKind, string]>).map(async ([kind, path]) => {
      textures.set(kind, await Assets.load<Texture>(path));
    }),
  );
}

export function getWeaponTexture(kind: WeaponVisualKind): Texture | undefined {
  return textures.get(kind);
}

export function getWeaponAnchor(kind: WeaponVisualKind): { x: number; y: number } {
  return ANCHORS[kind];
}

export function getWeaponScale(kind: WeaponVisualKind): number {
  return SCALES[kind];
}
