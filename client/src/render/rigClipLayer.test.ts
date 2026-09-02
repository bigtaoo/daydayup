/**
 * The additive attack overlay (`rigClipLayer.ts`) — the blend that made playing the authored
 * `attack` clips possible at all.
 *
 * ## What was actually broken, and what a passing test here has to prove
 *
 * `RigSkin.playClip` swapped the whole clip. `sampleClip` returns only the bones a clip names.
 * So playing `attack` dropped every bone it does not name to rest for the clip's whole
 * duration — the hero's `attack` never mentions `socket_l`, which `idle` bobs, so a shot froze
 * that socket at 0 and popped it back 350 ms later. That is the reason the 2026-08-30 pass
 * shipped a procedural envelope instead of the clips, and the reason this file exists.
 *
 * Every case below therefore asserts one of two things, and nothing else is interesting:
 *
 *   1. a bone the overlay does NOT name comes through the base clip untouched, and
 *   2. a bone it DOES name keeps its base value and gains the overlay on top, at each channel's
 *      own identity (add for translate/rotation, multiply for scale/alpha).
 *
 * Clips are built by hand rather than read off disk: the shipped bundles are checked against
 * this contract by `rigComposition.test.ts` (which is where a DATA claim belongs), and a
 * hand-built clip can state a case the shipped art happens not to contain — an overlay that
 * only scales, a base that only rotates, a bone in one and not the other.
 *
 * ## Mutation battery
 *
 * Recorded 2026-09-02, across the whole attack path (`rigClipLayer` / `rigAttackMotion` /
 * `RigSkin` / `Skin` / `Actor` / `EventReactor`), run against the full client suite. Every row
 * is a real source edit, `npx vitest run`, revert.
 *
 *   KILLED   layerAdditive: scale OVERRIDES instead of multiplying ............... 2 failing tests
 *   KILLED   layerAdditive: translate OVERRIDES instead of adding ................ 6
 *   KILLED   layerAdditive: an overlay bone with no base entry is dropped ........ 2
 *   KILLED   layerAdditive: folds into the OVERLAY instead of the base ........... 11
 *   KILLED   ClipLayers: the overlay never retires ............................... 1
 *   KILLED   ClipLayers: attack() does not restart a live overlay ................ 1
 *   KILLED   ClipLayers: sample() ignores the overlay entirely .................. 7
 *   KILLED   ClipLayers: a zero-duration attack clip latches forever ............. 1
 *   KILLED   ClipLayers: a non-looping base clip wraps like a loop ............... 1
 *   KILLED   RigSkin: the weapon angle drops the swing .......................... 3
 *   KILLED   RigSkin: the EYE follows the blade instead of the aim .............. 1
 *   KILLED   AttackMotion: the melee lunge takes the recoil sign ................. 2
 *   KILLED   AttackMotion: the swing skips its wind-up .......................... 1
 *   KILLED   AttackMotion: a swing also slides the module along the barrel ....... 5
 *   KILLED   AttackMotion: kind is ignored — everything is a recoil ............. 12
 *   KILLED   EventReactor: a swing is routed as a shot .......................... 1
 *   KILLED   EventReactor: a swing plays the gunshot cue ........................ 1
 *   KILLED   Actor: the attack kind is dropped on the way to the skin ........... 1
 *   KILLED   Skin: the attack clock never advances ............................... 2
 *   SURVIVED AttackMotion: `advance` loses its `Math.max(0, …)` clamp  [equivalent]
 *
 * The lone survivor is a true equivalent and is documented at the test that comes closest to it
 * (`rigAttackMotion.test.ts`, "an advance past the end…"): `progress` gates on `ms <= 0`, which a
 * negative `ms` satisfies exactly as zero does, and nothing accumulates across a `kick()`.
 *
 * **The battery's own first run is worth more than any row in it.** It crashed inside the test
 * runner *after applying mutant #1 and before reverting it*, so a live `scaleX` override sat in
 * the source for every subsequent row — and every subsequent row still reported KILLED, against a
 * tree that was already failing. A battery has to baseline first and revert in a `finally`, or its
 * output is a list of numbers that cannot distinguish a good test from a broken tree.
 */
