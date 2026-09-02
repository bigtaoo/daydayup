/**
 * Skin — the appearance layer that's either the Graphics placeholder (no real art
 * preloaded for the given skinName) or a real `.tao` rig once `skinRegistry` has
 * one — "same public interface either way" (design/12). `skinRegistry.getRigSkin`
 * is mocked here (same `vi.hoisted` convention as Pickup.test.ts's weaponSkins
 * mock) so the rig branch is reachable under plain vitest without a real asset
 * preload, using the same fake-bundle-over-a-real-Rig trick as RigSkin.test.ts.
 * Internals (`front`/`rig`) are reached the same way Actor.test.ts's `skinOf`
 * reaches Skin's own private field — cast, no public accessor.
 */
import { describe, it, expect, vi } from 'vitest';
import { Container, Texture, type Sprite } from 'pixi.js';
import { Skin } from './Skin';
import { Rig } from '../../render/Rig';
import { RigSkin } from '../../render/RigSkin';
import { ORB_CORE_RIG, ORB_CORE_REFERENCE_RADIUS } from '../../render/orbCoreRig';
import { CRITTER_CORE_RIG, CRITTER_CORE_REFERENCE_RADIUS } from '../../render/critterCoreRig';
import { BOSS_CORE_RIG, BOSS_CORE_REFERENCE_RADIUS } from '../../render/bossCoreRig';
import { RECOIL_MODULE_PX, RECOIL_MS } from '../../render/rigAttackMotion';
import type { RigSkinBundle } from '../../render/taoBundle';
import type { SpriteBinding } from '../../render/types';
import type { LoadedRigSkin } from '../../render/skinRegistry';

const mocks = vi.hoisted(() => ({ loaded: undefined as LoadedRigSkin | undefined }));
vi.mock('../../render/skinRegistry', () => ({
  getRigSkin: (_name: string) => mocks.loaded,
}));

function fakeBundle(rig: Rig): RigSkinBundle {
  const bindings = new Map<string, SpriteBinding>();
  const textures = new Map<string, Texture>();
  for (const boneId of rig.drawOrder) {
    bindings.set(boneId, { anchorX: 0.5, anchorY: 0.5, flipX: false, zOrder: 0, rotation: 0, scaleX: 1, scaleY: 1 });
    textures.set(boneId, Texture.WHITE);
  }
  return { bindings, clips: new Map(), textures };
}

/** char_vanguard's measured body fill (`skinRegistry.BODY_FILL`) — the fraction of its
 *  declared bodyR that the shell PNG actually paints. Restated here rather than imported
 *  because this file MOCKS skinRegistry wholesale; `rigComposition.test.ts` is what pins the
 *  real table against the real art. */
const ORB_CORE_BODY_FILL = 0.81;

function loadedRig(): LoadedRigSkin {
  const rig = new Rig(ORB_CORE_RIG);
  return { rig, bundle: fakeBundle(rig), referenceRadius: ORB_CORE_REFERENCE_RADIUS, bodyFill: ORB_CORE_BODY_FILL };
}

function internals(s: Skin) {
  return s as unknown as { rig?: RigSkin; front?: { rotation: number } };
}

describe('Skin — placeholder branch (no skinName, or a skinName with no preloaded rig)', () => {
  it('builds a body+front Graphics placeholder and reports hasRig=false', () => {
    mocks.loaded = undefined;
    const s = new Skin(0x123456, 0xabcdef, 20);
    expect(s.hasRig).toBe(false);
    expect(s.view.children.length).toBe(2); // body, front
  });

  it('a skinName that never resolves via getRigSkin also falls back to the placeholder', () => {
    mocks.loaded = undefined;
    const s = new Skin(0x123456, 0xabcdef, 20, 'not-a-real-skin');
    expect(s.hasRig).toBe(false);
  });

  it('setFacing rotates the front indicator by bodyRad only, ignoring aim/frameDt/clipName', () => {
    const s = new Skin(0x123456, 0xabcdef, 20);
    s.setFacing(Math.PI / 3, 99, 1000, 'attack');
    expect(internals(s).front!.rotation).toBe(Math.PI / 3);
    s.setFacing(-1, 0);
    expect(internals(s).front!.rotation).toBe(-1);
  });

  it('handAnchor returns the fixed demo anchor', () => {
    const s = new Skin(0x123456, 0xabcdef, 20);
    expect(s.handAnchor()).toEqual({ x: 0, y: 2 });
  });

  it('setWeaponKind/setWeaponTint are no-ops — no rig socket to mount onto, must not throw', () => {
    const s = new Skin(0x123456, 0xabcdef, 20);
    expect(() => s.setWeaponKind('ranged', 'blaster')).not.toThrow();
    expect(() => s.setWeaponTint(0xff0000)).not.toThrow();
    expect(s.hasRig).toBe(false);
  });
});

