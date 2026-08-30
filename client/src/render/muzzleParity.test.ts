/// <reference types="node" />
/**
 * Muzzle parity (design/18 G6, Layer 2) — the bullet's birth position is authored TWICE and
 * nothing cross-checks the two tables:
 *
 *   SIM    `muzzleGrid` per weapon (`engine/content/weaponSpecs/*.ts`) → `RangedSimSpec
 *          .muzzleOffset` → `WeaponFireSystem.spawnBullet` spawns at `actor + muzzleOffset`
 *          along the aim ray, on the GROUND plane.
 *   RENDER `anchor` / `rotationOffsetRad` / `scale` per weapon (`render/weaponSkins.ts`) →
 *          `rigWeaponMount.barrelReach`/`moduleMuzzleLocal` → `RigSkin.muzzleLocal()` →
 *          `Actor.muzzlePos()` → `Scene` → `Bullet.setMuzzleOrigin`.
 *
 * Nothing errors when they disagree: `Bullet.setMuzzleOrigin` EASES the difference away over
 * the first `MUZZLE_EASE_DISTANCE_PX` of flight, so a mismatch is silently converted into a
 * bigger correction. That is exactly why this is a test and not a look — the failure mode is
 * "the shot bends out of the gun", which no assertion anywhere was making.
 *
 * ## The geometry this file measures
 *
 * Everything is evaluated at aim = 0 (due east), the one pose where the whole chain is a
 * single scalar reach along the aim ray, and where the sim's own `muzzleOffset` is by
 * definition that same scalar. In that pose:
 *
 *   render reach (world px) = ( mount.x + barrelReach(tex, anchor, rotationOffsetRad) × scale )
 *                             × (actor radius px / rig referenceRadius)
 *
 * `mount.x` is `activeModuleMount`'s own answer — the socket bone's FK tip for the hero's
 * orb-core ('socket'), the body's measured drawn edge for a mob ('held') — and the trailing
 * factor is `Skin`'s authoring-px → gameplay-radius wrapper scale. All three are called here
 * as the shipped functions rather than restated, so a retune of any of them moves this table.
 *
 * ## The per-weapon table, measured 2026-08-30 (gap = render − sim, world px)
 *
 *   weapon         carrier              sim px   render px      gap
 *   blaster        char_vanguard         30.02       39.52    +9.51
 *   carom          char_vanguard         30.02       39.68    +9.67
 *   cannon         char_vanguard         32.00       41.96    +9.96
 *   tomahawk       char_vanguard         30.02       42.99   +12.98
 *   repeater       char_vanguard         30.02       42.40   +12.38
 *   seeker         char_vanguard         30.02       43.58   +13.56
 *   scattergun     char_vanguard         30.02       43.65   +13.63
 *   teslagun       char_vanguard         30.02       45.32   +15.31
 *   mortar         char_vanguard         30.02       45.51   +15.49
 *   frostseeker    char_vanguard         30.02       47.93   +17.91
 *   flamer         char_vanguard         30.02       47.98   +17.97
 *   lasercutter    char_vanguard         30.02       48.00   +17.99
 *   venomspit      char_vanguard         30.02       48.41   +18.39
 *   cryobolt       char_vanguard         30.02       49.05   +19.04
 *   cinderscatter  char_vanguard         30.02       49.47   +19.46
 *   gyre           char_vanguard         51.20       40.90   −10.30
 *   novaburst      char_vanguard         16.00       41.81   +25.81  ← declared exception
 *   enemygun       critter-core@15px     20.00       22.59    +2.59
 *   enemygun       critter-core@17px     20.00       25.58    +5.58  (ironclad, a bigger body)
 *   enemygun       floater-core@13px     20.00       23.45    +3.45
 *   enemygun       brute-core@20px       20.00       36.11   +16.11
 *
 * `gyre` is the one NEGATIVE row and it is deliberate: `muzzleGrid 1.6` spawns its projectile
 * out on the orbit circle (weaponSpecs' own comment), so the sim muzzle is meant to sit past
 * the barrel. `enemygun`'s spread is the mob bodies, not the gun — the same weapon on a
 * 20 px brute reaches 13 px further than on a 15 px critter, since the rig scales whole.
 *
 * The +12..14 px cluster is the same offset `Bullet.ts`' own doc records as "measured on real
 * shots", which is the cheapest available check that this model of the chain is the real one.
 *
 * ## Why the bound is `ease / 2` and not `ease`
 *
 * Derived, not chosen (and `derivedEaseDistancePx()` below measures the ease budget off the
 * shipped `Bullet` rather than restating the un-exported 40): the drawn position is
 * `base + gap·k²` with `k = remaining/ease`, so at the moment of the shot the correction
 * drains at `2·gap/ease` px per px flown. Above `gap = ease/2` that exceeds the bullet's own
 * forward motion and the drawn round moves BACKWARDS out of the barrel. `it('a gap of
 * ease/2 is exactly …')` proves that on a real Bullet instead of trusting this paragraph.
 *
 * `novaburst` is over it (25.81 px) and is a DECLARED EXCEPTION rather than a loosened bound:
 * its `muzzleGrid` is 0.5 where the rest of the ranged catalog is 0.9375, i.e. its sim muzzle
 * is half the roster's while its art reaches as far as any of them. Nothing about the frame
 * (a burst emitter) explains the halved offset, so this is recorded as a real content
 * disagreement with a ceiling on it, not as a rule.
 *
 * ## Mutation battery
 *
 * Run 2026-08-30 against this file only (`npx vitest run src/render/muzzleParity.test.ts`),
 * every mutation reverted afterwards and confirmed clean with `git diff --stat`.
 *
 *   KILLED   novaburst muzzleGrid 0.5 -> 0.9375 ...... 1 test: the declared-exception guard
 *   KILLED   cannon muzzleGrid 1.0 -> 2.0 ............ 1: the smooth-departure bound
 *   KILLED   ORB_CORE_RIG socket_r len 52 -> 80 ...... 1: novaburst's exception ceiling
 *   KILLED   HELD_MOUNT_R 1.0 -> 1.6 ................. 1: the smooth bound, via enemygun
 *   KILLED   MUZZLE_EASE_DISTANCE_PX 40 -> 24 ........ 1: the HARD bound (gap >= a full ease)
 *   KILLED   scattergun rotationOffsetRad dropped .... 1: the barrel-direction check
 *   KILLED   blaster anchor.x 0.22 -> 0.72 ........... 2: barrel direction + the smooth bound
 *   KILLED   blaster render scale 80/160 -> 130/160 .. 1: the smooth bound
 *   KILLED   WEAPON_DEFS.gyre entry deleted .......... 2: coverage + the def-count guard
 *   SURVIVED blaster render scale 80/160 -> 110/160
 *   SURVIVED MODULE_SCALE 0.75 -> 0.6
 *
 * Each kill was checked to be the test whose NAME describes that mutation, not merely some
 * red. The two survivors are the same honest gap, recorded rather than papered over: this
 * file bounds the sim/render DISAGREEMENT, so a render-side rescale is invisible to it until
 * the gap actually leaves the budget. blaster at 110/160 is still 16.6 px out (it dies at
 * ~125/160), and `MODULE_SCALE` 0.6 moves every muzzle INWARD, toward the sim point, which
 * shrinks every gap in the table. How big a module may be in the first place is a different
 * question, owned by `rigComposition.test.ts`'s module-proportion band — which does kill the
 * per-weapon 110/160 (checked), though not `MODULE_SCALE` itself, since that constant is the
 * deliberate whole-roster proportion knob its own doc says to tune.
 */
