import { describe, it, expect, vi, afterEach } from 'vitest';
import { EventBus, type AppEvents } from '../core/EventBus';
import { AppState } from '../core/AppState';
import { AnimationController } from '../animation/AnimationController';
import { CommandManager } from '../core/CommandManager';
import { FakeElement, installFakeDocument } from './fakeDom';
import { ToolbarPanel } from './ToolbarPanel';

afterEach(() => vi.unstubAllGlobals());

const CHECKBOX_IDS = ['chk-loop', 'chk-joints', 'chk-onion', 'chk-guide', 'chk-overlay', 'chk-pivots'];
const PLAIN_BUTTON_IDS = [
  'btn-play', 'btn-stop', 'btn-play2', 'btn-prev-kf', 'btn-next-kf',
  'btn-add-kf', 'btn-del-kf', 'btn-reset-pose', 'btn-presets',
];

function buildRegistry(): { registry: Record<string, FakeElement>; inpDurWrap: FakeElement } {
  const registry: Record<string, FakeElement> = {};
  for (const id of PLAIN_BUTTON_IDS) registry[id] = new FakeElement('button');
  for (const id of CHECKBOX_IDS) {
    const el = new FakeElement('input');
    el.type = 'checkbox';
    registry[id] = el;
  }
  registry['sel-speed']   = new FakeElement('select');
  registry['inp-bg-color'] = new FakeElement('input');
  registry['time-display'] = new FakeElement('span');

  const inpDur = new FakeElement('input');
  inpDur.type = 'text';
  registry['inp-duration'] = inpDur;
  const inpDurWrap = new FakeElement('div');
  inpDurWrap.appendChild(inpDur);

  return { registry, inpDurWrap };
}

/** `withSep` controls whether `el` starts with one pre-existing `.sep` divider
 *  (matching the real toolbar template) — false exercises buildUndoRedo's own
 *  append-with-no-separator fallback. */
function build(withSep = true) {
  const { registry } = buildRegistry();
  installFakeDocument(registry);
  vi.stubGlobal('prompt', vi.fn());

  const el = new FakeElement('div');
  let sepOrig: FakeElement | null = null;
  if (withSep) {
    sepOrig = new FakeElement('div');
    sepOrig.className = 'sep';
    el.appendChild(sepOrig);
  }

  const bus       = new EventBus<AppEvents>();
  const state     = new AppState(bus);
  const animCtrl  = new AnimationController(bus, state);
  const cmdManager = new CommandManager(bus);

  const panel = new ToolbarPanel(el as unknown as HTMLElement, bus, state, animCtrl, cmdManager);

  // The skeleton-toggle button is built locally (not looked up by id at
  // construction time) but IS looked up by id later, from the chk-overlay
  // change handler — register the same instance the panel actually built.
  const skeletonBtn = el.querySelector('#btn-skeleton-toggle');
  if (skeletonBtn) registry['btn-skeleton-toggle'] = skeletonBtn;

  return { panel, el, bus, state, animCtrl, cmdManager, registry, sepOrig };
}

describe('ToolbarPanel — structure', () => {
  it('inserts undo/redo (with its own separator) before the first existing separator, and the mode/preview/skeleton buttons around them', () => {
    const { el, sepOrig } = build(true);
    expect(el.children).toHaveLength(7);
    const [editorBtn, undoSep, btnUndo, btnRedo, previewBtn, skeletonBtn, lastChild] = el.children;

    expect(editorBtn.id).toBe('btn-editor-mode');
    expect(undoSep.hasClass('sep')).toBe(true);
    expect(undoSep.id).toBe('');
    expect(btnUndo.textContent).toBe('↩ Undo');
    expect(btnRedo.textContent).toBe('↪ Redo');
    expect(previewBtn.id).toBe('btn-preview-mode');
    expect(skeletonBtn.id).toBe('btn-skeleton-toggle');
    expect(lastChild).toBe(sepOrig);
  });

  it('falls back to appending undo/redo (plus a separator) when the toolbar starts completely empty', () => {
    const { el } = build(false);
    expect(el.children).toHaveLength(6);
    const [editorBtn, previewBtn, skeletonBtn, undoSep, btnUndo, btnRedo] = el.children;

    expect(editorBtn.id).toBe('btn-editor-mode');
    expect(previewBtn.id).toBe('btn-preview-mode');
    expect(skeletonBtn.id).toBe('btn-skeleton-toggle');
    expect(undoSep.hasClass('sep')).toBe(true);
    expect(btnUndo.textContent).toBe('↩ Undo');
    expect(btnRedo.textContent).toBe('↪ Redo');
  });

  it('undo/redo start disabled', () => {
    const { el } = build();
    const btnUndo = el.children.find(c => c.textContent === '↩ Undo')!;
    const btnRedo = el.children.find(c => c.textContent === '↪ Redo')!;
    expect(btnUndo.disabled).toBe(true);
    expect(btnRedo.disabled).toBe(true);
    expect(btnUndo.title).toBe('Nothing to undo');
  });
});

