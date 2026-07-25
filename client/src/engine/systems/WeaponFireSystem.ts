/**
 * Step 3 — Weapon fire. For every actor whose fire flag is set and whose weapon
 * cooldown is ready: ranged spawns Projectile(s) at the muzzle; melee starts a
 * swing (justSwung → HitResolve applies arc damage once at step 7, and DeflectSystem
 * parries bullets in the same arc at step 6). Cooldowns count down here in whole
 * ticks. Runs BEFORE movement (design/08) so a bullet spawns at this tick's muzzle,
 * then everything moves.
 *
 * Ports RangedWeapon.use() / MeleeWeapon.use() and the enemy-fire block of
 * Game.ts updateEnemies(): float cos/sin → fp-trig, px → grid-fp.
 *
 * Emission (design/03 "orthogonal to ballistic", ROADMAP 1.1): `bullets` pellets
 * fire per trigger; for bullets > 1 each pellet's angle jitters within ±spreadHalf,
 * drawn from combatPrng (a single-pellet pinpoint shot draws nothing — the baseline
 * guns advance no new PRNG stream). The ballistic id + its params are frozen onto
 * each spawned Projectile, exactly like damageType (design/07 payload) — motion
 * (ProjectileStepSystem) and the beam's damage-over-window (HitResolveSystem) read
 * them from there, never re-reading the spec.
 */
import { addFp, mulFp } from '../math/fixed';
import { cosFp, sinFp, normBrad, type Brad } from '../math/trig';
import { radialDir } from '../content/ballistics';
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
    const pellets = Math.max(1, spec.bullets);
    for (let i = 0; i < pellets; i++) {
      // Radial emission (design/03): an even ring around facing, DETERMINISTIC — no PRNG
      // draw at all. Orthogonal to the ballistic each pellet then flies with.
      // Spread emission (the default / baseline): a single-pellet pinpoint shot draws
      // nothing (byte-identical to the pre-1.1 baseline); a >1-pellet spread weapon
      // jitters each pellet within ±spreadHalf from combatPrng.
      const dir: Brad =
        spec.pattern === 'radial' && pellets > 1
          ? radialDir(a.facing, i, pellets)
          : pellets > 1 && spec.spreadHalf > 0
            ? normBrad(a.facing + (state.combatPrng.nextInt(spec.spreadHalf * 2 + 1) - spec.spreadHalf))
            : a.facing;
      this.spawnBullet(state, a, spec, dir, buffs);
    }
  }

  private spawnBullet(state: GameState, a: Actor, spec: RangedSimSpec, dir: Brad, buffs: BuffSums): void {
    const cos = cosFp(dir);
    const sin = sinFp(dir);
    const gx = addFp(a.gx, mulFp(cos, spec.muzzleOffset));
    const gy = addFp(a.gy, mulFp(sin, spec.muzzleOffset));
    state.projectiles.push({
      id: state.nextId(),
      faction: a.faction,
      teamId: a.teamId, // design/15 — the targeting predicate reads this, not faction
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
      // Ballistic runtime (design/03/09, ROADMAP 1.1) — frozen from the spec, like
      // damageType above. 'straight' reads none of the optional params.
      ballistic: spec.ballistic,
      turnRateBrad: spec.turnRateBrad,
      speed: spec.ballistic === 'homing' ? spec.bulletSpeed : undefined,
      returnAfterTicks: spec.returnAfterTicks,
      ticksAlive: spec.ballistic === 'boomerang' ? 0 : undefined,
      blastRadius: spec.blastRadius,
      beamTicksLeft: spec.beamTicks,
      beamTickInterval: spec.beamTickInterval,
      beamDir: spec.ballistic === 'beam' ? dir : undefined,
      beamRange: spec.beamRange,
      // orbit: pin to the owner and start the angle at the fire direction. bulletSpeed is
      // authored 0 (orbit doesn't travel), so vx/vy above are already 0 — the standard
      // integrate is a no-op and ProjectileStepSystem drives the circular motion instead.
      ownerId: spec.ballistic === 'orbit' ? a.id : undefined,
      orbitRadius: spec.orbitRadius,
      orbitAngleBrad: spec.ballistic === 'orbit' ? dir : undefined,
      orbitAngularVelBrad: spec.orbitAngularVelBrad,
    });
    state.events.push({ type: 'bullet_fired', faction: a.faction, gx, gy, facing: dir });
  }
}