describe('Skin — real .tao rig branch', () => {
  it('wraps the rig view in a wrapper scaled to radiusPx/referenceRadius, no placeholder Graphics', () => {
    mocks.loaded = loadedRig();
    const s = new Skin(0x123456, 0xabcdef, 20, 'char_vanguard');
    expect(s.hasRig).toBe(true);
    expect(s.view.children.length).toBe(1); // just the wrapper
    const wrapper = s.view.children[0] as Container;
    expect(wrapper.scale.x).toBeCloseTo(20 / ORB_CORE_REFERENCE_RADIUS, 10);
    expect(wrapper.scale.y).toBeCloseTo(20 / ORB_CORE_REFERENCE_RADIUS, 10);
    expect(wrapper.children).toContain(internals(s).rig!.view);
  });

  it('applies rigTint to every rig sprite via RigSkin.setTint when provided', () => {
    mocks.loaded = loadedRig();
    const s = new Skin(0x123456, 0xabcdef, 20, 'critter-core', 0xff8800);
    const rig = internals(s).rig!;
    const sprites = (rig as unknown as { sprites: Map<string, Sprite> }).sprites;
    expect(sprites.size).toBeGreaterThan(0);
    for (const sprite of sprites.values()) expect(sprite.tint).toBe(0xff8800);
  });

  it('omitting rigTint leaves the rig at its default (untinted) tint', () => {
    mocks.loaded = loadedRig();
    const s = new Skin(0x123456, 0xabcdef, 20, 'char_vanguard');
    const rig = internals(s).rig!;
    const sprites = (rig as unknown as { sprites: Map<string, Sprite> }).sprites;
    for (const sprite of sprites.values()) expect(sprite.tint).toBe(0xffffff);
  });

  it('setFacing forwards to the rig: accumulates the clock, plays the clip, sets body facing + aim, then updates', () => {
    mocks.loaded = loadedRig();
    const s = new Skin(0x123456, 0xabcdef, 20, 'char_vanguard');
    const rig = internals(s).rig!;
    const playClip = vi.spyOn(rig, 'playClip');
    const setBodyFacing = vi.spyOn(rig, 'setBodyFacing');
    const setAim = vi.spyOn(rig, 'setAim');
    const update = vi.spyOn(rig, 'update');

    s.setFacing(1, 2, 16, 'move');
    expect(playClip).toHaveBeenCalledWith('move', 16); // clock starts at 0, += frameDt
    expect(setBodyFacing).toHaveBeenCalledWith(1);
    expect(setAim).toHaveBeenCalledWith(2);
    expect(update).toHaveBeenCalledTimes(1);

    s.setFacing(1, 2, 24, 'idle');
    expect(playClip).toHaveBeenLastCalledWith('idle', 40); // clock keeps accumulating (16+24)
  });

  it('setWeaponKind/setWeaponTint forward directly to the rig', () => {
    mocks.loaded = loadedRig();
    const s = new Skin(0x123456, 0xabcdef, 20, 'char_vanguard');
    const rig = internals(s).rig!;
    const setWeaponKind = vi.spyOn(rig, 'setWeaponKind');
    const setWeaponTint = vi.spyOn(rig, 'setWeaponTint');

    s.setWeaponKind('melee', 'saber');
    expect(setWeaponKind).toHaveBeenCalledWith('melee', 'saber');
    s.setWeaponTint(0x00ff00);
    expect(setWeaponTint).toHaveBeenCalledWith(0x00ff00);
  });
});

