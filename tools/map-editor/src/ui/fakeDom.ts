// Shared minimal DOM stub for fields.ts / EncounterTable.ts / Inspector.ts tests.
//
// This repo has no jsdom/happy-dom (see DocumentIO.test.ts, tools/animator's
// IOController.test.ts) — `document` is genuinely undefined at runtime under plain
// vitest, so these three modules (all built purely via `el()`/`document.createElement`
// + `appendChild`, no innerHTML-then-query) need a fake `document.createElement` that
// records just the surface they actually touch: tagName, className, style (plain
// object), type/step/min, value/checked/selected, textContent, innerHTML (write-only —
// EncounterTable sets a <thead> header this way but never reads it back),
// appendChild/insertBefore/firstChild, classList.add, and onchange/onclick.
//
// Not a real DOM — e.g. textContent doesn't serialize child element text, appendChild
// doesn't set parentNode. Extend only if a new test actually needs it.

import { vi } from 'vitest';

export class FakeElement {
  tagName: string;
  className = '';
  style: Record<string, string> = {};
  children: FakeElement[] = [];
  type = '';
  step = '';
  min = '';
  value = '';
  checked = false;
  selected = false;
  onchange: (() => void) | null = null;
  onclick: (() => void) | null = null;
  private text = '';
  private classSet = new Set<string>();

  constructor(tag: string) {
    this.tagName = tag.toUpperCase();
  }

  get textContent(): string {
    return this.text;
  }
  set textContent(v: string) {
    this.text = v;
    this.children = [];
  }

  // Write-only: EncounterTable sets thead.innerHTML for a static header row and
  // never reads it back or expects it to be queryable as children.
  set innerHTML(_v: string) {
    this.children = [];
  }
  get innerHTML(): string {
    return '';
  }

  get firstChild(): FakeElement | null {
    return this.children[0] ?? null;
  }

  get classList() {
    const set = this.classSet;
    return {
      add: (c: string) => set.add(c),
      remove: (c: string) => set.delete(c),
      contains: (c: string) => set.has(c),
    };
  }

  /** Test-only helper — real classList has no such accessor. */
  hasClass(c: string): boolean {
    return this.classSet.has(c);
  }

  appendChild(child: FakeElement): FakeElement {
    this.children.push(child);
    return child;
  }

  insertBefore(newNode: FakeElement, ref: FakeElement | null): FakeElement {
    const idx = ref ? this.children.indexOf(ref) : -1;
    if (idx === -1) this.children.push(newNode);
    else this.children.splice(idx, 0, newNode);
    return newNode;
  }
}

export function fakeDocument() {
  return {
    createElement: (tag: string) => new FakeElement(tag),
    createTextNode: (text: string) => ({ nodeType: 3, textContent: text }),
  };
}

/** Stubs `document` (and, since Inspector uses the bare global, `confirm`) for the
 * duration of the test. Callers must `vi.unstubAllGlobals()` in `afterEach`. */
export function installFakeDom(confirmReturn = true): { confirmMock: ReturnType<typeof vi.fn> } {
  vi.stubGlobal('document', fakeDocument());
  const confirmMock = vi.fn().mockReturnValue(confirmReturn);
  vi.stubGlobal('confirm', confirmMock);
  return { confirmMock };
}

/** Recursively finds all descendants of a given tag (case-insensitive), depth-first.
 * Skips non-element children (e.g. the plain objects `createTextNode` returns —
 * checkboxField appends one of those as a label's second child) rather than
 * recursing into them, since they have no `.children` array of their own. */
export function findAllByTag(root: FakeElement, tag: string): FakeElement[] {
  const wanted = tag.toUpperCase();
  const out: FakeElement[] = [];
  for (const child of root.children) {
    if (!(child instanceof FakeElement)) continue;
    if (child.tagName === wanted) out.push(child);
    out.push(...findAllByTag(child, tag));
  }
  return out;
}

/** Recursively finds all descendants with a given className token, depth-first. */
export function findAllByClass(root: FakeElement, cls: string): FakeElement[] {
  const out: FakeElement[] = [];
  for (const child of root.children) {
    if (!(child instanceof FakeElement)) continue;
    if (child.className.split(' ').includes(cls)) out.push(child);
    out.push(...findAllByClass(child, cls));
  }
  return out;
}

/** Finds the `<input>`/`<select>` half of a `fieldRow(labelText, input)` pair
 * (numberField/textField/selectField all build exactly `<div><label/>{input}</div>`)
 * by the label's exact text. */
export function findFieldInput(root: FakeElement, labelText: string): FakeElement {
  for (const div of findAllByTag(root, 'div')) {
    const [label, input] = div.children;
    if (label instanceof FakeElement && label.tagName === 'LABEL' && label.textContent === labelText && input instanceof FakeElement) {
      return input;
    }
  }
  throw new Error(`findFieldInput: no field row found for label "${labelText}"`);
}

/** Finds a `checkboxField(labelText, ...)`'s `<input type=checkbox>` by the
 * label's exact text (checkboxField appends a plain text node, not a <label>
 * text, so this can't reuse findFieldInput's div-shape assumption). */
export function findCheckboxByLabel(root: FakeElement, labelText: string): FakeElement {
  for (const label of findAllByTag(root, 'label')) {
    const [input, textNode] = label.children;
    if (input instanceof FakeElement && input.type === 'checkbox' && (textNode as { textContent?: string } | undefined)?.textContent === labelText) {
      return input;
    }
  }
  throw new Error(`findCheckboxByLabel: no checkbox found for label "${labelText}"`);
}
