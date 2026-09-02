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
import { describe, it, expect, beforeAll, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { Texture } from 'pixi.js';
import { BASIC_ENEMY, PLAYER_BASE } from '@dd/engine';
import { fpToPx } from '../game/coords';
import { BODY_FILL, BODY_FILL_DEFAULT, RIG_DEFS } from './skinRegistry';
import { CHAR_BUNDLES } from './preloadArt';
import { RigSkin } from './RigSkin';
import { deserializeClip, type AnimationJson } from './taoBundle';
import { KIND_DEFAULTS, WEAPON_DEFS, MODULE_SCALE, type WeaponVisualDef } from './weaponSkins';
import { ACTIVE_WEAPON_SOCKET, HELD_MOUNT_R, barrelReach, resolveWeaponMount } from './rigWeaponMount';
import { preloadWeaponSkins } from './weaponSkins';
import { RECOIL_BODY_PX, RECOIL_MODULE_PX } from './rigRecoil';
import type { Rig } from './Rig';
import type { RigSkinBundle } from './taoBundle';
import type { AnimationClip, BoneDef, SpriteBinding, WorldPose } from './types';

// `Assets.load` would hit the network. Stubbed the way `muzzleParity.test.ts` stubs it —
// spread over the real module so every other pixi export (this file builds real `Texture`s and
// real `RigSkin`s) stays real. Needed at all because `getWeaponTexture` returns undefined
// until a weapon is in the preload cache, and an unmounted module cannot be checked for being
// attached to anything; caching it is also what makes `weaponSkins.resolve()` hand back the
// weapon's OWN calibration instead of falling back to the kind default.
//
// `Texture.WHITE` rather than the PNG's real size, unlike muzzleParity's stub: a module's
// POSITION — the only thing the assembly sweep below asserts — is its mount's, and the texture
// only sets what is drawn AT that point (anchor, scale, and the barrel reach measured from it).
// Anything texture-derived is muzzleParity's subject, and it must be a real `Texture` here
// because this one is assigned to a live `Sprite`, which a size-only stand-in cannot be.
const mocks = vi.hoisted(() => ({ assetsLoad: vi.fn() }));
vi.mock('pixi.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('pixi.js')>();
  return { ...actual, Assets: { ...actual.Assets, load: mocks.assetsLoad } };
});

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

  // `bodyFill` is passed exactly as the game passes it (`Skin.ts`: `new RigSkin(loaded.rig,
  // loaded.bundle, loaded.bodyFill)`). Omitting it defaulted to 1, i.e. "the art fills its
  // whole declared bodyR" — which is true for four of the seven bundles and silently wrong for
  // critter-core (0.70), whose held gun then mounts 15 authoring px further out here than in
  // the game. It only reaches `drawnBodyR`, so nothing above depended on it.
  const skin = new RigSkin(rig, bundle, BODY_FILL[name] ?? BODY_FILL_DEFAULT);
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

/**
 * ASSEMBLY INTEGRITY of the mounted weapon (2026-09-02) — the invariant this whole file is
 * about, applied to the one part of the rig that MOVES independently of its bone.
 *
 * Written because the bullet-arc fix shipped a regression past 4134 green tests, a 24-angle
 * geometry sweep and a 4-mutation battery, and one live frame caught it: the first version
 * orbited the weapon MODULE to the aim and left everything hanging off the same bone behind —
 * the socket ring, the energy tether drawn out to it, the contact shade on the core. Aiming
 * south drew the gun at (0, 6) with its ring still at (52, -49.7), 71 px away, tether reaching
 * for where the ring used to be.
 *
 * Nothing in the suite could see it, and the reason generalises: every test asserted where the
 * module IS — its mount coordinates, its muzzle point, its cross-track geometry, its depth
 * flip. None asserted that it is still ATTACHED to the thing that holds it, because a rig's
 * parts have that relationship by construction... right up until someone moves one of them out
 * of the FK chain, which is the moment the construction stops being the guarantee.
 *
 * So these assert RELATIONSHIPS between things the renderer positions INDEPENDENTLY, over the
 * real shipped bundles, swept across the aim and across every clip. Same family as "no two
 * parts occupy the same point" above, and the same reason for existing.
 */
