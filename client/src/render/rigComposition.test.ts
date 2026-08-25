/// <reference types="node" />
/**
 * Assembly invariants over every SHIPPED skin bundle — "is the character put together
 * correctly", checked against the real files in `client/public/skins/`.
 *
 * WHY THIS FILE EXISTS. The hero rig rendered visibly disassembled for ~3 weeks (art drawn
 * at each bone's pivot instead of its tip, and rotated by the bone's raw world angle) while
 * 1272 client tests stayed green and a full coverage audit passed. Two reasons the existing
 * tests could not see it, both of which this file is built to avoid:
 *
 *   1. They asserted the ONE number a past bug taught someone to assert — the weapon
 *      socket's aim rotation — and nothing about where any sprite actually SAT.
 *   2. `RigSkin.test.ts`/`Actor.test.ts` run on a FAKE bundle (`Texture.WHITE`, every
 *      binding scale 1) and hardcode expected coordinates. That pins the renderer against
 *      the same mental model that produced the bug, and says nothing about the real
 *      `animation.json` files the game actually loads.
 *
 * So: real bundles, real rigs, real `RigSkin`, and RELATIONSHIPS rather than restated
 * coordinates — a part is on the body, an arm is off it, no two parts occupy one point, art
 * is scaled to the bone it's bound to. Every check here is mutation-verified: reverting
 * either half of the 2026-08-17 placement fix fails a named subset of them (see the counts
 * in ROADMAP's entry), and they hold for all 7 shipped bundles rather than one.
 *
 * Deliberately NOT here: anything requiring real pixels (is the eye inside the shell's
 * painted eye socket, does the art LOOK right). That still needs a live render — see
 * design/12. These are the strongest checks that survive in a canvas-free vitest run.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { Texture } from 'pixi.js';
import { PLAYER_BASE } from '@dd/engine';
import { fpToPx } from '../game/coords';
import { BODY_FILL, BODY_FILL_DEFAULT, RIG_DEFS } from './skinRegistry';
import { CHAR_BUNDLES } from './preloadArt';
import { RigSkin } from './RigSkin';
import { deserializeClip, type AnimationJson } from './taoBundle';
import { KIND_DEFAULTS, WEAPON_DEFS, MODULE_SCALE, type WeaponVisualDef } from './weaponSkins';
import { HELD_MOUNT_R, barrelReach, resolveWeaponMount } from './rigWeaponMount';
import type { Rig } from './Rig';
import type { RigSkinBundle } from './taoBundle';
import type { AnimationClip, BoneDef, SpriteBinding, WorldPose } from './types';

const PUBLIC = new URL('../../public/', import.meta.url);
const read = (path: string): Buffer => readFileSync(new URL(path, PUBLIC));
const readJson = <T>(path: string): T => JSON.parse(read(path).toString('utf8')) as T;

/** A PNG's real pixel width, straight out of its IHDR chunk (offset 16 after the 8-byte
 *  signature + the chunk's own length/type) — the whole point is to use the art's ACTUAL
 *  size on disk, so this deliberately does not trust any recorded number. */
function pngWidth(path: string): number {
  return read(path).readUInt32BE(16);
}

/** A PNG's real pixel height, from the same IHDR chunk as `pngWidth`. */
function pngHeight(path: string): number {
  return read(path).readUInt32BE(20);
}

/** The (skinName → bundle directory) pairs the GAME preloads. Taken from the real table so
 *  a character added there cannot quietly skip every check in this file. */
function preloadedBundles(): Array<{ name: string; dir: string }> {
  // Imported, not scraped. This used to regex `main.ts`'s source for a `CHAR_BUNDLES`
  // literal, which silently produced an EMPTY list the moment that table moved (it moved
  // to render/preloadArt.ts when the WeChat entry started sharing it) — every
  // `describe.each` below would then have vanished with nothing failing except the
  // length assertion in the next describe, which is the only reason the hole was visible.
  // The table is a real exported constant now, so read it as one.
  return CHAR_BUNDLES.map(([name, baseUrl]) => ({ name, dir: baseUrl.replace('/skins/', '') }));
}