// muzzleAnchor (2026-08-17) — the one piece of geometry Skin adds on top of
// `RigSkin.muzzleLocal`: the wrapper scale that normalizes the rig's authoring-px
// space down to this actor's gameplay radius. `Actor.muzzlePos` then lifts the result
// into world space; `RigSkin.test.ts` covers where the point comes from inside the rig.
describe('Skin.muzzleAnchor — rig authoring-px scaled to the actor', () => {
  it('is null on the placeholder — its own barrel already ends at the sim muzzle', () => {
    mocks.loaded = undefined;
    const s = new Skin(0x123456, 0xabcdef, 20);
    expect(s.muzzleAnchor()).toBeNull();
  });

  it('is null on a rig with no weapon module mounted', () => {
    mocks.loaded = loadedRig();
    const s = new Skin(0x123456, 0xabcdef, 20, 'char_vanguard');
    s.setFacing(0, 0, 0, 'idle');
    expect(s.muzzleAnchor()).toBeNull();
  });

  it('scales the rig-local muzzle by radius / referenceRadius', () => {
    mocks.loaded = loadedRig();
    const s = new Skin(0x123456, 0xabcdef, 20, 'char_vanguard'); // 20 / 40 = 0.5x
    s.setFacing(0, 0, 0, 'idle');
    const rig = internals(s).rig!;
    // Stub the rig's own answer so this test covers ONLY the scale composition, not the
    // socket/texture geometry RigSkin.test.ts already pins down.
    rig.muzzleLocal = () => ({ x: 60, y: -46, heightPx: 46 });
    // The HEIGHT is scaled by the same wrapper as the point (2026-09-02) — it is stated in
    // the rig's authoring px too, so a half-size actor's gun hangs half as high.
    expect(s.muzzleAnchor()).toEqual({ x: 30, y: -23, heightPx: 23 });
  });

  it('a bigger actor scales the SAME rig-local point further out — the gun grows with the body', () => {
    mocks.loaded = loadedRig();
    const small = new Skin(0, 0, 20, 'char_vanguard');
    const big = new Skin(0, 0, 40, 'char_vanguard'); // 40 / 40 = 1x
    for (const s of [small, big]) s.setFacing(0, 0, 0, 'idle');
    internals(small).rig!.muzzleLocal = () => ({ x: 60, y: -46, heightPx: 46 });
    internals(big).rig!.muzzleLocal = () => ({ x: 60, y: -46, heightPx: 46 });
    expect(small.muzzleAnchor()).toEqual({ x: 30, y: -23, heightPx: 23 });
    expect(big.muzzleAnchor()).toEqual({ x: 60, y: -46, heightPx: 46 });
  });
});

// `bodyDrawnR` (2026-08-19 volume pass). A bone's `bodyR` — and the gameplay radius, which
// equals it for every rig here since every `referenceRadius` IS the body bone's `bodyR` — is a
// DECLARED radius; the PNG bound to it paints between 0.68 and 1.00 of that
// (`skinRegistry.BODY_FILL`, measured from the shipped files). Anything sized against the
// character's silhouette has to use this instead, and `Actor` sizes its ground shadow from it.
describe('Skin.bodyDrawnR — the drawn half-width, not the collision radius', () => {
  it('is the gameplay radius scaled by how much of it this bundle\'s art paints', () => {
    mocks.loaded = loadedRig();
    expect(new Skin(0x111111, 0x222222, 40, 'char_vanguard').bodyDrawnR)
      .toBeCloseTo(40 * ORB_CORE_BODY_FILL, 6);
  });

  it('scales linearly with the actor, so a bigger character has a proportionally bigger body', () => {
    mocks.loaded = loadedRig();
    const small = new Skin(0x111111, 0x222222, 20, 'char_vanguard').bodyDrawnR;
    const big = new Skin(0x111111, 0x222222, 60, 'char_vanguard').bodyDrawnR;
    expect(big / small).toBeCloseTo(3, 6);
  });

  it('is the full radius on the Graphics placeholder, whose capsule really is one radius wide', () => {
    mocks.loaded = undefined;
    expect(new Skin(0x111111, 0x222222, 40).bodyDrawnR).toBe(40);
  });

  it('is strictly smaller than the collision radius for every partly-filled bundle', () => {
    // The whole point: if these were ever equal for a bundle whose art does not fill its radius,
    // the number would be back to describing a box rather than a creature.
    mocks.loaded = loadedRig();
    expect(new Skin(0x111111, 0x222222, 40, 'char_vanguard').bodyDrawnR).toBeLessThan(40);
  });
});

