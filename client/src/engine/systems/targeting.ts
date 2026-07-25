/**
 * Hostile-target pooling (design/15 — the PvP team/hostility model, ROADMAP
 * 4.2a). Every combat system used to pick "the opposite array" via a hardcoded
 * `faction === 'player' ? state.enemies : state.players` ternary — an
 * assumption baked in that there are only ever two sides. That breaks the
 * moment two players can be on different teams (PvP) or the same team
 * (squads): the correct question was never "which array," it's "who is
 * hostile to me," which spans both arrays and can exclude members of either.
 *
 * `hostileTargets`/`nearestHostile` are the shared replacement, used by
 * HitResolveSystem, DeflectSystem, ProjectileStepSystem, and combat.ts.
 * Iteration is players-then-enemies, matching every other array-order-is-the-
 * tiebreak convention in the engine (design/06) — deterministic regardless of
 * how many teams are actually in play.
 */
import type { Fp } from '../math/fixed';
import type { GameState } from '../state/GameState';
import { isDowned, isHostile, type Actor, type Teamed } from '../state/entities';

/**
 * Every alive actor hostile to `self` that a hit/target query is allowed to
 * reach. Downed players are excluded unconditionally — they are invulnerable
 * and untargetable regardless of who's asking (design/07, ROADMAP 3.2) — so
 * every caller gets that guarantee for free instead of repeating the check.
 */
export function hostileTargets(state: GameState, self: Teamed): Actor[] {
  const out: Actor[] = [];
  for (const p of state.players) {
    if (p.alive && !isDowned(p) && isHostile(self, p)) out.push(p);
  }
  for (const e of state.enemies) {
    if (e.alive && isHostile(self, e)) out.push(e);
  }
  return out;
}

/** Nearest hostile actor to a point, or null. Ties broken by array order
 * (players before enemies, then push order within each) — deterministic
 * (design/06). Used for a deflected bullet's new target and homing's turn. */
export function nearestHostile(state: GameState, self: Teamed, x: Fp, y: Fp): Actor | null {
  let best: Actor | null = null;
  let bestSq = Infinity;
  for (const t of hostileTargets(state, self)) {
    const dx = (t.gx - x) as number;
    const dy = (t.gy - y) as number;
    const d = dx * dx + dy * dy;
    if (d < bestSq) {
      bestSq = d;
      best = t;
    }
  }
  return best;
}