import { describe, it, expect, beforeAll, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import type { Texture } from 'pixi.js';
import {
  ENEMY_BLUEPRINTS,
  PLAYER_BASE,
  WEAPON_SPECS,
  toSimSpec,
  type RangedSimSpec,
  type WeaponSpec,
} from '@dd/engine';

const PUBLIC = new URL('../../public/', import.meta.url);

/** A PNG's real pixel size, straight from its IHDR chunk — same reader, and same "never trust
 *  a recorded number" reason, as `rigComposition.test.ts`. */
function pngSize(path: string): { width: number; height: number } {
  const bytes = readFileSync(new URL(`.${path}`, PUBLIC));
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
}

// `Assets.load` would hit the network. Stubbed the same way biomeTilesLoad/
// environmentSpritesLoad already stub it — spread over the real module so everything else
// pixi exports stays REAL (`Bullet` below builds actual Graphics). The fake texture carries
// the PNG's true on-disk width/height: `barrelReach` is a ray/rect intersection against the
// texture's own bounds, so a made-up size would silently rescale every render-side number
// here and the whole table would measure a texture that does not ship.
const mocks = vi.hoisted(() => ({ assetsLoad: vi.fn() }));
vi.mock('pixi.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('pixi.js')>();
  return { ...actual, Assets: { ...actual.Assets, load: mocks.assetsLoad } };
});