/**
 * `weaponMount` is the one question `Actor` asks before deciding whether to draw its own
 * cosmetic weapon bar, and getting it wrong is expensive in both directions: answer 'sprite'
 * when nothing can mount and the actor looks unarmed; answer 'placeholder' when the rig IS
 * mounting one and two weapons render on top of each other.
 *
 * It replaced `hasRig && faction === 'player'` in `Actor` (2026-08-21). Note the third value:
 * 'none' and 'placeholder' both mean "the rig draws no sprite", but they mean opposite things
 * for Actor, and collapsing them is exactly what left the boss drawing a mob's rifle bar.
 */
describe('Skin.weaponMount — who is responsible for drawing the weapon', () => {
  it("is 'placeholder' with no rig loaded — nothing else can draw anything", () => {
    mocks.loaded = undefined;
    expect(new Skin(0x111111, 0x222222, 20).weaponMount).toBe('placeholder');
    expect(new Skin(0x111111, 0x222222, 20, 'char_vanguard').weaponMount).toBe('placeholder');
  });

  it("is 'sprite' for a socket-mount rig (the hero)", () => {
    mocks.loaded = loadedRig();
    expect(new Skin(0x111111, 0x222222, 20, 'char_vanguard').weaponMount).toBe('sprite');
  });

  it("is 'sprite' for a held-mount rig — the enemy case that used to fall through to the placeholder", () => {
    const rig = new Rig(CRITTER_CORE_RIG);
    mocks.loaded = { rig, bundle: fakeBundle(rig), referenceRadius: CRITTER_CORE_REFERENCE_RADIUS, bodyFill: 0.7 };
    expect(new Skin(0x111111, 0x222222, 15, 'critter-core').weaponMount).toBe('sprite');
  });

  it("is 'none' — not 'placeholder' — for a rig that deliberately carries no weapon (the boss)", () => {
    const rig = new Rig(BOSS_CORE_RIG);
    mocks.loaded = { rig, bundle: fakeBundle(rig), referenceRadius: BOSS_CORE_REFERENCE_RADIUS, bodyFill: 0.68 };
    const skin = new Skin(0x111111, 0x222222, 30, 'boss-core');
    expect(skin.weaponMount).toBe('none');
    expect(skin.hasRig).toBe(true); // it HAS a rig; it just isn't mounting anything
  });

  it('never depends on the faction — Skin is not told one, which is the fix', () => {
    // Regression guard in the strongest available form: the same skin name and the same
    // registry entry must give the same answer no matter who is carrying it, and `Skin`'s
    // constructor has no faction parameter for a future change to start branching on.
    mocks.loaded = loadedRig();
    const a = new Skin(0x111111, 0x222222, 20, 'char_vanguard');
    const b = new Skin(0x999999, 0x888888, 20, 'char_vanguard', 0xff0000); // enemy-style tint
    expect(a.weaponMount).toBe(b.weaponMount);
  });
});

/**
 * `Skin.attack()` — the one call `Actor.onAttack` makes. The recoil itself is covered in
 * `render/rigAttackMotion.test.ts` (the envelope) and `render/RigSkin.test.ts` (what it moves);
 * what belongs here is the WIRING, and specifically that the placeholder branch survives it:
 * a skin with no rig has no module to recoil, and firing must be a silent no-op rather than
 * the crash a `this.rig!` would give (the placeholder is what every actor renders as until
 * its bundle finishes preloading, so this path runs on the first frames of every run).
 */
