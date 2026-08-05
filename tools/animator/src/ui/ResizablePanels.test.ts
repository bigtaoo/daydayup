import { describe, it, expect, vi, afterEach } from 'vitest';
import { FakeElement, installFakeDocument } from './fakeDom';
import { ResizablePanels } from './ResizablePanels';

afterEach(() => vi.unstubAllGlobals());

/** Builds the 5-panel layout ResizablePanels expects: main > left-panel,
 *  canvas-wrap, right-panel[, atlas-panel] + a sibling timeline. `withAtlas`
 *  controls whether the optional right|atlas splitter should exist at all. */
function build(withAtlas: boolean) {
  installFakeDocument();

  const root = new FakeElement('div');
  const main = new FakeElement('div'); main.className = 'main';
  const left = new FakeElement('div'); left.className = 'left-panel';
  const canvasWrap = new FakeElement('div'); canvasWrap.id = 'canvas-wrap';
  const right = new FakeElement('div'); right.className = 'right-panel';
  const timeline = new FakeElement('div'); timeline.className = 'timeline';

  main.append(left, canvasWrap, right);
  root.append(main, timeline);

  let atlas: FakeElement | null = null;
  if (withAtlas) {
    atlas = new FakeElement('div');
    atlas.id = 'atlas-panel';
    main.appendChild(atlas);
  }

  left.style.width = '';
  right.style.width = '';
  if (atlas) atlas.style.width = '';
  timeline.style.height = '';

  Object.defineProperty(left, 'offsetWidth', { value: 200, configurable: true });
  Object.defineProperty(right, 'offsetWidth', { value: 150, configurable: true });
  if (atlas) Object.defineProperty(atlas, 'offsetWidth', { value: 100, configurable: true });
  Object.defineProperty(timeline, 'offsetHeight', { value: 120, configurable: true });

  const rp = new ResizablePanels(root as unknown as HTMLElement);
  return { rp, root, main, left, canvasWrap, right, atlas, timeline };
}

function dragHandles(main: FakeElement): FakeElement[] {
  return main.children.filter(c => c.hasClass('resize-handle'));
}

describe('ResizablePanels', () => {
  it('inserts a vertical handle before canvas-wrap and before right-panel', () => {
    const { main, canvasWrap, right } = build(false);
    const handles = dragHandles(main);
    expect(handles).toHaveLength(2);
    expect(main.children.indexOf(handles[0])).toBe(main.children.indexOf(canvasWrap) - 1);
    expect(main.children.indexOf(handles[1])).toBe(main.children.indexOf(right) - 1);
    handles.forEach(h => expect(h.hasClass('resize-handle-v')).toBe(true));
  });

  it('adds a third vertical handle (right|atlas) only when an atlas panel exists', () => {
    const { main, atlas } = build(true);
    const handles = dragHandles(main);
    expect(handles).toHaveLength(3);
    expect(main.children.indexOf(handles[2])).toBe(main.children.indexOf(atlas!) - 1);
  });

  it('dragging the right|atlas handle resizes both panels in tandem, rejecting the move if either would dip below 80px', () => {
    const { main, right, atlas } = build(true);
    const atlasHandle = dragHandles(main)[2];

    atlasHandle.fire('mousedown', { clientX: 500, preventDefault: vi.fn() });
    (document as unknown as { fire(e: string, ev: unknown): void }).fire('mousemove', { clientX: 460 });
    // delta = -40: right (150) + delta = 110, atlas (100) - delta = 140 — both ≥ 80, both applied.
    expect(right.style.width).toBe('110px');
    expect(atlas!.style.width).toBe('140px');

    (document as unknown as { fire(e: string, ev: unknown): void }).fire('mousemove', { clientX: 700 });
    // Next delta = 700-460 = 240: right dips to -130 — whole move rejected, neither style changes.
    expect(right.style.width).toBe('110px');
    expect(atlas!.style.width).toBe('140px');
  });

  it('inserts a horizontal handle before the timeline, at the root level', () => {
    const { root, timeline } = build(false);
    const handles = root.children.filter(c => c.hasClass('resize-handle-h'));
    expect(handles).toHaveLength(1);
    expect(root.children.indexOf(handles[0])).toBe(root.children.indexOf(timeline) - 1);
  });

  it('dragging the left|canvas handle grows/shrinks the left panel width, clamped at the 80px minimum', () => {
    const { main, canvasWrap, left } = build(false);
    const handle = main.children[main.children.indexOf(canvasWrap) - 1];

    handle.fire('mousedown', { clientX: 300, preventDefault: vi.fn() });
    expect(handle.hasClass('dragging')).toBe(true);

    (document as unknown as { fire(e: string, ev: unknown): void }).fire('mousemove', { clientX: 340 });
    expect(left.style.width).toBe('240px'); // 200 + (340-300)

    // A move that would push width below MIN (80) is rejected outright — style unchanged.
    (document as unknown as { fire(e: string, ev: unknown): void }).fire('mousemove', { clientX: -500 });
    expect(left.style.width).toBe('240px');

    (document as unknown as { fire(e: string, ev: unknown): void }).fire('mouseup', {});
    expect(handle.hasClass('dragging')).toBe(false);
  });

  it('dragging the canvas|right handle shrinks/grows the right panel inversely with the cursor delta', () => {
    const { main, right } = build(false);
    const rightHandle = dragHandles(main)[1];

    rightHandle.fire('mousedown', { clientX: 500, preventDefault: vi.fn() });
    (document as unknown as { fire(e: string, ev: unknown): void }).fire('mousemove', { clientX: 460 });
    // right.offsetWidth(150) - delta(460-500=-40) = 190
    expect(right.style.width).toBe('190px');
  });

  it('dragging the horizontal handle resizes the timeline height, clamped at the 60px minimum', () => {
    const { root, timeline } = build(false);
    const handle = root.children.find(c => c.hasClass('resize-handle-h'))!;

    handle.fire('mousedown', { clientY: 400, preventDefault: vi.fn() });
    expect(document.body.style.cursor).toBe('row-resize');

    (document as unknown as { fire(e: string, ev: unknown): void }).fire('mousemove', { clientY: 380 });
    // timeline.offsetHeight(120) - delta(380-400=-20) = 140
    expect(timeline.style.height).toBe('140px');

    (document as unknown as { fire(e: string, ev: unknown): void }).fire('mouseup', {});
    expect(document.body.style.cursor).toBe('');
    expect(document.body.style.userSelect).toBe('');
  });

  it('sets col-resize cursor while dragging a vertical handle', () => {
    const { main, canvasWrap } = build(false);
    const handle = main.children[main.children.indexOf(canvasWrap) - 1];

    handle.fire('mousedown', { clientX: 0, preventDefault: vi.fn() });
    expect(document.body.style.cursor).toBe('col-resize');
    expect(document.body.style.userSelect).toBe('none');
  });
});