import { Bullet } from '../game/scene/Bullet';
import { fpToPx } from '../game/coords';
import { BODY_FILL, BODY_FILL_DEFAULT, RIG_DEFS } from './skinRegistry';
import {
  activeModuleMount,
  barrelReach,
  moduleMuzzleLocal,
  resolveWeaponMount,
  type WeaponMountMode,
} from './rigWeaponMount';
import type { Rig } from './Rig';
import {
  KIND_DEFAULTS,
  MODULE_SCALE,
  WEAPON_DEFS,
  getWeaponAnchor,
  getWeaponRotationOffset,
  getWeaponScale,
  getWeaponTexture,
  preloadWeaponSkins,
  type WeaponVisualKind,
} from './weaponSkins';

beforeAll(async () => {
  mocks.assetsLoad.mockImplementation(async (arg: string | { src: string }) => {
    const src = typeof arg === 'string' ? arg : arg.src;
    return pngSize(src) as unknown as Texture;
  });
  await preloadWeaponSkins();
  EASE_PX = derivedEaseDistancePx(10);
});

// ── The sim/render pairing, resolved from real content ──────────────────────────────────

/** Aim due east: the pose where the sim's `muzzleOffset` and the drawn barrel tip are the
 *  same one-dimensional reach, so the two tables can be subtracted at all. */
const AIM_EAST = 0;

/** Who actually carries this weapon, resolved exactly the way `Actor` does it: a player's
 *  `atlasKey` (the roster shares one rig and one radius), an enemy blueprint's `bodyRig ??
 *  'critter-core'` with that blueprint's own radius. */
interface Carrier {
  label: string;
  rigName: string;
  radiusPx: number;
}

const HERO: Carrier = {
  label: 'char_vanguard',
  rigName: 'char_vanguard',
  radiusPx: fpToPx(PLAYER_BASE.radius),
};

/** Every enemy body that fires `enemygun` — i.e. every blueprint whose rig mounts a weapon at
 *  all. Deliberately built from `ENEMY_BLUEPRINTS` rather than listed, so a mob added later is
 *  swept without anyone remembering to come here. The boss is excluded by its rig, not by
 *  name: `boss-core` declares `weaponMount: 'none'` (see the null-mount test below). */
function enemyCarriers(): Carrier[] {
  const seen = new Map<string, Carrier>();
  for (const bp of Object.values(ENEMY_BLUEPRINTS)) {
    const rigName = bp.bodyRig ?? 'critter-core';
    if (resolveWeaponMount(RIG_DEFS[rigName]!.rig) === 'none') continue;
    // Keyed by rig+radius: the four elemental re-tints are the same body at the same size and
    // would otherwise repeat one row four times. The radius stays part of the key (and of the
    // label) because it scales the whole rig — `ironclad` is a critter-core at 17 px where the
    // rest are 15, which is a different drawn muzzle for the same gun.
    const radiusPx = fpToPx(bp.radius);
    seen.set(`${rigName}:${radiusPx}`, { label: `${rigName}@${radiusPx}px`, rigName, radiusPx });
  }
  return [...seen.values()];
}

/** The body bone a 'held' module hangs off, picked the way `RigSkin.heldMountBody` picks it:
 *  the rig's own body (the root-level bone carrying a `bodyR`). */
function bodyBone(rig: Rig): { boneId: string; bodyR: number } {
  const bone = rig.boneDefs.find(b => b.parent === 'root' && b.bodyR !== undefined)!;
  return { boneId: bone.id, bodyR: bone.bodyR! };
}

/**
 * Where this weapon's drawn business end sits, in world px measured from the actor's own
 * origin along the aim ray — the render half of the pair. Null when the carrier's rig mounts
 * nothing, which is the same null `RigSkin.muzzleLocal()` hands `Scene`.
 *
 * Runs the SHIPPED chain (`Rig.computeFK` → `activeModuleMount` → `moduleMuzzleLocal`, with
 * the resolvers supplying anchor/rotation/scale) rather than restating its arithmetic, so
 * the numbers here can only agree with the game by actually agreeing with it.
 */
