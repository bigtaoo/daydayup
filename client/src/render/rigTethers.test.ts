/**
 * `rigTethers` — the glowing energy tether every orbiting bone hangs off (design/12/13). Split out
 * of `RigSkin.ts` on 2026-08-19 to make room under the 500-line convention; `RigSkin.test.ts`
 * covers how it is wired into a rig, this file covers the free function's own contract.
 *
 * The one piece of behaviour worth pinning is the SIGNATURE memoization. It is an optimisation with
 * a correctness face: get it wrong in one direction and a hovering idle rebuilds two quadratic
 * curves every frame for nothing; get it wrong in the other and a tether freezes where it was while
 * the module it connects to keeps orbiting.
 */
import { describe, it, expect } from 'vitest';
import { Graphics } from 'pixi.js';
import { drawTethers, hasTetheredBone, TETHER_COLOR } from './rigTethers';
import { Rig } from './Rig';
import { ORB_CORE_RIG } from './orbCoreRig';
import { CRITTER_CORE_RIG } from './critterCoreRig';
import { BOSS_CORE_RIG } from './bossCoreRig';
import type { ResolvedBoneTransform, WorldPositions } from './types';

const NO_TRANSFORMS = new Map<string, ResolvedBoneTransform>();

function poseOf(def = ORB_CORE_RIG, transforms = NO_TRANSFORMS): WorldPositions {
  return new Rig(def).computeFK(0, 0, transforms);
}

interface Instr {
  action: string;
  data: { style?: { color: number; alpha: number; width: number } };
}
const strokes = (g: Graphics): Array<{ color: number; alpha: number; width: number }> =>
  (g.context.instructions as Instr[]).filter((i) => i.action === 'stroke').map((i) => i.data.style!);

/** A transform map with only `alpha` set for one bone, the rest at their neutral values. */
function alphaOnly(boneId: string, alpha: number): Map<string, ResolvedBoneTransform> {
  return new Map([[boneId, { rotation: 0, scaleX: 1, scaleY: 1, translateX: 0, translateY: 0, alpha }]]);
}

describe('hasTetheredBone — which rigs pay for a tether Graphics at all', () => {
  it('is true for the rigs whose bones declare the tube widths, false for the rest', () => {
    // A bone opts in by declaring `outerW`/`innerW`: orb-core's two sockets, boss-core's two
    // rings. A one-bone critter has no orbiting anything and must not allocate a Graphics.
    expect(hasTetheredBone(new Rig(ORB_CORE_RIG).boneDefs)).toBe(true);
    expect(hasTetheredBone(new Rig(BOSS_CORE_RIG).boneDefs)).toBe(true);
    expect(hasTetheredBone(new Rig(CRITTER_CORE_RIG).boneDefs)).toBe(false);
  });

  it('needs BOTH widths — a half-declared bone is not a tether', () => {
    const half = new Rig({
      ...ORB_CORE_RIG,
      bones: ORB_CORE_RIG.bones.map((b) => (b.outerW ? { ...b, innerW: undefined } : b)),
    });
    expect(hasTetheredBone(half.boneDefs)).toBe(false);
  });
});

describe('drawTethers — two passes per orbiting bone', () => {
  it('strokes a wide soft halo and a bright core line per tether, in the tether hue', () => {
    const g = new Graphics();
    drawTethers(g, new Rig(ORB_CORE_RIG).boneDefs, poseOf(), NO_TRANSFORMS, '', 0xffffff);
    const s = strokes(g);
    expect(s).toHaveLength(4); // 2 sockets x (halo + core)
    for (const stroke of s) expect(stroke.color).toBe(TETHER_COLOR);
    // Within each pair the halo is wider and fainter than the core it surrounds.
    expect(s[0]!.width).toBeGreaterThan(s[1]!.width);
    expect(s[0]!.alpha).toBeLessThan(s[1]!.alpha);
  });

  it('applies the caller\'s tint, so a re-tinted body\'s tethers read in its own hue', () => {
    const g = new Graphics();
    drawTethers(g, new Rig(ORB_CORE_RIG).boneDefs, poseOf(), NO_TRANSFORMS, '', 0xff3366);
    expect(g.tint).toBe(0xff3366);
  });

  it('draws nothing for a rig with no tethered bone', () => {
    const g = new Graphics();
    drawTethers(g, new Rig(CRITTER_CORE_RIG).boneDefs, poseOf(CRITTER_CORE_RIG), NO_TRANSFORMS, '', 0xffffff);
    expect(strokes(g)).toHaveLength(0);
  });

  it('skips a bone the clip has faded to nothing', () => {
    const g = new Graphics();
    const t = alphaOnly('socket_r', 0);
    drawTethers(g, new Rig(ORB_CORE_RIG).boneDefs, poseOf(ORB_CORE_RIG, t), t, '', 0xffffff);
    expect(strokes(g)).toHaveLength(2); // socket_l only
  });

  it('scales both passes by the bone\'s clip alpha, so a fading module fades its tether', () => {
    const g = new Graphics();
    const t = alphaOnly('socket_r', 0.5);
    drawTethers(g, new Rig(ORB_CORE_RIG).boneDefs, poseOf(ORB_CORE_RIG, t), t, '', 0xffffff);
    const s = strokes(g);
    const full = s.filter((x) => x.alpha > 0.5);
    const faded = s.filter((x) => x.alpha <= 0.5);
    expect(full).toHaveLength(1); // socket_l's core line at 0.9
    expect(faded.length).toBeGreaterThan(0);
  });
});

