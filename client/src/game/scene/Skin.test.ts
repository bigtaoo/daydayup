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

function loadedRig(): LoadedRigSkin {
  const rig = new Rig(ORB_CORE_RIG);
  return { rig, bundle: fakeBundle(rig), referenceRadius: ORB_CORE_REFERENCE_RADIUS };
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