import { describe, it, expect } from 'vitest';
import { ATTACK_CLIP, ClipLayers, layerAdditive } from './rigClipLayer';
import type { AnimationClip, BoneKeyframe, ResolvedBoneTransform } from './types';

const REST: ResolvedBoneTransform = {
  rotation: 0, scaleX: 1, scaleY: 1, translateX: 0, translateY: 0, alpha: 1,
};

const t = (over: Partial<ResolvedBoneTransform>): ResolvedBoneTransform => ({ ...REST, ...over });

/** A clip from `[time, { bone: keyframe }]` pairs — the same shape `taoBundle` deserializes to. */
function clip(duration: number, loop: boolean, frames: Array<[number, Record<string, BoneKeyframe>]>): AnimationClip {
  return {
    duration,
    loop,
    keyframes: frames.map(([time, bones]) => ({ time, bones: new Map(Object.entries(bones)) })),
  };
}

/** A two-bone stand-in for the shipped shape: `body` bobs on the base clip, `arm` is what the
 *  overlay moves. `body` is deliberately NOT in the overlay — that is case (1) above. */
const IDLE = clip(2, true, [
  [0, { body: { translateY: 0 }, arm: { translateY: 0 } }],
  [1, { body: { translateY: -6 }, arm: { translateY: -4 } }],
  [2, { body: { translateY: 0 }, arm: { translateY: 0 } }],
]);
const ATTACK = clip(0.4, false, [
  [0, { arm: { translateX: 0, scaleX: 1 } }],
  [0.2, { arm: { translateX: -10, scaleX: 0.5 } }],
  [0.4, { arm: { translateX: 0, scaleX: 1 } }],
]);

const bundleClips = (): Map<string, AnimationClip> =>
  new Map<string, AnimationClip>([['idle', IDLE], ['move', IDLE], [ATTACK_CLIP, ATTACK]]);

describe('layerAdditive — the per-channel combine rule', () => {
  it('adds translate and rotation, and multiplies scale and alpha', () => {
    const base = new Map([['a', t({ translateX: 3, translateY: -4, rotation: 10, scaleX: 2, scaleY: 0.5, alpha: 0.8 })]]);
    const out = layerAdditive(base, new Map([['a', t({ translateX: 5, translateY: 1, rotation: -4, scaleX: 3, scaleY: 2, alpha: 0.5 })]]));
    expect(out.get('a')).toEqual({
      translateX: 8, translateY: -3, rotation: 6, scaleX: 6, scaleY: 1, alpha: 0.4,
    });
  });

  it('leaves a bone the overlay never names exactly as the base had it', () => {
    // Case (1): the whole bug. `untouched` must come out bit-identical, not reset to rest.
    const pose = t({ translateY: -6, rotation: 12 });
    const out = layerAdditive(new Map([['untouched', pose], ['moved', t({})]]), new Map([['moved', t({ translateX: 9 })]]));
    expect(out.get('untouched')).toEqual(pose);
  });

  it('an overlay bone with no base entry lands on identity, not on undefined', () => {
    // The one-bone enemy rigs hit this: `attack` names `body`, and if the base clip is a name
    // the bundle does not have, the base sample is EMPTY. The overlay still has to apply.
    const out = layerAdditive(new Map(), new Map([['body', t({ translateX: 9, scaleY: 0.5 })]]));
    expect(out.get('body')).toEqual(t({ translateX: 9, scaleY: 0.5 }));
  });

  it('an identity overlay is a no-op on every channel', () => {
    // Why an attack clip is authored to start and end at identity: those two frames must
    // contribute NOTHING, or the layer steps the pose on trigger and again on expiry.
    const pose = t({ translateX: 2, translateY: 3, rotation: 30, scaleX: 1.5, scaleY: 0.5, alpha: 0.25 });
    expect(layerAdditive(new Map([['a', pose]]), new Map([['a', REST]])).get('a')).toEqual(pose);
  });

  it('returns the base map itself — the per-frame allocation the header claims to avoid', () => {
    const base = new Map([['a', t({})]]);
    expect(layerAdditive(base, new Map([['a', t({ translateX: 1 })]]))).toBe(base);
  });
});

