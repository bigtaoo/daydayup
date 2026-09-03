/**
 * `swapNeededForSlot` — the weapon-button → SWAP_WEAPON bridge (design/05/10 controls).
 *
 * The bug this pins: Game.ts's `onSwitchWeapon` handler took a `slot` argument and
 * discarded it, calling `requestSwap()` unconditionally. Both on-screen weapon buttons
 * (and both digit keys) therefore did the identical thing — a toggle — so "weapon 2"
 * pressed while slot 2 was active switched you off it. Every test below is written so it
 * would FAIL against that unconditional toggle, which the `already active` cases are; the
 * `other slot` cases are the ones that would fail against a blanket "never swap".
 */
import { describe, it, expect } from 'vitest';
import { swapNeededForSlot } from './weaponSlotSelect';

const SLOTS = 2; // PLAYER_BASE.weaponSlots; passed explicitly by the caller

describe('swapNeededForSlot', () => {
  it('pressing the button for the slot already active is a no-op', () => {
    expect(swapNeededForSlot(0, 1, SLOTS)).toBe(false);
    expect(swapNeededForSlot(1, 2, SLOTS)).toBe(false);
  });

  it('pressing the button for the other slot swaps', () => {
    expect(swapNeededForSlot(0, 2, SLOTS)).toBe(true);
    expect(swapNeededForSlot(1, 1, SLOTS)).toBe(true);
  });

  it('is idempotent: holding one slot and pressing it repeatedly never swaps', () => {
    for (let i = 0; i < 5; i++) expect(swapNeededForSlot(1, 2, SLOTS)).toBe(false);
  });

  it('a slot number outside the loadout is not a swap', () => {
    expect(swapNeededForSlot(0, 3, SLOTS)).toBe(false); // a third button would name nothing
    expect(swapNeededForSlot(0, 0, SLOTS)).toBe(false); // 1-based; 0 is not a control
    expect(swapNeededForSlot(0, -1, SLOTS)).toBe(false);
    expect(swapNeededForSlot(0, 1.5, SLOTS)).toBe(false);
  });

  it('an unreadable active slot falls back to the toggle rather than eating the press', () => {
    // Not reachable from the shipped call site (gated on phase === 'playing'), but the
    // alternative default — swallow the input — is the worse failure for a control.
    expect(swapNeededForSlot(undefined, 1, SLOTS)).toBe(true);
    expect(swapNeededForSlot(undefined, 2, SLOTS)).toBe(true);
  });

  it('scales to a wider loadout without a second rule', () => {
    expect(swapNeededForSlot(2, 3, 3)).toBe(false);
    expect(swapNeededForSlot(2, 1, 3)).toBe(true);
    expect(swapNeededForSlot(2, 4, 3)).toBe(false);
  });
});
