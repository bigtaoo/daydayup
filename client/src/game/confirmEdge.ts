// Which screen the game is currently showing. 'settings' is a full screen rather than
// an overlay (Game tracks which phase to return to via settingsReturnPhase). 'squad' is
// the PvP pre-formed-party lobby (design/05/15's squad follow-up) — the first runtime
// (not boot-flag) entry point into PvP.
export type Phase =
  | 'menu' | 'forge' | 'playing' | 'paused'
  | 'victory' | 'defeat' | 'settings' | 'squad' | 'account';

/**
 * Whether a screen accepts a raw fire-button edge as "confirm".
 *
 * ONLY the result screens do. This path is the fire-button fallback for Screens.ts's
 * own tap-anywhere-to-confirm (its `pointerdown` handler) and predates design/10's real
 * button UI — every other screen has real Buttons now and must be driven exclusively by
 * them.
 *
 * Letting it run anywhere else is a real bug, not a redundancy: `firing` is the raw
 * left-mouse-down state (WebInput sets it on `mousedown`), so on `menu`/`forge` the
 * confirm fired the instant a button went DOWN — before Pixi could deliver that
 * button's own `pointertap` on the way back UP. A human click holds for ~100ms, i.e.
 * several frames, so the poll always won the race: every main menu button collapsed
 * into "mouse-down anywhere → showForge()", and every forge button into "→ beginRun()",
 * with the intended tap swallowed because the confirm had already hidden the screen the
 * press started on. Synthetic clicks never reproduce it — they press and release inside
 * a single frame, so the poll never observes the rising edge at all.
 */
export function acceptsFireConfirm(phase: Phase): boolean {
  return phase === 'victory' || phase === 'defeat';
}

/** Rising-edge detection, gated by `acceptsFireConfirm`. */
export function shouldConfirmOnFireEdge(phase: Phase, firing: boolean, prevFiring: boolean): boolean {
  return acceptsFireConfirm(phase) && firing && !prevFiring;
}
