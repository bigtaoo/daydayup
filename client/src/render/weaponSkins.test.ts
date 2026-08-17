/**
 * weaponSkins.ts's per-weapon business-end art registry. Same "no asset server in this
 * test environment" convention as uiSkins.test.ts: every `Assets.load` call genuinely
 * rejects here, which is exactly what exercises the two bugs this file's preload/resolve
 * logic used to have — (1) `preloadWeaponSkins()` used to run every load through a
 * SINGLE `Promise.all` with no per-item try/catch, so it would REJECT outright the
 * instant any one texture failed, aborting every other still-in-flight load instead of
 * resolving best-effort like every sibling preloader; (2) `getWeaponTexture` (and the
 * anchor/scale/rotation getters) only fell back to the kind-default when a weapon id
 * was entirely unregistered, not when it WAS registered but its texture simply never
 * loaded — leaving the weapon socket fully invisible instead of the neutral silhouette.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import {
  preloadWeaponSkins, getWeaponTexture, getWeaponAnchor, getWeaponScale, getWeaponRotationOffset,
  KIND_DEFAULTS, WEAPON_DEFS, MODULE_SCALE,
} from './weaponSkins';

describe('preloadWeaponSkins — best-effort, never rejects (missing/unreachable art must not block boot)', () => {
  beforeAll(async () => {
    await preloadWeaponSkins();
  });

  it('resolves cleanly even though every load fails in this test environment', async () => {
    await expect(preloadWeaponSkins()).resolves.toBeUndefined();
  });

  it('a registered-but-never-loaded weapon falls back to its KIND texture, not undefined (invisible)', () => {
    // 'scattergun' is a real WEAPON_DEFS entry, but its texture never loaded here —
    // before the fix this returned undefined (RigSkin.updateWeaponSprite hides the
    // sprite entirely); now it degrades to the neutral ranged silhouette instead.
    expect(getWeaponTexture('scattergun', 'ranged')).toBe(getWeaponTexture(undefined, 'ranged'));
  });

  it('an unregistered weapon id still falls back to the kind default, as before', () => {
    expect(getWeaponTexture('not-a-real-weapon', 'melee')).toBe(getWeaponTexture(undefined, 'melee'));
  });

  it('the anchor/scale/rotation getters fall back to the KIND default TOGETHER with the texture — never a mismatched pairing', () => {
    // scattergun's own calibration (anchor {0.875,0.245}, rotationOffsetRad ≈ -156.8°) is
    // tuned for gun_scattergun.png specifically; applying it to the gun_default texture
    // this now renders instead would misplace/misrotate the sprite. All three getters
    // must agree with getWeaponTexture on which entry ("scattergun" vs the kind default)
    // is actually in play.
    const kindAnchor = getWeaponAnchor(undefined, 'ranged');
    const kindScale = getWeaponScale(undefined, 'ranged');
    const kindRotation = getWeaponRotationOffset(undefined, 'ranged');
    expect(getWeaponAnchor('scattergun', 'ranged')).toEqual(kindAnchor);
    expect(getWeaponScale('scattergun', 'ranged')).toBe(kindScale);
    expect(getWeaponRotationOffset('scattergun', 'ranged')).toBe(kindRotation);
  });

  // The measured per-texture `scale` normalizes that PNG's pixel size into rig authoring-px;
  // MODULE_SCALE on top of it is the separate proportion decision (2026-08-17: the mounted
  // module was ~2x the concept's module-to-core ratio and covered the hero's eye). Pinned as
  // a relationship, not a magic number, so retuning the factor doesn't churn this test —
  // but a module rendering at its raw measured size again would fail it.
  it('every module renders below its raw measured size (the core-proportion factor is applied)', () => {
    // Asserted against the table's OWN values rather than a copied literal — the previous
    // version of this test hardcoded `104/1536`, which quietly became a wrong number the
    // moment that stale divisor was fixed. Whether the resulting proportion is sane at all
    // is checked in rigComposition.test.ts, against each texture's real pixel width.
    expect(MODULE_SCALE).toBeLessThan(1);
    expect(getWeaponScale(undefined, 'ranged')).toBeCloseTo(KIND_DEFAULTS.ranged.scale * MODULE_SCALE, 12);
    expect(getWeaponScale(undefined, 'melee')).toBeCloseTo(KIND_DEFAULTS.melee.scale * MODULE_SCALE, 12);
    // Uniform: a per-weapon exception would break the "one coherent unit" rule resolve() has.
    expect(getWeaponScale('repeater', 'ranged')).toBeCloseTo(
      (WEAPON_DEFS.repeater?.scale ?? 0) * MODULE_SCALE, 12,
    );
  });
});
