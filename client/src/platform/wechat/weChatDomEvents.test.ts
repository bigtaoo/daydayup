/**
 * installWeChatEventBridge — the WeChat canvas -> Pixi EventSystem bridge (see that
 * file's doc comment for WHY this exists: the wx canvas has no real DOM event API, so
 * without this every menu/HUD Button/Slider is silently unclickable on WeChat). Fakes
 * all three targets Pixi's EventSystem actually registers on (canvas/globalThis/
 * document) as plain objects passed in explicitly — NOT `vi.stubGlobal('document', ...)`
 * — so a patch here can never leak into another test in this file via the real jsdom
 * globals.
 */
import { describe, it, expect, vi } from 'vitest';
import { installWeChatEventBridge } from './weChatDomEvents';

function fakeTarget() {
  const handlers: Record<string, ((evt: unknown) => void)[]> = {};
  return {
    handlers,
    addEventListener(type: string, fn: (evt: unknown) => void) {
      (handlers[type] ??= []).push(fn);
    },
    removeEventListener(type: string, fn: (evt: unknown) => void) {
      handlers[type] = (handlers[type] ?? []).filter((h) => h !== fn);
    },
  };
}

describe('installWeChatEventBridge', () => {
  it('captures a listener registered on the canvas and fires it on dispatch', () => {
    const canvas = fakeTarget();
    const bridge = installWeChatEventBridge(canvas, fakeTarget(), fakeTarget());
    const seen: unknown[] = [];
    canvas.addEventListener('mousedown', (e) => seen.push(e));

    bridge.dispatch('mousedown', 10, 20);

    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ type: 'mousedown', clientX: 10, clientY: 20, target: canvas });
  });

  it('taps globalTarget for mouseup and docTarget for mousemove — the two Pixi does NOT register on the canvas', () => {
    const canvas = fakeTarget();
    const globalTarget = fakeTarget();
    const docTarget = fakeTarget();
    const bridge = installWeChatEventBridge(canvas, globalTarget, docTarget);

    const seenUp: unknown[] = [];
    const seenMove: unknown[] = [];
    globalTarget.addEventListener('mouseup', (e) => seenUp.push(e));
    docTarget.addEventListener('mousemove', (e) => seenMove.push(e));

    bridge.dispatch('mouseup', 1, 2);
    bridge.dispatch('mousemove', 3, 4);

    expect(seenUp).toHaveLength(1);
    expect(seenMove).toHaveLength(1);
  });

  it('still forwards to the original addEventListener so a real caller on that global is unaffected', () => {
    const canvas = fakeTarget();
    const globalTarget = fakeTarget();
    installWeChatEventBridge(canvas, globalTarget, fakeTarget());

    const original = vi.fn();
    globalTarget.addEventListener('mouseup', original);

    expect(globalTarget.handlers.mouseup).toContain(original);
  });

  it('the synthetic event has a no-op preventDefault (EventSystem calls it unconditionally)', () => {
    const canvas = fakeTarget();
    const bridge = installWeChatEventBridge(canvas, fakeTarget(), fakeTarget());
    let captured: { preventDefault: () => void } | null = null;
    canvas.addEventListener('mousedown', (e) => { captured = e as { preventDefault: () => void }; });

    bridge.dispatch('mousedown', 0, 0);

    expect(() => captured!.preventDefault()).not.toThrow();
  });

  it('dispatch is a no-op (not a throw) when nothing ever registered for that type', () => {
    const bridge = installWeChatEventBridge(fakeTarget(), fakeTarget(), fakeTarget());
    expect(() => bridge.dispatch('mouseup', 5, 5)).not.toThrow();
  });

  it('removeEventListener stops a handler from receiving further dispatches', () => {
    const canvas = fakeTarget();
    const bridge = installWeChatEventBridge(canvas, fakeTarget(), fakeTarget());
    const seen: unknown[] = [];
    const handler = (e: unknown) => seen.push(e);
    canvas.addEventListener('mousedown', handler);
    canvas.removeEventListener('mousedown', handler);

    bridge.dispatch('mousedown', 0, 0);

    expect(seen).toHaveLength(0);
  });

  it('tolerates a globalTarget/docTarget with no addEventListener at all (best-effort, never throws)', () => {
    const canvas = fakeTarget();
    expect(() => installWeChatEventBridge(canvas, {}, null)).not.toThrow();
  });

  it('defaults globalTarget/docTarget to the real globalThis/document when omitted', () => {
    // This workspace's tests run in plain Node (WeChatInput.test.ts's own doc comment),
    // where `globalThis`/`document` have no addEventListener at all — so this exercises
    // the SAME "no addEventListener on the target" path as the tolerance test above,
    // just via the real defaults rather than an explicit `{}`/`null`. It can't leak
    // state into another test either way: with no addEventListener, `tap()` never
    // mutates anything.
    const canvas = fakeTarget();
    expect(() => installWeChatEventBridge(canvas)).not.toThrow();
  });
});