describe('Skin.attack — the attack trigger', () => {
  it('kicks the rig when there is one', () => {
    mocks.loaded = loadedRig();
    const s = new Skin(0x123456, 0xabcdef, 20, 'char_vanguard');
    const kick = vi.spyOn(internals(s).rig!, 'attack');
    s.attack('ranged');
    expect(kick).toHaveBeenCalledTimes(1);
  });

  it('passes the swinging WEAPON through to the rig, not just the kind', () => {
    // The middle hop of a three-link chain (`Actor.onAttack` -> here -> `RigSkin.attack` ->
    // `AttackMotion.kick`), and the one with no observable effect of its own: drop the argument
    // here and every weapon in the game silently swings the starter saber's 162° sector, which
    // is exactly the bug the 2026-09-02 pass fixed. Both ends of the chain are asserted in
    // `Actor.test.ts` and `render/RigSkin.test.ts`; this is the link between them.
    mocks.loaded = loadedRig();
    const s = new Skin(0x123456, 0xabcdef, 20, 'char_vanguard');
    const kick = vi.spyOn(internals(s).rig!, 'attack');
    const shape = { arcDeg: 220, recoveryMs: 667 };
    s.attack('melee', shape);
    expect(kick).toHaveBeenCalledWith('melee', shape);
    s.attack('ranged');
    expect(kick).toHaveBeenLastCalledWith('ranged', undefined); // a gun has no sector
  });

  it('is a silent no-op on the placeholder — nothing mounted, nothing to recoil', () => {
    mocks.loaded = undefined;
    const s = new Skin(0x123456, 0xabcdef, 20);
    expect(() => s.attack('ranged')).not.toThrow();
    expect(() => s.setFacing(0, 0, 16, 'idle')).not.toThrow();
  });

  it('advances the recoil off the render frame clock, so it settles on its own', () => {
    mocks.loaded = loadedRig();
    const s = new Skin(0x123456, 0xabcdef, 20, 'char_vanguard');
    const advance = vi.spyOn(internals(s).rig!, 'advanceClips');
    s.setFacing(0, 0, 16, 'idle');
    expect(advance).toHaveBeenCalledWith(16);
  });
});

/**
 * `Skin.hurt()` / `Skin.spawn()` / `Skin.die()` — the other three signals (2026-09-02), and the
 * same wiring-plus-placeholder pair `Skin.attack` above is checked for. What each clip then DOES
 * is `render/RigSkin.test.ts` and `render/rigClipLayer.test.ts`; the placeholder half matters
 * because it is what every actor renders as for the first frames of a run, which is exactly when
 * a spawn fires.
 */
