import { describe, it, expect, vi } from 'vitest';
import { Graphics, Text, Texture } from 'pixi.js';
import { Panel, Button } from './widgets';

// Panel's border option (design/10 legibility fix, 2026-08-02): a flat near-black fill
// at low alpha reads as invisible over the app's own black backdrop — borderColor
// gives it a readable edge regardless of what's behind it. Covers the opt-in stroke
// plus the pre-existing same-size skip-redraw guard `layout()` already had.
describe('Panel', () => {
  it('draws its scrim to the requested size', () => {
    const p = new Panel({ radius: 8 });
    p.layout(120, 60);
    const scrim = p.view.children[0] as Graphics;
    const b = scrim.getLocalBounds();
    expect(b.width).toBeCloseTo(120, 0);
    expect(b.height).toBeCloseTo(60, 0);
  });

  it('adds an inset border stroke when borderColor is set, without changing the panel footprint', () => {
    const bordered = new Panel({ radius: 8, borderColor: 0x4c566a });
    bordered.layout(120, 60);
    const scrim = bordered.view.children[0] as Graphics;
    const b = scrim.getLocalBounds();
    expect(b.width).toBeCloseTo(120, 0);
    expect(b.height).toBeCloseTo(60, 0);
  });

  it('draws no border stroke when borderColor is omitted (default, pre-existing look)', () => {
    const p = new Panel({ radius: 8 });
    expect(() => p.layout(120, 60)).not.toThrow();
  });

  it('is a no-op re-layout at the same size (skips redraw)', () => {
    const p = new Panel({ radius: 8, borderColor: 0x4c566a });
    p.layout(120, 60);
    const scrim = p.view.children[0] as Graphics;
    const clearSpy = vi.spyOn(scrim, 'clear');
    p.layout(120, 60);
    expect(clearSpy).not.toHaveBeenCalled();
  });

  it('redraws when the size actually changes', () => {
    const p = new Panel({ radius: 8, borderColor: 0x4c566a });
    p.layout(120, 60);
    const scrim = p.view.children[0] as Graphics;
    const clearSpy = vi.spyOn(scrim, 'clear');
    p.layout(200, 60);
    expect(clearSpy).toHaveBeenCalled();
  });
});

// Button's border option (design/10 legibility fix, 2026-08-02, same as Panel's above) —
// a flat fill alone reads as low-contrast wherever a button sits over a background image
// brighter than the fill itself (MainMenu's hub art). Covers the opt-in stroke, the fill
// staying fully opaque (was 0.9 — another part of the same fix), and the pre-existing
// label/icon behavior this change must not have broken.
describe('Button', () => {
  it('sizes its hit area to the given w/h, with or without a border', () => {
    // Bounds are read off the `bg` Graphics directly (children[0]), not the whole
    // `view` — `view` also holds the label Text, and measuring a Text's bounds needs
    // a real canvas, which this repo's plain-node vitest doesn't have (no jsdom/canvas
    // here, same constraint noted in ui/textWidth.ts).
    const plain = new Button('X', { w: 100, h: 40 });
    const plainBounds = (plain.view.children[0] as Graphics).getLocalBounds();
    expect(plainBounds.width).toBeCloseTo(100, 0);
    expect(plainBounds.height).toBeCloseTo(40, 0);

    // The border stroke's line width pushes bounds out by half its width — loosen the
    // tolerance a bit rather than pin an exact pixel, which isn't the invariant this
    // test cares about.
    const bordered = new Button('X', { w: 100, h: 40, borderColor: 0x718096 });
    const borderedBounds = (bordered.view.children[0] as Graphics).getLocalBounds();
    expect(borderedBounds.width).toBeCloseTo(100, -1);
    expect(borderedBounds.height).toBeCloseTo(40, -1);
  });

  it('draws no border stroke when borderColor is omitted (default, pre-existing look)', () => {
    expect(() => new Button('X', { w: 100, h: 40 })).not.toThrow();
  });

  it('sets the label text at construction and via setText', () => {
    const b = new Button('HELLO', { w: 100, h: 40 });
    const label = b.view.children[1] as Text;
    expect(label.text).toBe('HELLO');
    b.setText('BYE');
    expect(label.text).toBe('BYE');
  });

  it('fires onTap exactly once per pointertap, and only when it is set', () => {
    // `emit` is typed to require a real FederatedPointerEvent payload; the handler
    // itself ignores it, so a plain cast is fine here rather than constructing one.
    const emitTap = (view: { emit: (event: string) => void }) => view.emit('pointertap');
    const b = new Button('X', { w: 100, h: 40 });
    expect(() => emitTap(b.view)).not.toThrow();
    let calls = 0;
    b.onTap = () => { calls += 1; };
    emitTap(b.view);
    emitTap(b.view);
    expect(calls).toBe(2);
  });

  // "Press" is not "activate". A Button must only commit on the full down-then-up
  // gesture, because the frames between the two belong to whatever screen the press
  // started on — anything that acts on `pointerdown` alone can navigate that screen away
  // and swallow the tap that was actually intended (see game/confirmEdge.ts for the real
  // bug this describes, where a raw mouse-down poll did exactly that to every menu
  // button). The `pointerdown` listener here exists only to stop propagation.
  it('does not fire onTap on pointerdown alone — only the completed tap commits', () => {
    // Unlike the pointertap handler above, the pointerdown one DOES read its payload
    // (it calls stopPropagation), so this emit needs a stub rather than a bare cast.
    let stopped = 0;
    const ev = { stopPropagation: () => { stopped += 1; } };
    const emit = (view: { emit: (event: string, ev?: unknown) => void }, name: string) => view.emit(name, ev);
    const b = new Button('X', { w: 100, h: 40 });
    let calls = 0;
    b.onTap = () => { calls += 1; };

    emit(b.view, 'pointerdown');
    expect(calls).toBe(0);
    expect(stopped).toBe(1); // it consumed the press, but did not commit the action
    emit(b.view, 'pointerup');
    expect(calls).toBe(0); // Pixi synthesizes pointertap itself; up alone is not it

    emit(b.view, 'pointertap');
    expect(calls).toBe(1);
  });

  it('setIcon adds a chip + sprite and re-anchors the label to sit left-of-center', () => {
    const b = new Button('X', { w: 100, h: 40 });
    const label = b.view.children[1] as Text;
    expect(b.view.children.length).toBe(2);
    expect(label.anchor.x).toBe(0.5); // centered, no icon

    b.setIcon(Texture.WHITE);
    expect(b.view.children.length).toBe(4);
    expect(label.anchor.x).toBe(0); // left-anchored to sit right of the icon now

    b.setIcon(undefined);
    expect(b.view.children.length).toBe(2);
    expect(label.anchor.x).toBe(0.5); // back to centered once the icon is cleared
  });

  it('setIcon accepts an optional chip color without throwing', () => {
    const b = new Button('X', { w: 100, h: 40 });
    expect(() => b.setIcon(Texture.WHITE, 0x6b46c1)).not.toThrow();
    expect(b.view.children.length).toBe(4);
  });
});
