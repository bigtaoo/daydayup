// Shared minimal DOM stub for the UI panel tests (ImagePanel / AnimListPanel /
// ProjectPanel / ToolbarPanel / ResizablePanels / ErrorToast) — this repo has no
// jsdom/happy-dom (see IOController.test.ts's own fakeElement()+vi.stubGlobal
// pattern, which this extends), so these createElement/appendChild+addEventListener
// -built panels need a fake `document` with just enough of a real tree to support
// getElementById, querySelector('#id'|'.class'|TAG) and querySelectorAll, scoped to
// a specific element (not full CSS selector support — no combinators, no live
// NodeLists, textContent doesn't serialize child element text).
//
// Extend only if a new test actually needs more of the platform surface.

import { vi } from 'vitest';

type Listener = (e?: unknown) => void;

export class FakeElement {
  tagName: string;
  id = '';
  style: Record<string, string> = {};
  children: FakeElement[] = [];
  parent: FakeElement | null = null;

  // Form-control-ish surface used by these panels.
  type = '';
  accept = '';
  multiple = false;
  value = '';
  checked = false;
  disabled = false;
  selected = false;
  title = '';
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  files: any[] | null = null;
  dataset: Record<string, string> = {};

  readonly click = vi.fn(() => this.fire('click'));

  private text = '';
  private innerHtml = '';
  private classSet = new Set<string>();
  private listeners = new Map<string, Listener[]>();

  constructor(tag: string) {
    this.tagName = tag.toUpperCase();
  }

  get textContent(): string { return this.text; }
  set textContent(v: string) { this.text = v; this.children = []; }

  // Kept in sync with classList (real DOM's className/classList share one backing
  // set) — code in this codebase sets one or the other depending on the call site.
  get className(): string { return [...this.classSet].join(' '); }
  set className(v: string) {
    this.classSet.clear();
    v.split(/\s+/).filter(Boolean).forEach(c => this.classSet.add(c));
  }

  // Write-only, matching map-editor's fakeDom convention: nothing in this
  // codebase reads innerHTML back or expects it to be queryable as children.
  set innerHTML(v: string) { this.innerHtml = v; this.children = []; }
  get innerHTML(): string { return this.innerHtml; }

  get firstChild(): FakeElement | null { return this.children[0] ?? null; }

  get nextSibling(): FakeElement | null {
    if (!this.parent) return null;
    const idx = this.parent.children.indexOf(this);
    return this.parent.children[idx + 1] ?? null;
  }

  get classList() {
    const set = this.classSet;
    return {
      add:    (...cs: string[]) => cs.forEach(c => set.add(c)),
      remove: (...cs: string[]) => cs.forEach(c => set.delete(c)),
      toggle: (c: string, force?: boolean): boolean => {
        const on = force !== undefined ? force : !set.has(c);
        if (on) set.add(c); else set.delete(c);
        return on;
      },
      contains: (c: string) => set.has(c),
    };
  }
  /** Test-only helper — real classList has no such accessor. */
  hasClass(c: string): boolean { return this.classSet.has(c); }

  appendChild(child: FakeElement): FakeElement {
    child.parent = this;
    this.children.push(child);
    return child;
  }
  append(...nodes: FakeElement[]): void { nodes.forEach(n => this.appendChild(n)); }

  insertBefore(newNode: FakeElement, ref: FakeElement | null): FakeElement {
    newNode.parent = this;
    const idx = ref ? this.children.indexOf(ref) : -1;
    if (idx === -1) this.children.push(newNode);
    else this.children.splice(idx, 0, newNode);
    return newNode;
  }

  insertAdjacentElement(position: 'beforebegin' | 'afterbegin' | 'beforeend' | 'afterend', el: FakeElement): void {
    if (position === 'afterbegin') { el.parent = this; this.children.unshift(el); return; }
    if (position === 'beforeend')  { this.appendChild(el); return; }
    if (!this.parent) return; // no-op when unattached — matches real DOM's silent failure well enough here
    const idx = this.parent.children.indexOf(this);
    el.parent = this.parent;
    this.parent.children.splice(position === 'afterend' ? idx + 1 : idx, 0, el);
  }

  remove(): void {
    if (!this.parent) return;
    const idx = this.parent.children.indexOf(this);
    if (idx !== -1) this.parent.children.splice(idx, 1);
    this.parent = null;
  }

  addEventListener(event: string, cb: Listener): void {
    const arr = this.listeners.get(event) ?? [];
    arr.push(cb);
    this.listeners.set(event, arr);
  }
  removeEventListener(event: string, cb: Listener): void {
    const arr = this.listeners.get(event);
    if (arr) this.listeners.set(event, arr.filter(f => f !== cb));
  }
  /** Test-only helper — fires every listener registered for `event`. */
  fire(event: string, e: unknown = {}): void {
    (this.listeners.get(event) ?? []).forEach(cb => cb(e));
  }

  querySelector(selector: string): FakeElement | null {
    return findOne(this, selector);
  }
  querySelectorAll(selector: string): FakeElement[] {
    return findAll(this, selector);
  }
}

function matches(el: FakeElement, selector: string): boolean {
  if (selector.startsWith('#')) return el.id === selector.slice(1);
  if (selector.startsWith('.')) return el.hasClass(selector.slice(1));
  return el.tagName === selector.toUpperCase();
}

function findOne(root: FakeElement, selector: string): FakeElement | null {
  for (const child of root.children) {
    if (matches(child, selector)) return child;
    const found = findOne(child, selector);
    if (found) return found;
  }
  return null;
}

function findAll(root: FakeElement, selector: string): FakeElement[] {
  const out: FakeElement[] = [];
  for (const child of root.children) {
    if (matches(child, selector)) out.push(child);
    out.push(...findAll(child, selector));
  }
  return out;
}

/** A fake `document` — pass a `{id: FakeElement}` registry for getElementById
 *  lookups (elements the panel assumes already exist in the page's static HTML,
 *  as opposed to ones it builds itself via createElement). */
export function fakeDocument(registry: Record<string, FakeElement> = {}) {
  const body = new FakeElement('body');
  // Document-level event registration (ResizablePanels attaches its drag
  // mousemove/mouseup handlers to `document`, not to any specific element) —
  // delegate to a throwaway FakeElement purely for its listener bookkeeping.
  const eventHost = new FakeElement('document');
  return {
    body,
    createElement:       (tag: string) => new FakeElement(tag),
    getElementById:       (id: string) => registry[id] ?? null,
    addEventListener:    eventHost.addEventListener.bind(eventHost),
    removeEventListener: eventHost.removeEventListener.bind(eventHost),
    /** Test-only helper — fires every listener registered via addEventListener. */
    fire:                eventHost.fire.bind(eventHost),
    visibilityState: 'visible',
    activeElement: null,
  };
}

/** Stubs `document` for the duration of the test. Callers must
 *  `vi.unstubAllGlobals()` in `afterEach`. */
export function installFakeDocument(registry: Record<string, FakeElement> = {}): ReturnType<typeof fakeDocument> {
  const doc = fakeDocument(registry);
  vi.stubGlobal('document', doc);
  return doc;
}
