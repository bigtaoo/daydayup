import { describe, it, expect, vi, afterEach } from 'vitest';
import { EventBus, type AppEvents } from '../core/EventBus';
import { AppState } from '../core/AppState';
import { AnimationController } from '../animation/AnimationController';
import { CommandManager } from '../core/CommandManager';
import { Rig, type RigDef } from '../skeleton/Rig';
import type { Renderer } from '../rendering/Renderer';
import { InteractionController } from './InteractionController';

// ── Test rig ──────────────────────────────────────────────────────────────────
// A minimal 2-bone rig purpose-built to exercise BOTH hit-test branches of
// findBoneAt: `head` is a circular module (bodyR, no shaft) and `arm` is a
// tubular shaft (outerW/innerW, no bodyR) — the orb-core/boss-core rigs give
// every bone a bodyR, which would leave pointToSegmentDist's branch dead.
//
// Rest pose (root at 0,0):
//   head: pivot (0,0) → tip (0,-30), bodyR 15
//   arm:  pivot (0,0) → tip (50,0),  tubular, no bodyR
const TEST_RIG: RigDef = {
  id: 'test-rig',
  label: 'Test Rig',
  bones: [
    { id: 'root', parent: null,   len: 0,  rwa: 0,   label: 'Root' },
    { id: 'head', parent: 'root', len: 30, rwa: -90, bodyR: 15,                    label: 'Head' },
    { id: 'arm',  parent: 'root', len: 50, rwa: 0,   outerW: 6, innerW: 3,         label: 'Arm' },
  ],
  drawOrder:     ['head', 'arm'],
  timelineBones: ['head', 'arm'],
  defaultShadow: { w: 10, h: 5 },
};

// ── Fakes ─────────────────────────────────────────────────────────────────────

function fakeEventTarget() {
  const listeners = new Map<string, Array<(e: unknown) => void>>();
  return {
    addEventListener: (event: string, cb: (e: unknown) => void) => {
      const arr = listeners.get(event) ?? [];
      arr.push(cb);
      listeners.set(event, arr);
    },
    removeEventListener: (event: string, cb: (e: unknown) => void) => {
      const arr = listeners.get(event) ?? [];
      const idx = arr.indexOf(cb);
      if (idx >= 0) arr.splice(idx, 1);
    },
    fire(event: string, e: unknown = {}) {
      (listeners.get(event) ?? []).slice().forEach(cb => cb(e));
    },
  };
}

function fakeMouseEvent(clientX: number, clientY: number, extra: Record<string, unknown> = {}) {
  return { clientX, clientY, button: 0, preventDefault: vi.fn(), ...extra };
}

function fakeKeyEvent(key: string, extra: Record<string, unknown> = {}) {
  return {
    key,
    ctrlKey: false,
    metaKey: false,
    shiftKey: false,
    target: { tagName: 'BODY' },
    preventDefault: vi.fn(),
    ...extra,
  };
}

function buildController(rig: Rig = new Rig(TEST_RIG)) {
  const bus = new EventBus<AppEvents>();
  const state = new AppState(bus);
  const animCtrl = new AnimationController(bus, state);
  const cmdManager = new CommandManager(bus);

  const canvas = fakeEventTarget();
  const win = fakeEventTarget();
  vi.stubGlobal('window', win);

  const renderer = {
    pixiApp: { view: canvas },
    toStageCoords: (clientX: number, clientY: number) => ({ x: clientX, y: clientY }),
  } as unknown as Renderer;

  const controller = new InteractionController(renderer, bus, state, animCtrl, cmdManager, rig);
  return { controller, bus, state, animCtrl, cmdManager, rig, canvas, win };
}