describe('ToolbarPanel — undo/redo', () => {
  it('undo button click delegates to the command manager', () => {
    const { el, cmdManager } = build();
    const undoSpy = vi.spyOn(cmdManager, 'undo');
    el.children.find(c => c.textContent === '↩ Undo')!.fire('click');
    expect(undoSpy).toHaveBeenCalledTimes(1);
  });

  it('redo button click delegates to the command manager', () => {
    const { el, cmdManager } = build();
    const redoSpy = vi.spyOn(cmdManager, 'redo');
    el.children.find(c => c.textContent === '↪ Redo')!.fire('click');
    expect(redoSpy).toHaveBeenCalledTimes(1);
  });

  it('history:change updates both buttons\' disabled state and the undo title', () => {
    const { el, bus } = build();
    const btnUndo = el.children.find(c => c.textContent === '↩ Undo')!;
    const btnRedo = el.children.find(c => c.textContent === '↪ Redo')!;

    bus.emit('history:change', { canUndo: true, canRedo: false, label: 'Undo: Create clip "idle"' });
    expect(btnUndo.disabled).toBe(false);
    expect(btnRedo.disabled).toBe(true);
    expect(btnUndo.title).toBe('Undo: Create clip "idle"');

    bus.emit('history:change', { canUndo: false, canRedo: true, label: 'Redo: Create clip "idle"' });
    expect(btnUndo.disabled).toBe(true);
    expect(btnUndo.title).toBe('Nothing to undo');
  });
});

describe('ToolbarPanel — editor mode toggle', () => {
  it('starts in "animate" mode (the AppState default)', () => {
    const { el } = build();
    const btn = el.children.find(c => c.id === 'btn-editor-mode')!;
    expect(btn.textContent).toBe('🎬 Animate');
    expect(btn.hasClass('active')).toBe(false);
  });

  it('clicking flips AppState.editorMode and re-renders the label on editor:mode', () => {
    const { el, state } = build();
    const btn = el.children.find(c => c.id === 'btn-editor-mode')!;

    btn.fire('click');
    expect(state.editorMode).toBe('skin');
    expect(btn.textContent).toBe('🎨 Skin');
    expect(btn.hasClass('active')).toBe(true);

    btn.fire('click');
    expect(state.editorMode).toBe('animate');
    expect(btn.textContent).toBe('🎬 Animate');
    expect(btn.hasClass('active')).toBe(false);
  });
});

describe('ToolbarPanel — preview mode toggle', () => {
  it('starts in "skeleton" mode (the AppState default)', () => {
    const { el } = build();
    const btn = el.children.find(c => c.id === 'btn-preview-mode')!;
    expect(btn.textContent).toBe('🦴 Skeleton');
  });

  it('clicking flips AppState.previewMode', () => {
    const { el, state } = build();
    const btn = el.children.find(c => c.id === 'btn-preview-mode')!;
    btn.fire('click');
    expect(state.previewMode).toBe('sprite');
    expect(btn.textContent).toBe('🖼 Sprite');
  });

  it('re-renders the label on preview:mode even when changed elsewhere', () => {
    const { el, bus } = build();
    const btn = el.children.find(c => c.id === 'btn-preview-mode')!;
    bus.emit('preview:mode', 'sprite');
    expect(btn.textContent).toBe('🖼 Sprite');
  });
});

