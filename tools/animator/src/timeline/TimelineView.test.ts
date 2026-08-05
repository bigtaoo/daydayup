import { describe, it, expect, vi, afterEach } from 'vitest';
import { EventBus, type AppEvents } from '../core/EventBus';
import { AppState } from '../core/AppState';
import { AnimationController } from '../animation/AnimationController';
import { CommandManager } from '../core/CommandManager';
import { Rig } from '../skeleton/Rig';
import { ORB_CORE_RIG } from '../skeleton/rigs/orbCore';
import type { BoneKeyframe } from '../core/types';
import { TimelineView } from './TimelineView';

/**
 * TimelineView draws to a real Canvas2D context and reaches into a handful of
 * plain DOM elements (`document.getElementById('tl-vscroll'/'tl-vscroll-thumb')`,
 * a `labelContainer`, and internally constructs a `ContextMenu`, which itself
 * needs `document.createElement`/`document.body`/`document.addEventListener`).
 * This repo has no jsdom, so everything below is a hand-rolled fake:
 *   - `makeFakeCtx2D()` records every Canvas2D method call + every style-property
 *     assignment (fillStyle/strokeStyle/lineWidth/font) into a flat `calls` list,
 *     in the spirit of reading back Pixi's `Graphics.context.instructions` in
 *     `tools/map-editor/src/canvas/DungeonFloorCanvas.test.ts` — but for real
 *     Canvas2D there's no such built-in log, so this rebuilds one.
 *   - `fakeElement()` is a minimal generic DOM node (style/children/classList/
 *     addEventListener/appendChild/innerHTML-clears-children) reused for the
 *     canvas, labelContainer, vscroll track/thumb, and anything
 *     `document.createElement` is asked for.
 *   - The real `ContextMenu` the constructor builds is swapped for a spy right
 *     after construction (`menuSpy`), so onContextMenu tests don't need to
 *     stub `window.innerWidth/innerHeight` too — ContextMenu's own positioning
 *     logic is covered in ContextMenu.test.ts.
 *
 * ROW_H (26) / RULER_H (20) are TimelineView.ts's own unexported layout
 * constants — mirrored here as plain numbers since the module doesn't export
 * them.
 *
 * NOT covered: pixel-perfect draw-call *sequencing* (asserted via call counts
 * and key argument values instead, per the brief — sequencing would be
 * brittle against harmless reordering); the RAF-driven playback tick in
 * AnimationController (irrelevant to this view); and the real `ContextMenu`
 * DOM/positioning integration (owned by ContextMenu.test.ts).
 */

const ROW_H = 26;
const RULER_H = 20;

// ── Fakes ─────────────────────────────────────────────────────────────────────

