import { describe, it, expect } from 'vitest';
import type { Graphics, Text } from 'pixi.js';
import { TouchControlsView } from './TouchControlsView';
import type { TouchVisual } from '../../platform/types';

// Children are appended in this fixed order in the constructor — indexing into
// `view.children` is the only way in from the outside, since the individual
// Graphics/Text are private (this mirrors how the feature was hand-verified live in
// the browser: see the daydayup memory notes on why screenshots aren't available here).
const enum Child { MoveBase, MoveKnob, FireButton, Weapon1, Weapon2, Weapon1Label, Weapon2Label }

function graphicsAt(v: TouchControlsView, i: Child): Graphics {
  return v.view.children[i] as Graphics;
}
function textAt(v: TouchControlsView, i: Child): Text {
  return v.view.children[i] as Text;
}

const BASE_VISUAL: TouchVisual = {
  active: true,
  stickRadius: 50,
  move: null,
  fire: { cx: 300, cy: 60, r: 50, pressed: false },
  weapon1: { cx: 100, cy: 20, r: 15 },
  weapon2: { cx: 60, cy: 20, r: 15 },
};

describe('TouchControlsView', () => {
  it('starts hidden before the first update()', () => {
    const v = new TouchControlsView();
    expect(v.view.visible).toBe(false);
  });

  it('is presentation-only — never intercepts pointer events (canvas listeners own that)', () => {
    const v = new TouchControlsView();
    expect(v.view.eventMode).toBe('none');
  });

  it('stays hidden when TouchVisual.active is false, regardless of stick state', () => {
    const v = new TouchControlsView();
    v.update({ ...BASE_VISUAL, active: false });
    expect(v.view.visible).toBe(false);
  });

  it('becomes visible once active, with the move stick hidden while untouched', () => {
    const v = new TouchControlsView();
    v.update(BASE_VISUAL);
    expect(v.view.visible).toBe(true);
    expect(graphicsAt(v, Child.MoveBase).visible).toBe(false);
    expect(graphicsAt(v, Child.MoveKnob).visible).toBe(false);
  });

  it('draws the fire button at its fixed reported position regardless of the move stick', () => {
    const v = new TouchControlsView();
    v.update(BASE_VISUAL); // fixed position, drawn even though nothing is held
    const bounds = graphicsAt(v, Child.FireButton).getBounds();
    expect(bounds.x + bounds.width / 2).toBeCloseTo(300);
    expect(bounds.y + bounds.height / 2).toBeCloseTo(60);
  });

  it('draws the move stick base+knob at the reported origin/offset when held', () => {
    const v = new TouchControlsView();
    v.update({ ...BASE_VISUAL, move: { ox: 40, oy: 60, dx: 20, dy: -10 } });

    const base = graphicsAt(v, Child.MoveBase);
    expect(base.visible).toBe(true);
    const baseBounds = base.getBounds();
    expect(baseBounds.x + baseBounds.width / 2).toBeCloseTo(40);
    expect(baseBounds.y + baseBounds.height / 2).toBeCloseTo(60);

    const knob = graphicsAt(v, Child.MoveKnob);
    expect(knob.visible).toBe(true);
    const knobBounds = knob.getBounds();
    expect(knobBounds.x + knobBounds.width / 2).toBeCloseTo(60); // ox + dx
    expect(knobBounds.y + knobBounds.height / 2).toBeCloseTo(50); // oy + dy
  });

  it('re-hides the move stick the frame after release', () => {
    const v = new TouchControlsView();
    v.update({ ...BASE_VISUAL, move: { ox: 40, oy: 60, dx: 20, dy: -10 } });
    expect(graphicsAt(v, Child.MoveBase).visible).toBe(true);

    v.update({ ...BASE_VISUAL, move: null });
    expect(graphicsAt(v, Child.MoveBase).visible).toBe(false);
    expect(graphicsAt(v, Child.MoveKnob).visible).toBe(false);
  });

  it('draws both weapon buttons at their reported centre/radius every update, labelled 1/2', () => {
    const v = new TouchControlsView();
    v.update(BASE_VISUAL);

    const w1 = graphicsAt(v, Child.Weapon1).getBounds();
    expect(w1.x + w1.width / 2).toBeCloseTo(100);
    expect(w1.y + w1.height / 2).toBeCloseTo(20);

    const w2 = graphicsAt(v, Child.Weapon2).getBounds();
    expect(w2.x + w2.width / 2).toBeCloseTo(60);
    expect(w2.y + w2.height / 2).toBeCloseTo(20);

    const l1 = textAt(v, Child.Weapon1Label);
    expect(l1.text).toBe('1');
    expect(l1.position.x).toBe(100);
    expect(l1.position.y).toBe(20);

    const l2 = textAt(v, Child.Weapon2Label);
    expect(l2.text).toBe('2');
    expect(l2.position.x).toBe(60);
    expect(l2.position.y).toBe(20);
  });

  it('follows the buttons if their reported position changes (screen resize)', () => {
    const v = new TouchControlsView();
    v.update(BASE_VISUAL);
    v.update({ ...BASE_VISUAL, weapon1: { cx: 200, cy: 40, r: 15 } });
    const l1 = textAt(v, Child.Weapon1Label);
    expect(l1.position.x).toBe(200);
    expect(l1.position.y).toBe(40);
  });
});
