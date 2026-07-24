/**
 * Step 7 — Hit resolution. Opposing-faction bullets that overlap cancel each other
 * (mutual destruction, resolved first so a cancelled bullet can't also hit an actor
 * this tick). Then bullet–actor overlap deals damage (enemy bullets vs players,
 * player/deflected bullets vs enemies) and consumes the bullet; a melee swing that
 * started this tick (justSwung) deals arc damage to every enemy in its sector, once.
 * Damage only lowers hp here — death is decided in step 9, matching design/08's
 * separation. The projectiles array is compacted in place at the end, after
 * clash/step/block/hit have all resolved.
 *
 * Every hit funnels through one resolver, `applyHit` (design/07 "one shared
 * resolver"): apply the target's per-type resist, subtract integer damage, then —
 * by the hit's DamageType — layer the on-hit status (burn/chill/poison) or arc to a
 * neighbour (lightning). The lingering DoT/chill is ticked later by
 * StatusEffectSystem (step 8); `applyHit` only *starts* the effect. All status math
 * is integer (design/06); the chain uses squared-distance nearest, no trig.
 *
 * Ports the hit branches of Game.ts updateBullets()/resolveMeleeHit(); radians →
 * brad, float px → fp, squared-distance overlap tests. Knockback / armor / i-frames
 * are design/07 and land later. (The demo's per-frame multi-hit melee is corrected
 * to once-per-swing, per design/07.)
 */
import { atan2Brad, bradDiff, type Brad } from '../math/trig';
import { inBeamLine } from '../content/ballistics';
import type { GameState } from '../state/GameState';
import type { Actor, Faction, MeleeSimSpec, Projectile } from '../state/entities';
import { isDowned } from '../state/entities';
import type { DamageType } from '../content/damage';
import {
  BURN_DURATION,
  CHAIN_DMG_PERMILLE,
  CHAIN_RANGE,
  CHILL_DURATION,
  CHILL_SLOW,
  POISON_MAX_STACKS,
  POISON_STACK_DMG,
  POISON_STACK_DURATION,
  applyResist,
  burnDamageFor,
} from '../content/damage';
import { buffedDamage, sumBuffs } from '../balance/runbuffs';
import { takeDamage } from './combat';
import { circlesOverlap, retainAlive } from './geom';

export class HitResolveSystem {
  tick(state: GameState): void {
    // Lob landings + beam channels (design/03/09, ROADMAP 1.1) resolve first: a
    // landed lob is about to die this tick regardless, and a beam bullet never
    // moves/clashes/direct-hits like a normal bullet — both are handled entirely
    // through these dedicated passes, then excluded below.
    this.resolveLandedLobs(state);
    this.resolveBeams(state);
    this.resolveBulletClash(state);

    for (const b of state.projectiles) {
      if (!b.alive || b.ballistic === 'beam' || b.landed) continue;
      if (b.faction === 'enemy') {
        for (const p of state.players) {
          if (!p.alive || p.downed) continue; // downed players are invulnerable (design/07, 3.2)
          if (!circlesOverlap(b.gx, b.gy, b.radius, p.gx, p.gy, p.radius)) continue;
          this.applyHit(state, p, b.damage, b.damageType, 'enemy', state.players);
          b.alive = false;
          break;
        }
      } else {
        for (const e of state.enemies) {
          if (!e.alive) continue;
          if (!circlesOverlap(b.gx, b.gy, b.radius, e.gx, e.gy, e.radius)) continue;
          this.applyHit(state, e, b.damage, b.damageType, 'player', state.enemies);
          b.alive = false;
          break;
        }
      }
    }

    for (const p of state.players) {
      const w = p.weapon;
      if (!p.alive || p.downed || !w || w.spec.kind !== 'melee' || !w.justSwung) continue;
      this.meleeArc(state, p, w.spec);
    }

    retainAlive(state.projectiles);
  }

