/**
 * `PLAYER_BASE`'s three radii and the relationships between them — the content half of
 * ENGINE_VERSION 43's `footprintRadius`/`solidRadius` split (live report: *"角色走到墙角的
 * 时候，太靠墙了，感觉陷进去了"*).
 *
 * These are deliberately RELATIONSHIP assertions, not a restatement of three literals.
 * The bug they guard is not "someone typed the wrong number", it is "the rendered body
 * grew wider than the clearance the sim stops it at, and nothing noticed" — which is
 * exactly how the original report happened: the 7 px feet circle was authored before the
 * real 32 px-wide rig art existed, and stayed correct-looking in the source the whole
 * time. `client/src/render/rigComposition.test.ts` closes the loop from the other side,
 * against the actual shipped rig bundles.
 */
import { describe, it, expect } from 'vitest';
import { PLAYER_BASE } from '@dd/engine/content/players';
import { pxToFp } from '@dd/engine/content/convert';

describe('PLAYER_BASE radii (ENGINE_VERSION 43)', () => {
  it('the solid clearance IS the body radius — a hugged wall lands tangent to the silhouette', () => {
    // The rendered body is exactly `radius` x 2 wide (design/12's rig normalization), so
    // any clearance below `radius` puts part of the silhouette inside the wall's own art.
    expect(PLAYER_BASE.solidRadius).toBe(PLAYER_BASE.radius);
    expect(PLAYER_BASE.solidRadius).toBeGreaterThanOrEqual(PLAYER_BASE.radius);
  });

  it('the feet circle stayed where it was — actor↔actor crowding is unchanged from v42', () => {
    // The whole point of the split: fixing the wall read must not silently re-tune how
    // tightly a crowd of bodies packs, which is what raising `footprintRadius` would do.
    expect(PLAYER_BASE.footprintRadius).toBe(pxToFp(7));
    expect(PLAYER_BASE.footprintRadius).toBeLessThan(PLAYER_BASE.radius); // still the depth cue
  });

  it('the two are genuinely different values — the split is not a no-op rename', () => {
    expect(PLAYER_BASE.solidRadius).toBeGreaterThan(PLAYER_BASE.footprintRadius);
  });

  it('the clearance still fits through level 1\'s narrowest authored gap (a 2-grid door)', () => {
    // Every `world/dungeons/ember/` door passage is 2 grid = 64 px wide. A player is
    // 2 x solidRadius wide against wall geometry, so this is the real navigational
    // ceiling on the clearance — raising it past a grid cell would wedge the level shut.
    const doorWidth = pxToFp(64);
    expect((PLAYER_BASE.solidRadius * 2) as number).toBeLessThan(doorWidth as number);
  });
});
