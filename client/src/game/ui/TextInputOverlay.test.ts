/**
 * TextInputOverlay (design/05/15's party join-code field, design/16-accounts.md's
 * login/password fields). This project has no jsdom/happy-dom environment configured
 * (plain vitest — see net/transport.test.ts's own `FakeWebSocket` for the same
 * convention), so `document` is faked here with just the small, fixed surface this
 * class actually touches: `createElement`, `body.appendChild`, and an element with
 * `addEventListener`/`focus`/`remove`/`style`/`value`.
 *
 * The FakeInput's `remove()` deliberately mirrors a REAL browser's behavior of firing a
 * synchronous 'blur' event when a focused element is removed from the DOM — that's the
 * exact mechanic the blur-teardown fix below has to guard against re-triggering itself
 * (Enter/Escape/`close()` must not ALSO fire a duplicate `onCancel` via their own
 * `.remove()` call's synthetic blur).
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { TextInputOverlay } from './TextInputOverlay';

type Listener = (e: unknown) => void;

class FakeInput {
  type = '';
  placeholder = '';
  maxLength = 0;
  autocapitalize = '';
  autocomplete = '';
  spellcheck = false;
  style: Record<string, string> = {};
  value = '';
  focused = false;
  removed = false;
  private readonly listeners: Record<string, Listener[]> = {};

  addEventListener(type: string, fn: Listener): void {
    (this.listeners[type] ??= []).push(fn);
  }
  focus(): void {
    this.focused = true;
  }
  remove(): void {
    this.removed = true;
    // Real browsers fire a synchronous 'blur' when a focused element leaves the DOM.
    if (this.focused) {
      this.focused = false;
      this.fire('blur', {});
    }
  }
  fire(type: string, ev: unknown): void {
    for (const fn of [...(this.listeners[type] ?? [])]) fn(ev);
  }
  keydown(key: string): void {
    this.fire('keydown', { key, stopPropagation: () => {} });
  }
}

function stubDom(): { appended: FakeInput[] } {
  const appended: FakeInput[] = [];
  vi.stubGlobal('document', {
    createElement: () => new FakeInput(),
    body: { appendChild: (el: FakeInput) => appended.push(el) },
  });
  return { appended };
}

afterEach(() => vi.unstubAllGlobals());

describe('TextInputOverlay — submit / cancel (existing behavior, unaffected by the blur fix)', () => {
  it('Enter submits the typed value and closes, without a duplicate onCancel from remove()\'s own blur', () => {
    const { appended } = stubDom();
    const overlay = new TextInputOverlay();
    const onSubmit = vi.fn();
    const onCancel = vi.fn();
    overlay.open({ onSubmit, onCancel });
    const el = appended[0]!;
    el.value = 'ABCDE';
    el.keydown('Enter');

    expect(onSubmit).toHaveBeenCalledWith('ABCDE');
    expect(onCancel).not.toHaveBeenCalled();
    expect(overlay.isOpen).toBe(false);
    expect(el.removed).toBe(true);
  });

  it('Escape cancels and closes, without a duplicate onCancel from remove()\'s own blur', () => {
    const { appended } = stubDom();
    const overlay = new TextInputOverlay();
    const onSubmit = vi.fn();
    const onCancel = vi.fn();
    overlay.open({ onSubmit, onCancel });
    appended[0]!.keydown('Escape');

    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(onSubmit).not.toHaveBeenCalled();
    expect(overlay.isOpen).toBe(false);
  });
});

describe('TextInputOverlay — blur teardown (previously documented but not implemented)', () => {
  it('a genuine external blur (e.g. tapping a Pixi button underneath) closes the overlay and fires onCancel', () => {
    const { appended } = stubDom();
    const overlay = new TextInputOverlay();
    const onSubmit = vi.fn();
    const onCancel = vi.fn();
    overlay.open({ onSubmit, onCancel });
    const el = appended[0]!;
    el.focused = true; // open() already focused it; explicit for clarity

    el.fire('blur', {}); // simulates the browser blurring it as focus moves elsewhere

    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(onSubmit).not.toHaveBeenCalled();
    expect(overlay.isOpen).toBe(false);
    expect(el.removed).toBe(true);
  });

  it('never submits the typed value on blur — only a real Enter does', () => {
    const { appended } = stubDom();
    const overlay = new TextInputOverlay();
    const onSubmit = vi.fn();
    overlay.open({ onSubmit });
    const el = appended[0]!;
    el.value = 'partial';
    el.fire('blur', {});
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('close() called explicitly by a caller does not double-fire onCancel via its own blur', () => {
    const { appended } = stubDom();
    const overlay = new TextInputOverlay();
    const onCancel = vi.fn();
    overlay.open({ onSubmit: vi.fn(), onCancel });
    overlay.close();
    expect(onCancel).not.toHaveBeenCalled(); // close() is a plain teardown, not itself a "cancel"
    expect(appended[0]!.removed).toBe(true);
  });

  it('a blur firing AFTER the overlay was already closed some other way is inert (no crash, no second onCancel)', () => {
    const { appended } = stubDom();
    const overlay = new TextInputOverlay();
    const onCancel = vi.fn();
    overlay.open({ onSubmit: vi.fn(), onCancel });
    const el = appended[0]!;
    overlay.close();
    expect(() => el.fire('blur', {})).not.toThrow();
    expect(onCancel).not.toHaveBeenCalled();
  });

  it('opening a second overlay while one is already open tears down the first without its stale blur firing onCancel on the new one', () => {
    const { appended } = stubDom();
    const overlay = new TextInputOverlay();
    const onCancel1 = vi.fn();
    const onCancel2 = vi.fn();
    overlay.open({ onSubmit: vi.fn(), onCancel: onCancel1 });
    overlay.open({ onSubmit: vi.fn(), onCancel: onCancel2 }); // open() itself calls close() first
    expect(onCancel1).not.toHaveBeenCalled();
    expect(onCancel2).not.toHaveBeenCalled();
    expect(appended).toHaveLength(2);
    expect(appended[0]!.removed).toBe(true);
  });
});