  /** Lob landing (design/03/09): a bullet ProjectileStepSystem flagged `landed` this
   * tick detonates through the normal resist/status hit path against every
   * opposite-faction actor within `blastRadius`, then dies — no direct-hit special
   * case (a lob that connects mid-flight already consumed itself as a normal hit,
   * above, before ever reaching landed). */
  private resolveLandedLobs(state: GameState): void {
    for (const b of state.projectiles) {
      if (!b.alive || !b.landed || b.blastRadius === undefined) continue;
      const targets: readonly Actor[] = b.faction === 'player' ? state.enemies : state.players;
      const attacker: Faction = b.faction === 'player' ? 'player' : 'enemy';
      for (const t of targets) {
        if (!t.alive || isDowned(t)) continue; // downed players are invulnerable (3.2)
        const dx = (t.gx - b.gx) as number;
        const dy = (t.gy - b.gy) as number;
        const reach = (b.blastRadius + t.radius) as number;
        if (dx * dx + dy * dy > reach * reach) continue;
        this.applyHit(state, t, b.damage, b.damageType, attacker, targets);
      }
      b.alive = false;
    }
  }

  /**
   * Beam channels (design/03/09): a beam bullet never moves (frozen at its fire-time
   * origin/direction); on the global `state.tick % beamTickInterval` cadence — the
   * same lockstep pattern StatusEffectSystem uses for DoT (design/07: no per-instance
   * clock) — it damages every opposite-faction actor along its line, once per
   * cadence tick, for as long as it stays alive (ProjectileStepSystem counts down
   * `beamTicksLeft` and kills it at 0).
   */
  private resolveBeams(state: GameState): void {
    for (const b of state.projectiles) {
      if (!b.alive || b.ballistic !== 'beam') continue;
      if (!b.beamTickInterval || state.tick % b.beamTickInterval !== 0) continue;
      const targets: readonly Actor[] = b.faction === 'player' ? state.enemies : state.players;
      const attacker: Faction = b.faction === 'player' ? 'player' : 'enemy';
      const dir = b.beamDir ?? (0 as Brad);
      const range = b.beamRange ?? (0 as Projectile['radius']);
      for (const t of targets) {
        if (!t.alive || isDowned(t)) continue; // downed players are invulnerable (3.2)
        if (!inBeamLine(b.gx, b.gy, dir, range, t.gx, t.gy, t.radius)) continue;
        this.applyHit(state, t, b.damage, b.damageType, attacker, targets);
      }
    }
  }

  /**
   * The single shared hit resolver (design/07). `attacker` is the source faction
   * (drives the 'hit' fx colour); `group` is the array the target belongs to, used
   * as the lightning chain's candidate pool. Applies resist → integer damage →
   * on-hit status. Death is NOT decided here (step 9). All arithmetic is integer.
   */
  private applyHit(
    state: GameState,
    target: Actor,
    rawDamage: number,
    type: DamageType,
    attacker: Faction,
    group: readonly Actor[],
  ): void {
    const dmg = applyResist(rawDamage, type, target.resist);
    // Shield-first absorb + hit event + shield_break (design/07 two-pool takeDamage).
    takeDamage(state, target, dmg, attacker, type);
    // Status magnitude keys off the resisted hit, independent of how it split shield/hp.
    this.applyStatus(state, target, dmg, type, group);
  }