describe('InteractionController', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  // ── Hit-testing ──────────────────────────────────────────────────────────────

  describe('hit-testing (findBoneAt via mousedown)', () => {
    it('selects a circular (bodyR) bone when clicking on its tip', () => {
      const { canvas, state } = buildController();
      canvas.fire('mousedown', fakeMouseEvent(0, -30));
      expect(state.selectedBone).toBe('head');
    });

    it('selects a tubular (outerW/innerW, no bodyR) bone via pointToSegmentDist', () => {
      const { canvas, state } = buildController();
      // Midpoint of the arm segment (0,0)–(50,0); well clear of head's radius.
      canvas.fire('mousedown', fakeMouseEvent(25, 0));
      expect(state.selectedBone).toBe('arm');
    });

    it('deselects when clicking on empty space', () => {
      const { canvas, state } = buildController();
      canvas.fire('mousedown', fakeMouseEvent(0, -30));
      expect(state.selectedBone).toBe('head');

      canvas.fire('mousedown', fakeMouseEvent(500, 500));
      expect(state.selectedBone).toBeNull();
    });

    it('ignores non-left-button mousedown entirely', () => {
      const { canvas, state, animCtrl } = buildController();
      canvas.fire('mousedown', fakeMouseEvent(0, -30, { button: 2 }));
      expect(state.selectedBone).toBeNull();

      // Drag never started — a follow-up mousemove must not set a live delta.
      canvas.fire('mousemove', fakeMouseEvent(10, -30));
      expect(animCtrl.getCurrentFrame().get('head')).toBeUndefined();
    });

    it('selects a bone but does not start a drag in skin mode', () => {
      const { canvas, state, animCtrl } = buildController();
      state.setEditorMode('skin');

      canvas.fire('mousedown', fakeMouseEvent(0, -30));
      expect(state.selectedBone).toBe('head');

      canvas.fire('mousemove', fakeMouseEvent(30, -30));
      expect(animCtrl.getCurrentFrame().get('head')).toBeUndefined();
    });
  });

  // ── Drag / rotate ────────────────────────────────────────────────────────────

  describe('drag-to-rotate + commit on mouseup', () => {
    it('applies a live rotation delta while dragging', () => {
      const { canvas, animCtrl } = buildController();
      canvas.fire('mousedown', fakeMouseEvent(0, -30)); // hits head, pivot (0,0)

      // Moving to (30,0): atan2(0,30)=0 vs dragStartAngle atan2(-30,0)=-90° → +90°
      canvas.fire('mousemove', fakeMouseEvent(30, 0));
      expect(animCtrl.getCurrentFrame().get('head')?.rotation).toBeCloseTo(90);
    });

    it('does nothing on mousemove when not dragging', () => {
      const { canvas, animCtrl } = buildController();
      canvas.fire('mousemove', fakeMouseEvent(30, 0));
      expect(animCtrl.getCurrentFrame().size).toBe(0);
    });

    it('commits a RotateBoneCommand + keyframe on mouseup when rotation changed enough', () => {
      const { canvas, animCtrl, cmdManager, state } = buildController();
      animCtrl.createClip('walk');
      animCtrl.selectClip('walk');

      canvas.fire('mousedown', fakeMouseEvent(0, -30));
      canvas.fire('mousemove', fakeMouseEvent(30, 0));
      canvas.fire('mouseup');

      expect(cmdManager.canUndo).toBe(true);
      const clip = animCtrl.currentClip!;
      expect(clip.keyframes).toHaveLength(1);
      expect(clip.keyframes[0].time).toBeCloseTo(0);
      expect(clip.keyframes[0].bones.get('head')?.rotation).toBeCloseTo(90);
      expect(state.selectedKfTime).toBeCloseTo(0);

      // Live delta was cleared once the rotation was committed as a keyframe.
      expect(animCtrl.getCurrentFrame().get('head')?.rotation).toBeCloseTo(90);
    });

    it('undo removes the keyframe it created (no prior keyframe existed)', () => {
      const { canvas, animCtrl, cmdManager } = buildController();
      animCtrl.createClip('walk');
      animCtrl.selectClip('walk');

      canvas.fire('mousedown', fakeMouseEvent(0, -30));
      canvas.fire('mousemove', fakeMouseEvent(30, 0));
      canvas.fire('mouseup');
      expect(animCtrl.currentClip!.keyframes).toHaveLength(1);

      cmdManager.undo();
      expect(animCtrl.currentClip!.keyframes).toHaveLength(0);
    });

    it('undo restores the prior rotation when a keyframe already existed at that time', () => {
      const { canvas, animCtrl, cmdManager, state } = buildController();
      animCtrl.createClip('walk');
      animCtrl.selectClip('walk');
      animCtrl.addKeyframeAt(0, new Map([['head', { rotation: 5 }]]));
      state.setCurrentTime(0);

      canvas.fire('mousedown', fakeMouseEvent(0, -30));
      canvas.fire('mousemove', fakeMouseEvent(30, 0));
      canvas.fire('mouseup');

      // The drag angle delta (~90°) is added on top of the pre-existing rotation (5).
      expect(animCtrl.currentClip!.keyframes).toHaveLength(1);
      expect(animCtrl.currentClip!.keyframes[0].bones.get('head')?.rotation).toBeCloseTo(95);

      cmdManager.undo();
      expect(animCtrl.currentClip!.keyframes).toHaveLength(1);
      expect(animCtrl.currentClip!.keyframes[0].bones.get('head')?.rotation).toBeCloseTo(5);
    });

    it('does not push a command when the rotation barely changed', () => {
      const { canvas, animCtrl, cmdManager } = buildController();
      animCtrl.createClip('walk');
      animCtrl.selectClip('walk');

      canvas.fire('mousedown', fakeMouseEvent(0, -30));
      canvas.fire('mouseup'); // no mousemove — rotation delta is 0

      expect(cmdManager.canUndo).toBe(false);
      expect(animCtrl.currentClip!.keyframes).toHaveLength(0);
    });

    it('mouseup with no active drag is a no-op', () => {
      const { canvas, cmdManager } = buildController();
      expect(() => canvas.fire('mouseup')).not.toThrow();
      expect(cmdManager.canUndo).toBe(false);
    });

    it('mouseleave commits a drag the same way mouseup does', () => {
      const { canvas, animCtrl, cmdManager } = buildController();
      animCtrl.createClip('walk');
      animCtrl.selectClip('walk');

      canvas.fire('mousedown', fakeMouseEvent(0, -30));
      canvas.fire('mousemove', fakeMouseEvent(30, 0));
      canvas.fire('mouseleave');

      expect(cmdManager.canUndo).toBe(true);
      expect(animCtrl.currentClip!.keyframes).toHaveLength(1);
    });
  });

  // ── Right-click pan ──────────────────────────────────────────────────────────

  describe('right-click pan', () => {
    it('drags the root position and prevents the context menu', () => {
      const { canvas, win, state } = buildController();
      const e = fakeMouseEvent(100, 50);
      canvas.fire('contextmenu', e);
      expect(e.preventDefault).toHaveBeenCalledTimes(1);

      win.fire('mousemove', { clientX: 110, clientY: 60 });
      expect(state.rootX).toBeCloseTo(10);
      expect(state.rootY).toBeCloseTo(10);
    });

    it('stops panning once mouseup fires (listeners are detached)', () => {
      const { canvas, win, state } = buildController();
      canvas.fire('contextmenu', fakeMouseEvent(100, 50));
      win.fire('mousemove', { clientX: 110, clientY: 60 });
      expect(state.rootX).toBeCloseTo(10);

      win.fire('mouseup');
      win.fire('mousemove', { clientX: 200, clientY: 200 });
      // Still at the position set by the last mousemove before mouseup.
      expect(state.rootX).toBeCloseTo(10);
      expect(state.rootY).toBeCloseTo(10);
    });
  });

  // ── Keyboard ─────────────────────────────────────────────────────────────────

  describe('keyboard commands', () => {
    it('ignores keydown while focus is in a text input', () => {
      const { win, animCtrl } = buildController();
      animCtrl.createClip('walk');
      animCtrl.selectClip('walk');

      win.fire('keydown', fakeKeyEvent('k', { target: { tagName: 'INPUT' } }));
      expect(animCtrl.currentClip!.keyframes).toHaveLength(0);

      win.fire('keydown', fakeKeyEvent('k', { target: { tagName: 'TEXTAREA' } }));
      win.fire('keydown', fakeKeyEvent('k', { target: { tagName: 'SELECT' } }));
      expect(animCtrl.currentClip!.keyframes).toHaveLength(0);
    });

    it('ctrl+z undoes, ctrl+shift+z and ctrl+y redo', () => {
      const { win, cmdManager } = buildController();
      const undoSpy = vi.spyOn(cmdManager, 'undo');
      const redoSpy = vi.spyOn(cmdManager, 'redo');

      const undoEvent = fakeKeyEvent('z', { ctrlKey: true });
      win.fire('keydown', undoEvent);
      expect(undoSpy).toHaveBeenCalledTimes(1);
      expect(undoEvent.preventDefault).toHaveBeenCalledTimes(1);

      win.fire('keydown', fakeKeyEvent('z', { ctrlKey: true, shiftKey: true }));
      expect(redoSpy).toHaveBeenCalledTimes(1);

      win.fire('keydown', fakeKeyEvent('y', { ctrlKey: true }));
      expect(redoSpy).toHaveBeenCalledTimes(2);
    });

    it('Tab toggles preview mode, "s" toggles editor mode', () => {
      const { win, state } = buildController();
      expect(state.previewMode).toBe('skeleton');

      const tabEvent = fakeKeyEvent('Tab');
      win.fire('keydown', tabEvent);
      expect(state.previewMode).toBe('sprite');
      expect(tabEvent.preventDefault).toHaveBeenCalledTimes(1);

      win.fire('keydown', fakeKeyEvent('Tab'));
      expect(state.previewMode).toBe('skeleton');

      expect(state.editorMode).toBe('animate');
      win.fire('keydown', fakeKeyEvent('S'));
      expect(state.editorMode).toBe('skin');
      win.fire('keydown', fakeKeyEvent('s'));
      expect(state.editorMode).toBe('animate');
    });

    it('"k" adds a keyframe at the current time and emits a status message', () => {
      const { win, bus, animCtrl, state } = buildController();
      animCtrl.createClip('walk');
      animCtrl.selectClip('walk');
      state.setCurrentTime(0.25);

      const statusSpy = vi.fn();
      bus.on('status', statusSpy);

      win.fire('keydown', fakeKeyEvent('k'));

      expect(animCtrl.currentClip!.keyframes).toHaveLength(1);
      expect(animCtrl.currentClip!.keyframes[0].time).toBeCloseTo(0.25);
      expect(statusSpy).toHaveBeenCalledWith(expect.stringContaining('0.250'));
    });

    it('Delete removes the keyframe at the selected (or current) time and emits status', () => {
      const { win, bus, animCtrl, state } = buildController();
      animCtrl.createClip('walk');
      animCtrl.selectClip('walk');
      animCtrl.addKeyframeAt(0.5);
      state.setSelectedKfTime(0.5);

      const statusSpy = vi.fn();
      bus.on('status', statusSpy);

      win.fire('keydown', fakeKeyEvent('Delete'));

      expect(animCtrl.currentClip!.keyframes).toHaveLength(0);
      expect(statusSpy).toHaveBeenCalledWith(expect.stringContaining('0.500'));
    });

    it('Backspace falls back to currentTime when no keyframe is selected', () => {
      const { win, animCtrl, state } = buildController();
      animCtrl.createClip('walk');
      animCtrl.selectClip('walk');
      animCtrl.addKeyframeAt(0.75);
      state.setCurrentTime(0.75);

      win.fire('keydown', fakeKeyEvent('Backspace'));
      expect(animCtrl.currentClip!.keyframes).toHaveLength(0);
    });

    it('space toggles play/pause (blocked with a status error when no clip is selected)', () => {
      const { win, bus, state } = buildController();
      const errorSpy = vi.fn();
      bus.on('error', errorSpy);

      const spaceEvent = fakeKeyEvent(' ');
      win.fire('keydown', spaceEvent);

      expect(spaceEvent.preventDefault).toHaveBeenCalledTimes(1);
      expect(errorSpy).toHaveBeenCalledWith('Select an animation first');
      expect(state.isPlaying).toBe(false);
    });
  });
});