describe('ToolbarPanel — skeleton overlay toggle', () => {
  it('starts disabled (previewMode defaults to skeleton, not sprite)', () => {
    const { el } = build();
    const btn = el.children.find(c => c.id === 'btn-skeleton-toggle')!;
    expect(btn.disabled).toBe(true);
    expect(btn.hasClass('active')).toBe(false);
  });

  it('enables once preview mode switches to sprite, and toggling syncs the sidebar checkbox', () => {
    const { el, state, registry } = build();
    const btn = el.children.find(c => c.id === 'btn-skeleton-toggle')!;

    state.setPreviewMode('sprite');
    expect(btn.disabled).toBe(false);

    btn.fire('click');
    expect(state.showSkeletonOverlay).toBe(true);
    expect(registry['chk-overlay'].checked).toBe(true);
    expect(btn.hasClass('active')).toBe(true);

    btn.fire('click');
    expect(state.showSkeletonOverlay).toBe(false);
    expect(registry['chk-overlay'].checked).toBe(false);
    expect(btn.hasClass('active')).toBe(false);
  });

  it('disables again (and drops "active") when preview mode switches back to skeleton', () => {
    const { el, state } = build();
    const btn = el.children.find(c => c.id === 'btn-skeleton-toggle')!;
    state.setPreviewMode('sprite');
    btn.fire('click'); // turn overlay on while enabled
    state.setPreviewMode('skeleton');
    expect(btn.disabled).toBe(true);
    expect(btn.hasClass('active')).toBe(false); // inSprite is now false
  });
});

describe('ToolbarPanel — bindExisting: playback controls', () => {
  it('btn-play and btn-play2 both call animCtrl.toggle()', () => {
    const { registry, animCtrl } = build();
    const toggleSpy = vi.spyOn(animCtrl, 'toggle').mockImplementation(() => {});
    registry['btn-play'].fire('click');
    registry['btn-play2'].fire('click');
    expect(toggleSpy).toHaveBeenCalledTimes(2);
  });

  it('btn-stop calls animCtrl.stop()', () => {
    const { registry, animCtrl } = build();
    const stopSpy = vi.spyOn(animCtrl, 'stop').mockImplementation(() => {});
    registry['btn-stop'].fire('click');
    expect(stopSpy).toHaveBeenCalledTimes(1);
  });

  it('btn-prev-kf / btn-next-kf move current time to the adjacent keyframe when one exists', () => {
    const { registry, animCtrl, state } = build();
    animCtrl.createClip('idle');
    animCtrl.selectClip('idle');
    animCtrl.addKeyframeAt(0, new Map());
    animCtrl.addKeyframeAt(1, new Map());
    state.setCurrentTime(0.5);

    registry['btn-prev-kf'].fire('click');
    expect(state.currentTime).toBe(0);

    state.setCurrentTime(0.5);
    registry['btn-next-kf'].fire('click');
    expect(state.currentTime).toBe(1);
  });

  it('btn-prev-kf / btn-next-kf are no-ops when there is no adjacent keyframe', () => {
    const { registry, state } = build();
    state.setCurrentTime(0.5);
    registry['btn-prev-kf'].fire('click');
    registry['btn-next-kf'].fire('click');
    expect(state.currentTime).toBe(0.5);
  });

  it('btn-reset-pose calls animCtrl.resetPose()', () => {
    const { registry, animCtrl } = build();
    const spy = vi.spyOn(animCtrl, 'resetPose');
    registry['btn-reset-pose'].fire('click');
    expect(spy).toHaveBeenCalledTimes(1);
  });
});

