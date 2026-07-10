/**
 * Step 8 — Status effects (design/03/07 elements). Ticks the lingering on-hit
 * statuses that HitResolve (step 7) STARTED: burn and poison deal damage-over-time,
 * chill counts down (MovementSystem reads it to slow the actor). Runs AFTER hit
 * resolution and BEFORE death & drops (step 9) so a DoT kill is swept — and rolls a
 * drop — the same tick, exactly like a direct-hit kill.
 *
 * DoT lands on the global `state.tick % DOT_INTERVAL` cadence, so every burning /
 * poisoned actor ticks in lockstep — no per-actor clock field, fully deterministic
 * (design/06). Burn is one refreshing timer; poison is independent stacks, each
 * aged and expired on its own. All damage is integer and only lowers hp (death is
 * step 9's call, matching HitResolve). Applies to players and enemies uniformly.
 */
import { DOT_INTERVAL } from '../content/damage';
import type { GameState } from '../state/GameState';
import type { Actor } from '../state/entities';

export class StatusEffectSystem {
  tick(state: GameState): void {
    const dotTick = state.tick % DOT_INTERVAL === 0;
    for (const p of state.players) if (p.alive) this.actor(state, p, dotTick);
    for (const e of state.enemies) if (e.alive) this.actor(state, e, dotTick);
  }

  private actor(state: GameState, a: Actor, dotTick: boolean): void {
    const st = a.status;
    // The DoT source faction (fx colour) is the opposite of the sufferer's.
    const src = a.faction === 'enemy' ? 'player' : 'enemy';

    if (dotTick) {
      if (st.burnTicks > 0 && st.burnDmg > 0) {
        a.hp -= st.burnDmg;
        state.events.push({ type: 'hit', target: a.id, faction: src, gx: a.gx, gy: a.gy, damage: st.burnDmg, damageType: 'fire' });
        state.events.push({ type: 'status', effect: 'burn', target: a.id, gx: a.gx, gy: a.gy });
      }
      let poisonDmg = 0;
      for (const s of st.poison) poisonDmg += s.dmg;
      if (poisonDmg > 0) {
        a.hp -= poisonDmg;
        state.events.push({ type: 'hit', target: a.id, faction: src, gx: a.gx, gy: a.gy, damage: poisonDmg, damageType: 'poison' });
        state.events.push({ type: 'status', effect: 'poison', target: a.id, gx: a.gx, gy: a.gy });
      }
    }

    // Age every timer by one tick. Burn/chill reset their magnitude at expiry so a
    // later, weaker application can't inherit a stale value (HitResolve keeps the
    // MAX burn tick while active).
    if (st.burnTicks > 0 && --st.burnTicks === 0) st.burnDmg = 0;
    if (st.chillTicks > 0 && --st.chillTicks === 0) st.chillSlow = 0;
    if (st.poison.length > 0) {
      for (const s of st.poison) s.ticks--;
      // Remove expired stacks in place, preserving push order (deterministic).
      let w = 0;
      for (let r = 0; r < st.poison.length; r++) {
        const s = st.poison[r]!;
        if (s.ticks > 0) st.poison[w++] = s;
      }
      st.poison.length = w;
    }
  }
}
