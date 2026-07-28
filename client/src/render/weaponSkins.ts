// Universal-mount weapon business-end textures (design/03/12/13): the socket base is
// identical for every weapon, so historically the render layer used ONE sprite per
// weapon KIND (ranged/melee) — a "fire rifle" and an "ice rifle" shared the same
// neutral gun_default art (element is a crystal-colour tint, applied separately).
//
// ROADMAP 5.3 follow-up: per-FRAME business-end art. `scattergun`/`seeker`/`mortar`/
// `lasercutter`/`tomahawk`/`novaburst`/`gyre`/`hammer`/`spear` each get a distinct
// silhouette (a shotgun muzzle reads differently from a beam emitter); weapons with no
// dedicated entry (blaster/repeater/cannon/enemygun/saber/emberblade/frostbrand/
// stormglaive/carom/leech) still fall back to the generic gun_default/sword_default —
// no readable shape difference would justify unique art for those yet. Looked up by
// `WeaponSimSpec.name` (the weapon id), falling back to the KIND default.
//
// Preloaded like skinRegistry's character bundles: best-effort, never blocks gameplay
// if a fetch fails.
import { Assets, Texture } from 'pixi.js';

export type WeaponVisualKind = 'ranged' | 'melee';

interface WeaponVisualDef {
  path: string;
  // Anchor = the socket-connector point in THIS texture's own bounding box (0..1
  // fraction of its width/height) — where the sprite pivots and where it's placed onto
  // the socket bone's world position (RigSkin.updateWeaponSprite).
  anchor: { x: number; y: number };
  // Normalizes this texture's own pixel dimensions down to the rig's authoring-px
  // convention (mirrors a rig bone's SpriteBinding.scaleX/Y, design/12).
  scale: number;
  // Most of the new business-end art was drawn "socket on the right, business end
  // trailing to the left" (a GPT Image 2 composition habit, not something requested) —
  // the OPPOSITE of gun_default/sword_default's own "socket upper-left, tip lower-right"
  // convention that `RigSkin`'s aim-tracking rotation assumes (rotation=0 already
  // points the authored art the way a 0-radian aim should look). Rather than pixel-
  // flip the source art, this offset (radians, added on top of the live aim rotation)
  // cancels each texture's own baked pointing direction so the mounted sprite still
  // reads as pointing at the reticle. Omitted = 0 (already-canonical art).
  rotationOffsetRad?: number;
}

const deg = (d: number): number => (d * Math.PI) / 180;

// KIND_DEFAULTS' anchors are still the original first-pass eyeball (not yet
// re-measured live). WEAPON_DEFS' `rotationOffsetRad` values ARE measured, not
// eyeballed: a page-side script loaded each PNG into a canvas, took the alpha-
// farthest pixel from the (eyeballed) anchor as the tip, and computed the real
// baked angle from actual pixel data — see the session that added this table.
// Anchor fractions themselves are still first-pass eyeball, good enough since the
// rotation offset is what actually determines pointing direction.
const KIND_DEFAULTS: Record<WeaponVisualKind, WeaponVisualDef> = {
  ranged: { path: '/weapons/gun_default.png', anchor: { x: 0.25, y: 0.44 }, scale: 104 / 1536 },
  melee: { path: '/weapons/sword_default.png', anchor: { x: 0.2, y: 0.455 }, scale: 104 / 1536 },
};

const WEAPON_DEFS: Partial<Record<string, WeaponVisualDef>> = {
  scattergun: { path: '/weapons/gun_scattergun.png', anchor: { x: 0.875, y: 0.245 }, scale: 80 / 320, rotationOffsetRad: deg(-156.8) },
  seeker: { path: '/weapons/gun_seeker.png', anchor: { x: 0.922, y: 0.278 }, scale: 78 / 320, rotationOffsetRad: deg(-161.3) },
  mortar: { path: '/weapons/gun_mortar.png', anchor: { x: 0.938, y: 0.628 }, scale: 85 / 320, rotationOffsetRad: deg(165.5) },
  lasercutter: { path: '/weapons/gun_lasercutter.png', anchor: { x: 0.922, y: 0.382 }, scale: 95 / 320, rotationOffsetRad: deg(-165) },
  tomahawk: { path: '/weapons/gun_tomahawk.png', anchor: { x: 0.906, y: 0.241 }, scale: 78 / 320, rotationOffsetRad: deg(-162.8) },
  novaburst: { path: '/weapons/gun_novaburst.png', anchor: { x: 0.875, y: 0.704 }, scale: 80 / 320, rotationOffsetRad: deg(178.4) },
  // Drawn the opposite way round from the other 8 (housing/socket on the LEFT, the
  // spinning disc business-end on the RIGHT) — close to gun_default's own convention,
  // so only a small offset.
  gyre: { path: '/weapons/gun_gyre.png', anchor: { x: 0.219, y: 0.448 }, scale: 85 / 320, rotationOffsetRad: deg(-7.8) },
  hammer: { path: '/weapons/sword_hammer.png', anchor: { x: 0.906, y: 0.508 }, scale: 75 / 320, rotationOffsetRad: deg(173.7) },
  spear: { path: '/weapons/sword_spear.png', anchor: { x: 0.906, y: 0.346 }, scale: 100 / 320, rotationOffsetRad: deg(-161.1) },
};

const textures = new Map<string, Texture>();

function allDefs(): Array<[string, WeaponVisualDef]> {
  return [...Object.entries(KIND_DEFAULTS), ...Object.entries(WEAPON_DEFS)] as Array<[string, WeaponVisualDef]>;
}

export async function preloadWeaponSkins(): Promise<void> {
  await Promise.all(
    allDefs().map(async ([key, def]) => {
      textures.set(key, await Assets.load<Texture>(def.path));
    }),
  );
}

function resolve(name: string | undefined, kind: WeaponVisualKind): { key: string; def: WeaponVisualDef } {
  if (name && WEAPON_DEFS[name]) return { key: name, def: WEAPON_DEFS[name]! };
  return { key: kind, def: KIND_DEFAULTS[kind] };
}

export function getWeaponTexture(name: string | undefined, kind: WeaponVisualKind): Texture | undefined {
  const { key } = resolve(name, kind);
  return textures.get(key);
}

export function getWeaponAnchor(name: string | undefined, kind: WeaponVisualKind): { x: number; y: number } {
  return resolve(name, kind).def.anchor;
}

export function getWeaponScale(name: string | undefined, kind: WeaponVisualKind): number {
  return resolve(name, kind).def.scale;
}

export function getWeaponRotationOffset(name: string | undefined, kind: WeaponVisualKind): number {
  return resolve(name, kind).def.rotationOffsetRad ?? 0;
}