describe('ToolbarPanel — bindExisting: keyframe add/delete are undoable commands', () => {
  it('btn-add-kf adds a keyframe at the current time and pushes an undoable command', () => {
    const { registry, animCtrl, state, cmdManager } = build();
    animCtrl.createClip('idle');
    animCtrl.selectClip('idle');
    state.setCurrentTime(0.25);

    registry['btn-add-kf'].fire('click');

    expect(animCtrl.currentClip!.keyframes.map(k => k.time)).toEqual([0.25]);
    expect(cmdManager.canUndo).toBe(true);

    cmdManager.undo();
    expect(animCtrl.currentClip!.keyframes).toHaveLength(0);
  });

  it('btn-del-kf deletes the keyframe at the selected time (falling back to current time)', () => {
    const { registry, animCtrl, state, cmdManager } = build();
    animCtrl.createClip('idle');
    animCtrl.selectClip('idle');
    animCtrl.addKeyframeAt(0.5, new Map());
    state.setSelectedKfTime(0.5);

    registry['btn-del-kf'].fire('click');

    expect(animCtrl.currentClip!.keyframes).toHaveLength(0);
    expect(cmdManager.canUndo).toBe(true);
  });
});

describe('ToolbarPanel — bindExisting: form controls', () => {
  it('sel-speed change updates AppState.playSpeed', () => {
    const { registry, state } = build();
    registry['sel-speed'].value = '2';
    registry['sel-speed'].fire('change');
    expect(state.playSpeed).toBe(2);
  });

  it('chk-loop change updates AppState.looping', () => {
    const { registry, state } = build();
    registry['chk-loop'].checked = false;
    registry['chk-loop'].fire('change');
    expect(state.looping).toBe(false);
  });

  it('inp-duration change sets the current clip\'s duration when numeric', () => {
    const { registry, animCtrl } = build();
    animCtrl.createClip('idle');
    animCtrl.selectClip('idle');
    registry['inp-duration'].value = '3.5';
    registry['inp-duration'].fire('change');
    expect(animCtrl.currentClip!.duration).toBe(3.5);
  });

  it('inp-duration change is ignored when not numeric', () => {
    const { registry, animCtrl } = build();
    animCtrl.createClip('idle');
    animCtrl.selectClip('idle');
    const before = animCtrl.currentClip!.duration;
    registry['inp-duration'].value = 'abc';
    registry['inp-duration'].fire('change');
    expect(animCtrl.currentClip!.duration).toBe(before);
  });

  it('injects an "Auto" button right after inp-duration that calls animCtrl.autoFitDuration()', () => {
    const { registry, animCtrl } = build();
    const inpDur = registry['inp-duration'];
    const wrap = inpDur.parent!;
    expect(wrap.children[wrap.children.indexOf(inpDur) + 1].textContent).toBe('Auto');

    const spy = vi.spyOn(animCtrl, 'autoFitDuration').mockImplementation(() => {});
    wrap.children[wrap.children.indexOf(inpDur) + 1].fire('click');
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['chk-joints', 'setShowJoints'],
    ['chk-onion',  'setShowOnion'],
    ['chk-guide',  'setShowGuide'],
    ['chk-pivots', 'setShowPivots'],
  ] as const)('%s change calls AppState.%s(checked)', (id, method) => {
    const { registry, state } = build();
    const spy = vi.spyOn(state, method);
    registry[id].checked = true;
    registry[id].fire('change');
    expect(spy).toHaveBeenCalledWith(true);
  });

  it('chk-overlay change updates AppState.showSkeletonOverlay and syncs btn-skeleton-toggle\'s active class', () => {
    const { registry, state } = build();
    state.setPreviewMode('sprite');

    registry['chk-overlay'].checked = true;
    registry['chk-overlay'].fire('change');

    expect(state.showSkeletonOverlay).toBe(true);
    expect(registry['btn-skeleton-toggle'].hasClass('active')).toBe(true);
  });

  it('inp-bg-color input sets AppState.backgroundColor from a valid hex string', () => {
    const { registry, state } = build();
    registry['inp-bg-color'].value = '#ff0000';
    registry['inp-bg-color'].fire('input');
    expect(state.backgroundColor).toBe(0xff0000);
  });

  it('inp-bg-color input ignores an unparseable value', () => {
    const { registry, state } = build();
    const before = state.backgroundColor;
    registry['inp-bg-color'].value = 'zzzzzz';
    registry['inp-bg-color'].fire('input');
    expect(state.backgroundColor).toBe(before);
  });
});