interface Assembly {
  rig: Rig;
  bodyBone: BoneDef;
  bodyR: number;
  parts: BoneDef[]; // every sprite-bearing bone that is NOT the body
  skin: RigSkin;
  restPose: ReadonlyMap<string, WorldPose>;
  clips: Map<string, AnimationClip>;
  /** Rendered width in rig authoring-px: the art's real pixel width × the scale RigSkin
   *  actually applied this frame. */
  footprint: (boneId: string) => number;
  centre: (boneId: string) => { x: number; y: number };
}

function load(name: string, dir: string): Assembly {
  const entry = RIG_DEFS[name];
  expect(entry, `main.ts preloads '${name}' but skinRegistry has no RigDef for it`).toBeDefined();
  const rig = entry.rig;

  const animation = readJson<AnimationJson>(`skins/${dir}/animation.json`);
  const frames = readJson<Record<string, string[]>>(`skins/${dir}/frames.json`);
  const bindings = new Map<string, SpriteBinding>(Object.entries(animation.bindings));
  const clips = new Map(Object.entries(animation.animations).map(([n, c]) => [n, deserializeClip(c)]));
  const textures = new Map<string, Texture>();
  for (const [slot, variants] of Object.entries(frames)) {
    for (const variant of variants) textures.set(variant === 'default' ? slot : `${slot}__${variant}`, Texture.WHITE);
  }
  const bundle: RigSkinBundle = { bindings, clips, textures };

  const skin = new RigSkin(rig, bundle);
  skin.setBodyFacing(0);
  skin.setAim(0);
  skin.update();
  // Read back what the real renderer computed (private, same cast every sibling test uses).
  const sprites = (): Map<string, { x: number; y: number; scale: { x: number } }> =>
    (skin as unknown as { sprites: Map<string, { x: number; y: number; scale: { x: number } }> }).sprites;

  // The body bone: the one hanging directly off the root that carries a bodyR circle
  // (orb-core `shell`, critter `body`, boss `core`). Every rig here has exactly one.
  const bodyCandidates = rig.boneDefs.filter(b => b.parent === 'root' && b.bodyR !== undefined);
  expect(bodyCandidates, `${name}: expected exactly one root-level body bone`).toHaveLength(1);
  const bodyBone = bodyCandidates[0];

  const widthCache = new Map<string, number>();
  const artWidth = (boneId: string): number => {
    if (!widthCache.has(boneId)) widthCache.set(boneId, pngWidth(`skins/${dir}/${boneId}.png`));
    return widthCache.get(boneId)!;
  };

  return {
    rig,
    bodyBone,
    bodyR: bodyBone.bodyR!,
    parts: rig.drawOrder.filter(id => id !== bodyBone.id).map(id => rig.boneMap.get(id)!),
    skin,
    restPose: rig.computeFK(0, 0, new Map()),
    clips,
    footprint: (boneId) => artWidth(boneId) * Math.abs(sprites().get(boneId)!.scale.x),
    centre: (boneId) => ({ x: sprites().get(boneId)!.x, y: sprites().get(boneId)!.y }),
  };
}

const dist = (a: { x: number; y: number }, b: { x: number; y: number }): number => Math.hypot(a.x - b.x, a.y - b.y);
const isOrbiting = (bone: BoneDef): boolean => bone.outerW !== undefined && bone.innerW !== undefined;

const BUNDLES = preloadedBundles();

describe('rig composition — every skin the game preloads is covered here', () => {
  it('found the preload list and every entry resolves to a registered rig + a real bundle', () => {
    expect(BUNDLES.length).toBeGreaterThanOrEqual(7);
    for (const { name, dir } of BUNDLES) {
      expect(RIG_DEFS[name], `no RigDef registered for preloaded skin '${name}'`).toBeDefined();
      expect(() => readJson(`skins/${dir}/animation.json`)).not.toThrow();
    }
  });
});

