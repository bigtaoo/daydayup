import { describe, it, expect, vi } from 'vitest';
import { EventBus, type AppEvents } from './EventBus';
import { AppState } from './AppState';
import type { SpriteBinding, AttachmentPoint } from './types';

function build() {
  const bus = new EventBus<AppEvents>();
  const state = new AppState(bus);
  return { bus, state };
}

const BINDING: SpriteBinding = {
  anchorX: 0.5, anchorY: 0.5, flipX: false, zOrder: 0, rotation: 0, scaleX: 1, scaleY: 1,
};

describe('AppState — UI state', () => {
  it('defaults', () => {
    const { state } = build();
    expect(state.selectedBone).toBeNull();
    expect(state.currentTime).toBe(0);
    expect(state.isPlaying).toBe(false);
    expect(state.playSpeed).toBe(1);
    expect(state.looping).toBe(true);
    expect(state.panOffsetX).toBe(0);
    expect(state.panOffsetY).toBe(0);
    expect(state.selectedKfTime).toBeNull();
    expect(state.rootX).toBe(0);
    expect(state.rootY).toBe(0);
  });

  it('setSelectedBone updates the getter and emits bone:select', () => {
    const { bus, state } = build();
    const spy = vi.fn();
    bus.on('bone:select', spy);

    state.setSelectedBone('shell');

    expect(state.selectedBone).toBe('shell');
    expect(spy).toHaveBeenCalledWith('shell');

    state.setSelectedBone(null);
    expect(state.selectedBone).toBeNull();
    expect(spy).toHaveBeenCalledWith(null);
  });

  it('setCurrentTime updates the getter and emits time:change', () => {
    const { bus, state } = build();
    const spy = vi.fn();
    bus.on('time:change', spy);

    state.setCurrentTime(1.25);

    expect(state.currentTime).toBe(1.25);
    expect(spy).toHaveBeenCalledWith(1.25);
  });

  it('setPlaying updates the getter and emits play:state', () => {
    const { bus, state } = build();
    const spy = vi.fn();
    bus.on('play:state', spy);

    state.setPlaying(true);

    expect(state.isPlaying).toBe(true);
    expect(spy).toHaveBeenCalledWith(true);
  });

  it('setPlaySpeed / setLooping update their getters without emitting anything', () => {
    const { bus, state } = build();
    const anyEvent = vi.fn();
    bus.on('status', anyEvent);
    bus.on('rig:change', anyEvent);

    state.setPlaySpeed(2);
    state.setLooping(false);

    expect(state.playSpeed).toBe(2);
    expect(state.looping).toBe(false);
    expect(anyEvent).not.toHaveBeenCalled();
  });

  it('setPanOffset updates both getters, silently', () => {
    const { state } = build();
    state.setPanOffset(10, -5);
    expect(state.panOffsetX).toBe(10);
    expect(state.panOffsetY).toBe(-5);
  });

  it('setRootPos updates both getters, silently', () => {
    const { state } = build();
    state.setRootPos(3, 4);
    expect(state.rootX).toBe(3);
    expect(state.rootY).toBe(4);
  });

  it('setSelectedKfTime updates the getter, silently, and accepts null', () => {
    const { state } = build();
    state.setSelectedKfTime(0.5);
    expect(state.selectedKfTime).toBe(0.5);
    state.setSelectedKfTime(null);
    expect(state.selectedKfTime).toBeNull();
  });
});

describe('AppState — editor mode', () => {
  it('defaults to animate', () => {
    const { state } = build();
    expect(state.editorMode).toBe('animate');
  });

  it('setEditorMode updates the getter and emits editor:mode', () => {
    const { bus, state } = build();
    const spy = vi.fn();
    bus.on('editor:mode', spy);

    state.setEditorMode('skin');

    expect(state.editorMode).toBe('skin');
    expect(spy).toHaveBeenCalledWith('skin');
  });
});

describe('AppState — preview / view options', () => {
  it('defaults', () => {
    const { state } = build();
    expect(state.previewMode).toBe('skeleton');
    expect(state.showSkeletonOverlay).toBe(false);
    expect(state.showJoints).toBe(true);
    expect(state.showOnion).toBe(false);
    expect(state.showGuide).toBe(false);
    expect(state.showPivots).toBe(false);
    expect(state.backgroundColor).toBe(0xF5F0E8);
  });

  it('setPreviewMode updates the getter and emits preview:mode', () => {
    const { bus, state } = build();
    const spy = vi.fn();
    bus.on('preview:mode', spy);

    state.setPreviewMode('sprite');

    expect(state.previewMode).toBe('sprite');
    expect(spy).toHaveBeenCalledWith('sprite');
  });

  it('setShow*/setBackgroundColor update their getters, silently', () => {
    const { bus, state } = build();
    const spy = vi.fn();
    bus.on('rig:change', spy);
    bus.on('attachment:change', spy);

    state.setShowSkeletonOverlay(true);
    state.setShowJoints(false);
    state.setShowOnion(true);
    state.setShowGuide(true);
    state.setShowPivots(true);
    state.setBackgroundColor(0x000000);

    expect(state.showSkeletonOverlay).toBe(true);
    expect(state.showJoints).toBe(false);
    expect(state.showOnion).toBe(true);
    expect(state.showGuide).toBe(true);
    expect(state.showPivots).toBe(true);
    expect(state.backgroundColor).toBe(0x000000);
    expect(spy).not.toHaveBeenCalled();
  });
});