describe('ToolbarPanel — bindExisting: btn-presets', () => {
  it('loads and selects a valid preset name, and posts a status message', () => {
    const { registry, animCtrl } = build();
    vi.stubGlobal('prompt', vi.fn().mockReturnValue('idle'));
    const loadSpy   = vi.spyOn(animCtrl, 'loadPreset');
    const selectSpy = vi.spyOn(animCtrl, 'selectClip');

    registry['btn-presets'].fire('click');

    expect(loadSpy).toHaveBeenCalledWith('idle');
    expect(selectSpy).toHaveBeenCalledWith('idle');
  });

  it('emits an error for an unknown preset name', () => {
    const { registry, bus } = build();
    vi.stubGlobal('prompt', vi.fn().mockReturnValue('not-a-real-preset'));
    const errors: string[] = [];
    bus.on('error', msg => errors.push(msg));

    registry['btn-presets'].fire('click');

    expect(errors).toEqual(['Unknown preset: not-a-real-preset']);
  });

  it('does nothing when the prompt is cancelled or blank', () => {
    const { registry, animCtrl } = build();
    vi.stubGlobal('prompt', vi.fn().mockReturnValue(''));
    const loadSpy = vi.spyOn(animCtrl, 'loadPreset');

    registry['btn-presets'].fire('click');

    expect(loadSpy).not.toHaveBeenCalled();
  });
});

describe('ToolbarPanel — bus listeners driving read-only display elements', () => {
  it('play:state flips the btn-play label between Play and Pause', () => {
    const { bus, registry } = build();
    bus.emit('play:state', true);
    expect(registry['btn-play'].textContent).toBe('⏸ Pause');
    bus.emit('play:state', false);
    expect(registry['btn-play'].textContent).toBe('▶ Play');
  });

  it('time:change renders elapsed/duration, defaulting duration to 0.5s with no clip selected', () => {
    const { bus, registry } = build();
    bus.emit('time:change', 0.125);
    expect(registry['time-display'].textContent).toBe('0.125s / 0.500s');
  });

  it('time:change uses the current clip\'s duration once one is selected', () => {
    const { bus, registry, animCtrl } = build();
    animCtrl.createClip('idle');
    animCtrl.selectClip('idle');
    animCtrl.setDuration(2);
    bus.emit('time:change', 1);
    expect(registry['time-display'].textContent).toBe('1.000s / 2.000s');
  });

  it('anim:select syncs the duration input and loop checkbox from the newly selected clip', () => {
    const { registry, animCtrl } = build();
    animCtrl.createClip('idle');
    animCtrl.selectClip('idle');
    animCtrl.setDuration(1.25);

    // Re-select to re-fire anim:select against the now-1.25s clip.
    animCtrl.createClip('walk');
    animCtrl.selectClip('walk');
    animCtrl.setDuration(1.25);
    animCtrl.selectClip('idle');

    expect(registry['inp-duration'].value).toBe('1.25');
    expect(registry['chk-loop'].checked).toBe(true); // AnimationController.createClip defaults loop: true
  });

  it('kf:change re-syncs the duration input, unless it is currently focused', () => {
    const { bus, registry, animCtrl } = build();
    animCtrl.createClip('idle');
    animCtrl.selectClip('idle');
    animCtrl.setDuration(1);
    registry['inp-duration'].value = '1.00';

    animCtrl.currentClip!.duration = 4; // simulate an external change (e.g. autoFitDuration)
    bus.emit('kf:change');
    expect(registry['inp-duration'].value).toBe('4.00');

    (document as unknown as { activeElement: unknown }).activeElement = registry['inp-duration'];
    animCtrl.currentClip!.duration = 9;
    bus.emit('kf:change');
    expect(registry['inp-duration'].value).toBe('4.00'); // untouched — user is actively editing it
  });
});
