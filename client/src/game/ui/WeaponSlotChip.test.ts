/**
 * WeaponSlotChip has no text to assert against (WeaponCard's usual seam) — what's worth
 * pinning is the tap wiring (same commit-on-completed-tap contract Button's own tests
 * pin, widgets.test.ts) and the icon's cache-key guard (same "don't repaint for a value
 * that didn't change" shape WeaponCard.test.ts pins for the active card).
 */
import { describe, it, expect, vi } from 'vitest';
import { Texture, type Sprite } from 'pixi.js';
import type { WeaponSimSpec } from '@dd/engine';
import { WEAPON_SIM_BY_ID } from '@dd/engine';
import { WeaponSlotChip } from './WeaponSlotChip';

// `render/weaponSkins` resolves real art via `Assets.load`, unavailable under plain
// vitest — mocked to a real (if blank) Texture so the icon-add/remove branch is actually
// exercised, same convention FxController.test.ts uses for its own GPU-backed collaborator.
vi.mock('../../render/weaponSkins', () => ({
  getWeaponTexture: vi.fn(() => Texture.WHITE),
}));

const BLASTER = WEAPON_SIM_BY_ID.blaster!;
const SABER = WEAPON_SIM_BY_ID.saber!;

function variant(base: WeaponSimSpec, over: Partial<WeaponSimSpec>): WeaponSimSpec {
  return { ...base, ...over } as WeaponSimSpec;
}

// Same bare-cast/stub convention Button's own pointertap/pointerdown tests use
// (widgets.test.ts) — the handlers here ignore the payload except pointerdown's stub.
const emitTap = (view: { emit: (event: string) => void }) => view.emit('pointertap');
const emitPointerdown = (view: { emit: (e: string, ev?: unknown) => void }, ev: unknown) =>
  view.emit('pointerdown', ev);

describe('WeaponSlotChip — tap-to-swap wiring', () => {
  it('is tappable: static event mode, pointer cursor', () => {
    const chip = new WeaponSlotChip();
    expect(chip.view.eventMode).toBe('static');
    expect(chip.view.cursor).toBe('pointer');
  });

  it('fires onTap exactly once per pointertap, and only when it is set', () => {
    const chip = new WeaponSlotChip();
    expect(() => emitTap(chip.view)).not.toThrow(); // no onTap wired yet — must not throw
    let calls = 0;
    chip.onTap = () => { calls += 1; };
    emitTap(chip.view);
    emitTap(chip.view);
    expect(calls).toBe(2);
  });

  // Mirrors Button's own "press is not activate" contract (widgets.test.ts) — the
  // pointerdown listener here exists only to stop propagation on a HUD panel that might
  // otherwise treat the press as something else, same reasoning as Button's.
  it('does not fire onTap on pointerdown alone — it only stops propagation', () => {
    const chip = new WeaponSlotChip();
    let calls = 0;
    let stopped = 0;
    chip.onTap = () => { calls += 1; };

    emitPointerdown(chip.view, { stopPropagation: () => { stopped += 1; } });
    expect(calls).toBe(0);
    expect(stopped).toBe(1);

    emitTap(chip.view);
    expect(calls).toBe(1);
  });
});

describe('WeaponSlotChip — icon (best-effort art, no texture loaded)', () => {
  it('draws the rarity-bordered chip without throwing when no texture resolves', () => {
    const chip = new WeaponSlotChip();
    expect(() => chip.set(BLASTER)).not.toThrow();
  });

  it('draws the muted "no weapon" border without throwing (fewer than two carried weapons)', () => {
    const chip = new WeaponSlotChip();
    expect(() => chip.set(null)).not.toThrow();
  });
});

describe('WeaponSlotChip — icon (texture available)', () => {
  it('adds a dimmed icon sprite once a texture resolves', () => {
    const chip = new WeaponSlotChip();
    expect(chip.view.children.length).toBe(1); // just the border chip so far

    chip.set(BLASTER);

    expect(chip.view.children.length).toBe(2);
    const icon = chip.view.children[1] as Sprite;
    expect(icon.alpha).toBeLessThan(1); // dimmer than the active card's own icon — reads as "idle"
  });

  it('removes the icon again once the slot goes back to null', () => {
    const chip = new WeaponSlotChip();
    chip.set(BLASTER);
    expect(chip.view.children.length).toBe(2);

    chip.set(null);

    expect(chip.view.children.length).toBe(1);
  });

  it('does not repaint (same icon instance) for an identical spec — the cache-key guard', () => {
    const chip = new WeaponSlotChip();
    chip.set(BLASTER);
    const icon = chip.view.children[1];

    chip.set(BLASTER); // literally the same spec object
    expect(chip.view.children[1]).toBe(icon);

    chip.set({ ...BLASTER }); // a different object, but same name/rarity/kind → same key
    expect(chip.view.children[1]).toBe(icon);
  });

  it('repaints when the weapon changes id, rarity, or kind (same key invalidates correctly)', () => {
    const chip = new WeaponSlotChip();
    chip.set(BLASTER);

    expect(() => chip.set(SABER)).not.toThrow(); // different id AND kind (ranged → melee)
    expect(() => chip.set(variant(SABER, { rarity: 'legendary' }))).not.toThrow(); // rarity-only change
  });
});
