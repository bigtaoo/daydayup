/**
 * The spec `rarityOverlay.ts` closes is a CHANNEL claim: rarity reads by count, element by
 * hue, so the two can never be confused. These tests are written against that claim rather
 * than against the constants — the arc step and the pip radius are free to be retuned, the
 * count being a bijection onto the tier is not.
 *
 * The count sweep runs over every authored weapon in `WEAPON_SPECS`, not over a fixture
 * list of tiers. A fixture would keep passing if a whole tier stopped appearing in the
 * content (the coverage would vanish silently, which is this repo's recurring one).
 */
import { describe, it, expect } from 'vitest';
import { Graphics } from 'pixi.js';
import { RARITY_ORDER, RARITY_TIERS, WEAPON_SPECS, type RarityTier } from '@dd/engine';
import { drawRarityPips, pipCount } from './rarityOverlay';
import { RARITY_COLORS, ELEMENT_COLORS, elementColor } from './theme';

interface PathInstr {
  action: string;
  data: unknown[];
}
interface Instr {
  action: string;
  data: { style?: { color?: number; alpha?: number }; path?: { instructions: PathInstr[] } };
}

function instrs(g: Graphics): Instr[] {
  return g.context.instructions as unknown as Instr[];
}

/** Every circle drawn, as `{ cx, cy, r, color, alpha }`. */
function pips(g: Graphics): Array<{ cx: number; cy: number; r: number; color: number; alpha: number }> {
  return instrs(g).flatMap((ins) =>
    (ins.data.path?.instructions ?? [])
      .filter((pi) => pi.action === 'circle')
      .map((pi) => {
        const [cx, cy, r] = pi.data.filter((v): v is number => typeof v === 'number');
        return { cx: cx!, cy: cy!, r: r!, color: ins.data.style?.color ?? 0, alpha: ins.data.style?.alpha ?? 0 };
      }),
  );
}

function drawn(tier: RarityTier, cx = 0, cy = 0, r = 13): Graphics {
  const g = new Graphics();
  drawRarityPips(g, tier, cx, cy, r);
  return g;
}

describe('pipCount — the channel itself', () => {
  it('is a bijection onto the tiers, so a tier is recoverable from the COUNT alone', () => {
    // This is the whole spec in one assertion: if two tiers ever shared a count, rarity would
    // be back to needing colour to disambiguate, which is the collision the overlay exists to
    // avoid. Enumerated from RARITY_ORDER so a sixth tier is covered the day it is added.
    const counts = RARITY_ORDER.map(pipCount);
    expect(new Set(counts).size).toBe(RARITY_ORDER.length);
  });

  it('is monotone in the tier order, so "more marks" always means "better"', () => {
    const counts = RARITY_ORDER.map(pipCount);
    for (let i = 1; i < counts.length; i++) expect(counts[i]!).toBeGreaterThan(counts[i - 1]!);
  });

  it('starts at zero, so the baseline tier is the one that draws nothing', () => {
    expect(pipCount(RARITY_ORDER[0]!)).toBe(0);
  });
});

