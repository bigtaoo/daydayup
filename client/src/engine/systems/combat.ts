/**
 * Shared damage application (design/07 two-pool `takeDamage`). Every damage source —
 * a direct bullet/melee hit, a lightning chain, a burn/poison DoT tick — routes
 * through here so the shield-first absorb, the idle-regen timer reset, and the
 * shield-break event are defined in ONE place (HitResolveSystem + StatusEffectSystem
 * both call it).
 *
 * Absorb order (design/07): shield soaks first, overflow spills to hp. ANY damage
 * resets `ticksSinceHit` to 0 (a lingering DoT therefore keeps shield regen
 * suppressed — "clear your status to recover"). If the hit emptied a previously
 * non-empty shield, a `shield_break` event fires (render fx + the 0.5 break passive).
 * Death is still decided later (step 9), matching the rest of combat — this only
 * lowers pools. All arithmetic is integer (design/06).
 */
import type { GameState } from '../state/GameState';
import type { Actor, Faction } from '../state/entities';
import type { DamageType } from '../content/damage';

/**
 * Apply `dmg` (already resisted) to `target`, shield-first. `src` is the attacker
 * faction (drives the hit fx colour); the hit event is emitted at the target's
 * position with the remaining shield attached. Emits `shield_break` on depletion.
 */
export function takeDamage(
  state: GameState,
  target: Actor,
  dmg: number,
  src: Faction,
  type: DamageType,
): void {
  target.ticksSinceHit = 0;
  const hadShield = target.shield > 0;
  if (target.shield >= dmg) {
    target.shield -= dmg;
  } else {
    target.hp -= dmg - target.shield;
    target.shield = 0;
  }
  state.events.push({
    type: 'hit',
    target: target.id,
    faction: src,
    gx: target.gx,
    gy: target.gy,
    damage: dmg,
    damageType: type,
    shieldRemaining: target.shield,
  });
  if (hadShield && target.shield === 0) {
    state.events.push({ type: 'shield_break', id: target.id, gx: target.gx, gy: target.gy });
  }
}