function drawnMuzzleReachPx(weaponId: string, kind: WeaponVisualKind, carrier: Carrier): number | null {
  const entry = RIG_DEFS[carrier.rigName]!;
  const mode: WeaponMountMode = resolveWeaponMount(entry.rig);
  const worldPose = entry.rig.computeFK(0, 0, new Map());
  const body = bodyBone(entry.rig);
  const fill = BODY_FILL[carrier.rigName] ?? BODY_FILL_DEFAULT;
  const mount = activeModuleMount(
    mode,
    worldPose,
    new Map(),
    AIM_EAST,
    { boneId: body.boneId, drawnR: body.bodyR * fill },
    0, // at rest: no recoil, the pose every measurement in this file is taken in
  );
  if (!mount) return null;
  const local = moduleMuzzleLocal(
    mount,
    AIM_EAST,
    1,
    getWeaponTexture(weaponId, kind)!,
    getWeaponAnchor(weaponId, kind),
    getWeaponRotationOffset(weaponId, kind),
    getWeaponScale(weaponId, kind),
  );
  // `Skin`'s wrapper normalizes the rig's authoring px onto this actor's gameplay radius.
  return local.x * (carrier.radiusPx / entry.referenceRadius);
}

interface ParityRow {
  id: string;
  carrier: string;
  simPx: number;
  renderPx: number;
  gap: number;
}

/** One row per (ranged weapon × body that carries it). Melee has no `muzzleOffset` and spawns
 *  no projectile, so it is covered by the catalog-coverage sweep instead. */
function parityRows(): ParityRow[] {
  const rows: ParityRow[] = [];
  for (const [id, spec] of Object.entries(WEAPON_SPECS)) {
    if (spec.kind !== 'ranged') continue;
    const sim = toSimSpec(spec) as RangedSimSpec;
    const simPx = fpToPx(sim.muzzleOffset);
    // `enemygun` is the enemy loadout (`content/enemies.ts` gives every blueprint
    // ENEMY_GUN_SIM) and is excluded from the player's `WEAPON_SIM_BY_ID` — its parity is
    // against the mob bodies, at their radii, not the hero's.
    for (const carrier of id === 'enemygun' ? enemyCarriers() : [HERO]) {
      const renderPx = drawnMuzzleReachPx(id, 'ranged', carrier);
      expect(renderPx, `${id} on ${carrier.label}: expected a mounted module`).not.toBeNull();
      rows.push({ id, carrier: carrier.label, simPx, renderPx: renderPx!, gap: renderPx! - simPx });
    }
  }
  return rows;
}

/**
 * The ease budget, MEASURED off the shipped `Bullet` (`MUZZLE_EASE_DISTANCE_PX` is private —
 * `Bullet.test.ts` pins it by behaviour for the same reason). Fly a bullet forward in small
 * steps and report the travel at which the correction is exactly spent. Derived rather than
 * hardcoded so a retune of that constant retunes this file's bounds with it, instead of
 * leaving a stale 40 behind that no longer describes anything.
 */
function derivedEaseDistancePx(offsetPx: number): number {
  const b = new Bullet(4);
  b.place(0, 0, 0);
  b.setMuzzleOrigin(offsetPx, 0);
  b.interpolate(1, 0);
  for (let i = 1; i <= 4000; i++) {
    const d = i * 0.25;
    b.pushState(d, 0, 0, 0);
    b.interpolate(1, 16);
    if (b.x - d === 0) return d;
  }
  throw new Error('the muzzle correction never finished — Bullet.setMuzzleOrigin changed shape');
}

let EASE_PX = 0;

// ── 1. Every sim weapon has a render entry ──────────────────────────────────────────────

