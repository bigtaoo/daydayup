/**
 * healthBar — the in-world floating hp bar's appearance (design/10 legibility).
 *
 * The interesting tests here are not "does it draw four rects". They are the two properties
 * the 2026-08-21 pass existed to establish, both of which the previous bar failed and both of
 * which are invisible to any test that only counts shapes:
 *
 *   1. **Background independence.** Every layer that carries the bar's silhouette is opaque,
 *      so the bar renders at the same luma whatever it is standing in front of. The old bar's
 *      track was alpha 0.85 and therefore measured anywhere from 25.6 to 57.1 luma across 18
 *      placements in one real room.
 *   2. **A guaranteed cue in both directions.** No single value separates from both a 27-luma
 *      shadowed floor and an 88-luma wall cap, so the bar carries a dark contour AND a light
 *      bevel, and the test asserts that whichever surface it lands on, one of the two is
 *      strongly separated from it.
 *
 * Both are asserted against the DRAWN OUTPUT — the real `Graphics` instruction list, colours
 * and alphas read back out and converted to luma by this file's own arithmetic — not against
 * the module's constants, so editing the palette in the source has to keep the property true
 * rather than merely keep a number in sync.
 *
 * `WORLD_LUMA` is the measured surface range the bar has to live on: 27-88. The low end is
 * the darkest background sampled behind a real mob's bar (an 18-placement sweep, 2026-08-21);
 * the high end is the wall-cap/pillar-top band measured in the 2026-08-19 volume pass
 * (ground 39-49, wall face 27.3-27.5, wall cap 72-88, pillar top 87).
 */
import { describe, it, expect } from 'vitest';
import { Graphics } from 'pixi.js';
import { THEME } from '../theme';
import { drawHealthBar, healthFillColor } from './healthBar';

const WORLD_LUMA = { min: 27, max: 88 };

/** Rec709 luma of a packed 0xRRGGBB, the same measure the frame sampling used. */
function luma(hex: number): number {
  return 0.2126 * ((hex >> 16) & 0xff) + 0.7152 * ((hex >> 8) & 0xff) + 0.0722 * (hex & 0xff);
}

/** `src` composited over `dst` at `alpha`, in luma. */
function over(src: number, dst: number, alpha: number): number {
  return alpha * luma(src) + (1 - alpha) * luma(dst);
}

interface Layer {
  color: number;
  alpha: number;
  x: number;
  y: number;
  w: number;
  h: number;
  radius: number;
}

/** Read back every filled roundRect `drawHealthBar` emitted, in draw order. */
function layersOf(g: Graphics): Layer[] {
  type Instr = {
    action: string;
    data: {
      style?: { color: number; alpha: number };
      path?: { instructions: Array<{ action: string; data: unknown[] }> };
    };
  };
  const out: Layer[] = [];
  for (const raw of g.context.instructions as unknown as Instr[]) {
    if (raw.action !== 'fill' || !raw.data.style) continue;
    for (const pi of raw.data.path?.instructions ?? []) {
      if (pi.action !== 'roundRect') continue;
      const [x, y, w, h, radius] = pi.data as number[];
      out.push({ color: raw.data.style.color, alpha: raw.data.style.alpha, x, y, w, h, radius });
    }
  }
  return out;
}

function bar(opts: { w?: number; h?: number; ratio: number; local?: boolean }): Layer[] {
  const g = new Graphics();
  drawHealthBar(g, { w: opts.w ?? 20, h: opts.h ?? 4, ratio: opts.ratio, local: opts.local ?? false });
  return layersOf(g);
}

/** The four layers by role, identified by geometry rather than by index so a reordering of
 *  the draw calls can't silently make these tests assert the wrong shape. */