interface CtxCall { method: string; args: unknown[] }

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function makeFakeCtx2D(): any {
  const calls: CtxCall[] = [];
  const record = (method: string) => (...args: unknown[]) => { calls.push({ method, args }); };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const ctx: any = {
    calls,
    clearRect: record('clearRect'),
    fillRect: record('fillRect'),
    beginPath: record('beginPath'),
    moveTo: record('moveTo'),
    lineTo: record('lineTo'),
    closePath: record('closePath'),
    fill: record('fill'),
    stroke: record('stroke'),
    save: record('save'),
    restore: record('restore'),
    rect: record('rect'),
    clip: record('clip'),
    arc: record('arc'),
    fillText: record('fillText'),
  };
  for (const prop of ['fillStyle', 'strokeStyle', 'lineWidth', 'font']) {
    let value: unknown;
    Object.defineProperty(ctx, prop, {
      get: () => value,
      set: (v: unknown) => { value = v; calls.push({ method: `set:${prop}`, args: [v] }); },
    });
  }
  return ctx;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function fakeElement(tag = 'div'): any {
  const listeners = new Map<string, Array<(e: unknown) => void>>();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const el: any = {
    tagName: tag,
    style: {},
    className: '',
    disabled: false,
    textContent: '',
    clientWidth: 0,
    clientHeight: 0,
    scrollTop: 0,
    remove: vi.fn(),
    getBoundingClientRect: () => ({ left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0 }),
  };
  el.children = [];
  el.appendChild = (child: unknown) => { el.children.push(child); return child; };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  el.contains = (node: any): boolean =>
    node === el || el.children.some((c: any) => c === node || (typeof c.contains === 'function' && c.contains(node)));
  el.addEventListener = (ev: string, cb: (e: unknown) => void) => {
    const arr = listeners.get(ev) ?? [];
    arr.push(cb);
    listeners.set(ev, arr);
  };
  el.removeEventListener = (ev: string, cb: (e: unknown) => void) => {
    const arr = listeners.get(ev);
    if (arr) listeners.set(ev, arr.filter(f => f !== cb));
  };
  el.dispatch = (ev: string, e: unknown = {}) => {
    (listeners.get(ev) ?? []).slice().forEach(cb => cb(e));
  };
  el.listenerCount = (ev: string) => (listeners.get(ev) ?? []).length;
  let html = '';
  Object.defineProperty(el, 'innerHTML', {
    get: () => html,
    set: (v: string) => { html = v; el.children = []; },
  });
  const classSet = new Set<string>();
  el.classList = {
    add: (c: string) => classSet.add(c),
    remove: (c: string) => classSet.delete(c),
    contains: (c: string) => classSet.has(c),
  };
  return el;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function fakeCanvasEl(ctx: unknown): any {
  const el = fakeElement('canvas');
  el.width = 800;
  el.height = 400;
  el.parentElement = { clientWidth: 800, clientHeight: 400 };
  el.getContext = () => ctx;
  el.getBoundingClientRect = () => ({ left: 0, top: 0, right: el.width, bottom: el.height, width: el.width, height: el.height });
  return el;
}

function fakeDocument(elementsById: Record<string, unknown>) {
  const listeners = new Map<string, Array<(e: unknown) => void>>();
  return {
    getElementById: (id: string) => elementsById[id],
    createElement: (tag: string) => fakeElement(tag),
    body: { appendChild: vi.fn() },
    addEventListener: (ev: string, cb: (e: unknown) => void) => {
      const arr = listeners.get(ev) ?? [];
      arr.push(cb);
      listeners.set(ev, arr);
    },
    removeEventListener: (ev: string, cb: (e: unknown) => void) => {
      const arr = listeners.get(ev);
      if (arr) listeners.set(ev, arr.filter(f => f !== cb));
    },
    dispatch: (ev: string, e: unknown) => {
      (listeners.get(ev) ?? []).slice().forEach(cb => cb(e));
    },
  };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function priv(view: TimelineView): any {
  return view;
}

function buildView(opts: { canvasWidth?: number; canvasHeight?: number } = {}) {
  const ctx = makeFakeCtx2D();
  const canvasEl = fakeCanvasEl(ctx);
  if (opts.canvasWidth != null) {
    canvasEl.width = opts.canvasWidth;
    canvasEl.parentElement.clientWidth = opts.canvasWidth;
  }
  if (opts.canvasHeight != null) {
    canvasEl.height = opts.canvasHeight;
    canvasEl.parentElement.clientHeight = opts.canvasHeight;
  }

  const labelContainer = fakeElement('div');
  const vscrollEl = fakeElement('div');
  const vscrollThumb = fakeElement('div');
  vscrollEl.clientHeight = 400;

  const doc = fakeDocument({ 'tl-vscroll': vscrollEl, 'tl-vscroll-thumb': vscrollThumb });
  vi.stubGlobal('document', doc);

  const bus = new EventBus<AppEvents>();
  const state = new AppState(bus);
  const rig = new Rig(ORB_CORE_RIG);
  const animCtrl = new AnimationController(bus, state);
  const cmdManager = new CommandManager(bus);

  const view = new TimelineView(canvasEl, labelContainer, bus, state, animCtrl, cmdManager, rig);

  // Swap the real ContextMenu the constructor built for a spy — its own
  // positioning/rendering behaviour is covered by ContextMenu.test.ts, and
  // stubbing it here means onContextMenu tests don't need a `window` global.
  const menuSpy = { show: vi.fn(), hide: vi.fn(), destroy: vi.fn() };
  priv(view).contextMenu = menuSpy;

  return { view, ctx, canvasEl, labelContainer, vscrollEl, vscrollThumb, bus, state, animCtrl, cmdManager, rig, menuSpy, doc };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

// ── Constructor wiring ────────────────────────────────────────────────────────

describe('TimelineView — constructor wiring', () => {
  it('reads the 2D context off the canvas and the vscroll elements by id', () => {
    const { view, ctx, vscrollEl, vscrollThumb } = buildView();
    expect(priv(view).ctx).toBe(ctx);
    expect(priv(view).vscrollEl).toBe(vscrollEl);
    expect(priv(view).vscrollThumb).toBe(vscrollThumb);
  });

  it('wires exactly one mousedown/mousemove/mouseup/mouseleave/contextmenu/wheel listener on the canvas', () => {
    const { canvasEl } = buildView();
    for (const ev of ['mousedown', 'mousemove', 'mouseup', 'mouseleave', 'contextmenu', 'wheel']) {
      expect(canvasEl.listenerCount(ev)).toBe(1);
    }
  });

  it('wires a mousedown listener on both the scroll thumb and the scroll track', () => {
    const { vscrollEl, vscrollThumb } = buildView();
    expect(vscrollThumb.listenerCount('mousedown')).toBe(1);
    expect(vscrollEl.listenerCount('mousedown')).toBe(1);
  });

  it('marks dirty+labelsDirty on kf:change/anim:select/bone:select, but only dirty on time:change', () => {
    const { view, bus } = buildView();
    view.render();
    expect(priv(view).dirty).toBe(false);
    expect(priv(view).labelsDirty).toBe(false);

    bus.emit('time:change', 1);
    expect(priv(view).dirty).toBe(true);
    expect(priv(view).labelsDirty).toBe(false);

    view.render();
    bus.emit('kf:change');
    expect(priv(view).dirty).toBe(true);
    expect(priv(view).labelsDirty).toBe(true);

    view.render();
    bus.emit('anim:select', 'walk');
    expect(priv(view).dirty).toBe(true);
    expect(priv(view).labelsDirty).toBe(true);

    view.render();
    bus.emit('bone:select', 'shell');
    expect(priv(view).dirty).toBe(true);
    expect(priv(view).labelsDirty).toBe(true);
  });
});

// ── render() ──────────────────────────────────────────────────────────────────

describe('TimelineView — render()', () => {
  it('is a no-op when not dirty', () => {
    const { view, ctx } = buildView();
    view.render();
    const callsAfterFirst = ctx.calls.length;
    view.render();
    expect(ctx.calls.length).toBe(callsAfterFirst);
  });

  it('resizes the canvas to match its parent element and re-clamps an out-of-range scroll offset', () => {
    const { view, canvasEl } = buildView({ canvasWidth: 800, canvasHeight: 100 });
    canvasEl.width = 50;
    canvasEl.height = 50;
    priv(view).scrollY = 99999;

    view.render();

    expect(canvasEl.width).toBe(800);
    expect(canvasEl.height).toBe(100);
    // rowsContentH = 5 bones * 26 = 130; visible = 100 - 20(RULER_H) = 80 → maxScrollY = 50.
    expect(priv(view).scrollY).toBe(50);
  });

  it('paints a full-size dark background rect', () => {
    const { view, ctx } = buildView({ canvasWidth: 800, canvasHeight: 400 });
    view.render();
    expect(ctx.calls.some((c: CtxCall) => c.method === 'set:fillStyle' && c.args[0] === '#1a1a2e')).toBe(true);
    expect(ctx.calls.some((c: CtxCall) => c.method === 'fillRect' && c.args[0] === 0 && c.args[1] === 0 && c.args[2] === 800 && c.args[3] === 400)).toBe(true);
  });

  it('draws exactly 11 ruler ticks at evenly-spaced x positions with matching time labels', () => {
    const { view, ctx, animCtrl } = buildView({ canvasWidth: 1000, canvasHeight: 400 });
    animCtrl.createClip('walk');
    animCtrl.selectClip('walk');
    animCtrl.setDuration(2);
    view.render();

    const texts = ctx.calls.filter((c: CtxCall) => c.method === 'fillText');
    expect(texts).toHaveLength(11);
    expect(texts[0].args).toEqual(['0.00', 2, 13]);
    expect(texts[5].args).toEqual(['1.00', 502, 13]);
    expect(texts[10].args).toEqual(['2.00', 1002, 13]);
  });

  it('falls back to a 0.5s duration ruler when no clip is selected', () => {
    const { view, ctx } = buildView({ canvasWidth: 1000, canvasHeight: 400 });
    view.render();
    const texts = ctx.calls.filter((c: CtxCall) => c.method === 'fillText');
    expect(texts[10].args).toEqual(['0.50', 1002, 13]);
  });

  it('draws one row background per timeline bone when every row fits in view', () => {
    const { view, ctx, rig } = buildView({ canvasWidth: 800, canvasHeight: 400 });
    view.render();
    // Row backgrounds are the only fillRect calls with height === ROW_H (26); the
    // full-canvas background and the playhead marker use different heights.
    const rowFills = ctx.calls.filter((c: CtxCall) => c.method === 'fillRect' && c.args[3] === ROW_H);
    expect(rowFills).toHaveLength(rig.timelineBones.length);
  });

  it('draws a diamond per keyframe bone entry (colour by property type), skipping bones absent from that keyframe', () => {
    const { view, ctx, animCtrl, state } = buildView({ canvasWidth: 800, canvasHeight: 400 });
    animCtrl.createClip('walk');
    animCtrl.selectClip('walk');
    const bones = new Map<string, BoneKeyframe>([
      ['shell', { translateX: 5 }],               // orange (translate)
      ['eye', { scaleX: 2 }],                      // blue (scale)
      ['belly', {}],                                // grey (rotation-only default)
      ['socket_l', { translateX: 1, scaleX: 2 }],   // orange diamond + 1 blue dot
      // socket_r: no entry at all — must not be drawn
    ]);
    animCtrl.addKeyframeAt(0.25, bones);
    // addKeyframeAt auto-selects the new keyframe (state.setSelectedKfTime(t)) — clear
    // that so these diamonds render in their normal (non-highlight) colours below.
    state.setSelectedKfTime(null);
    view.render();

    const fillStyleCount = (color: string) =>
      ctx.calls.filter((c: CtxCall) => c.method === 'set:fillStyle' && c.args[0] === color).length;

    expect(fillStyleCount('#f9e2af')).toBe(2); // shell diamond + socket_l diamond
    expect(fillStyleCount('#89b4fa')).toBe(2); // eye diamond + socket_l's indicator dot
    expect(fillStyleCount('#89899a')).toBe(11 + 1); // 11 ruler ticks + belly's grey diamond
    expect(ctx.calls.filter((c: CtxCall) => c.method === 'arc')).toHaveLength(1); // socket_l's one dot
  });

  it('renders the selected keyframe diamond in the highlight colour and suppresses its indicator dots', () => {
    const { view, ctx, animCtrl, state } = buildView({ canvasWidth: 800, canvasHeight: 400 });
    animCtrl.createClip('walk');
    animCtrl.selectClip('walk');
    animCtrl.addKeyframeAt(0.25, new Map<string, BoneKeyframe>([
      ['socket_l', { translateX: 1, scaleX: 2 }],
    ]));
    state.setSelectedKfTime(0.25);
    view.render();

    const fillStyleCount = (color: string) =>
      ctx.calls.filter((c: CtxCall) => c.method === 'set:fillStyle' && c.args[0] === color).length;

    expect(fillStyleCount('#74c7ec')).toBe(1);
    expect(fillStyleCount('#f9e2af')).toBe(0);
    expect(fillStyleCount('#89b4fa')).toBe(0);
    expect(ctx.calls.filter((c: CtxCall) => c.method === 'arc')).toHaveLength(0);
  });

  it('draws the playhead marker at a position proportional to currentTime/duration', () => {
    const { view, ctx, animCtrl, state } = buildView({ canvasWidth: 1000, canvasHeight: 400 });
    animCtrl.createClip('walk');
    animCtrl.selectClip('walk');
    animCtrl.setDuration(2);
    state.setCurrentTime(1); // halfway
    view.render();

    const marker = ctx.calls.find((c: CtxCall) => c.method === 'fillRect' && c.args[2] === 8 && c.args[3] === RULER_H);
    expect(marker).toBeDefined();
    expect(marker!.args[0]).toBe(500 - 4); // px = 0.5 * 1000
  });

  it('rebuilds the label rows only when labelsDirty, leaving them alone on a dirty-only re-render', () => {
    const { view, labelContainer, bus, rig } = buildView();
    view.render();
    expect(labelContainer.children).toHaveLength(rig.timelineBones.length);

    labelContainer.children = [];
    bus.emit('time:change', 0.1); // dirty only
    view.render();
    expect(labelContainer.children).toHaveLength(0); // renderLabels() was NOT called
  });

  it('label rows show the bone label text and mark only the selected bone active', () => {
    const { view, labelContainer, state, rig } = buildView();
    state.setSelectedBone('eye');
    priv(view).labelsDirty = true;
    priv(view).dirty = true;
    view.render();

    const eyeIdx = rig.timelineBones.indexOf('eye');
    const shellIdx = rig.timelineBones.indexOf('shell');
    expect(labelContainer.children[eyeIdx].className).toContain('active');
    expect(labelContainer.children[shellIdx].className).not.toContain('active');
    expect(labelContainer.children[eyeIdx].innerHTML).toContain('Eye');
  });

  it('clicking a label row selects that row bone', () => {
    const { view, labelContainer, state, rig } = buildView();
    view.render();
    const idx = rig.timelineBones.indexOf('belly');
    labelContainer.children[idx].dispatch('click');
    expect(state.selectedBone).toBe('belly');
  });
});

// ── Private hit-test math (getTimeFromX / getRowFromY / findKfAt) ────────────

describe('TimelineView — getTimeFromX / getRowFromY (private hit-test math)', () => {
  it('maps clientX linearly across [0, duration] and clamps outside the canvas', () => {
    const { view, animCtrl } = buildView({ canvasWidth: 800 });
    animCtrl.createClip('walk');
    animCtrl.selectClip('walk');
    animCtrl.setDuration(4);
    const getTimeFromX = (x: number) => priv(view).getTimeFromX(x);

    expect(getTimeFromX(0)).toBe(0);
    expect(getTimeFromX(400)).toBeCloseTo(2);
    expect(getTimeFromX(800)).toBeCloseTo(4);
    expect(getTimeFromX(-100)).toBe(0);   // clamped to 0
    expect(getTimeFromX(10000)).toBe(4);  // clamped to duration
  });

  it('falls back to a 0.5s duration when no clip is selected', () => {
    const { view } = buildView({ canvasWidth: 100 });
    expect(priv(view).getTimeFromX(50)).toBeCloseTo(0.25);
  });

  it('maps clientY to a timeline row index, accounting for the ruler offset', () => {
    const { view, rig } = buildView({ canvasHeight: 400 });
    const getRowFromY = (y: number) => priv(view).getRowFromY(y);

    expect(getRowFromY(RULER_H)).toEqual({ ri: 0, boneId: rig.timelineBones[0] });
    expect(getRowFromY(RULER_H + ROW_H - 1)).toEqual({ ri: 0, boneId: rig.timelineBones[0] });
    expect(getRowFromY(RULER_H + ROW_H)).toEqual({ ri: 1, boneId: rig.timelineBones[1] });
    expect(getRowFromY(0)).toBeNull(); // inside the ruler, above any row
    expect(getRowFromY(RULER_H + rig.timelineBones.length * ROW_H)).toBeNull(); // below the last row
  });

  it('shifts the row hit-test by the current scroll offset', () => {
    const { view, rig } = buildView({ canvasHeight: 400 });
    priv(view).scrollY = ROW_H; // scrolled down by exactly one row
    expect(priv(view).getRowFromY(RULER_H)).toEqual({ ri: 1, boneId: rig.timelineBones[1] });
  });
});

describe('TimelineView — findKfAt (private hit-test)', () => {
  it('returns the keyframe/bone under the cursor within an 8px x-tolerance', () => {
    const { view, animCtrl, rig } = buildView({ canvasWidth: 800, canvasHeight: 400 });
    animCtrl.createClip('walk');
    animCtrl.selectClip('walk');
    animCtrl.setDuration(1);
    animCtrl.addKeyframeAt(0.5, new Map([['eye', {}]])); // kx = 0.5/1 * 800 = 400
    const findKfAt = (x: number, y: number) => priv(view).findKfAt(x, y);
    const rowY = RULER_H + rig.timelineBones.indexOf('eye') * ROW_H + ROW_H / 2;

    expect(findKfAt(400, rowY)?.boneId).toBe('eye');
    expect(findKfAt(406, rowY)?.boneId).toBe('eye'); // inside the 8px tolerance
    expect(findKfAt(409, rowY)).toBeNull();          // outside the tolerance
  });

  it('ignores clicks in the ruler area', () => {
    const { view, animCtrl } = buildView({ canvasWidth: 800, canvasHeight: 400 });
    animCtrl.createClip('walk');
    animCtrl.selectClip('walk');
    animCtrl.addKeyframeAt(0, new Map([['shell', {}]]));
    expect(priv(view).findKfAt(0, 5)).toBeNull(); // y=5 < RULER_H
  });

  it('returns null with no clip selected, and when the row bone has no entry at any keyframe', () => {
    const { view, animCtrl, rig } = buildView({ canvasWidth: 800, canvasHeight: 400 });
    expect(priv(view).findKfAt(0, RULER_H + 5)).toBeNull(); // no clip at all

    animCtrl.createClip('walk');
    animCtrl.selectClip('walk');
    animCtrl.addKeyframeAt(0.1, new Map([['shell', {}]])); // only shell has an entry
    const eyeRowY = RULER_H + rig.timelineBones.indexOf('eye') * ROW_H + ROW_H / 2;
    expect(priv(view).findKfAt(80, eyeRowY)).toBeNull();
  });
});

// ── Mouse interaction ─────────────────────────────────────────────────────────

describe('TimelineView — mouse interaction (drag keyframe vs scrub)', () => {
  it('mousedown on a keyframe starts a drag and selects that keyframe/bone', () => {
    const { canvasEl, animCtrl, state, rig, view } = buildView({ canvasWidth: 800, canvasHeight: 400 });
    animCtrl.createClip('walk');
    animCtrl.selectClip('walk');
    animCtrl.setDuration(1);
    animCtrl.addKeyframeAt(0.5, new Map([['shell', {}]])); // kx=400
    const rowY = RULER_H + rig.timelineBones.indexOf('shell') * ROW_H + ROW_H / 2;

    canvasEl.dispatch('mousedown', { button: 0, clientX: 400, clientY: rowY });

    expect(priv(view).isDraggingKf).toBe(true);
    expect(priv(view).dragKfTime).toBe(0.5);
    expect(state.selectedKfTime).toBe(0.5);
    expect(state.currentTime).toBe(0.5);
    expect(state.selectedBone).toBe('shell');
  });

  it('mousedown off any keyframe starts scrubbing, selects the row bone, and clears kf selection', () => {
    const { canvasEl, animCtrl, state, rig, view } = buildView({ canvasWidth: 800, canvasHeight: 400 });
    animCtrl.createClip('walk');
    animCtrl.selectClip('walk');
    animCtrl.setDuration(1);
    state.setSelectedKfTime(0.9);
    const rowY = RULER_H + rig.timelineBones.indexOf('belly') * ROW_H + ROW_H / 2;

    canvasEl.dispatch('mousedown', { button: 0, clientX: 200, clientY: rowY });

    expect(priv(view).isScrubbing).toBe(true);
    expect(state.selectedBone).toBe('belly');
    expect(state.currentTime).toBeCloseTo(0.25); // 200/800 * 1s
    expect(state.selectedKfTime).toBeNull();
  });

  it('ignores a non-left-button mousedown', () => {
    const { canvasEl, view } = buildView();
    canvasEl.dispatch('mousedown', { button: 2, clientX: 0, clientY: 0 });
    expect(priv(view).isDraggingKf).toBe(false);
    expect(priv(view).isScrubbing).toBe(false);
  });

  it('dragging a keyframe moves it, tracks the new time, and does not mark labels dirty', () => {
    const { canvasEl, animCtrl, state, view } = buildView({ canvasWidth: 800, canvasHeight: 400 });
    animCtrl.createClip('walk');
    animCtrl.selectClip('walk');
    animCtrl.setDuration(1);
    animCtrl.addKeyframeAt(0.5, new Map([['shell', {}]]));
    priv(view).isDraggingKf = true;
    priv(view).dragKfTime = 0.5;
    priv(view).labelsDirty = true;

    canvasEl.dispatch('mousemove', { clientX: 600, clientY: 0 }); // → t = 0.75

    expect(priv(view).dragKfTime).toBeCloseTo(0.75);
    expect(state.currentTime).toBeCloseTo(0.75);
    expect(priv(view).labelsDirty).toBe(false);
    expect(animCtrl.currentClip!.keyframes).toHaveLength(1);
    expect(animCtrl.currentClip!.keyframes[0].time).toBeCloseTo(0.75);
  });

  it('mousemove does nothing while playing, for both drag and scrub', () => {
    const { canvasEl, animCtrl, state, view } = buildView({ canvasWidth: 800, canvasHeight: 400 });
    animCtrl.createClip('walk');
    animCtrl.selectClip('walk');
    animCtrl.setDuration(1);
    animCtrl.addKeyframeAt(0.5, new Map([['shell', {}]]));
    state.setPlaying(true);
    priv(view).isDraggingKf = true;
    priv(view).dragKfTime = 0.5;
    const before = state.currentTime;

    canvasEl.dispatch('mousemove', { clientX: 600, clientY: 0 });

    expect(state.currentTime).toBe(before);
    expect(animCtrl.currentClip!.keyframes[0].time).toBe(0.5); // unmoved
  });

  it('scrubbing updates currentTime and clears kf selection while moving', () => {
    const { canvasEl, state, view } = buildView({ canvasWidth: 800, canvasHeight: 400 });
    state.setSelectedKfTime(0.3);
    priv(view).isScrubbing = true;

    canvasEl.dispatch('mousemove', { clientX: 400, clientY: 0 });

    expect(state.currentTime).toBeCloseTo(0.25); // no clip → fallback dur 0.5; 400/800*0.5
    expect(state.selectedKfTime).toBeNull();
  });

  it('mouseup clears both drag and scrub flags', () => {
    const { canvasEl, view } = buildView();
    priv(view).isDraggingKf = true;
    priv(view).isScrubbing = true;
    canvasEl.dispatch('mouseup', {});
    expect(priv(view).isDraggingKf).toBe(false);
    expect(priv(view).isScrubbing).toBe(false);
  });

  it('mouseleave cancels an in-progress drag or scrub', () => {
    const { canvasEl, view } = buildView();
    priv(view).isDraggingKf = true;
    priv(view).isScrubbing = true;
    canvasEl.dispatch('mouseleave');
    expect(priv(view).isDraggingKf).toBe(false);
    expect(priv(view).isScrubbing).toBe(false);
  });
});

// ── Scrolling ──────────────────────────────────────────────────────────────────

describe('TimelineView — scrolling', () => {
  it('onWheel prevents default and scrolls by deltaY, clamped to [0, maxScrollY]', () => {
    const { canvasEl, view } = buildView({ canvasHeight: 100 }); // small viewport → real maxScrollY
    const preventDefault = vi.fn();

    canvasEl.dispatch('wheel', { deltaY: 40, preventDefault });
    expect(preventDefault).toHaveBeenCalledTimes(1);
    expect(priv(view).scrollY).toBeGreaterThan(0);

    canvasEl.dispatch('wheel', { deltaY: -100000, preventDefault });
    expect(priv(view).scrollY).toBe(0);

    canvasEl.dispatch('wheel', { deltaY: 100000, preventDefault });
    expect(priv(view).scrollY).toBe(priv(view).maxScrollY);
  });

  const orbCoreBoneCount = new Rig(ORB_CORE_RIG).timelineBones.length;

  it('maxScrollY is 0 once the viewport is tall enough to show every row', () => {
    const { view } = buildView({ canvasHeight: orbCoreBoneCount * ROW_H + RULER_H + 200 });
    expect(priv(view).maxScrollY).toBe(0);
  });

  it('updateScrollbar hides the thumb when content fits, shows it (>=20px) otherwise', () => {
    const { view: fitView, vscrollThumb: fitThumb } = buildView({ canvasHeight: orbCoreBoneCount * ROW_H + RULER_H + 200 });
    fitView.render();
    expect(fitThumb.style.display).toBe('none');

    const { view: scrollView, vscrollThumb: scrollThumb } = buildView({ canvasHeight: 100 });
    scrollView.render();
    expect(scrollThumb.style.display).toBe('');
    expect(parseFloat(scrollThumb.style.height)).toBeGreaterThanOrEqual(20);
  });

  it('applyScroll mirrors scrollY onto the label container', () => {
    const { view, labelContainer } = buildView({ canvasHeight: 100 });
    priv(view).applyScroll(20);
    expect(labelContainer.scrollTop).toBe(priv(view).scrollY);
    expect(priv(view).scrollY).toBe(20);
  });
});

describe('TimelineView — scroll thumb drag / track click', () => {
  it('ignores a non-left-button thumb mousedown', () => {
    const { vscrollThumb, view } = buildView({ canvasHeight: 100 });
    vscrollThumb.dispatch('mousedown', { button: 2, clientY: 0, stopPropagation: vi.fn(), preventDefault: vi.fn() });
    expect(priv(view).isDraggingScroll).toBe(false);
  });

  it('dragging the thumb far down/up clamps scrollY to the max/min, and mouseup ends the drag', () => {
    const { vscrollThumb, view, doc } = buildView({ canvasHeight: 100 });

    vscrollThumb.dispatch('mousedown', { button: 0, clientY: 100, stopPropagation: vi.fn(), preventDefault: vi.fn() });
    expect(priv(view).isDraggingScroll).toBe(true);
    expect(vscrollThumb.classList.contains('dragging')).toBe(true);

    doc.dispatch('mousemove', { clientY: 100000 });
    expect(priv(view).scrollY).toBe(priv(view).maxScrollY);

    doc.dispatch('mousemove', { clientY: -100000 });
    expect(priv(view).scrollY).toBe(0);

    doc.dispatch('mouseup', {});
    expect(priv(view).isDraggingScroll).toBe(false);
    expect(vscrollThumb.classList.contains('dragging')).toBe(false);

    // The document-level listeners were torn down on mouseup — further moves are no-ops.
    priv(view).scrollY = 5;
    doc.dispatch('mousemove', { clientY: 100000 });
    expect(priv(view).scrollY).toBe(5);
  });

  it('clicking the scroll track (not the thumb) jumps scrollY proportionally to click position', () => {
    const { vscrollEl, view } = buildView({ canvasHeight: 100 });
    vscrollEl.clientHeight = 220; // trackH = 200

    vscrollEl.dispatch('mousedown', { target: {}, clientY: RULER_H }); // y=0 → ratio 0
    expect(priv(view).scrollY).toBe(0);

    vscrollEl.dispatch('mousedown', { target: {}, clientY: RULER_H + 200 }); // y=trackH → ratio 1
    expect(priv(view).scrollY).toBe(priv(view).maxScrollY);
  });

  it('clicking directly on the thumb element is a no-op (the thumb-drag listener owns that)', () => {
    const { vscrollEl, vscrollThumb, view } = buildView({ canvasHeight: 100 });
    const before = priv(view).scrollY;
    vscrollEl.dispatch('mousedown', { target: vscrollThumb, clientY: 99999 });
    expect(priv(view).scrollY).toBe(before);
  });
});

// ── Right-click easing/copy/paste/delete menu ────────────────────────────────

describe('TimelineView — onContextMenu', () => {
  it('prevents default but shows no menu when right-clicking off any keyframe', () => {
    const { canvasEl, menuSpy } = buildView({ canvasWidth: 800, canvasHeight: 400 });
    const preventDefault = vi.fn();
    canvasEl.dispatch('contextmenu', { clientX: 0, clientY: 0, preventDefault });
    expect(preventDefault).toHaveBeenCalledTimes(1);
    expect(menuSpy.show).not.toHaveBeenCalled();
  });

  it('builds a 10-item menu: easing separator, 5 easings (checkmark on the current one), separator, copy/paste/delete', () => {
    const { canvasEl, animCtrl, menuSpy, rig } = buildView({ canvasWidth: 800, canvasHeight: 400 });
    animCtrl.createClip('walk');
    animCtrl.selectClip('walk');
    animCtrl.setDuration(1);
    animCtrl.addKeyframeAt(0.5, new Map([['shell', { easing: 'ease-in' }]])); // kx=400
    const rowY = RULER_H + rig.timelineBones.indexOf('shell') * ROW_H + ROW_H / 2;

    canvasEl.dispatch('contextmenu', { clientX: 400, clientY: rowY, preventDefault: vi.fn() });

    expect(menuSpy.show).toHaveBeenCalledTimes(1);
    const [x, y, items] = menuSpy.show.mock.calls[0];
    expect(x).toBe(400);
    expect(y).toBe(rowY);
    expect(items).toHaveLength(10);
    expect(items[0].disabled).toBe(true);
    expect(items[1].label).toBe('  linear');
    expect(items[2].label).toBe('✓ ease-in');
    expect(items[3].label).toBe('  ease-out');
    expect(items[4].label).toBe('  ease-in-out');
    expect(items[5].label).toBe('  step');
    expect(items[6].disabled).toBe(true);
    expect(items[7].label).toBe('Copy keyframe');
    expect(items[8].label).toBe('Paste keyframe');
    expect(items[9].label).toBe('Delete keyframe');
  });

  it('wires Copy/Paste/Delete keyframe menu actions to AnimationController', () => {
    const { canvasEl, animCtrl, menuSpy, rig, state } = buildView({ canvasWidth: 800, canvasHeight: 400 });
    animCtrl.createClip('walk');
    animCtrl.selectClip('walk');
    animCtrl.setDuration(1);
    animCtrl.addKeyframeAt(0.5, new Map([['shell', { translateX: 9 }]]));
    const rowY = RULER_H + rig.timelineBones.indexOf('shell') * ROW_H + ROW_H / 2;
    canvasEl.dispatch('contextmenu', { clientX: 400, clientY: rowY, preventDefault: vi.fn() });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const items: any[] = menuSpy.show.mock.calls[0][2];

    items.find(i => i.label === 'Copy keyframe').action();
    state.setCurrentTime(0.9);
    items.find(i => i.label === 'Paste keyframe').action();
    expect(animCtrl.currentClip!.keyframes).toHaveLength(2);
    expect(animCtrl.currentClip!.keyframes[1].bones.get('shell')?.translateX).toBe(9);

    items.find(i => i.label === 'Delete keyframe').action();
    // Deletes the keyframe AT the right-clicked time (0.5), not the pasted one.
    expect(animCtrl.currentClip!.keyframes.map(k => k.time)).not.toContain(0.5);
    expect(animCtrl.currentClip!.keyframes).toHaveLength(1);
  });

  it('an easing menu item runs an undoable Command that updates the keyframe easing', () => {
    const { canvasEl, animCtrl, cmdManager, menuSpy, rig } = buildView({ canvasWidth: 800, canvasHeight: 400 });
    animCtrl.createClip('walk');
    animCtrl.selectClip('walk');
    animCtrl.setDuration(1);
    animCtrl.addKeyframeAt(0.5, new Map([['shell', { easing: 'linear' }]]));
    const rowY = RULER_H + rig.timelineBones.indexOf('shell') * ROW_H + ROW_H / 2;
    canvasEl.dispatch('contextmenu', { clientX: 400, clientY: rowY, preventDefault: vi.fn() });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const items: any[] = menuSpy.show.mock.calls[0][2];

    items.find(i => i.label === '  step').action();
    expect(animCtrl.currentClip!.keyframes[0].bones.get('shell')?.easing).toBe('step');

    cmdManager.undo();
    expect(animCtrl.currentClip!.keyframes[0].bones.get('shell')?.easing).toBe('linear');
  });
});

// ── destroy() ──────────────────────────────────────────────────────────────────

describe('TimelineView — destroy()', () => {
  it('delegates to the context menu', () => {
    const { view, menuSpy } = buildView();
    view.destroy();
    expect(menuSpy.destroy).toHaveBeenCalledTimes(1);
  });
});