describe('AppState — bone length scales', () => {
  it('getLengthScale defaults to 1 for an unset bone', () => {
    const { state } = build();
    expect(state.getLengthScale('shell')).toBe(1);
  });

  it('setLengthScale stores a non-1 scale and emits rig:change', () => {
    const { bus, state } = build();
    const spy = vi.fn();
    bus.on('rig:change', spy);

    state.setLengthScale('shell', 1.5);

    expect(state.getLengthScale('shell')).toBe(1.5);
    expect(state.boneLengthScales.get('shell')).toBe(1.5);
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('setLengthScale with a value indistinguishable from 1 removes any override (keeps the map sparse)', () => {
    const { state } = build();
    state.setLengthScale('shell', 1.5);
    state.setLengthScale('shell', 1);

    expect(state.getLengthScale('shell')).toBe(1);
    expect(state.boneLengthScales.has('shell')).toBe(false);
  });

  it('setLengthScale ignores non-positive scales (no mutation, no emit)', () => {
    const { bus, state } = build();
    const spy = vi.fn();
    bus.on('rig:change', spy);

    state.setLengthScale('shell', 0);
    state.setLengthScale('shell', -2);

    expect(state.getLengthScale('shell')).toBe(1);
    expect(spy).not.toHaveBeenCalled();
  });

  it('setAllLengthScales replaces the map, dropping entries close to 1, and emits rig:change once', () => {
    const { bus, state } = build();
    state.setLengthScale('eye', 2); // pre-existing override, should be wiped by the bulk set
    const spy = vi.fn();
    bus.on('rig:change', spy);

    state.setAllLengthScales({ shell: 1.2, belly: 1, socket_l: 0.8 });

    expect(state.getLengthScale('shell')).toBe(1.2);
    expect(state.getLengthScale('belly')).toBe(1); // filtered out, stored as default
    expect(state.boneLengthScales.has('belly')).toBe(false);
    expect(state.getLengthScale('socket_l')).toBe(0.8);
    expect(state.getLengthScale('eye')).toBe(1); // wiped by the bulk replace
    expect(spy).toHaveBeenCalledTimes(1);
  });
});

describe('AppState — sprite bindings', () => {
  it('getBinding returns undefined when nothing is bound', () => {
    const { state } = build();
    expect(state.getBinding('shell')).toBeUndefined();
  });

  it('setBinding stores the binding, emits binding:change with the boneId', () => {
    const { bus, state } = build();
    const spy = vi.fn();
    bus.on('binding:change', spy);

    state.setBinding('shell', BINDING);

    expect(state.getBinding('shell')).toBe(BINDING);
    expect(state.boneBindings.get('shell')).toBe(BINDING);
    expect(spy).toHaveBeenCalledWith('shell');
  });

  it('removeBinding deletes it and emits binding:change with the boneId', () => {
    const { bus, state } = build();
    state.setBinding('shell', BINDING);
    const spy = vi.fn();
    bus.on('binding:change', spy);

    state.removeBinding('shell');

    expect(state.getBinding('shell')).toBeUndefined();
    expect(spy).toHaveBeenCalledWith('shell');
  });
});

describe('AppState — attachment points', () => {
  const shadow: AttachmentPoint = {
    id: 'shadow', label: 'Shadow', parentBone: 'shell', offsetX: 0, offsetY: 10, shadowW: 34, shadowH: 12,
  };

  it('setAttachmentPoint stores a defensive copy (not a shared reference) and emits attachment:change', () => {
    const { bus, state } = build();
    const spy = vi.fn();
    bus.on('attachment:change', spy);
    const original = { ...shadow };

    state.setAttachmentPoint(original);
    original.offsetY = 999; // mutate the caller's object after the call

    expect(state.attachmentPoints.get('shadow')).not.toBe(original);
    expect(state.attachmentPoints.get('shadow')?.offsetY).toBe(10);
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('setAllAttachmentPoints clears existing points and replaces them, emitting once', () => {
    const { bus, state } = build();
    state.setAttachmentPoint(shadow);
    const spy = vi.fn();
    bus.on('attachment:change', spy);

    const replacement: AttachmentPoint = { id: 'shadow', label: 'Shadow 2', parentBone: 'core', offsetX: 1, offsetY: 2 };
    state.setAllAttachmentPoints([replacement]);

    expect(state.attachmentPoints.size).toBe(1);
    expect(state.attachmentPoints.get('shadow')).toEqual(replacement);
    expect(state.attachmentPoints.get('shadow')).not.toBe(replacement);
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('setAllAttachmentPoints with an empty array clears all points', () => {
    const { state } = build();
    state.setAttachmentPoint(shadow);

    state.setAllAttachmentPoints([]);

    expect(state.attachmentPoints.size).toBe(0);
  });
});