function roles(layers: Layer[], w: number, h: number) {
  const contour = layers.find((l) => l.w > w && l.h > h);
  const full = layers.filter((l) => l.w === w && l.h === h);
  const track = full[0];
  const fill = layers.find((l) => l.h === h && l.w <= w && l !== track);
  const bevel = layers.find((l) => l.h < h);
  return { contour, track, fill, bevel };
}

describe('drawHealthBar — structure', () => {
  it('draws contour, track, fill and bevel, with the contour strictly outside the track', () => {
    const layers = bar({ ratio: 0.6 });
    const { contour, track, fill, bevel } = roles(layers, 20, 4);
    expect(contour).toBeDefined();
    expect(track).toBeDefined();
    expect(fill).toBeDefined();
    expect(bevel).toBeDefined();
    // The contour is an inflated FILL, not a stroke — so it can never eat into the track's
    // height the way a centre-aligned stroke would.
    expect(contour!.x).toBeLessThan(track!.x);
    expect(contour!.y).toBeLessThan(track!.y);
    expect(contour!.w).toBeGreaterThan(track!.w);
    expect(contour!.h).toBeGreaterThan(track!.h);
  });

  it('is centred on its own origin, so Actor can position it by y alone', () => {
    const { track } = roles(bar({ ratio: 1, w: 30, h: 6 }), 30, 6);
    expect(track!.x).toBeCloseTo(-15, 10);
    expect(track!.y).toBeCloseTo(-3, 10);
  });

  it('rounds to a full pill, matching the HUD widgets.Bar it shares a screen with', () => {
    const { track } = roles(bar({ ratio: 1, w: 30, h: 6 }), 30, 6);
    expect(track!.radius).toBeCloseTo(3, 10);
  });

  it('clears before redrawing, so a shrinking bar cannot leave its old fill behind', () => {
    const g = new Graphics();
    drawHealthBar(g, { w: 20, h: 4, ratio: 1, local: false });
    drawHealthBar(g, { w: 20, h: 4, ratio: 0.25, local: false });
    const full = layersOf(g).filter((l) => l.h === 4 && l.w === 20);
    // One track only — a second full-width layer would be the previous frame's 100% fill.
    expect(full.length).toBe(1);
  });
});

describe('drawHealthBar — the fill', () => {
  it('scales with the hp fraction', () => {
    const w = 40;
    const at = (ratio: number) => roles(bar({ ratio, w, h: 4 }), w, 4).fill!.w;
    expect(at(1)).toBeCloseTo(40, 10);
    expect(at(0.5)).toBeCloseTo(20, 10);
  });

  it('ramps green → amber → red across the thresholds', () => {
    expect(healthFillColor(1)).toBe(0x66bb6a);
    expect(healthFillColor(0.51)).toBe(0x66bb6a);
    expect(healthFillColor(0.5)).toBe(0xffca28); // boundary belongs to the LOWER band
    expect(healthFillColor(0.26)).toBe(0xffca28);
    expect(healthFillColor(0.25)).toBe(0xef5350);
    expect(healthFillColor(0.01)).toBe(0xef5350);
  });

  it('draws the ramp colour the ratio asks for', () => {
    const { fill } = roles(bar({ ratio: 0.1, w: 40 }), 40, 4);
    expect(fill!.color).toBe(healthFillColor(0.1));
  });

  // The state where legibility matters most: one hit from death. `w * ratio` alone goes
  // sub-pixel at gameplay zoom there (0.02 * 20 = 0.4 world px, under one screen px at the
  // ~1.6x room zoom measured), so an almost-dead actor rendered as an apparently EMPTY bar —
  // indistinguishable from a dead one.
  it('never draws a sub-pixel sliver: a non-zero hp is at least one pill wide', () => {
    const { fill } = roles(bar({ ratio: 0.02, w: 20, h: 4 }), 20, 4);
    expect(fill!.w).toBeGreaterThanOrEqual(4);
  });

  it('draws no fill at all at zero hp — the floor is a real floor, not a stub', () => {
    const layers = bar({ ratio: 0, w: 20, h: 4 });
    // track + contour + bevel, and nothing in a fill colour.
    const fillColors = new Set([0x66bb6a, 0xffca28, 0xef5350]);
    expect(layers.some((l) => fillColors.has(l.color))).toBe(false);
  });

  it('clamps out-of-range ratios instead of overdrawing the track', () => {
    expect(roles(bar({ ratio: 4, w: 20 }), 20, 4).fill!.w).toBeCloseTo(20, 10);
    expect(roles(bar({ ratio: -3, w: 20 }), 20, 4).fill).toBeUndefined();
  });
});

