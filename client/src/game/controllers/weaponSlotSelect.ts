/**
 * Weapon-button → SWAP_WEAPON policy (design/05/10 controls).
 *
 * The two on-screen weapon buttons (`platform/TouchControls.ts`'s `weapon1Btn`/`weapon2Btn`)
 * and the `Digit1`/`Digit2` keys are labelled as SLOT PICKERS — design/10 calls them
 * "weapon-1 / weapon-2" — and they each pass the slot they mean to `onSwitchWeapon(slot)`.
 * The engine, however, only offers a TOGGLE: `Button.SWAP_WEAPON` flips `activeSlot`
 * (design/08), because with `WEAPON_SLOTS === 2` a toggle is a complete control surface.
 *
 * Game.ts used to bridge those two by discarding the argument and toggling unconditionally,
 * which made both buttons do the identical thing: pressing "weapon 2" while slot 2 was
 * already active switched you to slot 1 — a labelled control that does the opposite of its
 * label every other press. This is the missing half of that bridge: a press only becomes a
 * swap request when the slot it names is not already the active one. Idempotent presses
 * become no-ops, which is what a slot picker means.
 *
 * Pure, and separate from Game.ts, for the same reason `confirmEdge.ts` is: input policy is
 * the part worth testing, and Game.ts needs a Pixi application to construct.
 *
 * The HUD's idle-slot chip is deliberately NOT routed through here (`HudView.onSwapWeapon`):
 * it names no slot — "tap the other slot" IS a toggle — so it calls `requestSwap()` directly.
 */
import { PLAYER_BASE } from '@dd/engine';

/**
 * Should a `onSwitchWeapon(requestedSlot)` press turn into a `SWAP_WEAPON` request?
 *
 * @param activeSlot  the local player's current `activeSlot` (0-based), or `undefined` when
 *                    the live state cannot be read.
 * @param requestedSlot the 1-based slot the pressed control names.
 * @param slotCount   how many slots exist (`PLAYER_BASE.weaponSlots`).
 */
export function swapNeededForSlot(
  activeSlot: number | undefined,
  requestedSlot: number,
  slotCount: number,
): boolean {
  // A control naming a slot that does not exist is not a swap by any reading.
  if (!Number.isInteger(requestedSlot) || requestedSlot < 1 || requestedSlot > slotCount) return false;
  // No readable state (no run yet / online before match_start): fall back to the toggle, so
  // the button still does SOMETHING rather than silently eating the press. Not reachable
  // from the shipped call site, which is already gated on `phase === 'playing'`.
  if (activeSlot === undefined) return true;
  return activeSlot !== requestedSlot - 1;
}

/**
 * The shipped call site's form: same rule, against this game's own slot count. Split from the
 * fully-parameterized core above so Game.ts needs one import and one line for the whole
 * bridge — Game.ts is baselined debt under CLAUDE.md's 500-line convention, so a control-flow
 * detail that can live in its own module has to.
 */
export function shouldSwapToSlot(activeSlot: number | undefined, requestedSlot: number): boolean {
  return swapNeededForSlot(activeSlot, requestedSlot, PLAYER_BASE.weaponSlots);
}