describe('ClipLayers — the base clip', () => {
  it('wraps a looping clip by its own duration, so the phase survives a long-running clock', () => {
    const l = new ClipLayers(bundleClips());
    l.playBase('idle', 1000); // 1 s into a 2 s loop = the trough
    const atOneSecond = l.sample().get('body')!.translateY;
    l.playBase('idle', 1000 + 2000 * 7); // seven loops later
    expect(l.sample().get('body')!.translateY).toBeCloseTo(atOneSecond, 12);
    expect(atOneSecond).toBeCloseTo(-6, 12);
  });

  it('an unknown clip name selects nothing rather than holding the previous one', () => {
    // What a bundle missing a clip does. Before 2026-09-02 every enemy bundle lacked `move`, so
    // a walking enemy took this path and lost its idle bob entirely; the shipped bundles now all
    // carry the full vocabulary, but the render layer must not assume that.
    const l = new ClipLayers(bundleClips());
    l.playBase('idle', 1000);
    expect(l.sample().size).toBeGreaterThan(0);
    l.playBase('nope', 1000);
    expect(l.sample().size).toBe(0);
  });
});

describe('ClipLayers — the attack overlay', () => {
  it('is inert until something attacks', () => {
    const l = new ClipLayers(bundleClips());
    l.playBase('idle', 1000);
    l.advance(16);
    expect(l.attacking).toBe(false);
    expect(l.sample().get('arm')).toEqual(t({ translateY: -4 }));
  });

  it('adds to the attacking bone while leaving every other bone on the base clip', () => {
    const l = new ClipLayers(bundleClips());
    l.playBase('idle', 1000); // body -6, arm -4
    l.attack();
    l.advance(200); // 0.2 s = the overlay's own peak: arm translateX -10, scaleX 0.5
    const pose = l.sample();
    expect(pose.get('body')).toEqual(t({ translateY: -6 })); // untouched by the attack
    // ...and the arm keeps its idle bob AND takes the kick, which is the entire point.
    expect(pose.get('arm')).toEqual(t({ translateY: -4, translateX: -10, scaleX: 0.5 }));
  });

  it('contributes nothing on the frame it is triggered', () => {
    const l = new ClipLayers(bundleClips());
    l.playBase('idle', 1000);
    const before = l.sample();
    l.attack();
    expect(l.sample()).toEqual(before); // t=0 of an identity-anchored clip
  });

  it('retires itself once the clip has played out, leaving no residue', () => {
    const l = new ClipLayers(bundleClips());
    l.playBase('idle', 1000);
    const rest = l.sample();
    l.attack();
    l.advance(200);
    expect(l.sample()).not.toEqual(rest);
    l.advance(200); // exactly the clip duration
    expect(l.attacking).toBe(false);
    expect(l.sample()).toEqual(rest);
    l.advance(5000); // and it stays retired
    expect(l.sample()).toEqual(rest);
  });

  it('restarts from its first frame when a second attack lands mid-clip', () => {
    // The normal case for a fast weapon, and the one the old whole-clip swap could not survive:
    // the starter blaster's 200 ms cooldown is shorter than a 350 ms attack clip.
    const l = new ClipLayers(bundleClips());
    l.playBase('idle', 1000);
    l.attack();
    l.advance(200);
    const peak = l.sample().get('arm')!.translateX;
    expect(peak).toBeCloseTo(-10, 12);
    l.attack();
    expect(l.sample().get('arm')!.translateX).toBeCloseTo(0, 12); // back to the clip's t=0
    l.advance(200);
    expect(l.sample().get('arm')!.translateX).toBeCloseTo(peak, 12);
  });

  it('keeps running while the base clip is swapped underneath it', () => {
    // idle <-> move happens whenever the player starts or stops moving, which is constantly,
    // and it must not cancel an attack in flight.
    const l = new ClipLayers(bundleClips());
    l.playBase('idle', 1000);
    l.attack();
    l.advance(200);
    l.playBase('move', 1000);
    expect(l.attacking).toBe(true);
    expect(l.sample().get('arm')!.translateX).toBeCloseTo(-10, 12);
  });

  it('the overlay clock is its own — advancing it does not move the base clip', () => {
    const l = new ClipLayers(bundleClips());
    l.playBase('idle', 1000);
    const body = l.sample().get('body')!.translateY;
    l.attack();
    l.advance(150);
    expect(l.sample().get('body')!.translateY).toBe(body); // base time comes from playBase alone
  });

  it('a bundle with no attack clip reports it, and attacking is a silent no-op', () => {
    // A bundle is DATA. Every shipped one carries an `attack` since 2026-09-02, but the render
    // layer must not crash on one that does not — it just contributes no clip layer, and
    // `rigAttackMotion`'s aim-relative half carries the whole read.
    const l = new ClipLayers(new Map([['idle', IDLE]]));
    expect(l.hasAttackClip).toBe(false);
    l.playBase('idle', 1000);
    const rest = l.sample();
    l.attack();
    l.advance(16);
    expect(l.attacking).toBe(false);
    expect(l.sample()).toEqual(rest);
  });

  it('an attack with no base clip at all still animates', () => {
    const l = new ClipLayers(bundleClips());
    l.playBase('nope', 0);
    l.attack();
    l.advance(200);
    expect(l.sample().get('arm')).toEqual(t({ translateX: -10, scaleX: 0.5 }));
  });

  it('tolerates a zero-length frame — the rest-pose layout pass calls it with dt 0', () => {
    // `Skin.setFacing(…, frameDt = 0)` runs once at construction to measure the silhouette. If
    // that call retired or advanced an overlay, the very first frame of an attack would be lost.
    const l = new ClipLayers(bundleClips());
    l.playBase('idle', 1000);
    l.attack();
    l.advance(0);
    expect(l.attacking).toBe(true);
    l.advance(0);
    expect(l.attacking).toBe(true);
  });

  it('retires a zero-duration attack clip instead of holding it forever', () => {
    // Defensive, and cheap: `advance` compares against the clip's own duration, so a clip
    // authored (or exported) with duration 0 would satisfy `>= 0` on the first advance. It must
    // clear, not latch — a stuck overlay is a permanently deformed character.
    const zero = { duration: 0, loop: false, keyframes: [{ time: 0, bones: new Map([['arm', { translateX: 5 }]]) }] };
    const l = new ClipLayers(new Map([['idle', IDLE], [ATTACK_CLIP, zero]]));
    l.playBase('idle', 0);
    l.attack();
    l.advance(16);
    expect(l.attacking).toBe(false);
  });

  it('never writes into the overlay map it is handed', () => {
    // `layerAdditive` folds INTO the base on purpose (the per-frame allocation its header talks
    // about). The overlay is `sampleClip`'s own result and must come back untouched, or a shared
    // sample could be corrupted by whoever layered it.
    const overlay = new Map([['a', t({ translateX: 5, scaleX: 2 })]]);
    const snapshot = JSON.stringify([...overlay]);
    layerAdditive(new Map([['a', t({ translateX: 1, scaleX: 3 })]]), overlay);
    expect(JSON.stringify([...overlay])).toBe(snapshot);
  });

  it('the identity it falls back to is not shared mutable state', () => {
    // An overlay bone with no base entry is combined against a module-level IDENTITY. If that
    // object were ever written through, the SECOND such bone in the whole process would inherit
    // the first one's transform — a bug that only shows up on the third rig on screen.
    const first = layerAdditive(new Map(), new Map([['a', t({ translateX: 7, scaleX: 4 })]])).get('a')!;
    const second = layerAdditive(new Map(), new Map([['b', t({})]])).get('b')!;
    expect(second).toEqual(t({}));
    expect(first).toEqual(t({ translateX: 7, scaleX: 4 }));
  });

  it('a non-looping base clip holds its last pose rather than wrapping', () => {
    // `playBase` only takes a modulo for a LOOPING clip. `hurt`/`death`/`spawn` are one-shots
    // and are not driven yet, but the moment they are, a wrap would restart a death mid-fall.
    const once = { duration: 0.5, loop: false, keyframes: [
      { time: 0, bones: new Map([['body', { translateY: 0 }]]) },
      { time: 0.5, bones: new Map([['body', { translateY: -30 }]]) },
    ] };
    const l = new ClipLayers(new Map([['death', once]]));
    l.playBase('death', 2000); // four durations in
    expect(l.sample().get('body')!.translateY).toBe(-30);
  });
});