describe('drawHealthBar — legibility against the world (measured invariants)', () => {
  // Property 1: the mechanism. Anything translucent renders at a value the background
  // decides, which is exactly how the old track came to measure 25.6-57.1 luma.
  it('draws every silhouette-carrying layer opaque', () => {
    const { contour, track, fill } = roles(bar({ ratio: 0.5, w: 20 }), 20, 4);
    expect(contour!.alpha).toBe(1);
    expect(track!.alpha).toBe(1);
    expect(fill!.alpha).toBe(1);
  });

  // Property 2: the outcome. Over the whole measured surface range, at least one of the two
  // cues has real separation from the background. The old bar's worst case over this same
  // range was ~12 luma (at a 27-luma floor); this asserts a floor of 45.
  it('keeps one strongly-separated cue against every measured world surface', () => {
    const layers = bar({ ratio: 0.35, w: 20, h: 4 });
    const { contour, track, bevel } = roles(layers, 20, 4);
    const contourL = luma(contour!.color);
    // The bevel's worst case is over the TRACK, the darkest thing it is ever drawn on.
    const bevelL = over(bevel!.color, track!.color, bevel!.alpha);

    let worst = Infinity;
    let worstAt = -1;
    for (let bg = WORLD_LUMA.min; bg <= WORLD_LUMA.max; bg += 0.5) {
      const best = Math.max(Math.abs(contourL - bg), Math.abs(bevelL - bg));
      if (best < worst) {
        worst = best;
        worstAt = bg;
      }
    }
    expect(worst, `worst separation ${worst.toFixed(1)} luma at background ${worstAt}`)
      .toBeGreaterThanOrEqual(45);
  });

  it('carries the dark cue against bright surfaces and the light cue against dark ones', () => {
    const layers = bar({ ratio: 0.35, w: 20, h: 4 });
    const { contour, track, bevel } = roles(layers, 20, 4);
    const contourL = luma(contour!.color);
    const bevelL = over(bevel!.color, track!.color, bevel!.alpha);
    // Against a wall cap / pillar top (72-88) the contour is the one doing the work...
    expect(WORLD_LUMA.max - contourL).toBeGreaterThanOrEqual(45);
    // ...and against the darkest measured floor it is the bevel.
    expect(bevelL - WORLD_LUMA.min).toBeGreaterThanOrEqual(45);
  });

  // Found by the mutation battery: brightening TRACK to a mid-grey left every assertion above
  // green, because the bevel is measured OVER the track and simply got brighter with it. But a
  // bright track destroys the bar's actual job — "how much is left" is read as fill-against-
  // empty, and if the empty part is nearly as light as a full one there is no fraction to see.
  it('keeps the empty track clearly darker than every fill state', () => {
    const { track } = roles(bar({ ratio: 1, w: 20 }), 20, 4);
    const trackL = luma(track!.color);
    for (const ratio of [1, 0.4, 0.1]) {
      const fillL = luma(healthFillColor(ratio));
      expect(fillL - trackL, `fill at ratio ${ratio} vs track`).toBeGreaterThanOrEqual(60);
    }
  });

  // Also from the battery: doubling BEVEL_H survived, because the only assertion on it was
  // "the same at both bar sizes" — true of any constant. A bevel that is half the bar stops
  // being a highlight and becomes a second stripe competing with the fill.
  it('keeps the bevel a thin highlight, not a stripe — a minority of the bar height', () => {
    for (const h of [4, 6]) {
      const { track, bevel } = roles(bar({ ratio: 1, w: 30, h }), 30, h);
      expect(bevel!.h / track!.h).toBeLessThanOrEqual(0.3);
    }
  });

  it('puts the bevel over the fill as well as the track, so it reads as gloss not lost fill', () => {
    const layers = bar({ ratio: 1, w: 20, h: 4 });
    const { track, fill, bevel } = roles(layers, 20, 4);
    // Drawn last of the four, and horizontally inside the track, so it crosses both.
    expect(layers.indexOf(bevel!)).toBe(layers.length - 1);
    expect(bevel!.x).toBeGreaterThanOrEqual(track!.x);
    expect(bevel!.x + bevel!.w).toBeLessThanOrEqual(track!.x + track!.w);
    expect(bevel!.x).toBeLessThan(fill!.x + fill!.w);
  });
});