describe.each(BUNDLES)('rig composition — $name ($dir)', ({ name, dir }) => {
  const a = load(name, dir);

  it('the body is drawn at its own hover height (its bone TIP), not down at the ground pivot', () => {
    // The bug: drawn at `sx/sy`, i.e. one body-length below where the rig puts the body,
    // which is what left every child bone stranded above the body's head.
    const tip = a.restPose.get(a.bodyBone.id)!;
    expect(a.centre(a.bodyBone.id).x).toBeCloseTo(tip.ex, 3);
    expect(a.centre(a.bodyBone.id).y).toBeCloseTo(tip.ey, 3);
    expect(tip.ey).not.toBeCloseTo(tip.sy, 3); // the two really are different points for this rig
  });

  it('every sprite renders upright at rest — art is authored in its bone\'s rest orientation', () => {
    // The bug: rotation came from the raw world angle, so a body bone pointing up (rwa -90)
    // rotated its own art 90° — the hero's spikes pointed left, every enemy was on its side.
    const sprites = (a.skin as unknown as { sprites: Map<string, { rotation: number }> }).sprites;
    for (const boneId of a.rig.drawOrder) {
      const rotation = sprites.get(boneId)?.rotation ?? 0;
      expect(Math.abs(rotation), `${boneId} is rotated ${(rotation * 180) / Math.PI}° at rest`).toBeLessThan(1e-6);
    }
  });

  it('art is scaled to the bone it\'s bound to: rendered footprint == 2 × that bone\'s bodyR', () => {
    // Pins every shipped binding's scaleX against the rig, using the art's REAL pixel width
    // — the guard against a re-export/downsample landing a sprite at the wrong size (this
    // repo has shipped a ~15.7x character-scale bug once, and a stale weapon divisor twice).
    for (const boneId of a.rig.drawOrder) {
      const bodyR = a.rig.boneMap.get(boneId)?.bodyR;
      if (bodyR === undefined) continue;
      expect(a.footprint(boneId) / (2 * bodyR), `${boneId}'s art is not sized to its bodyR`).toBeCloseTo(1, 1);
    }
  });

  it('decorative parts sit ON the body; orbiting modules sit OFF it', () => {
    const bodyCentre = a.centre(a.bodyBone.id);
    for (const bone of a.parts) {
      const d = dist(a.centre(bone.id), bodyCentre);
      if (isOrbiting(bone)) {
        // An arm has to be visibly clear of the core, or there is no "two arms" silhouette.
        expect(d, `${bone.id} orbits INSIDE the body`).toBeGreaterThan(a.bodyR);
        expect(d, `${bone.id} orbits absurdly far from the body`).toBeLessThan(a.bodyR * 2);
      } else {
        // A face/belly part has to be contained by the body it decorates.
        const reach = d + a.footprint(bone.id) / 2;
        expect(reach, `${bone.id} hangs off the body`).toBeLessThanOrEqual(a.bodyR * 1.25);
      }
    }
  });

  it('no two parts occupy the same point — the exact shape of the shipped bug', () => {
    // Pre-fix, orb-core's eye, belly and BOTH sockets were all at (0,-46): four sprites and
    // the mounted weapon stacked on one pixel. Any future rig that collapses two parts onto
    // each other fails here, whatever the cause.
    for (let i = 0; i < a.parts.length; i++) {
      for (let j = i + 1; j < a.parts.length; j++) {
        const [p, q] = [a.parts[i], a.parts[j]];
        expect(dist(a.centre(p.id), a.centre(q.id)), `${p.id} and ${q.id} are co-located`)
          .toBeGreaterThan(a.bodyR * 0.2);
      }
    }
  });

  it('all orbiting modules share one orbit radius (a symmetric pair of arms, not a lopsided one)', () => {
    const bodyCentre = a.centre(a.bodyBone.id);
    const radii = a.parts.filter(isOrbiting).map(b => dist(a.centre(b.id), bodyCentre));
    for (const r of radii) expect(r).toBeCloseTo(radii[0], 3);
  });

  it('every orbiting module is connected by a drawn tether — and a rig without arms draws none', () => {
    const internals = a.skin as unknown as { tethers: unknown | null; tetherGeometry: string };
    const orbiting = a.parts.filter(isOrbiting).length;
    if (orbiting === 0) {
      expect(internals.tethers).toBeNull();
      return;
    }
    expect(internals.tethers).not.toBeNull();
    expect(internals.tetherGeometry.split(';').filter(Boolean)).toHaveLength(orbiting);
  });

  it('stays assembled through every shipped animation clip, not just at rest', () => {
    // Sampled across each clip because the FK model does NOT cascade translate/scale to
    // children (design/12): a clip that bobs the body without bobbing its parts would tear
    // the character apart mid-animation, and nothing else in the suite would notice.
    const SAMPLES = 12;
    const sprites = (a.skin as unknown as { sprites: Map<string, { alpha: number }> }).sprites;
    for (const [clipName, clip] of a.clips) {
      for (let i = 0; i <= SAMPLES; i++) {
        a.skin.playClip(clipName, (clip.duration * 1000 * i) / SAMPLES);
        a.skin.update();
        const bodyCentre = a.centre(a.bodyBone.id);
        for (const bone of a.parts) {
          if ((sprites.get(bone.id)?.alpha ?? 1) <= 0.01) continue; // faded out (death/spawn) — nothing to see
          const d = dist(a.centre(bone.id), bodyCentre);
          const where = `${clipName} @${i}/${SAMPLES}: ${bone.id}`;
          if (isOrbiting(bone)) {
            expect(d, `${where} pulled inside the body`).toBeGreaterThan(a.bodyR * 0.9);
          } else {
            expect(d + a.footprint(bone.id) / 2, `${where} slid off the body`).toBeLessThanOrEqual(a.bodyR * 1.6);
          }
        }
      }
    }
    a.skin.playClip('idle', 0);
    a.skin.update();
  });
});