describe('catalog coverage — every weapon the sim can equip has its own render calibration', () => {
  it('resolves every WEAPON_SPECS id to its OWN weaponSkins entry, never the kind default', () => {
    const ids = Object.keys(WEAPON_SPECS);
    const fellBack: string[] = [];
    let checked = 0;
    for (const id of ids) {
      const spec: WeaponSpec = WEAPON_SPECS[id]!;
      const kind: WeaponVisualKind = spec.kind === 'melee' ? 'melee' : 'ranged';
      const own = WEAPON_DEFS[id];
      if (!own) {
        fellBack.push(id);
        continue;
      }
      // Identity, not equality: `weaponSkins.resolve` returns ONE def and every getter reads
      // the same object, which is what stops a texture from one weapon being paired with
      // another's anchor. Comparing values would pass even if each getter picked its own.
      expect(getWeaponAnchor(id, kind), `${id} anchor`).toBe(own.anchor);
      expect(getWeaponScale(id, kind), `${id} scale`).toBeCloseTo(own.scale * MODULE_SCALE, 12);
      expect(getWeaponRotationOffset(id, kind), `${id} rotation`).toBe(own.rotationOffsetRad ?? 0);
      // The art has to match the KIND too: a sword texture on a ranged weapon would resolve
      // "coherently" and still draw the wrong object.
      expect(own.path.startsWith(kind === 'melee' ? '/weapons/sword_' : '/weapons/gun_'), own.path).toBe(true);
      checked++;
    }
    expect(fellBack, 'weapons with no render calibration of their own').toEqual([]);
    // Anti-vacuity: the loop above is over a table, and an empty or silently shrunken table
    // would satisfy every assertion inside it. 25 is the shipped catalog as of 2026-08-30 —
    // a floor, not a pin, so adding a weapon does not fail this line (the `fellBack` check
    // above is what holds a new one to having art).
    expect(checked, 'weapons actually swept').toBe(ids.length);
    expect(checked).toBeGreaterThanOrEqual(25);
  });

  it('points every barrel AWAY from its own socket end of the canvas', () => {
    // What `rotationOffsetRad` is for, stated as a check instead of as a comment. Each
    // texture is drawn socket-at-one-end / business-end-at-the-other, and the offset cancels
    // whichever way that particular art was baked; `barrelReach` then walks from the anchor
    // toward the canvas edge in the baked direction. So the baked direction's x component and
    // the anchor's own side of the canvas must have OPPOSITE signs — a barrel that walks back
    // toward its own socket is a texture whose offset was dropped, mis-signed, or never
    // measured, and the muzzle then lands inside the housing.
    //
    // This is the one check here that a self-consistent edit to `weaponSkins` cannot satisfy
    // by construction: everything else about a def is compared against that same def.
    const defs = [...Object.entries(KIND_DEFAULTS), ...Object.entries(WEAPON_DEFS)] as Array<
      [string, { anchor: { x: number; y: number }; rotationOffsetRad?: number }]
    >;
    expect(defs.length).toBeGreaterThanOrEqual(27); // 2 kind defaults + 25 weapons, 2026-08-30
    for (const [key, def] of defs) {
      const bakedDirX = Math.cos(-(def.rotationOffsetRad ?? 0));
      const anchorSide = def.anchor.x - 0.5;
      expect(
        bakedDirX * anchorSide,
        `${key}: barrel direction x=${bakedDirX.toFixed(3)} runs back toward its own anchor ` +
          `side (anchor.x=${def.anchor.x})`,
      ).toBeLessThan(0);
    }
  });

  it('degrades a MISSING entry to the neutral kind default as one coherent unit', () => {
    // An unregistered id must not pick up a real weapon's anchor/scale/rotation — it takes
    // the kind default's, all three from the same def, so the fallback silhouette is drawn
    // correctly rather than drawn wrong.
    const ghost = 'no_such_weapon';
    expect(WEAPON_DEFS[ghost]).toBeUndefined();
    expect(getWeaponAnchor(ghost, 'ranged')).toBe(KIND_DEFAULTS.ranged.anchor);
    expect(getWeaponScale(ghost, 'ranged')).toBeCloseTo(KIND_DEFAULTS.ranged.scale * MODULE_SCALE, 12);
    expect(getWeaponRotationOffset(ghost, 'ranged')).toBe(KIND_DEFAULTS.ranged.rotationOffsetRad ?? 0);
    expect(getWeaponAnchor(ghost, 'melee')).toBe(KIND_DEFAULTS.melee.anchor);
  });

  it('degrades a NOT-YET-PRELOADED weapon to no correction at all, not to a wrong one', async () => {
    // The frames before `preloadWeaponSkins` resolves. `RigSkin.updateWeaponSprites` mounts
    // nothing without a texture, `muzzleLocal()` is then null, and `Scene` skips
    // `setMuzzleOrigin` entirely — the bullet stays exactly where the engine put it. The
    // dangerous alternative would be reporting a muzzle for a texture that isn't there.
    // A FRESH module instance (this file's own copy is preloaded in `beforeAll`), which is
    // the only way to observe the pre-preload registry at all.
    vi.resetModules();
    const fresh = await import('./weaponSkins');
    expect(fresh.getWeaponTexture('blaster', 'ranged')).toBeUndefined();
    expect(fresh.getWeaponTexture(undefined, 'ranged')).toBeUndefined();
    // ...while this file's own preloaded copy is unaffected, i.e. the two really are
    // different registries and the assertion above is not just re-reading a broken one.
    expect(getWeaponTexture('blaster', 'ranged')).toBeDefined();
  });
});