describe('drawTethers — the signature memoization', () => {
  it('returns a signature, and the SAME one for an unchanged pose', () => {
    const bones = new Rig(ORB_CORE_RIG).boneDefs;
    const first = drawTethers(new Graphics(), bones, poseOf(), NO_TRANSFORMS, '', 0xffffff);
    const second = drawTethers(new Graphics(), bones, poseOf(), NO_TRANSFORMS, '', 0xffffff);
    expect(first).not.toBe('');
    expect(second).toBe(first);
  });

  it('skips the redraw when handed back its own signature — a still idle costs one compare', () => {
    // Detected by leaving a MARKER on the Graphics: a redraw begins with `clear()`, so if the
    // marker survives, the call really did return early. Counting strokes cannot tell the two
    // apart — a clear-and-rebuild lands on the same count.
    const bones = new Rig(ORB_CORE_RIG).boneDefs;
    const g = new Graphics();
    const sig = drawTethers(g, bones, poseOf(), NO_TRANSFORMS, '', 0xffffff);
    g.moveTo(0, 0).lineTo(1, 1).stroke({ color: 0xabcdef, width: 1, alpha: 1 });
    drawTethers(g, bones, poseOf(), NO_TRANSFORMS, sig, 0xffffff);
    expect(strokes(g).some((x) => x.color === 0xabcdef)).toBe(true);
  });

  it('DOES redraw once the pose moves, which is the half that must not be optimised away', () => {
    const bones = new Rig(ORB_CORE_RIG).boneDefs;
    const moved = new Map<string, ResolvedBoneTransform>([
      ['socket_r', { rotation: 40, scaleX: 1, scaleY: 1, translateX: 0, translateY: 0, alpha: 1 }],
    ]);
    const g = new Graphics();
    const sig = drawTethers(g, bones, poseOf(), NO_TRANSFORMS, '', 0xffffff);
    g.moveTo(0, 0).lineTo(1, 1).stroke({ color: 0xabcdef, width: 1, alpha: 1 });
    const after = drawTethers(g, bones, poseOf(ORB_CORE_RIG, moved), moved, sig, 0xffffff);
    expect(after).not.toBe(sig);
    expect(strokes(g).some((x) => x.color === 0xabcdef)).toBe(false); // really cleared
    expect(strokes(g)).toHaveLength(4); // ...and rebuilt, not doubled
  });

  it('folds the clip ALPHA into the signature too, not just the endpoints', () => {
    // A module fading out while its bones stay put still has to repaint, or the tether hangs on
    // at full brightness attached to nothing.
    const bones = new Rig(ORB_CORE_RIG).boneDefs;
    const sig = drawTethers(new Graphics(), bones, poseOf(), NO_TRANSFORMS, '', 0xffffff);
    const t = alphaOnly('socket_r', 0.3);
    const faded = drawTethers(new Graphics(), bones, poseOf(ORB_CORE_RIG, t), t, sig, 0xffffff);
    expect(faded).not.toBe(sig);
  });

  it('never accumulates across many repaints of a moving rig', () => {
    const bones = new Rig(ORB_CORE_RIG).boneDefs;
    const g = new Graphics();
    let sig = '';
    for (let i = 1; i <= 6; i++) {
      const t = new Map<string, ResolvedBoneTransform>([
        ['socket_r', { rotation: i * 15, scaleX: 1, scaleY: 1, translateX: 0, translateY: 0, alpha: 1 }],
      ]);
      sig = drawTethers(g, bones, poseOf(ORB_CORE_RIG, t), t, sig, 0xffffff);
    }
    expect(strokes(g)).toHaveLength(4);
  });
});