describe('rig composition — a mounted weapon module reads as a module against the core', () => {
  // The core it mounts on is the hero's: orb-core's shell, 2 × bodyR authoring-px wide.
  const CORE_DIAMETER = 2 * RIG_DEFS.char_vanguard.rig.boneMap.get('shell')!.bodyR!;
  const entries: Array<[string, WeaponVisualDef]> = [
    ...Object.entries(KIND_DEFAULTS),
    ...(Object.entries(WEAPON_DEFS) as Array<[string, WeaponVisualDef]>),
  ];

  it.each(entries)('%s is between 0.4x and 1.0x the core diameter', (_id, def) => {
    // Both bounds are real regressions, not hypotheticals: at 1.0x+ the gun covered the
    // hero's eye and dominated the silhouette (the 2026-08-17 report, fixed by MODULE_SCALE);
    // below 0.4x a module reads as a nub, which is what KIND_DEFAULTS' stale `/1536` divisor
    // was doing (~0.2x) on the never-invisible fallback path. Checked from each texture's
    // REAL on-disk width, so re-exporting the art at a different size fails here.
    const ratio = (pngWidth(def.path.replace(/^\//, '')) * def.scale * MODULE_SCALE) / CORE_DIAMETER;
    expect(ratio).toBeGreaterThan(0.4);
    expect(ratio).toBeLessThanOrEqual(1.0);
  });

  it('the proportion factor is applied uniformly — no per-weapon exception can drift in', () => {
    expect(MODULE_SCALE).toBeGreaterThan(0);
    expect(MODULE_SCALE).toBeLessThanOrEqual(1);
  });
});

/**
 * The cross-layer invariant the 2026-08-19 report was actually about: the sim's wall
 * clearance has to be at least as wide as the body the renderer draws, or the character's
 * silhouette ends up inside the wall it is standing against (`ENGINE_VERSION` 43,
 * `Actor.solidRadius`). Every other check in this file compares the rig against itself;
 * this one compares the shipped rig against a number that lives in the ENGINE, which is the
 * seam the bug actually lived in — the 7 px feet circle was authored before the real 32 px
 * art existed and stayed plausible-looking in both files separately for weeks.
 *
 * Failing here means one of two edits happened without the other: the rig art (or its
 * reference radius) grew, or the clearance shrank.
 */
describe('rig composition — the drawn body fits inside the sim\'s wall clearance (v43)', () => {
  const CHARACTERS = BUNDLES.filter(b => b.name.startsWith('char_'));

  it('every playable character bundle is covered here', () => {
    expect(CHARACTERS.length).toBeGreaterThanOrEqual(3); // vanguard / skirmisher / juggernaut
  });

  it.each(CHARACTERS)('$name\'s body half-width never exceeds PLAYER_BASE.solidRadius', ({ name, dir }) => {
    const a = load(name, dir);
    // What Skin.ts does: normalize the rig's authoring px to the actor's gameplay radius
    // (`rigScale = radius / referenceRadius`), so this is the body's real on-screen half
    // width in WORLD px — the same unit the engine's radii are in once out of fixed point.
    const bodyPx = fpToPx(PLAYER_BASE.radius);
    const halfWidthWorldPx = a.bodyR * (bodyPx / RIG_DEFS[name].referenceRadius);
    expect(halfWidthWorldPx).toBeLessThanOrEqual(fpToPx(PLAYER_BASE.solidRadius));
  });

  it('and the clearance is not wastefully wider than the body either', () => {
    // The other direction is a real failure mode too: a clearance well past the silhouette
    // reads as the character being held off the wall by an invisible cushion, which is the
    // opposite complaint. Tangent is the target — one body radius, no more.
    expect(fpToPx(PLAYER_BASE.solidRadius)).toBeLessThanOrEqual(fpToPx(PLAYER_BASE.radius) * 1.1);
  });
});

/**
 * `skinRegistry.BODY_FILL` against the real pixels (2026-08-19 volume pass).
 *
 * A bone's `bodyR` is the rig's DECLARED body radius; the PNG bound to it is a square canvas
 * whose creature may paint far less of it — measured, between 0.68 and 1.00 of the radius,
 * differing per bundle rather than per rig (`brute-core` fills its canvas edge to edge,
 * `critter-core`'s crystal paints 0.70). Anything sized off `bodyR` is therefore sized off a box
 * up to 45% wider than the art inside it, which is exactly what made an enemy's ground shadow
 * read as a black dinner plate it was sitting in.
 *
 * `BODY_FILL` records the measurement so `Actor` can size its shadow from the art. This is what
 * keeps it honest: re-cropping, rescaling or replacing a body texture changes the number these
 * tests measure, and the table has to move with it. Same class of cross-layer failure as the
 * `footprintRadius` mismatch fixed the same week — a hand-tuned number sized against art that
 * has since changed, with nothing in either file showing it.
 *
 * Decoding is real PNG decoding (`tools/png-pipeline/pngCodec.mjs`, the repo's own codec — the
 * alternative would be a second decoder in test code), so this deliberately reads whole images
 * rather than an IHDR header like its siblings above.
 */
/**
 * The held weapon mount, checked against the REAL shipped content (2026-08-21).
 *
 * `rigWeaponMount.test.ts` covers the geometry as arithmetic and `RigSkin.test.ts` covers the
 * wiring; neither can tell you whether the rule actually works for the art that ships. This
 * does, and it is the check that would have caught the alternative design before it was built:
 * a socket bone on the shared enemy rig could only declare ONE length, and these three bundles
 * paint 0.70 / 1.00 / 1.00 of the same declared `bodyR`, so no single length clears all three.
 *
 * Both bounds are the two ways a mounted gun goes wrong, and each was seen on a real frame
 * during the pass:
 *   - the barrel has to CLEAR the body silhouette, or the gun is a lump inside the creature;
 *   - the housing has to OVERLAP it, or the gun floats detached (which is exactly what a mount
 *     radius of 1.15 did to floater-core, whose `bodyFill` is its widest row and so overstates
 *     its half-width at the mount's own height).
 *
 * Sized from `BODY_FILL` — pinned to the shipped PNGs by the block above — and from the real
 * on-disk width of `gun_enemygun.png`. So re-cropping an enemy body, or re-exporting the gun at
 * a different size, fails here rather than shipping a detached weapon.
 */
describe('rig composition — the held weapon mount works for the art that actually ships', () => {
  const ENEMY_GUN = WEAPON_DEFS.enemygun!;
  const gunW = pngWidth(ENEMY_GUN.path.replace(/^\//, ''));

  /**
   * The mounted gun's extent along the aim, in rig authoring-px, measured the way `RigSkin`
   * and `muzzleLocal` measure it: anchor-to-tip forward, anchor-to-canvas-edge backward.
   *
   * Reads the calibration straight out of `WEAPON_DEFS`, NOT through `getWeaponAnchor`/
   * `getWeaponRotationOffset`. Those resolve through `weaponSkins.resolve()`, which falls back
   * to the KIND default unless the texture is in the preload cache — and under vitest nothing
   * is preloaded, so every one of them silently returned `gun_default`'s calibration instead of
   * `enemygun`'s. The mutation battery found it: moving enemygun's anchor to its barrel tip
   * changed nothing here. The authored table is what ships, so the table is what to check.
   */
  function gunReach(): { forward: number; backward: number } {
    const anchor = ENEMY_GUN.anchor;
    const scale = ENEMY_GUN.scale * MODULE_SCALE;
    const gunH = pngHeight(ENEMY_GUN.path.replace(/^\//, ''));
    const forward = barrelReach(gunW, gunH, anchor, ENEMY_GUN.rotationOffsetRad ?? 0) * scale;
    // Backward: from the anchor to the far canvas edge, i.e. how much housing can tuck in.
    const backward = anchor.x * gunW * scale;
    return { forward, backward };
  }

  it("reads enemygun's OWN calibration, not the kind default it falls back to unpreloaded", () => {
    // Guard on the guard: if these ever coincide, the checks below stop testing enemygun.
    expect(ENEMY_GUN.anchor).not.toEqual(KIND_DEFAULTS.ranged.anchor);
    expect(gunReach().forward).toBeGreaterThan(0);
  });

  const HELD = BUNDLES.filter(({ name }) => resolveWeaponMount(RIG_DEFS[name]!.rig) === 'held');

  it('found the held-mount bundles — critter/brute/floater, all sharing one rig', () => {
    expect(HELD.map(b => b.name).sort()).toEqual(['brute-core', 'critter-core', 'floater-core']);
    // The premise of the whole design: one Rig instance, so one socket length for all three.
    const rigs = new Set(HELD.map(b => RIG_DEFS[b.name]!.rig));
    expect(rigs.size).toBe(1);
  });

  it('the three held bundles do NOT share a drawn body radius — why one socket length cannot fit', () => {
    const radii = new Set(HELD.map(b => RIG_DEFS[b.name]!.rig.boneMap.get('body')!.bodyR! * BODY_FILL[b.name]!));
    expect(radii.size).toBeGreaterThan(1);
  });

  it.each(HELD)('$name: the barrel clears the body and the housing still overlaps it', ({ name }) => {
    const rig = RIG_DEFS[name]!.rig;
    const drawnR = rig.boneMap.get('body')!.bodyR! * BODY_FILL[name]!;
    const anchorAt = drawnR * HELD_MOUNT_R;
    const { forward, backward } = gunReach();

    // The muzzle ends outside the silhouette, by a real margin rather than a rounding error.
    expect(anchorAt + forward, `${name}: barrel tip vs drawn radius ${drawnR}`).toBeGreaterThan(drawnR * 1.2);
    // ...and the back of the housing is inside it, so the gun reads as carried.
    expect(anchorAt - backward, `${name}: housing back vs drawn radius ${drawnR}`).toBeLessThan(drawnR);
  });

  it.each(HELD)('$name: the gun reads as a module against THIS body, not just against the hero core', ({ name }) => {
    // Same proportion question the orb-core block above asks, but per enemy body — the mobs are
    // smaller than the hero, so a gun sized only against the hero's core could swamp them.
    const drawnR = RIG_DEFS[name]!.rig.boneMap.get('body')!.bodyR! * BODY_FILL[name]!;
    const ratio = (gunW * ENEMY_GUN.scale * MODULE_SCALE) / (2 * drawnR);
    expect(ratio).toBeGreaterThan(0.4);
    expect(ratio).toBeLessThanOrEqual(1.2);
  });

  it('every preloaded bundle resolves to a mount mode, and the boss is the only weaponless one', () => {
    const byMode = new Map<string, string[]>();
    for (const { name } of BUNDLES) {
      const mode = resolveWeaponMount(RIG_DEFS[name]!.rig);
      byMode.set(mode, [...(byMode.get(mode) ?? []), name]);
    }
    expect(byMode.get('none')).toEqual(['boss-core']);
    expect(byMode.get('socket')!.sort()).toEqual(['char_juggernaut', 'char_skirmisher', 'char_vanguard']);
    expect(byMode.get('held')!.length).toBe(3);
    // No bundle may be left without a mode — that is how the boss ended up drawing a
    // placeholder bar for months.
    expect(byMode.get('socket')!.length + byMode.get('held')!.length + byMode.get('none')!.length)
      .toBe(BUNDLES.length);
  });
});

describe('BODY_FILL — the recorded body art fill matches the shipped pixels', () => {
  /** `alpha > 8` rather than `> 0`: a chroma-keyed PNG carries a rim of near-zero antialiasing
   *  alpha that is invisible on screen and would inflate every measurement. */
  const ALPHA_FLOOR = 8;

  async function opaqueHalfWidth(dir: string, boneId: string, scaleX: number): Promise<number> {
    // The repo's PNG codec is a plain .mjs tool module; `pngCodec.d.mts` (added 2026-08-20 for
    // `scene/pillarArt.test.ts`) is what gives it a type surface here.
    const { decodePNG } = await import('../../../tools/png-pipeline/pngCodec.mjs');
    const img = decodePNG(read(`skins/${dir}/${boneId}.png`)) as { width: number; height: number; data: Uint8Array };
    let minX = img.width;
    let maxX = -1;
    for (let y = 0; y < img.height; y++) {
      for (let x = 0; x < img.width; x++) {
        if (img.data[(y * img.width + x) * 4 + 3]! <= ALPHA_FLOOR) continue;
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
      }
    }
    expect(maxX, `${dir}/${boneId}.png has no opaque pixels at all`).toBeGreaterThanOrEqual(0);
    return ((maxX - minX + 1) * scaleX) / 2;
  }

  it('has an entry for every skin the game preloads — a missing one silently means 1.0', () => {
    for (const { name } of BUNDLES) expect(BODY_FILL[name], `BODY_FILL['${name}']`).toBeDefined();
  });

  it.each(BUNDLES)('$name\'s recorded fill is what its body PNG actually paints', async ({ name, dir }) => {
    const a = load(name, dir);
    const animation = readJson<AnimationJson>(`skins/${dir}/animation.json`);
    const binding = animation.bindings[a.bodyBone.id]!;
    const halfWidth = await opaqueHalfWidth(dir, a.bodyBone.id, binding.scaleX);
    // Within 0.02 — the table is rounded to two places, and a real art change moves it far more.
    expect(halfWidth / a.bodyR).toBeCloseTo(BODY_FILL[name]!, 2);
  });

  it('never records more than 1.0 — art wider than its own bodyR is a rig bug, not a fill', () => {
    for (const { name } of BUNDLES) expect(BODY_FILL[name]!).toBeLessThanOrEqual(1);
  });

  it('defaults to 1.0, the conservative direction, for an unregistered skin', () => {
    // A shadow slightly too big is a look note; a missing one is a character that floats.
    expect(BODY_FILL_DEFAULT).toBe(1);
    expect(BODY_FILL['not-a-skin']).toBeUndefined();
  });
});