// ── 2. The gap the ease has to absorb ───────────────────────────────────────────────────

/**
 * Weapons whose two tables disagree by more than the derived budget. A DECLARED row, not a
 * loosened bound — it is fenced from both sides by the two tests below: the gap may not grow
 * past `ceilingPx`, and it may not SHRINK back inside the budget either, because an exception
 * that is no longer one has to be deleted from here rather than left as a rubber stamp.
 */
const DECLARED_GAP_EXCEPTIONS: Record<string, { ceilingPx: number; why: string }> = {
  novaburst: {
    ceilingPx: 27,
    why: "muzzleGrid 0.5 against the ranged catalog's 0.9375 — the sim muzzle is half the " +
      'roster\'s while the art reaches as far as any of them (measured gap 25.81 px)',
  },
};

describe('sim ↔ render muzzle parity — the gap the ease has to absorb', () => {
  it('sweeps every ranged weapon in the catalog (and every body that carries it)', () => {
    const rows = parityRows();
    const rangedIds = Object.entries(WEAPON_SPECS).filter(([, s]) => s.kind === 'ranged').map(([id]) => id);
    // Anti-vacuity, twice over: the row set must cover the real catalog, and it must be
    // BIGGER than the catalog, because `enemygun` contributes one row per enemy body.
    expect(new Set(rows.map(r => r.id))).toEqual(new Set(rangedIds));
    expect(rangedIds.length).toBeGreaterThanOrEqual(15);
    expect(rows.length).toBeGreaterThan(rangedIds.length);
    // Every measurement is a real distance, not a zero that would satisfy any bound below.
    for (const r of rows) {
      expect(r.simPx, `${r.id} sim muzzle`).toBeGreaterThan(0);
      expect(r.renderPx, `${r.id} drawn muzzle on ${r.carrier}`).toBeGreaterThan(0);
    }
  });

  it('measures the ease budget off the shipped Bullet, independently of the offset size', () => {
    expect(EASE_PX).toBeGreaterThan(1);
    expect(EASE_PX).toBeLessThan(200);
    // The budget is a distance the bullet flies, not a fraction of the correction: a much
    // larger offset must spend over exactly the same ground.
    expect(derivedEaseDistancePx(120)).toBeCloseTo(EASE_PX, 6);
  });

  it('a gap of ease/2 is exactly where the drawn round stops moving forward', () => {
    // The derivation behind the bound used below, checked on a real Bullet rather than
    // asserted in prose. At `gap = ease/2` the correction drains at exactly the bullet's own
    // speed, so the drawn round hangs still on the first px of flight; any more and it walks
    // backwards out of the barrel while the sim point runs away from it.
    const drawnStep = (gap: number): number => {
      const b = new Bullet(4);
      b.place(0, 0, 0);
      b.setMuzzleOrigin(gap, 0);
      b.interpolate(1, 0);
      const before = b.x;
      b.pushState(0.5, 0, 0, 0);
      b.interpolate(1, 16);
      return b.x - before;
    };
    expect(drawnStep(EASE_PX / 2 - 1)).toBeGreaterThan(0); // still moving forward
    expect(drawnStep(EASE_PX / 2 + 1)).toBeLessThan(0); // reversed
  });

  it('keeps every weapon inside the derived budget, exceptions declared per weapon', () => {
    const rows = parityRows();
    const smoothBound = EASE_PX / 2;
    const over: string[] = [];
    for (const r of rows) {
      // The hard bound applies to everything, exceptions included: past a FULL ease budget
      // the correction cannot be spent within the flight it was designed for at all.
      expect(Math.abs(r.gap), `${r.id} on ${r.carrier}: gap ${r.gap.toFixed(2)}px vs ease ${EASE_PX}px`)
        .toBeLessThan(EASE_PX);
      const declared = DECLARED_GAP_EXCEPTIONS[r.id];
      if (declared) {
        expect(Math.abs(r.gap), `${r.id}: declared exception (${declared.why})`).toBeLessThan(declared.ceilingPx);
        continue;
      }
      if (Math.abs(r.gap) >= smoothBound) over.push(`${r.id} on ${r.carrier}: ${r.gap.toFixed(2)}px`);
    }
    expect(over, `over the ${smoothBound}px smooth-departure bound and not declared`).toEqual([]);
  });

  it('holds every declared exception to still BEING one — a fixed weapon must be deleted here', () => {
    const rows = parityRows();
    for (const [id, declared] of Object.entries(DECLARED_GAP_EXCEPTIONS)) {
      const worst = rows.filter(r => r.id === id).sort((a, b) => Math.abs(b.gap) - Math.abs(a.gap))[0];
      expect(worst, `${id} is declared an exception but is not in the catalog sweep`).toBeDefined();
      expect(
        Math.abs(worst!.gap),
        `${id} now fits the ${EASE_PX / 2}px bound (${worst!.gap.toFixed(2)}px) — delete its ` +
          `DECLARED_GAP_EXCEPTIONS row rather than leaving a rubber stamp behind: ${declared.why}`,
      ).toBeGreaterThanOrEqual(EASE_PX / 2);
    }
  });
});

