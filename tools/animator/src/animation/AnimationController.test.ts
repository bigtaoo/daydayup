import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventBus, type AppEvents } from '../core/EventBus';
import { AppState } from '../core/AppState';
import { AnimationController } from './AnimationController';
import type { AnimationClip } from '../core/types';

function build() {
  const bus = new EventBus<AppEvents>();
  const state = new AppState(bus);
  const animCtrl = new AnimationController(bus, state);
  return { bus, state, animCtrl };
}

describe('AnimationController', () => {
  // ── Data accessors ────────────────────────────────────────────────────────

  describe('data accessors', () => {
    it('starts empty: no store entries, no current clip/name', () => {
      const { animCtrl } = build();
      expect(animCtrl.store.size).toBe(0);
      expect(animCtrl.currentClip).toBeNull();
      expect(animCtrl.currentName).toBeNull();
    });

    it('currentClip resolves the selected clip from the store', () => {
      const { animCtrl } = build();
      animCtrl.createClip('walk');
      animCtrl.selectClip('walk');
      expect(animCtrl.currentName).toBe('walk');
      expect(animCtrl.currentClip).toBe(animCtrl.store.get('walk'));
    });
  });

  // ── getCurrentFrame ───────────────────────────────────────────────────────

  describe('getCurrentFrame', () => {
    it('returns an empty map when there is no current clip', () => {
      const { animCtrl } = build();
      expect(animCtrl.getCurrentFrame().size).toBe(0);
    });

    it('samples the current clip at the current time', () => {
      const { animCtrl, state } = build();
      animCtrl.createClip('walk');
      animCtrl.selectClip('walk');
      animCtrl.addKeyframeAt(0, new Map([['shell', { translateY: 0 }]]));
      animCtrl.addKeyframeAt(1, new Map([['shell', { translateY: -10 }]]));
      state.setCurrentTime(0.5);

      expect(animCtrl.getCurrentFrame().get('shell')?.translateY).toBeCloseTo(-5);
    });

    it('overlays a live delta onto an existing bone transform', () => {
      const { animCtrl } = build();
      animCtrl.createClip('walk');
      animCtrl.selectClip('walk');
      animCtrl.addKeyframeAt(0, new Map([['shell', { rotation: 10 }]]));

      animCtrl.setBoneDelta('shell', 5);
      expect(animCtrl.getCurrentFrame().get('shell')?.rotation).toBeCloseTo(15);
    });

    it('overlays a live delta as a fresh identity-default entry for a bone with no base transform', () => {
      const { animCtrl } = build();
      animCtrl.createClip('walk');
      animCtrl.selectClip('walk');

      animCtrl.setBoneDelta('eye', 7);
      const eye = animCtrl.getCurrentFrame().get('eye');
      expect(eye).toEqual({ rotation: 7, scaleX: 1, scaleY: 1, translateX: 0, translateY: 0, alpha: 1 });
    });
  });

  // ── getOnionFrames ────────────────────────────────────────────────────────

  describe('getOnionFrames', () => {
    it('returns an empty array when there is no current clip', () => {
      const { animCtrl } = build();
      expect(animCtrl.getOnionFrames()).toEqual([]);
    });

    it('returns both neighbors when currentTime sits strictly between two keyframes', () => {
      const { animCtrl, state } = build();
      animCtrl.createClip('walk');
      animCtrl.selectClip('walk');
      animCtrl.addKeyframeAt(0, new Map([['shell', { rotation: 0 }]]));
      animCtrl.addKeyframeAt(1, new Map([['shell', { rotation: 10 }]]));
      animCtrl.addKeyframeAt(2, new Map([['shell', { rotation: 20 }]]));
      state.setCurrentTime(1.5);

      const frames = animCtrl.getOnionFrames();
      expect(frames).toHaveLength(2);
      expect(frames[0].get('shell')?.rotation).toBeCloseTo(10);
      expect(frames[1].get('shell')?.rotation).toBeCloseTo(20);
    });

    it('returns only the previous neighbor when currentTime is after the last keyframe', () => {
      const { animCtrl, state } = build();
      animCtrl.createClip('walk');
      animCtrl.selectClip('walk');
      animCtrl.addKeyframeAt(0, new Map([['shell', { rotation: 0 }]]));
      animCtrl.addKeyframeAt(1, new Map([['shell', { rotation: 10 }]]));
      state.setCurrentTime(5);

      expect(animCtrl.getOnionFrames()).toHaveLength(1);
    });
  });

  // ── Keyframe CRUD ─────────────────────────────────────────────────────────

  describe('keyframe CRUD', () => {
    it('addKeyframeAt is a no-op with no current clip', () => {
      const { animCtrl, bus } = build();
      const spy = vi.fn();
      bus.on('kf:change', spy);
      animCtrl.addKeyframeAt(0);
      expect(spy).not.toHaveBeenCalled();
    });

    it('addKeyframeAt with no bones arg snapshots the current (live-delta-influenced) frame', () => {
      const { animCtrl, state } = build();
      animCtrl.createClip('walk');
      animCtrl.selectClip('walk');
      animCtrl.setBoneDelta('shell', 15);

      animCtrl.addKeyframeAt(0);
      const bones = animCtrl.currentClip!.keyframes[0].bones;
      expect(bones.get('shell')?.rotation).toBeCloseTo(15);
      expect(state.selectedKfTime).toBeCloseTo(0);
    });

    it('rounds time to the millisecond and sorts keyframes chronologically', () => {
      const { animCtrl } = build();
      animCtrl.createClip('walk');
      animCtrl.selectClip('walk');

      animCtrl.addKeyframeAt(1, new Map());
      animCtrl.addKeyframeAt(0.12345, new Map());
      animCtrl.addKeyframeAt(0.5, new Map());

      const times = animCtrl.currentClip!.keyframes.map(k => k.time);
      expect(times).toEqual([0.123, 0.5, 1]);
    });

    it('merges bones into an existing keyframe at the same time rather than duplicating it', () => {
      const { animCtrl } = build();
      animCtrl.createClip('walk');
      animCtrl.selectClip('walk');

      animCtrl.addKeyframeAt(0, new Map([['shell', { rotation: 1 }]]));
      animCtrl.addKeyframeAt(0, new Map([['eye', { alpha: 0.5 }]]));

      expect(animCtrl.currentClip!.keyframes).toHaveLength(1);
      const bones = animCtrl.currentClip!.keyframes[0].bones;
      expect(bones.get('shell')?.rotation).toBe(1);
      expect(bones.get('eye')?.alpha).toBe(0.5);
    });

    it('emits kf:change on addKeyframeAt', () => {
      const { animCtrl, bus } = build();
      animCtrl.createClip('walk');
      animCtrl.selectClip('walk');
      const spy = vi.fn();
      bus.on('kf:change', spy);

      animCtrl.addKeyframeAt(0, new Map());
      expect(spy).toHaveBeenCalledTimes(1);
    });

    it('deleteKeyframeAt removes the matching keyframe, clears selection, emits kf:change', () => {
      const { animCtrl, state, bus } = build();
      animCtrl.createClip('walk');
      animCtrl.selectClip('walk');
      animCtrl.addKeyframeAt(0.3, new Map());
      const spy = vi.fn();
      bus.on('kf:change', spy);

      animCtrl.deleteKeyframeAt(0.3);
      expect(animCtrl.currentClip!.keyframes).toHaveLength(0);
      expect(state.selectedKfTime).toBeNull();
      expect(spy).toHaveBeenCalledTimes(1);
    });

    it('deleteKeyframeAt is a no-op when nothing matches or there is no current clip', () => {
      const { animCtrl, bus } = build();
      const spy = vi.fn();
      bus.on('kf:change', spy);

      animCtrl.deleteKeyframeAt(0); // no current clip
      expect(spy).not.toHaveBeenCalled();

      animCtrl.createClip('walk');
      animCtrl.selectClip('walk'); // emits its own kf:change — not what we're testing
      spy.mockClear();
      animCtrl.deleteKeyframeAt(9); // no keyframe at time 9

      expect(spy).not.toHaveBeenCalled();
    });

    it('moveKeyframe re-times and re-sorts, rounds the new time, no-ops when no match', () => {
      const { animCtrl } = build();
      animCtrl.createClip('walk');
      animCtrl.selectClip('walk');
      animCtrl.addKeyframeAt(0, new Map());
      animCtrl.addKeyframeAt(1, new Map());

      animCtrl.moveKeyframe(0, 0.5001);
      expect(animCtrl.currentClip!.keyframes.map(k => k.time)).toEqual([0.5, 1]);

      // No matching source keyframe — no-op, no throw.
      expect(() => animCtrl.moveKeyframe(99, 2)).not.toThrow();
      expect(animCtrl.currentClip!.keyframes).toHaveLength(2);
    });

    it('updateKeyframeProp merges props into an existing bone entry, no-ops when no match', () => {
      const { animCtrl } = build();
      animCtrl.createClip('walk');
      animCtrl.selectClip('walk');
      animCtrl.addKeyframeAt(0, new Map([['shell', { rotation: 1, alpha: 1 }]]));

      animCtrl.updateKeyframeProp(0, 'shell', { rotation: 42 });
      const shell = animCtrl.currentClip!.keyframes[0].bones.get('shell');
      expect(shell).toEqual({ rotation: 42, alpha: 1 });

      // Bone with no prior entry gets created from an empty base.
      animCtrl.updateKeyframeProp(0, 'eye', { alpha: 0.2 });
      expect(animCtrl.currentClip!.keyframes[0].bones.get('eye')).toEqual({ alpha: 0.2 });

      // No matching keyframe time — no-op.
      expect(() => animCtrl.updateKeyframeProp(99, 'shell', { rotation: 0 })).not.toThrow();
    });

    it('copyKeyframe/pasteKeyframe deep-clones so mutating the source does not affect the clipboard', () => {
      const { animCtrl } = build();
      animCtrl.createClip('walk');
      animCtrl.selectClip('walk');
      animCtrl.addKeyframeAt(0, new Map([['shell', { rotation: 10 }]]));

      animCtrl.copyKeyframe(0);
      animCtrl.updateKeyframeProp(0, 'shell', { rotation: 999 }); // mutate source after copy

      animCtrl.pasteKeyframe(1);
      const pasted = animCtrl.currentClip!.keyframes.find(k => Math.abs(k.time - 1) < 0.001)!;
      expect(pasted.bones.get('shell')?.rotation).toBe(10);
    });

    it('copyKeyframe is a no-op when there is no matching keyframe; pasteKeyframe is a no-op with an empty clipboard', () => {
      const { animCtrl } = build();
      animCtrl.createClip('walk');
      animCtrl.selectClip('walk');

      animCtrl.copyKeyframe(0); // nothing to copy
      animCtrl.pasteKeyframe(0);
      expect(animCtrl.currentClip!.keyframes).toHaveLength(0);
    });

    it('getPrevKeyframe/getNextKeyframe find the nearest neighbors, null when absent', () => {
      const { animCtrl, state } = build();
      animCtrl.createClip('walk');
      animCtrl.selectClip('walk');
      expect(animCtrl.getPrevKeyframe()).toBeNull();
      expect(animCtrl.getNextKeyframe()).toBeNull();

      animCtrl.addKeyframeAt(0, new Map());
      animCtrl.addKeyframeAt(1, new Map());
      animCtrl.addKeyframeAt(2, new Map());
      state.setCurrentTime(1.5);

      expect(animCtrl.getPrevKeyframe()?.time).toBeCloseTo(1);
      expect(animCtrl.getNextKeyframe()?.time).toBeCloseTo(2);
    });
  });

  // ── Clip management ───────────────────────────────────────────────────────

  describe('clip management', () => {
    it('createClip adds a default clip and emits anim:list; does not overwrite an existing one', () => {
      const { animCtrl, bus } = build();
      const spy = vi.fn();
      bus.on('anim:list', spy);

      animCtrl.createClip('walk');
      expect(animCtrl.store.get('walk')).toEqual({ duration: 0.5, loop: true, keyframes: [] });
      expect(spy).toHaveBeenCalledTimes(1);

      animCtrl.selectClip('walk');
      animCtrl.setDuration(3);
      animCtrl.createClip('walk'); // should not reset the clip we just modified
      expect(animCtrl.currentClip!.duration).toBe(3);
    });

    it('deleteClip falls back to another store entry when deleting the active clip', () => {
      const { animCtrl, bus } = build();
      animCtrl.createClip('a');
      animCtrl.createClip('b');
      animCtrl.selectClip('a');

      const selectSpy = vi.fn();
      bus.on('anim:select', selectSpy);
      animCtrl.deleteClip('a');

      expect(animCtrl.store.has('a')).toBe(false);
      expect(animCtrl.currentName).toBe('b');
      expect(selectSpy).toHaveBeenCalledWith('b');
    });

    it('deleteClip clears currentName without emitting anim:select when the store becomes empty', () => {
      const { animCtrl, bus } = build();
      animCtrl.createClip('a');
      animCtrl.selectClip('a');

      const selectSpy = vi.fn();
      bus.on('anim:select', selectSpy);
      animCtrl.deleteClip('a');

      expect(animCtrl.currentName).toBeNull();
      expect(selectSpy).not.toHaveBeenCalled();
    });

    it('renameClip preserves the clip and updates currentName; no-ops on missing/duplicate names', () => {
      const { animCtrl } = build();
      animCtrl.createClip('a');
      animCtrl.selectClip('a');
      const clipRef = animCtrl.currentClip;

      animCtrl.renameClip('a', 'b');
      expect(animCtrl.currentName).toBe('b');
      expect(animCtrl.store.get('b')).toBe(clipRef);
      expect(animCtrl.store.has('a')).toBe(false);

      animCtrl.createClip('c');
      expect(() => animCtrl.renameClip('b', 'c')).not.toThrow(); // duplicate target — no-op
      expect(animCtrl.store.has('b')).toBe(true);

      expect(() => animCtrl.renameClip('nope', 'z')).not.toThrow(); // missing source — no-op
    });

    it('selectClip resets currentTime and emits anim:select + kf:change; ignores unknown names', () => {
      const { animCtrl, state, bus } = build();
      animCtrl.createClip('walk');
      state.setCurrentTime(5);

      const selectSpy = vi.fn();
      const kfSpy = vi.fn();
      bus.on('anim:select', selectSpy);
      bus.on('kf:change', kfSpy);

      animCtrl.selectClip('walk');
      expect(state.currentTime).toBe(0);
      expect(selectSpy).toHaveBeenCalledWith('walk');
      expect(kfSpy).toHaveBeenCalledTimes(1);

      animCtrl.selectClip('does-not-exist');
      expect(animCtrl.currentName).toBe('walk'); // unchanged
    });

    it('setDuration clamps to a 0.1s minimum and no-ops without a current clip', () => {
      const { animCtrl } = build();
      expect(() => animCtrl.setDuration(5)).not.toThrow();

      animCtrl.createClip('walk');
      animCtrl.selectClip('walk');
      animCtrl.setDuration(0.01);
      expect(animCtrl.currentClip!.duration).toBe(0.1);
    });

    it('autoFitDuration sets duration to the last keyframe time; errors when there are none', () => {
      const { animCtrl, bus } = build();
      animCtrl.createClip('walk');
      animCtrl.selectClip('walk');

      const errorSpy = vi.fn();
      bus.on('error', errorSpy);
      animCtrl.autoFitDuration();
      expect(errorSpy).toHaveBeenCalledWith('No keyframes to fit duration to');

      animCtrl.addKeyframeAt(0, new Map());
      animCtrl.addKeyframeAt(1.2, new Map());
      const statusSpy = vi.fn();
      bus.on('status', statusSpy);
      animCtrl.autoFitDuration();
      expect(animCtrl.currentClip!.duration).toBeCloseTo(1.2);
      expect(statusSpy).toHaveBeenCalledTimes(1);
    });

    it('loadPreset clones a known preset into the store; unknown names are a no-op', () => {
      const { animCtrl, bus } = build();
      const spy = vi.fn();
      bus.on('anim:list', spy);

      animCtrl.loadPreset('idle');
      expect(animCtrl.store.has('idle')).toBe(true);
      expect(animCtrl.store.get('idle')!.keyframes.length).toBeGreaterThan(0);
      expect(spy).toHaveBeenCalledTimes(1);

      animCtrl.loadPreset('not-a-real-preset');
      expect(spy).toHaveBeenCalledTimes(1); // no additional emit
    });

    it('loadClip stores a fully-deserialized clip and emits anim:list', () => {
      const { animCtrl, bus } = build();
      const clip: AnimationClip = { duration: 1, loop: false, keyframes: [] };
      const spy = vi.fn();
      bus.on('anim:list', spy);

      animCtrl.loadClip('imported', clip);
      expect(animCtrl.store.get('imported')).toBe(clip);
      expect(spy).toHaveBeenCalledTimes(1);
    });

    it('clearAll empties the store, clears currentName, emits anim:list', () => {
      const { animCtrl, bus } = build();
      animCtrl.createClip('a');
      animCtrl.selectClip('a');
      const spy = vi.fn();
      bus.on('anim:list', spy);

      animCtrl.clearAll();
      expect(animCtrl.store.size).toBe(0);
      expect(animCtrl.currentName).toBeNull();
      expect(spy).toHaveBeenCalledTimes(1);
    });
  });

  // ── Live drag delta ───────────────────────────────────────────────────────

  describe('live drag delta', () => {
    it('setBoneDelta/clearLiveDelta control the overlay applied by getCurrentFrame', () => {
      const { animCtrl } = build();
      animCtrl.setBoneDelta('shell', 12);
      expect(animCtrl.getCurrentFrame().get('shell')?.rotation).toBeCloseTo(12);

      animCtrl.clearLiveDelta();
      expect(animCtrl.getCurrentFrame().get('shell')).toBeUndefined();
    });

    it('resetPose clears the live delta and emits pose:reset', () => {
      const { animCtrl, bus } = build();
      animCtrl.setBoneDelta('shell', 12);
      const spy = vi.fn();
      bus.on('pose:reset', spy);

      animCtrl.resetPose();
      expect(animCtrl.getCurrentFrame().get('shell')).toBeUndefined();
      expect(spy).toHaveBeenCalledTimes(1);
    });
  });

  // ── Playback (play/pause/tick — RAF stubbed) ──────────────────────────────

  describe('playback', () => {
    let raf: ReturnType<typeof vi.fn>;
    let caf: ReturnType<typeof vi.fn>;
    let nextId: number;

    beforeEach(() => {
      nextId = 1;
      raf = vi.fn((_cb: (ts: number) => void) => nextId++);
      caf = vi.fn();
      vi.stubGlobal('requestAnimationFrame', raf);
      vi.stubGlobal('cancelAnimationFrame', caf);
    });

    afterEach(() => {
      vi.unstubAllGlobals();
    });

    it('play() without a selected clip emits an error and never touches RAF', () => {
      const { animCtrl, bus, state } = build();
      const errorSpy = vi.fn();
      bus.on('error', errorSpy);

      animCtrl.play();
      expect(errorSpy).toHaveBeenCalledWith('Select an animation first');
      expect(state.isPlaying).toBe(false);
      expect(raf).not.toHaveBeenCalled();
    });

    it('play() with a clip selected starts playback and schedules a frame', () => {
      const { animCtrl, state } = build();
      animCtrl.createClip('walk');
      animCtrl.selectClip('walk');

      animCtrl.play();
      expect(state.isPlaying).toBe(true);
      expect(raf).toHaveBeenCalledTimes(1);
    });

    it('pause() stops playback and cancels the pending frame', () => {
      const { animCtrl, state } = build();
      animCtrl.createClip('walk');
      animCtrl.selectClip('walk');
      animCtrl.play();

      animCtrl.pause();
      expect(state.isPlaying).toBe(false);
      expect(caf).toHaveBeenCalledTimes(1);
    });

    it('stop() pauses and rewinds currentTime to 0', () => {
      const { animCtrl, state } = build();
      animCtrl.createClip('walk');
      animCtrl.selectClip('walk');
      state.setCurrentTime(0.3);
      animCtrl.play();

      animCtrl.stop();
      expect(state.isPlaying).toBe(false);
      expect(state.currentTime).toBe(0);
    });

    it('toggle() plays when paused and pauses when playing', () => {
      const { animCtrl, state } = build();
      animCtrl.createClip('walk');
      animCtrl.selectClip('walk');

      animCtrl.toggle();
      expect(state.isPlaying).toBe(true);

      animCtrl.toggle();
      expect(state.isPlaying).toBe(false);
    });

    it('tick() advances currentTime by elapsed-time * playSpeed and reschedules', () => {
      const { animCtrl, state } = build();
      animCtrl.createClip('walk'); // default duration 0.5
      animCtrl.selectClip('walk');
      animCtrl.play();

      const firstTick = raf.mock.calls[0][0] as (ts: number) => void;
      firstTick(1000); // first tick only records lastTs, no time advance yet
      expect(state.currentTime).toBe(0);
      expect(raf).toHaveBeenCalledTimes(2);

      const secondTick = raf.mock.calls[1][0] as (ts: number) => void;
      secondTick(1200); // +200ms
      expect(state.currentTime).toBeCloseTo(0.2);
      expect(raf).toHaveBeenCalledTimes(3);
    });

    it('tick() respects playSpeed when advancing time', () => {
      const { animCtrl, state } = build();
      animCtrl.createClip('walk');
      animCtrl.selectClip('walk');
      state.setPlaySpeed(2);
      animCtrl.play();

      const tick1 = raf.mock.calls[0][0] as (ts: number) => void;
      tick1(0);
      const tick2 = raf.mock.calls[1][0] as (ts: number) => void;
      tick2(100); // +100ms * speed 2 = 0.2s
      expect(state.currentTime).toBeCloseTo(0.2);
    });

    it('tick() wraps time around the clip duration when looping', () => {
      const { animCtrl, state } = build();
      animCtrl.createClip('walk');
      animCtrl.selectClip('walk');
      animCtrl.setDuration(0.5);
      animCtrl.play();

      const tick1 = raf.mock.calls[0][0] as (ts: number) => void;
      tick1(0);
      const tick2 = raf.mock.calls[1][0] as (ts: number) => void;
      tick2(600); // +0.6s >= 0.5s duration, loop=true by default
      expect(state.currentTime).toBeCloseTo(0.1);
      expect(state.isPlaying).toBe(true); // still playing — it looped, not stopped
    });

    it('tick() clamps to duration and pauses when not looping', () => {
      const { animCtrl, state } = build();
      animCtrl.createClip('walk');
      animCtrl.selectClip('walk');
      animCtrl.setDuration(0.5);
      state.setLooping(false);
      animCtrl.play();

      const tick1 = raf.mock.calls[0][0] as (ts: number) => void;
      tick1(0);
      const framesBeforeOverrun = raf.mock.calls.length;
      const tick2 = raf.mock.calls[1][0] as (ts: number) => void;
      tick2(600);

      expect(state.currentTime).toBeCloseTo(0.5);
      expect(state.isPlaying).toBe(false);
      expect(caf).toHaveBeenCalledTimes(1);
      // pause() short-circuits tick() before it schedules another frame.
      expect(raf).toHaveBeenCalledTimes(framesBeforeOverrun);
    });

    it('tick() is a no-op once playback has been paused out-of-band', () => {
      const { animCtrl, state } = build();
      animCtrl.createClip('walk');
      animCtrl.selectClip('walk');
      animCtrl.play();

      const tick1 = raf.mock.calls[0][0] as (ts: number) => void;
      const scheduledBefore = raf.mock.calls.length;
      animCtrl.pause();
      tick1(1000); // stale callback firing after an explicit pause()

      expect(state.currentTime).toBe(0);
      expect(raf).toHaveBeenCalledTimes(scheduledBefore); // no extra frame scheduled
    });
  });
});
