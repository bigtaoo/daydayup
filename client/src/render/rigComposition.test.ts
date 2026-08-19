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
import { RIG_DEFS } from './skinRegistry';
import { RigSkin } from './RigSkin';
import { deserializeClip, type AnimationJson } from './taoBundle';
import { KIND_DEFAULTS, WEAPON_DEFS, MODULE_SCALE, type WeaponVisualDef } from './weaponSkins';
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

/** The (skinName → bundle directory) pairs the GAME preloads, parsed out of main.ts's own
 *  source. Read rather than imported because importing main.ts runs `boot()` (same `?raw`-
 *  style trick as textMetrics.test.ts) — and read at all so a character added to main.ts
 *  can't quietly skip every check in this file. */
function preloadedBundles(): Array<{ name: string; dir: string }> {
  const source = readFileSync(new URL('../main.ts', import.meta.url)).toString('utf8');
  const list = source.match(/CHAR_BUNDLES[\s\S]*?\];/)?.[0] ?? '';
  return [...list.matchAll(/\['([\w-]+)',\s*'\/skins\/([\w-]+)'\]/g)].map(m => ({ name: m[1], dir: m[2] }));
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