  /** Layer the element's on-hit effect. `dmg` is the post-resist damage just dealt. */
  private applyStatus(
    state: GameState,
    target: Actor,
    dmg: number,
    type: DamageType,
    group: readonly Actor[],
  ): void {
    const st = target.status;
    switch (type) {
      case 'fire': {
        // Burn REFRESHES: reset the timer, keep the stronger tick (design: fire is a
        // topped-up DoT, not a stacking one).
        st.burnTicks = BURN_DURATION;
        st.burnDmg = Math.max(st.burnDmg, burnDamageFor(dmg));
        state.events.push({ type: 'status', effect: 'burn', target: target.id, gx: target.gx, gy: target.gy });
        break;
      }
      case 'ice': {
        st.chillTicks = CHILL_DURATION;
        st.chillSlow = CHILL_SLOW;
        state.events.push({ type: 'status', effect: 'chill', target: target.id, gx: target.gx, gy: target.gy });
        break;
      }
      case 'poison': {
        // STACKING DoT: each hit adds an independent stack (up to the cap). Oldest
        // stacks age out on their own timers (StatusEffectSystem). Cap by dropping
        // the new hit when full — the oldest keeps ticking (deterministic).
        if (st.poison.length < POISON_MAX_STACKS) {
          st.poison.push({ ticks: POISON_STACK_DURATION, dmg: POISON_STACK_DMG });
        }
        state.events.push({ type: 'status', effect: 'poison', target: target.id, gx: target.gx, gy: target.gy });
        break;
      }
      case 'lightning': {
        // CHAIN: arc to the nearest OTHER alive actor in the target's own group,
        // within range, for a fraction of the hit. One hop, no further status (no
        // recursion). Nearest by squared distance; ties broken by array order (08).
        this.chain(state, target, dmg, group);
        state.events.push({ type: 'status', effect: 'shock', target: target.id, gx: target.gx, gy: target.gy });
        break;
      }
      case 'physical':
        break; // raw damage only
    }
  }

  /** Lightning arc: deal a fraction of `dmg` to the nearest other in-group actor in range. */
  private chain(state: GameState, from: Actor, dmg: number, group: readonly Actor[]): void {
    let best: Actor | null = null;
    let bestSq = Infinity;
    const reachSq = CHAIN_RANGE * CHAIN_RANGE;
    for (const a of group) {
      if (!a.alive || a === from) continue;
      const dx = a.gx - from.gx;
      const dy = a.gy - from.gy;
      const d = dx * dx + dy * dy;
      if (d > reachSq || d >= bestSq) continue;
      bestSq = d;
      best = a;
    }
    if (!best) return;
    const chainDmg = Math.max(1, Math.trunc((dmg * CHAIN_DMG_PERMILLE) / 1000));
    // A chained hit is a hit: shield-first, and it can break a shield too (design/07).
    takeDamage(state, best, chainDmg, from.faction === 'enemy' ? 'player' : 'enemy', 'lightning');
    state.events.push({ type: 'status', effect: 'shock', target: best.id, gx: best.gx, gy: best.gy });
  }

  /**
   * Opposing-faction bullets that overlap annihilate each other. O(n²) over the
   * live bullets, i<j so each pair is tested once; ties/order are the array's push
   * order, so the outcome is deterministic (design/08). A bullet cancels at most
   * one other per tick (marked dead on first clash), which is enough — anything
   * still alive falls through to the actor-hit loop below.
   */
  private resolveBulletClash(state: GameState): void {
    const ps = state.projectiles;
    for (let i = 0; i < ps.length; i++) {
      const a = ps[i]!;
      if (!a.alive || a.ballistic === 'beam' || a.landed) continue;
      for (let j = i + 1; j < ps.length; j++) {
        const b = ps[j]!;
        if (!b.alive || b.faction === a.faction || b.ballistic === 'beam' || b.landed) continue;
        if (!circlesOverlap(a.gx, a.gy, a.radius, b.gx, b.gy, b.radius)) continue;
        a.alive = false;
        b.alive = false;
        state.events.push({ type: 'clash', gx: a.gx, gy: a.gy });
        break; // a is gone — move to the next bullet
      }
    }
  }

  private meleeArc(state: GameState, p: GameState['players'][number], spec: MeleeSimSpec): void {
    // Player run buffs scale outgoing arc damage (design/14; enemies never swing melee).
    const damage = buffedDamage(spec.damage, sumBuffs(p.buffs));
    for (const e of state.enemies) {
      if (!e.alive) continue;
      const dx = e.gx - p.gx;
      const dy = e.gy - p.gy;
      const reach = spec.range + e.radius;
      if (dx * dx + dy * dy > reach * reach) continue;
      const ang = atan2Brad(dy, dx);
      if (Math.abs(bradDiff(ang, p.facing)) > spec.arcHalf) continue;
      this.applyHit(state, e, damage, spec.damageType, 'player', state.enemies);
    }
  }
}