describe('Skin — the three lifecycle/reaction clips', () => {
  it('forwards each one to the rig', () => {
    mocks.loaded = loadedRig();
    const s = new Skin(0x123456, 0xabcdef, 20, 'char_vanguard');
    const rig = internals(s).rig!;
    const spies = {
      hurt: vi.spyOn(rig, 'hurt'), spawn: vi.spyOn(rig, 'spawn'), die: vi.spyOn(rig, 'die'),
    };
    s.hurt();
    s.spawn();
    s.die();
    expect(spies.hurt).toHaveBeenCalledTimes(1);
    expect(spies.spawn).toHaveBeenCalledTimes(1);
    expect(spies.die).toHaveBeenCalledTimes(1);
  });

  it('is a silent no-op on the placeholder — the first frames of every run render as one', () => {
    mocks.loaded = undefined;
    const s = new Skin(0x123456, 0xabcdef, 20);
    expect(() => { s.spawn(); s.hurt(); s.die(); }).not.toThrow();
    expect(() => s.setFacing(0, 0, 16, 'idle')).not.toThrow();
  });

  it('does not measure its own silhouette through a spawn — the body is at 20% there', () => {
    // `bodyDrawnH` is measured in the constructor and read by the occlusion x-ray as the
    // denominator for "how much of this character is a wall covering". The spawn clip opens at
    // scale 0.2, so a skin that started its own spawn before measuring would report a body a
    // fifth of its real height for the rest of the run. `Actor.onSpawn` is deliberately called
    // by `Scene` AFTER construction; this pins that the constructor never does it itself.
    //
    // The bundle needs a REAL spawn clip for that to mean anything. The first version of this
    // test used `loadedRig()`, whose fake bundle carries no clips at all — so `spawn()` was a
    // no-op, the two heights matched trivially, and a mutation battery walked a
    // spawn-before-measure straight past it. The `shrinks` assertion below is what makes the
    // equality above evidence rather than a coincidence.
    mocks.loaded = loadedRig();
    mocks.loaded.bundle.clips.set('spawn', {
      duration: 0.35,
      loop: false,
      keyframes: [
        { time: 0, bones: new Map([['shell', { scaleX: 0.2, scaleY: 0.2 }]]) },
        { time: 0.35, bones: new Map([['shell', { scaleX: 1, scaleY: 1 }]]) },
      ],
    });
    const a = new Skin(0, 0, 20, 'char_vanguard');
    const b = new Skin(0, 0, 20, 'char_vanguard');
    b.spawn();
    b.setFacing(0, 0, 0, 'idle');
    expect(a.bodyDrawnH).toBeGreaterThan(0);
    expect(b.bodyDrawnH).toBe(a.bodyDrawnH);
    // ...and the clip really does shrink the LIVE body, i.e. measuring through it would have
    // produced a different number.
    const shrunk = b.view.getLocalBounds().height;
    b.setFacing(0, 0, 350, 'idle'); // play the spawn out
    expect(b.view.getLocalBounds().height).toBeGreaterThan(shrunk);
  });
});

/**
 * The recoil's UNITS crossing `Skin`'s wrapper (2026-08-30). `rigAttackMotion` states the kick in rig
 * authoring px and `RigSkin` applies it there, but what the fx and the bullet spawn actually
 * consume is `muzzleAnchor()` — authoring px multiplied by `radius / referenceRadius`. Nothing
 * else pins that composition for a MOVING point: the existing `muzzleAnchor` tests stub
 * `muzzleLocal` to a constant, so they cannot see a recoil that is scaled twice, or not at all.
 */
describe('Skin.attack — the recoil crosses the wrapper scale intact', () => {
  it('moves the world-space muzzle by the authoring kick times radius / referenceRadius', () => {
    mocks.loaded = loadedRig();
    const s = new Skin(0x123456, 0xabcdef, 20, 'char_vanguard'); // 20 / 40 = 0.5x
    const rig = internals(s).rig!;
    let local = { x: 60, y: -46 };
    // Stand in for the rig's own geometry, but make it MOVE with the recoil the way the real
    // one does — the point of this test is the scale composition, not the rig arithmetic.
    rig.muzzleLocal = () => ({ x: local.x - (rig as unknown as { motion: { modulePx: number } }).motion.modulePx, y: local.y, heightPx: 46 });
    s.setFacing(0, 0, 0, 'idle');
    const rest = s.muzzleAnchor()!;
    s.attack('ranged');
    s.setFacing(0, 0, RECOIL_MS * 0.22, 'idle'); // advance to the peak through the real path
    const kicked = s.muzzleAnchor()!;
    expect(rest.x - kicked.x).toBeCloseTo(RECOIL_MODULE_PX * 0.5, 6);
    void local;
  });

  it('a bigger actor gets a proportionally bigger kick on screen — same rig, same constant', () => {
    mocks.loaded = loadedRig();
    const kickOf = (radius: number): number => {
      const s = new Skin(0, 0, radius, 'char_vanguard');
      const rig = internals(s).rig!;
      rig.muzzleLocal = () => ({ x: 60 - (rig as unknown as { motion: { modulePx: number } }).motion.modulePx, y: 0, heightPx: 46 });
      s.setFacing(0, 0, 0, 'idle');
      const rest = s.muzzleAnchor()!.x;
      s.attack('ranged');
      s.setFacing(0, 0, RECOIL_MS * 0.22, 'idle');
      return rest - s.muzzleAnchor()!.x;
    };
    expect(kickOf(40)).toBeCloseTo(kickOf(20) * 2, 6);
  });
});
