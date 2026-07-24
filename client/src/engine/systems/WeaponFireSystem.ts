/**
 * Step 3 — Weapon fire. For every actor whose fire flag is set and whose weapon
 * cooldown is ready: ranged spawns a Projectile at the muzzle; melee starts a
 * swing (justSwung → HitResolve applies arc damage once at step 7, and DeflectSystem
 * parries bullets in the same arc at step 6). Cooldowns count down here in whole
 * ticks. Runs BEFORE movement (design/08) so a bullet spawns at this tick's muzzle,
 * then everything moves.
 *
 * Ports RangedWeapon.use() / MeleeWeapon.use() and the enemy-fire block of
 * Game.ts updateEnemies(): float cos/sin → fp-trig, px → grid-fp. Multi-pellet
 * spread jitter (combatPrng; content spreadDeg/bullets) is deferred to a later
 * stage — the demo weapons are all single pinpoint shots.
 */
import { addFp, mulFp } from '../math/fixed';
import { cosFp, sinFp } from '../math/trig';
import {
  buffedCooldown,
  buffedDamage,
  sumBuffs,
  NO_BUFFS,
  type BuffSums,
} from '../balance/runbuffs';
import type { GameState } from '../state/GameState';
import type { Actor, RangedSimSpec } from '../state/entities';

export class WeaponFireSystem {
  tick(state: GameState): void {
    // Run buffs are player-level (design/14): a player's summed-clamped stack scales
    // its damage + attack speed; enemies carry none (NO_BUFFS = identity), so their
    // fire is byte-for-byte unchanged.
    for (const p of state.players) this.actor(state, p, sumBuffs(p.buffs));
    for (const e of state.enemies) this.actor(state, e, NO_BUFFS);
  }

  private actor(state: GameState, a: Actor, buffs: BuffSums): void {
    const w = a.weapon;
    if (!w) return;
    w.justSwung = false;
    if (w.cooldownTicks > 0) w.cooldownTicks--;
    if (!a.alive || !a.firing || w.cooldownTicks > 0) return;

    if (w.spec.kind === 'ranged') {
      this.fireRanged(state, a, w.spec, buffs);
      w.cooldownTicks = buffedCooldown(w.spec.fireRateTicks, buffs);
    } else {
      w.justSwung = true;
      w.cooldownTicks = buffedCooldown(w.spec.swingCooldownTicks, buffs);
    }
  }

  private fireRanged(state: GameState, a: Actor, spec: RangedSimSpec, buffs: BuffSums): void {
    const cos = cosFp(a.facing);
    const sin = sinFp(a.facing);
    const gx = addFp(a.gx, mulFp(cos, spec.muzzleOffset));
    const gy = addFp(a.gy, mulFp(sin, spec.muzzleOffset));
    state.projectiles.push({
      id: state.nextId(),
      faction: a.faction,
      gx,
      gy,
      z: spec.bulletZ,
      vx: mulFp(cos, spec.bulletSpeed),
      vy: mulFp(sin, spec.bulletSpeed),
      radius: spec.bulletRadius,
      damage: buffedDamage(spec.damage, buffs), // buff frozen onto the bullet at fire time
      damageType: spec.damageType, // frozen onto the bullet (design/07 payload)
      lifeTicks: spec.bulletLifeTicks,
      alive: true,
    });
    state.events.push({ type: 'bullet_fired', faction: a.faction, gx, gy, facing: a.facing });
  }
}
