/**
 * Forge (the loadout/outpost screen). Pixi Container/Text/Graphics construct and
 * mutate fine under plain vitest with no renderer attached (same finding
 * Screens.test.ts/PartyScreen.test.ts made) — asserted here via `.position`/`.visible`/
 * `.text`, not pixel output.
 *
 * Two real layout bugs, both reported live as "the screen is a mess": the buyable-
 * blueprint list had no length bound and could run off both edges of the screen as one
 * line, and the bottom action bar (clear/start/hint) was positioned by flowing down
 * from the row list + compare card and only *clamped* to fit once it overflowed —
 * which left it floating on top of the still-there row list instead of below it.
 */
import { describe, it, expect } from 'vitest';
import { DOMAdapter } from 'pixi.js';
import { Forge } from './Forge';
import { defaultMetaState, acquireBlueprint, purchasableBlueprints } from '../meta';
import type { MetaState } from '../meta';
import type { Button } from './ui/widgets';

// This suite is the first to call Forge.render(), which reads `Text.height` to flow
// its layout — that lazily asks Pixi to measure text on a real `<canvas>` 2D context,
// which doesn't exist under this repo's plain-node vitest environment (no jsdom/canvas
// dependency; every other UI screen test avoids `.height`/`.bounds` on a Text for
// exactly this reason). Swapping in a fake canvas via Pixi's own `DOMAdapter` seam
// avoids pulling in a real canvas/jsdom dependency just to run this: the actual glyph
// metrics don't matter to any assertion below (they only affect where content flows,
// never whether the fixed bottom bar or the no-room compare-card hide behave right).
DOMAdapter.set({
  ...DOMAdapter.get(),
  createCanvas: (width?: number, height?: number) => {
    const ctx = {
      font: '',
      measureText(text: string) {
        const m = /(\d+(?:\.\d+)?)px/.exec(this.font as string);
        const fontSize = m ? parseFloat(m[1]!) : 10;
        const w = text.length * fontSize * 0.6;
        return { width: w, actualBoundingBoxAscent: fontSize * 0.8, actualBoundingBoxDescent: fontSize * 0.2 };
      },
    };
    return { width: width ?? 0, height: height ?? 0, getContext: () => ctx } as unknown as HTMLCanvasElement;
  },
  getCanvasRenderingContext2D: () => class {} as unknown as typeof CanvasRenderingContext2D,
});

function privateOf(f: Forge) {
  return f as unknown as {
    infoText: { text: string };
    rowBtns: Button[];
    clearBtn: Button;
    startBtn: Button;
    hint: { position: { x: number; y: number } };
    compareCard: { view: { visible: boolean; position: { x: number; y: number }; height: number } };
  };
}

// Buys down the shelf to `max` or fewer remaining purchasable blueprints (defaultMetaState
// starts with 17 — see forge.test.ts's own purchasableBlueprints assertion).
function withFewBuyable(max: number): MetaState {
  let m = defaultMetaState();
  while (purchasableBlueprints(m).length > max) {
    m = acquireBlueprint(m, purchasableBlueprints(m)[0]!);
  }
  return m;
}

describe('Forge — infoText buyable-list bound', () => {
  it('collapses a long shelf to a bare count instead of joining every name', () => {
    const f = new Forge();
    const m = defaultMetaState();
    expect(purchasableBlueprints(m).length).toBeGreaterThan(3); // the case that used to overflow
    f.render(m, 1280, 720);
    const text = privateOf(f).infoText.text;
    expect(text).toContain(`${purchasableBlueprints(m).length} more available`);
    // None of the shelf's own blueprint ids should leak into the collapsed line — only
    // the count should. (A regression here would mean the old unbounded join is back.)
    for (const id of purchasableBlueprints(m).slice(3)) expect(text).not.toContain(id);
  });

  it('still lists names when the shelf is short enough to matter', () => {
    const f = new Forge();
    const m = withFewBuyable(2);
    const shelf = purchasableBlueprints(m);
    expect(shelf.length).toBeGreaterThan(0);
    expect(shelf.length).toBeLessThanOrEqual(3);
    f.render(m, 1280, 720);
    const text = privateOf(f).infoText.text;
    for (const id of shelf) expect(text).toContain(id);
    expect(text).not.toContain('more available');
  });

  it('omits the Store line entirely once nothing is left to buy', () => {
    const f = new Forge();
    const m = withFewBuyable(0);
    expect(purchasableBlueprints(m)).toHaveLength(0);
    f.render(m, 1280, 720);
    expect(privateOf(f).infoText.text).not.toContain('Store');
  });
});

describe('Forge — fixed bottom action bar', () => {
  it('anchors clear/start/hint to the viewport height, not to the content flow above them', () => {
    const f = new Forge();
    const m = defaultMetaState();
    f.render(m, 1280, 720);
    const p = privateOf(f);
    expect(p.startBtn.view.position.y).toBe(720 - 60);
    expect(p.clearBtn.view.position.y).toBe(720 - 60 + 7);
    expect(p.hint.position.y).toBe(720 - 6);
  });

  it('stays at the same height-relative offset on a short viewport instead of drifting onto the row list', () => {
    // The original bug: this button's y came from `Math.min(flowedY, h - 70)`, so on a
    // short screen it landed wherever the flow happened to overflow to — which, with
    // eight full-size rows above it, meant on top of rows 6-8. Pinning it to `h` means
    // the same offset from the bottom holds regardless of viewport size.
    const f = new Forge();
    const m = defaultMetaState();
    f.render(m, 1280, 480);
    const p = privateOf(f);
    expect(p.startBtn.view.position.y).toBe(480 - 60);
    expect(p.clearBtn.view.position.y).toBe(480 - 60 + 7);
    expect(p.hint.position.y).toBe(480 - 6);
  });

  it('does not move the action bar when paging changes how much content sits above it', () => {
    const f = new Forge();
    const m = defaultMetaState();
    f.render(m, 1280, 600);
    const before = privateOf(f).startBtn.view.position.y;
    f.moveSelection(1); // may flip pages, changing the row-list content but not its size
    f.render(m, 1280, 600);
    expect(privateOf(f).startBtn.view.position.y).toBe(before);
  });
});

describe('Forge — compare card no-room hide', () => {
  it('shows the compare card when the viewport is tall enough', () => {
    const f = new Forge();
    f.render(defaultMetaState(), 1280, 900);
    expect(privateOf(f).compareCard.view.visible).toBe(true);
  });

  it('hides the compare card instead of overlapping the fixed action bar on a short viewport', () => {
    const f = new Forge();
    f.render(defaultMetaState(), 1280, 380);
    const p = privateOf(f);
    expect(p.compareCard.view.visible).toBe(false);
    // And the action bar itself must still be exactly where a taller render would put
    // it relative to `h` — hiding the card must not be achieved by moving the bar.
    expect(p.startBtn.view.position.y).toBe(380 - 60);
  });
});