describe('drawHealthBar — the "which one is me" marker (design/10, chosen 2026-08-14)', () => {
  it('recolours the CONTOUR to the player teal for the local seat', () => {
    const mine = roles(bar({ ratio: 0.5, w: 20, local: true }), 20, 4);
    const theirs = roles(bar({ ratio: 0.5, w: 20, local: false }), 20, 4);
    expect(mine.contour!.color).toBe(THEME.colors.player);
    expect(theirs.contour!.color).not.toBe(THEME.colors.player);
  });

  it('changes nothing else about the bar — the marker is the contour alone', () => {
    const mine = bar({ ratio: 0.5, w: 20, local: true });
    const theirs = bar({ ratio: 0.5, w: 20, local: false });
    expect(mine.length).toBe(theirs.length);
    // Same geometry throughout, and the same colours everywhere but the contour.
    mine.forEach((l, i) => {
      expect([l.x, l.y, l.w, l.h]).toEqual([theirs[i]!.x, theirs[i]!.y, theirs[i]!.w, theirs[i]!.h]);
    });
    expect(mine.filter((l, i) => l.color !== theirs[i]!.color).length).toBe(1);
  });

  it('is still legible against every measured surface — teal is bright, so it swaps which cue leads', () => {
    const { contour } = roles(bar({ ratio: 0.5, w: 20, local: true }), 20, 4);
    // The local contour replaces the dark cue with a bright one, so the guarantee has to come
    // from the teal itself against the darkest floor rather than from the contour being dark.
    expect(luma(contour!.color) - WORLD_LUMA.min).toBeGreaterThanOrEqual(45);
  });
});

describe('drawHealthBar — per-actor sizing (Actor owns the numbers, this owns the look)', () => {
  it('honours the w/h it is handed, so a boss bar really is bigger', () => {
    const mob = roles(bar({ ratio: 1, w: 20, h: 4 }), 20, 4);
    const boss = roles(bar({ ratio: 1, w: 66, h: 6 }), 66, 6);
    expect(boss.track!.w).toBeGreaterThan(mob.track!.w);
    expect(boss.track!.h).toBeGreaterThan(mob.track!.h);
  });

  it('scales the contour and bevel with the bar, not by a fixed fraction of it', () => {
    const mob = roles(bar({ ratio: 1, w: 20, h: 4 }), 20, 4);
    const boss = roles(bar({ ratio: 1, w: 66, h: 6 }), 66, 6);
    // The contour is a constant 1 world px on every side at both sizes — a HUD outline that
    // grew with the bar would be a heavy black border on the boss.
    expect(mob.contour!.w - mob.track!.w).toBeCloseTo(2, 10);
    expect(boss.contour!.w - boss.track!.w).toBeCloseTo(2, 10);
    expect(mob.bevel!.h).toBeCloseTo(boss.bevel!.h, 10);
  });
});
