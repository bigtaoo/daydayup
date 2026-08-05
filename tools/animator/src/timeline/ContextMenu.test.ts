import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ContextMenu, type MenuItem } from './ContextMenu';

// ContextMenu is built entirely via document.createElement/appendChild (never
// innerHTML-then-query), so a minimal fake element — style/children/listeners —
// is enough; no jsdom needed. Same convention as IOController.test.ts's
// inline fakeElement().

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function fakeElement(tag = 'div'): any {
  const listeners = new Map<string, Array<(e: unknown) => void>>();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const el: any = {
    tagName: tag,
    style: { cssText: '' },
    disabled: false,
    textContent: '',
    remove: vi.fn(),
    getBoundingClientRect: () => ({ left: 0, top: 0, right: 0, bottom: 0, width: 180, height: 90 }),
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
  let html = '';
  Object.defineProperty(el, 'innerHTML', {
    get: () => html,
    // Rough real-DOM emulation: replacing innerHTML detaches any existing children.
    set: (v: string) => { html = v; el.children = []; },
  });
  return el;
}

function fakeDocument() {
  const listeners = new Map<string, Array<(e: unknown) => void>>();
  return {
    body: { appendChild: vi.fn() },
    createElement: (tag: string) => fakeElement(tag),
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
function priv(menu: ContextMenu): any {
  return menu;
}

describe('ContextMenu', () => {
  let doc: ReturnType<typeof fakeDocument>;

  beforeEach(() => {
    doc = fakeDocument();
    vi.stubGlobal('document', doc);
    vi.stubGlobal('window', { innerWidth: 1024, innerHeight: 768 });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('creates a fixed-position hidden div and appends it to document.body on construction', () => {
    const menu = new ContextMenu();
    const el = priv(menu).el;
    expect(doc.body.appendChild).toHaveBeenCalledWith(el);
    expect(el.style.cssText).toContain('position:fixed');
    expect(el.style.cssText).toContain('display:none');
  });

  it('show() renders one button per item with the right label and disabled state', () => {
    const menu = new ContextMenu();
    const items: MenuItem[] = [
      { label: 'A', action: vi.fn() },
      { label: '--- separator ---', disabled: true, action: () => {} },
    ];
    menu.show(10, 10, items);
    const el = priv(menu).el;
    expect(el.children).toHaveLength(2);
    expect(el.children[0].textContent).toBe('A');
    expect(el.children[0].disabled).toBe(false);
    expect(el.children[1].textContent).toBe('--- separator ---');
    expect(el.children[1].disabled).toBe(true);
    expect(el.style.display).toBe('block');
  });

  it('show() clears any previously rendered items before rendering the new set', () => {
    const menu = new ContextMenu();
    menu.show(0, 0, [{ label: 'first', action: () => {} }]);
    menu.show(0, 0, [{ label: 'second-a', action: () => {} }, { label: 'second-b', action: () => {} }]);
    const el = priv(menu).el;
    expect(el.children).toHaveLength(2);
    expect(el.children.map((c: { textContent: string }) => c.textContent)).toEqual(['second-a', 'second-b']);
  });

  it('clicking an enabled item runs its action and hides the menu', () => {
    const menu = new ContextMenu();
    const action = vi.fn();
    menu.show(0, 0, [{ label: 'Go', action }]);
    const el = priv(menu).el;
    el.children[0].dispatch('click', {});
    expect(action).toHaveBeenCalledTimes(1);
    expect(el.style.display).toBe('none');
  });

  it('clicking a disabled item does nothing and leaves the menu open', () => {
    const menu = new ContextMenu();
    const action = vi.fn();
    menu.show(0, 0, [{ label: 'Nope', disabled: true, action }]);
    const el = priv(menu).el;
    el.children[0].dispatch('click', {});
    expect(action).not.toHaveBeenCalled();
    expect(el.style.display).toBe('block');
  });

  it('positions the menu at (x, y) when it fits within the viewport', () => {
    const menu = new ContextMenu();
    menu.show(50, 60, [{ label: 'A', action: () => {} }]);
    const el = priv(menu).el;
    // fakeElement's getBoundingClientRect is fixed at 180x90 — comfortably inside 1024x768.
    expect(el.style.left).toBe('50px');
    expect(el.style.top).toBe('60px');
  });

  it('clamps the menu position so it never overflows the right/bottom viewport edge', () => {
    vi.stubGlobal('window', { innerWidth: 200, innerHeight: 100 });
    const menu = new ContextMenu();
    // rect is 180x90 (fakeElement default); ask to open far outside a tiny viewport
    // so the Math.min clamp kicks in on both axes.
    menu.show(190, 95, [{ label: 'A', action: () => {} }]);
    const el = priv(menu).el;
    expect(el.style.left).toBe(`${200 - 180 - 4}px`);
    expect(el.style.top).toBe(`${100 - 90 - 4}px`);
  });

  it('hide() sets display to none', () => {
    const menu = new ContextMenu();
    menu.show(0, 0, [{ label: 'A', action: () => {} }]);
    menu.hide();
    expect(priv(menu).el.style.display).toBe('none');
  });

  it('a mousedown outside the menu hides it', () => {
    const menu = new ContextMenu();
    menu.show(0, 0, [{ label: 'A', action: () => {} }]);
    doc.dispatch('mousedown', { target: {} });
    expect(priv(menu).el.style.display).toBe('none');
  });

  it('a mousedown inside the menu leaves it open', () => {
    const menu = new ContextMenu();
    menu.show(0, 0, [{ label: 'A', action: () => {} }]);
    const el = priv(menu).el;
    doc.dispatch('mousedown', { target: el.children[0] });
    expect(el.style.display).toBe('block');
  });

  it('pressing Escape hides the menu', () => {
    const menu = new ContextMenu();
    menu.show(0, 0, [{ label: 'A', action: () => {} }]);
    doc.dispatch('keydown', { key: 'Escape' });
    expect(priv(menu).el.style.display).toBe('none');
  });

  it('a non-Escape key does nothing', () => {
    const menu = new ContextMenu();
    menu.show(0, 0, [{ label: 'A', action: () => {} }]);
    doc.dispatch('keydown', { key: 'Enter' });
    expect(priv(menu).el.style.display).toBe('block');
  });

  it('destroy() removes the element and stops responding to document mousedown/keydown', () => {
    const menu = new ContextMenu();
    const el = priv(menu).el;
    menu.destroy();
    expect(el.remove).toHaveBeenCalledTimes(1);

    el.style.display = 'block';
    doc.dispatch('mousedown', { target: {} });
    doc.dispatch('keydown', { key: 'Escape' });
    expect(el.style.display).toBe('block'); // listeners were removed — no change
  });
});
