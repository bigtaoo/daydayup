/**
 * `BlueprintCard` — the Forge grid's per-blueprint icon card (design/14 icon-card pass,
 * replacing Forge's old text-row `Button`s). Covers what a card actually needs to get
 * right: its text fields update via `set()`, the icon sprite is added/removed based on
 * whether a texture is supplied, the locked/selected states repaint the right colors
 * (read via `Graphics.context.instructions`, the same technique `Minimap.test.ts`
 * established for asserting on drawn fill/stroke colors with no renderer attached), and
 * the tap wiring matches `Button`'s own press-vs-tap contract (`widgets.test.ts`).
 */
import { describe, it, expect } from 'vitest';
import { Graphics, Sprite, Text, Texture } from 'pixi.js';
import { BlueprintCard } from './BlueprintCard';

// Private fields, read the same way every other screen/widget test in this repo reads
// past `private` (WeaponCard.test.ts's `nameText`/`subText` getters, Forge.test.ts's
// `TestButton`/`TestCard` casts) — here there's no public getter for color/icon, so the
// cast reaches the field directly instead.
function innerOf(c: BlueprintCard) {
  return c as unknown as { bg: Graphics; icon: Sprite | null; name: Text };
}

const BASE = {
  key: '1',
  name: 'repeater',
  cost: 'PHY×3',
  status: 'craftable',
  statusColor: 0x68d391,
  borderColor: 0x63b3ed,
  selected: false,
  staged: 0,
  locked: false,
} as const;

// `g.context.instructions` gives `{action: 'fill'|'stroke', data: {style: {color, alpha,
// width}}}` per draw call — confirmed via a throwaway probe against a real `roundRect().
// fill().roundRect().stroke()` chain (this file's own `bg` drawing shape) before trusting
// it, same as Minimap.test.ts's own verification step.
function strokeColorOf(g: Graphics): number | undefined {
  return g.context.instructions.find((ins) => ins.action === 'stroke')?.data?.style?.color;
}

describe('BlueprintCard — text fields', () => {
  it('sets key/name/cost/status from set()', () => {
    const c = new BlueprintCard();
    c.set(BASE);
    expect(c.keyLabel).toBe('[1]');
    expect(c.nameLabel).toBe('repeater');
    expect(c.costLabel).toBe('PHY×3');
    expect(c.statusLabel).toBe('craftable');
  });

  it('shows no staged badge at staged=0, and a compact ▸×N badge once staged', () => {
    const c = new BlueprintCard();
    c.set(BASE);
    expect(c.stagedLabel).toBe('');
    c.set({ ...BASE, staged: 2 });
    expect(c.stagedLabel).toBe('▸×2');
  });

  it('repaints every field on a later set() (reused across pages, per Forge.ts)', () => {
    const c = new BlueprintCard();
    c.set(BASE);
    c.set({ ...BASE, key: '2', name: 'flamer', cost: 'FIR×3', status: 'need materials' });
    expect(c.keyLabel).toBe('[2]');
    expect(c.nameLabel).toBe('flamer');
    expect(c.costLabel).toBe('FIR×3');
    expect(c.statusLabel).toBe('need materials');
  });
});

describe('BlueprintCard — icon', () => {
  it('has no icon sprite until a texture is supplied', () => {
    const c = new BlueprintCard();
    c.set({ ...BASE, icon: undefined });
    expect(innerOf(c).icon).toBeNull();
  });

  it('adds an icon sprite once a texture is supplied', () => {
    const c = new BlueprintCard();
    c.set({ ...BASE, icon: Texture.WHITE });
    const icon = innerOf(c).icon;
    expect(icon).not.toBeNull();
    expect(icon!.texture).toBe(Texture.WHITE);
    expect(c.view.children).toContain(icon);
  });

  it('removes the icon sprite again once the texture goes away (unlocked → hidden mid-page-flip)', () => {
    const c = new BlueprintCard();
    c.set({ ...BASE, icon: Texture.WHITE });
    c.set({ ...BASE, icon: undefined });
    expect(innerOf(c).icon).toBeNull();
  });

  it('dims the icon when locked, full opacity when unlocked', () => {
    const c = new BlueprintCard();
    c.set({ ...BASE, icon: Texture.WHITE, locked: true });
    expect(innerOf(c).icon!.alpha).toBeLessThan(1);
    c.set({ ...BASE, icon: Texture.WHITE, locked: false });
    expect(innerOf(c).icon!.alpha).toBe(1);
  });
});

describe('BlueprintCard — border/name color (design/14 rarity border-not-hue convention)', () => {
  it('strokes the given borderColor when not the browse cursor', () => {
    const c = new BlueprintCard();
    c.set({ ...BASE, borderColor: 0xb794f4, selected: false });
    expect(strokeColorOf(innerOf(c).bg)).toBe(0xb794f4);
  });

  it('strokes a bright accent color instead, once selected — overrides borderColor', () => {
    const c = new BlueprintCard();
    c.set({ ...BASE, borderColor: 0xb794f4, selected: true });
    expect(strokeColorOf(innerOf(c).bg)).toBe(0x63b3ed);
    expect(strokeColorOf(innerOf(c).bg)).not.toBe(0xb794f4);
  });

  it('colors the name gray when locked, regardless of the rarity borderColor', () => {
    const c = new BlueprintCard();
    c.set({ ...BASE, borderColor: 0xf6e05e, locked: true });
    expect(innerOf(c).name.style.fill).toBe(0x718096);
  });

  it('colors the name with the rarity borderColor when unlocked', () => {
    const c = new BlueprintCard();
    c.set({ ...BASE, borderColor: 0xf6e05e, locked: false });
    expect(innerOf(c).name.style.fill).toBe(0xf6e05e);
  });
});

// Same press-vs-tap contract Button's own suite pins (widgets.test.ts) — a card sits in
// Forge's tap-anywhere screen the same way a row Button did, so it needs the same
// double-fire guard.
describe('BlueprintCard — tap wiring', () => {
  it('fires onTap on a completed pointertap, not on pointerdown alone', () => {
    const c = new BlueprintCard();
    let stopped = 0;
    let taps = 0;
    c.onTap = () => { taps += 1; };
    c.view.emit('pointerdown', { stopPropagation: () => { stopped += 1; } } as never);
    expect(taps).toBe(0);
    expect(stopped).toBe(1);
    c.view.emit('pointertap' as never);
    expect(taps).toBe(1);
  });

  it('does not throw when onTap is unset', () => {
    const c = new BlueprintCard();
    expect(() => c.view.emit('pointertap' as never)).not.toThrow();
  });
});