// ── 3. The correction is fully spent, from a REAL weapon's numbers ──────────────────────

describe('Bullet.setMuzzleOrigin — spent by the budget distance, driven by real catalog numbers', () => {
  // `Bullet.test.ts` already covers the ease CURVE (monotonicity, hypot travel measurement,
  // overshoot, the shadow). What it cannot cover is that the offset it feeds — a hardcoded
  // (30, -18) — is anything a shipped weapon would actually produce. This derives the offset
  // from the blaster's own two tables, exactly as `Scene` composes it, so a retune of either
  // side is exercised here instead of being invisible to both files.
  const SIM_X = 500;
  const SIM_GROUND_Y = 300;

  /** `Scene`: `setMuzzleOrigin(muzzle.x - bx, muzzle.y - (by - bz))` — the drawn barrel tip
   *  minus the engine's spawn point, the latter already lifted onto the screen by `bulletZ`. */
  function realOffsetFor(id: string): { dx: number; dy: number; zPx: number } {
    const sim = toSimSpec(WEAPON_SPECS[id]!) as RangedSimSpec;
    const entry = RIG_DEFS[HERO.rigName]!;
    const wrapper = HERO.radiusPx / entry.referenceRadius;
    const mount = activeModuleMount(
      resolveWeaponMount(entry.rig), entry.rig.computeFK(0, 0, new Map()), new Map(), AIM_EAST, null, 0,
    )!;
    const local = moduleMuzzleLocal(
      mount, AIM_EAST, 1, getWeaponTexture(id, 'ranged')!,
      getWeaponAnchor(id, 'ranged'), getWeaponRotationOffset(id, 'ranged'), getWeaponScale(id, 'ranged'),
    );
    const zPx = fpToPx(sim.bulletZ);
    return {
      dx: local.x * wrapper - fpToPx(sim.muzzleOffset),
      // The bullet's SCREEN y is its ground y minus the z lift, and the shooter's own ground
      // y is the bullet's (aim is due east, so the sim muzzle slides purely horizontally) —
      // so the vertical half of the correction is the drawn barrel's height plus that lift.
      dy: local.y * wrapper + zPx,
      zPx,
    };
  }

  it('spends a real blaster shot’s whole correction within the ease budget', () => {
    const { dx, dy, zPx } = realOffsetFor('blaster');
    // Non-vacuous: this weapon's two tables really do disagree, in BOTH axes — a zero offset
    // would make the "fully spent" assertion below true for free.
    expect(Math.hypot(dx, dy)).toBeGreaterThan(5);
    expect(dx).not.toBe(0);
    expect(dy).not.toBe(0);

    const b = new Bullet(4);
    b.place(SIM_X, SIM_GROUND_Y, zPx);
    b.setMuzzleOrigin(dx, dy);
    b.interpolate(1, 0);
    // Frame one: drawn at the gun, i.e. the full correction over the lifted sim position.
    expect(b.x).toBeCloseTo(SIM_X + dx, 6);
    expect(b.y).toBeCloseTo(SIM_GROUND_Y - zPx + dy, 6);

    // ...and after the budget distance of travel, exactly on the sim line. Exact equality, not
    // toBeCloseTo: the correction is switched off, not merely small.
    b.pushState(SIM_X + EASE_PX, SIM_GROUND_Y, zPx, 0);
    b.interpolate(1, 1000 / 30);
    expect(b.x).toBe(SIM_X + EASE_PX);
    expect(b.y).toBe(SIM_GROUND_Y - zPx);
  });

  it('still has correction left one px short of the budget, for every ranged weapon', () => {
    // The other half of "fully spent by the budget": that the budget is what spends it, not
    // some earlier snap. Swept over the catalog so it is a statement about the pair of tables
    // rather than about one lucky weapon.
    const ids = Object.entries(WEAPON_SPECS).filter(([, s]) => s.kind === 'ranged').map(([id]) => id);
    expect(ids.length).toBeGreaterThanOrEqual(15);
    for (const id of ids) {
      if (id === 'enemygun') continue; // mounted on a mob body, measured in the sweep above
      const { dx, dy, zPx } = realOffsetFor(id);
      const b = new Bullet(4);
      b.place(SIM_X, SIM_GROUND_Y, zPx);
      b.setMuzzleOrigin(dx, dy);
      b.interpolate(1, 0);
      b.pushState(SIM_X + EASE_PX - 1, SIM_GROUND_Y, zPx, 0);
      b.interpolate(1, 1000 / 30);
      const residual = Math.hypot(b.x - (SIM_X + EASE_PX - 1), b.y - (SIM_GROUND_Y - zPx));
      expect(residual, `${id} correction at 1px short of the budget`).toBeGreaterThan(0);
    }
  });
});