describe('drawRarityPips', () => {
  it('draws nothing at all for the baseline tier', () => {
    const g = drawn(RARITY_ORDER[0]!);
    expect(instrs(g)).toHaveLength(0);
    expect(g.getLocalBounds().width).toBe(0);
  });

  it.each(RARITY_ORDER.slice(1))('%s draws exactly pipCount marks', (tier) => {
    expect(pips(drawn(tier))).toHaveLength(pipCount(tier));
  });

  it.each(RARITY_ORDER.slice(1))('%s draws its marks in its own rarity hue and nothing else', (tier) => {
    const want = RARITY_COLORS[RARITY_TIERS[tier].colorKey];
    for (const p of pips(drawn(tier))) expect(p.color).toBe(want);
  });

  it.each(RARITY_ORDER.slice(1))('%s spreads its marks symmetrically about straight-up', (tier) => {
    const ps = pips(drawn(tier, 0, 0, 13));
    const sumX = ps.reduce((a, p) => a + p.cx, 0);
    expect(sumX).toBeCloseTo(0, 6); // symmetric about the vertical
    for (const p of ps) expect(p.cy).toBeLessThan(0); // above the object, per the spec
  });

  it.each(RARITY_ORDER.slice(1))('%s keeps every mark on the arc it was given', (tier) => {
    const r = 13;
    for (const p of pips(drawn(tier, 0, 0, r))) {
      expect(Math.hypot(p.cx, p.cy)).toBeCloseTo(r, 6);
    }
  });

  it.each(RARITY_ORDER.slice(1))('%s translates with (cx, cy) and scales with r', (tier) => {
    const at0 = pips(drawn(tier, 0, 0, 13));
    const moved = pips(drawn(tier, 100, 60, 13));
    expect(moved[0]!.cx - at0[0]!.cx).toBeCloseTo(100, 6);
    expect(moved[0]!.cy - at0[0]!.cy).toBeCloseTo(60, 6);
    const bigger = pips(drawn(tier, 0, 0, 40));
    expect(bigger[0]!.r).toBeGreaterThan(at0[0]!.r);
  });

  it('marks never overlap each other, at any drawn count', () => {
    // Two touching pips read as one longer mark, which would break the count channel exactly
    // where it matters most (4 vs 3). Checked at the smallest arc the game actually uses.
    for (const tier of RARITY_ORDER.slice(1)) {
      const ps = pips(drawn(tier, 0, 0, 13));
      for (let i = 1; i < ps.length; i++) {
        const gap = Math.hypot(ps[i]!.cx - ps[i - 1]!.cx, ps[i]!.cy - ps[i - 1]!.cy);
        expect(gap, `${tier} pips ${i - 1}/${i}`).toBeGreaterThan(ps[i]!.r * 2);
      }
    }
  });

  it('the emissive alpha ramps monotonically up the ladder', () => {
    const drawnTiers = RARITY_ORDER.slice(1);
    const alphas = drawnTiers.map((t) => pips(drawn(t))[0]!.alpha);
    for (let i = 1; i < alphas.length; i++) expect(alphas[i]!).toBeGreaterThan(alphas[i - 1]!);
    expect(alphas[alphas.length - 1]!).toBeCloseTo(1, 6); // the top tier is fully bright
  });

  it('every mark stays a solid dot rather than a speck, down to the smallest arc in play', () => {
    // `Pickup` draws on a 13 px arc; the floor exists so a hypothetical smaller caller still
    // gets a visible mark. Same minimum-solid-mass rule as `elementIcons`.
    for (const tier of RARITY_ORDER.slice(1)) {
      for (const p of pips(drawn(tier, 0, 0, 6))) expect(p.r, tier).toBeGreaterThanOrEqual(1.4);
    }
  });
});

describe('the channel separation, against the palettes that made it necessary', () => {
  it('the two palettes really do collide on hue — which is why count carries rarity', () => {
    // Pins design/13's stated worry as a fact rather than a comment. If a future palette pass
    // ever separates them, this failing is the signal to revisit the spec, not to delete it.
    const rarityHues = new Set(Object.values(RARITY_COLORS));
    const elementHues = new Set(Object.values(ELEMENT_COLORS));
    elementHues.add(elementColor('physical'));
    const shared = [...rarityHues].filter((h) => elementHues.has(h));
    expect(shared.length).toBeGreaterThan(0); // `common` white IS `physical`'s neutral
  });

  it('no rarity tier is identifiable only by hue: the counts alone separate all five', () => {
    const byCount = new Map<number, RarityTier>();
    for (const tier of RARITY_ORDER) {
      expect(byCount.has(pipCount(tier))).toBe(false);
      byCount.set(pipCount(tier), tier);
    }
  });
});

describe('sweep — every authored weapon draws the marks its own tier implies', () => {
  const ids = Object.keys(WEAPON_SPECS);

  it('the content actually exercises more than one tier (else the sweep below is vacuous)', () => {
    const tiers = new Set(ids.map((id) => WEAPON_SPECS[id]!.rarity));
    expect(tiers.size).toBeGreaterThan(2);
  });

  it.each(Object.keys(WEAPON_SPECS))('%s', (id) => {
    const spec = WEAPON_SPECS[id]!;
    const g = drawn(spec.rarity);
    expect(pips(g)).toHaveLength(RARITY_ORDER.indexOf(spec.rarity));
  });

  it('every tier present in the content is reachable by count, and distinctly', () => {
    const seen = new Map<number, Set<RarityTier>>();
    for (const id of ids) {
      const tier = WEAPON_SPECS[id]!.rarity;
      const n = pips(drawn(tier)).length;
      (seen.get(n) ?? seen.set(n, new Set()).get(n)!).add(tier);
    }
    for (const [n, tiers] of seen) expect(tiers.size, `count ${n}`).toBe(1);
  });
});