describe('rig composition — the mounted weapon stays attached to its own mount', () => {
  /** Every preloaded bundle that mounts a weapon at all, with the weapon its carrier fires. */
  const ARMED = BUNDLES
    .filter(({ name }) => resolveWeaponMount(RIG_DEFS[name]!.rig) !== 'none')
    .map(b => ({
      ...b,
      mode: resolveWeaponMount(RIG_DEFS[b.name]!.rig),
      // The hero roster carries the catalog; every enemy body fires ENEMY_GUN_SIM
      // (`content/enemies.ts`), whose render id is `enemygun`.
      weapon: resolveWeaponMount(RIG_DEFS[b.name]!.rig) === 'socket' ? 'blaster' : 'enemygun',
    }));

  /** 16 directions, not the four axes: a mount that is wrong at 90° can be right at 0°, which
   *  is exactly how the arc survived (`muzzleParity.test.ts` carries that lesson in full). */
  const AIMS = Array.from({ length: 16 }, (_, i) => (i * Math.PI * 2) / 16);

  beforeAll(async () => {
    mocks.assetsLoad.mockImplementation(async (arg: string | { src: string }) => {
      void (typeof arg === 'string' ? arg : arg.src);
      return Texture.WHITE;
    });
    await preloadWeaponSkins();
  });

  /** A freshly loaded rig with its weapon mounted. */
  function armed(name: string, dir: string, weapon: string): Assembly {
    const a = load(name, dir);
    a.skin.setWeaponKind('ranged', weapon);
    return a;
  }
  const posed = (a: Assembly, aim: number): void => {
    a.skin.setBodyFacing(aim);
    a.skin.setAim(aim);
    a.skin.update();
  };
  const moduleAt = (a: Assembly): { x: number; y: number } => {
    const sprite = (a.skin as unknown as { weaponSprite: { x: number; y: number; visible: boolean } | null }).weaponSprite;
    expect(sprite, 'no weapon module was mounted at all').not.toBeNull();
    expect(sprite!.visible, 'the mounted module is hidden').toBe(true);
    return { x: sprite!.x, y: sprite!.y };
  };

  it('found the armed bundles — every preloaded body except the boss', () => {
    expect(ARMED.map(b => b.name).sort())
      .toEqual(['brute-core', 'char_juggernaut', 'char_skirmisher', 'char_vanguard', 'critter-core', 'floater-core']);
    expect(ARMED.filter(b => b.mode === 'socket')).not.toHaveLength(0);
    expect(ARMED.filter(b => b.mode === 'held')).not.toHaveLength(0);
  });

  // The anti-vacuity control for everything below: a module that never moved would satisfy
  // every "stays attached" check for free. It has to actually travel with the aim.
  it.each(ARMED)('$name: the module travels with the aim rather than merely spinning', ({ name, dir, weapon }) => {
    const a = armed(name, dir, weapon);
    posed(a, 0);
    const east = moduleAt(a);
    posed(a, Math.PI / 2);
    const south = moduleAt(a);
    // A quarter-turn apart, so they must be at least the mount's own reach apart.
    expect(dist(east, south)).toBeGreaterThan(a.bodyR * 0.5);
  });

  it.each(ARMED.filter(b => b.mode === 'socket'))(
    '$name: the module sits exactly on its own socket ring, at every aim',
    ({ name, dir, weapon }) => {
      const a = armed(name, dir, weapon);
      for (const aim of AIMS) {
        posed(a, aim);
        // The ring is the socket bone's OWN art, placed by the sprite loop; the module is
        // placed by `activeModuleMount`. Two independent paths, one point — 71 px apart in the
        // regression this test exists for.
        expect(dist(moduleAt(a), a.centre(ACTIVE_WEAPON_SOCKET)), 'aim ' + Math.round((aim * 180) / Math.PI))
          .toBeLessThan(0.01);
      }
    },
  );

  it.each(ARMED.filter(b => b.mode === 'socket'))(
    '$name: and through every shipped clip, so the gun rides the hover bob with its ring',
    ({ name, dir, weapon }) => {
      const a = armed(name, dir, weapon);
      const SAMPLES = 8;
      for (const [clipName, clip] of a.clips) {
        for (let i = 0; i <= SAMPLES; i++) {
          a.skin.setAim(1.1); // an off-axis aim, so this is not the rest pose either
          a.skin.playClip(clipName, (clip.duration * 1000 * i) / SAMPLES);
          a.skin.update();
          expect(dist(moduleAt(a), a.centre(ACTIVE_WEAPON_SOCKET)), clipName + ' @' + i + '/' + SAMPLES)
            .toBeLessThan(0.01);
        }
      }
    },
  );

  it.each(ARMED.filter(b => b.mode === 'socket'))(
    '$name: the drawn tether reaches the module, not the point it used to hang at',
    ({ name, dir, weapon }) => {
      const a = armed(name, dir, weapon);
      for (const aim of AIMS) {
        posed(a, aim);
        // `tetherGeometry` is the signature `drawTethers` builds from the endpoints it actually
        // strokes — `sx,sy,ex,ey,alpha;` per tethered bone — so this reads the drawn curve's
        // own far end rather than recomputing where it ought to be.
        const geom = (a.skin as unknown as { tetherGeometry: string }).tetherGeometry;
        const ends = geom.split(';').filter(Boolean).map((row) => {
          const parts = row.split(',').map(Number);
          return { x: parts[2]!, y: parts[3]! };
        });
        expect(ends.length, 'no tether was drawn at all').toBeGreaterThan(0);
        const mod = moduleAt(a);
        const nearest = Math.min(...ends.map((e) => dist(e, mod)));
        // 0.1 rather than 0.01: the signature rounds its endpoints to one decimal place.
        expect(nearest, 'aim ' + Math.round((aim * 180) / Math.PI)).toBeLessThan(0.1);
      }
    },
  );

  it.each(ARMED.filter(b => b.mode === 'held'))(
    '$name: the held gun stays on the body edge at the SAME distance in every direction',
    ({ name, dir, weapon }) => {
      const a = armed(name, dir, weapon);
      const fill = BODY_FILL[name] ?? BODY_FILL_DEFAULT;
      const want = a.bodyR * fill * HELD_MOUNT_R;
      for (const aim of AIMS) {
        posed(a, aim);
        // Constant in every direction is the whole point: the vertical half of this offset was
        // squashed 0.45 until 2026-09-02, which made a mob's gun sit closer to its body when
        // aiming up or down — i.e. off the line its own bullets fly along (`muzzleParity`).
        expect(dist(moduleAt(a), a.centre(a.bodyBone.id)), 'aim ' + Math.round((aim * 180) / Math.PI))
          .toBeCloseTo(want, 6);
      }
    },
  );
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

/**
 * The fire recoil, against the art that actually ships (2026-08-30).
 *
 * `rigRecoil.test.ts` pins the envelope and `RigSkin.test.ts` pins what it moves, but both run
 * on a FAKE bundle where every binding scale is 1 — the exact blind spot this file's header
 * describes. What only real data can answer is whether the authored kick DISTANCE is right for
 * these seven bodies: it is one constant in rig authoring-px, applied to bodies whose drawn
 * radii range from 27.6 to 50 of those px and whose rigs range from a 40 to a 70 reference
 * radius. A number that reads well on the hero can be invisible on one rig and bury the gun in
 * another, and no fake-bundle test can see either.
 *
 * Measured in the authored-table space (`WEAPON_DEFS` + the real PNG's IHDR), NOT through
 * `getWeaponAnchor`/`getWeaponScale`, for the reason the held-mount block above documents:
 * unpreloaded, those silently fall back to the KIND default and stop testing the real gun.
 */
describe('rig composition — the fire recoil against every shipped body', () => {
  const ENEMY_GUN = WEAPON_DEFS.enemygun!;
  const gunPath = ENEMY_GUN.path.replace(/^\//, '');
  /** Anchor -> muzzle along the aim, in rig authoring-px, as `muzzleLocal` measures it. */
  const gunForward =
    barrelReach(pngWidth(gunPath), pngHeight(gunPath), ENEMY_GUN.anchor, ENEMY_GUN.rotationOffsetRad ?? 0)
    * ENEMY_GUN.scale * MODULE_SCALE;
  /** Anchor -> back of the housing, i.e. how much gun tucks INTO the body. */
  const gunBackward = ENEMY_GUN.anchor.x * pngWidth(gunPath) * ENEMY_GUN.scale * MODULE_SCALE;

  const HELD = BUNDLES.filter(({ name }) => resolveWeaponMount(RIG_DEFS[name]!.rig) === 'held');
  const SOCKET = BUNDLES.filter(({ name }) => resolveWeaponMount(RIG_DEFS[name]!.rig) === 'socket');

  // Every check here is stated at the PEAK of the envelope, and that is the worst case for all
  // of them: the recoil pulls the module straight back down its own barrel, so the closer the
  // gun gets to the body the more of it is behind the silhouette.
  it.each(HELD)('$name: the barrel still clears the body at the peak of the recoil', ({ name }) => {
    const drawnR = RIG_DEFS[name]!.rig.boneMap.get('body')!.bodyR! * BODY_FILL[name]!;
    const tipAtPeak = drawnR * HELD_MOUNT_R - RECOIL_MODULE_PX + gunForward;
    // A shot has to leave the silhouette on the frame it is fired — that is the one frame the
    // muzzle flare, the sparks and the bullet's own spawn point are all anchored on. A margin,
    // not a hairline: 1.2x is the same bar the rest-pose check next door uses.
    expect(tipAtPeak, `${name}: barrel tip ${tipAtPeak.toFixed(1)} vs drawn radius ${drawnR}`)
      .toBeGreaterThan(drawnR * 1.2);
  });

  it.each(HELD)('$name: the recoil never drives the housing through the body centre', ({ name }) => {
    const drawnR = RIG_DEFS[name]!.rig.boneMap.get('body')!.bodyR! * BODY_FILL[name]!;
    const housingBack = drawnR * HELD_MOUNT_R - RECOIL_MODULE_PX - gunBackward;
    // Still on the near side of the body's own centre. Past 0 the gun would have slid out the
    // FAR side of the creature, and the smallest shipped body (critter-core, drawn radius 35)
    // is the one with the least room — 4 authoring px of it at the peak.
    expect(housingBack, `${name}: housing back at peak, drawn radius ${drawnR}`).toBeGreaterThan(0);
    // ...and still tucked in, so it goes on reading as carried rather than as floating alongside.
    expect(housingBack).toBeLessThan(drawnR);
  });

  it.each(SOCKET)('$name: the orbiting module stays outside the core at the peak', ({ name }) => {
    const rig = RIG_DEFS[name]!.rig;
    const drawnR = rig.boneMap.get('shell')!.bodyR! * BODY_FILL[name]!;
    // The socket path mounts on the bone's TIP, which FK fixes at `len` from the body's own
    // tip; the recoil is the only thing that ever shortens that reach.
    const anchorAtPeak = rig.boneMap.get('socket_r')!.len - RECOIL_MODULE_PX;
    expect(anchorAtPeak, `${name}: module anchor at peak vs drawn radius ${drawnR}`).toBeGreaterThan(drawnR);
  });

  // A recoil smaller than a screen pixel is a recoil nobody sees — which IS the bug this pass
  // exists to fix — and it is invisible to every other test, because they all work in authoring
  // px where the constant is simply whatever it says it is.
  it.each(BUNDLES)('$name: the kick survives the scale down to world px', ({ name }) => {
    if (resolveWeaponMount(RIG_DEFS[name]!.rig) === 'none') return; // boss-core draws no gun
    const actorR = fpToPx(name.startsWith('char_') ? PLAYER_BASE.radius : BASIC_ENEMY.radius);
    // `Skin`'s own normalization: a rig's authoring px are scaled by radius / referenceRadius.
    const toWorld = actorR / RIG_DEFS[name]!.referenceRadius;
    expect(RECOIL_MODULE_PX * toWorld, `${name}: module kick in world px`).toBeGreaterThan(1);
    expect(RECOIL_BODY_PX * toWorld, `${name}: body lean in world px`).toBeGreaterThan(0.3);
    // ...and not so large it reads as the character being shoved rather than as a gun cycling:
    // the kick stays under half the body's own drawn half-width.
    const drawnHalfW = RIG_DEFS[name]!.referenceRadius * (BODY_FILL[name] ?? BODY_FILL_DEFAULT);
    expect(RECOIL_MODULE_PX).toBeLessThan(drawnHalfW / 2);
  });
});

/**
 * The clip inventory that makes firing procedural rather than a clip (design/12's "Firing is
 * NOT a clip"). This is a DATA claim, and the design note rests entirely on it: clips here are
 * sampled WHOLE, so playing `attack` would blank every bone the clip does not track, and it
 * would do nothing at all for a rig that ships without one.
 *
 * A tripwire rather than a coordinate check. If either fact below flips — an enemy bundle gains
 * an `attack`, or the hero's `attack` starts carrying the bones `idle` bobs — the reason the
 * recoil is an envelope has changed, and that decision deserves re-reading rather than silently
 * standing on a premise that no longer holds.
 */
describe('rig composition — why firing is an envelope and not the authored attack clip', () => {
  const clipsOf = (dir: string): Record<string, { keyframes: { bones: Record<string, unknown> }[] }> =>
    readJson<AnimationJson>(`skins/${dir}/animation.json`).animations as unknown as
      Record<string, { keyframes: { bones: Record<string, unknown> }[] }>;

  it('the four enemy bundles ship no attack clip at all — an envelope is the only path that covers them', () => {
    const enemies = BUNDLES.filter(({ name }) => !name.startsWith('char_'));
    expect(enemies.map(b => b.name).sort())
      .toEqual(['boss-core', 'brute-core', 'critter-core', 'floater-core']);
    for (const { name, dir } of enemies) {
      expect(Object.keys(clipsOf(dir)).sort(), `${name} clip inventory`)
        .toEqual(['death', 'hurt', 'idle', 'spawn']);
    }
  });

  it('the hero attack clip exists but tracks ONLY the socket — playing it would blank the hover bob', () => {
    for (const { name, dir } of BUNDLES.filter(b => b.name.startsWith('char_'))) {
      const clips = clipsOf(dir);
      expect(clips.attack, `${name} ships an attack clip`).toBeDefined();
      const bonesIn = (clip: string): string[] =>
        [...new Set(clips[clip]!.keyframes.flatMap(k => Object.keys(k.bones)))].sort();
      // The whole argument in one assertion: `idle` animates the body parts, `attack` does not
      // touch a single one of them, and a whole-clip swap therefore drops them all to rest.
      expect(bonesIn('attack')).toEqual(['socket_r']);
      const dropped = bonesIn('idle').filter(b => !bonesIn('attack').includes(b));
      expect(dropped, `${name}: bones idle animates that attack would blank`).toContain('shell');
      expect(dropped.length).toBeGreaterThan(2);
    }
  });
});