// ── 4. A rig that mounts nothing ────────────────────────────────────────────────────────

describe('a rig with no mounted module yields null — the bullet stays where the engine put it', () => {
  it("gives the boss's 'none' body plan no mount and therefore no muzzle", () => {
    const boss = RIG_DEFS['boss-core']!;
    expect(resolveWeaponMount(boss.rig)).toBe('none');
    const worldPose = boss.rig.computeFK(0, 0, new Map());
    const body = bodyBone(boss.rig);
    // Handed a perfectly good body to hang a gun off, and a real socket-less pose: 'none' is
    // a decision about the BODY PLAN, so neither argument may talk it into mounting one.
    expect(activeModuleMount('none', worldPose, new Map(), AIM_EAST, { boneId: body.boneId, drawnR: body.bodyR }, 0))
      .toBeNull();
    expect(activeModuleMount('none', worldPose, new Map(), AIM_EAST, null, 0)).toBeNull();
  });

  it('is the boss blueprint that actually reaches that rig, not just a table entry', () => {
    // The link the previous test assumes: the shipped boss really does point at 'boss-core',
    // so "the boss draws no gun" is a fact about content and not about a rig nobody uses.
    const bosses = Object.values(ENEMY_BLUEPRINTS).filter(bp => bp.boss);
    expect(bosses.length).toBeGreaterThan(0);
    for (const bp of bosses) expect(resolveWeaponMount(RIG_DEFS[bp.bodyRig ?? 'critter-core']!.rig)).toBe('none');
  });

  it('gives a socket rig no mount before its pose exists (the frames before FK has run)', () => {
    // The other null `Scene` has to survive: an empty pose (nothing computed yet this frame).
    // `barrelReach` is still a perfectly good number here — which is exactly the trap: without
    // the null the module would be mounted at (0,0), i.e. the muzzle would be reported inside
    // the character rather than not reported at all.
    const hero = RIG_DEFS[HERO.rigName]!;
    expect(resolveWeaponMount(hero.rig)).toBe('socket');
    expect(activeModuleMount('socket', new Map(), new Map(), AIM_EAST, null, 0)).toBeNull();
    const tex = getWeaponTexture('blaster', 'ranged')!;
    expect(barrelReach(tex.width, tex.height, getWeaponAnchor('blaster', 'ranged'),
      getWeaponRotationOffset('blaster', 'ranged'))).toBeGreaterThan(0);
  });
});
