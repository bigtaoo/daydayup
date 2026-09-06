/**
 * Melee mobs (ENGINE_VERSION 59, design/05 — *"近战的怪也加上一些"*). The roster's first
 * two enemies that hit you with a blade instead of a bullet.
 *
 * This file is about the two constraints that used to hold each other up, and what
 * breaks if either comes back:
 *
 *   - `EnemyBlueprint.weapon` was typed `RangedSimSpec`, so a melee mob could not be
 *     authored at all;
 *   - `HitResolveSystem`'s melee pass looped `state.players` only, so a melee mob
 *     authored anyway would have walked up, played its swing, and dealt nothing.
 *
 * Both are now open, which means a swing that does no damage is a silent failure —
 * exactly the shape design/18 warns about, and the reason the damage assertion below
 * goes through the real engine step order rather than calling `meleeArc` directly.
 */
import { describe, it, expect } from 'vitest';
import { createGameState, type GameState } from '@dd/engine/state/GameState';
import { HitResolveSystem, WeaponFireSystem } from '@dd/engine/systems';
import {
  buildEnemyActor,
  DEFAULT_ENEMY_MOVE_SPEED_PER_TICK,
  ENEMY_BLUEPRINTS,
  RAVAGER,
  STALKER,
} from '@dd/engine/content/enemies';
import { PLAYER_BASE } from '@dd/engine/content/players';
import { pxToFp } from '@dd/engine/content/convert';
import { openSwing } from '@dd/engine/content/weapons';
import type { MeleeSimSpec } from '@dd/engine/state/entities';

const CFG = { seed: 3, worldW: 800, worldH: 800, waves: [] as const };

const MELEE_TYPES = ['stalker', 'ravager'] as const;

/** A melee mob standing right on top of player 0, facing it, swinging this tick. */
function swingingAt(s: GameState, type: string) {
  const p = s.players[0]!;
  const e = buildEnemyActor(s, p.gx, p.gy, type);
  // Two body radii apart along +x, well inside every mob blade's reach, and face it.
  e.gx = (p.gx - pxToFp(20)) as typeof e.gx;
  e.facing = 0 as typeof e.facing;
  e.weapon!.cooldownTicks = 0;
  e.firing = true;
  s.enemies.push(e);
  return { p, e };
}

describe('the roster now has melee mobs at all', () => {
  it('exactly two blueprints carry a melee loadout, and they are the named ones', () => {
    const melee = Object.entries(ENEMY_BLUEPRINTS)
      .filter(([, bp]) => bp.weapon.kind === 'melee')
      .map(([type]) => type);
    expect(melee.sort()).toEqual([...MELEE_TYPES].sort());
  });

  it('every OTHER blueprint is still ranged — this pass converted nothing by accident', () => {
    const ranged = Object.entries(ENEMY_BLUEPRINTS)
      .filter(([type]) => !(MELEE_TYPES as readonly string[]).includes(type))
      .filter(([, bp]) => bp.weapon.kind !== 'ranged')
      .map(([type]) => type);
    expect(ranged).toEqual([]);
  });

  it('neither mob blade deflects — parry stays the player’s mechanic', () => {
    // Recorded in `weaponSpecs/dropOnly.ts` as a deliberate no: a mob that parries your
    // bullets back inverts design/03's core mechanic and makes the ranged half of a
    // loadout strictly worse against exactly the mobs it exists to counter.
    for (const type of MELEE_TYPES) {
      const spec = ENEMY_BLUEPRINTS[type]!.weapon as MeleeSimSpec;
      expect(spec.deflect, `${type} parries`).toBe(false);
    }
  });

  it('each one stops INSIDE its own blade’s reach, or it could never land a hit', () => {
    // The one number that makes a melee mob work, and the one nothing else would catch:
    // `engageRangeFp` is what `AIDecideSystem` walks the mob to, and `range` is what
    // `meleeArc` measures. Set the first larger than the second and the mob parks just
    // out of its own reach and flails forever — a softlock-shaped bug that reads on
    // screen as "the monster is attacking but nothing happens".
    for (const type of MELEE_TYPES) {
      const bp = ENEMY_BLUEPRINTS[type]!;
      const spec = bp.weapon as MeleeSimSpec;
      const reach = (spec.range as number) + (PLAYER_BASE.radius as number);
      expect(bp.engageRangeFp, `${type} has no engage range of its own`).toBeDefined();
      expect(bp.engageRangeFp! as number, `${type} stands outside its own reach`).toBeLessThan(reach);
    }
  });

  it('the rusher is faster than the roster default but still slower than the player', () => {
    // Both halves matter. Faster than the default is what makes it a rusher; slower than
    // the player is the roster-wide rule from the v42 retune — backing off has to keep
    // opening a gap, or there is no counterplay to closing distance at all.
    expect(STALKER.moveSpeedPerTick! as number).toBeGreaterThan(DEFAULT_ENEMY_MOVE_SPEED_PER_TICK as number);
    expect(STALKER.moveSpeedPerTick! as number).toBeLessThan(PLAYER_BASE.speedPerTick as number);
  });

  it('the heavy is NOT faster — a wide sweep you cannot walk away from has no answer', () => {
    expect(RAVAGER.moveSpeedPerTick).toBeUndefined(); // takes the roster default
  });

  it('the two are opposite reads, not a re-skin', () => {
    const claw = STALKER.weapon as MeleeSimSpec;
    const maul = RAVAGER.weapon as MeleeSimSpec;
    expect(claw.arcHalf).toBeLessThan(maul.arcHalf); // narrow lunge vs wide sweep
    expect(claw.swingCooldownTicks).toBeLessThan(maul.swingCooldownTicks); // quick vs slow
    expect(claw.damage).toBeLessThan(maul.damage);
    expect(STALKER.maxHp).toBeLessThan(RAVAGER.maxHp);
  });
});

describe('a melee mob actually damages the player (HitResolveSystem, ENGINE_VERSION 59)', () => {
  it('lands its swing on a player inside the arc', () => {
    for (const type of MELEE_TYPES) {
      const s = createGameState(CFG);
      const { p, e } = swingingAt(s, type);
      const before = p.hp + p.shield;
      s.tick++;
      new WeaponFireSystem().tick(s); // opens the swing window
      new HitResolveSystem().tick(s);
      expect(p.hp + p.shield, `${type} swung and dealt nothing`).toBeLessThan(before);
      expect(e.weapon!.swingHitIds).toContain(p.id);
    }
  });

  it('hits each body at most once across the WHOLE window, not once per active tick', () => {
    // design/07's "one swing, one attack". A mob blade with a 10-tick window (enemymaul)
    // would otherwise deal its damage ten times over.
    const s = createGameState(CFG);
    const { p, e } = swingingAt(s, 'ravager');
    const spec = e.weapon!.spec as MeleeSimSpec;
    expect(spec.swingTicks).toBeGreaterThan(1); // the case this is about
    const before = p.hp + p.shield;
    const fire = new WeaponFireSystem();
    const hit = new HitResolveSystem();
    for (let i = 0; i < spec.swingTicks; i++) {
      s.tick++;
      s.clearEvents();
      e.firing = i === 0; // one trigger, then hold the window open
      fire.tick(s);
      hit.tick(s);
    }
    // `toBeCloseTo`, not `toBe`: a character's shield pool is authored as a decimal
    // (`SkinDef.maxShield`, e.g. 3.2), so `hp + shield` carries float error that has
    // nothing to do with what this test is measuring. The damage itself is an integer.
    expect(before - (p.hp + p.shield)).toBeCloseTo(spec.damage, 6);
  });

  it('misses a player standing outside the arc, even at point-blank range', () => {
    const s = createGameState(CFG);
    const { p, e } = swingingAt(s, 'stalker');
    e.facing = 32768 as typeof e.facing; // 180 brad — turned fully away
    const before = p.hp + p.shield;
    s.tick++;
    new WeaponFireSystem().tick(s);
    new HitResolveSystem().tick(s);
    expect(p.hp + p.shield).toBe(before);
  });

  it('attributes the hit to the ENEMY faction, not to the player who took it', () => {
    // `meleeArc` hardcoded `'player'` as the damage source while players were the only
    // thing that could swing. Left alone, a mob's own hit would have coloured its fx as
    // if the player had dealt it (`EventReactor`'s `hit` branch reads this field).
    const s = createGameState(CFG);
    swingingAt(s, 'ravager');
    s.tick++;
    new WeaponFireSystem().tick(s);
    new HitResolveSystem().tick(s);
    const hit = s.events.find((ev) => ev.type === 'hit');
    expect(hit && 'faction' in hit && hit.faction).toBe('enemy');
  });

  it('never hits another enemy — hostility is by team, not by "the other array"', () => {
    const s = createGameState(CFG);
    const { e } = swingingAt(s, 'ravager');
    const bystander = buildEnemyActor(s, e.gx, e.gy, 'basic'); // standing in the arc
    bystander.gx = (e.gx + pxToFp(10)) as typeof bystander.gx;
    s.enemies.push(bystander);
    const before = bystander.hp;
    s.tick++;
    new WeaponFireSystem().tick(s);
    new HitResolveSystem().tick(s);
    expect(bystander.hp).toBe(before);
  });

  it('a mob killed mid-swing stops swinging', () => {
    // The alive gate is re-checked per tick, matching the player branch beside it.
    const s = createGameState(CFG);
    const { p, e } = swingingAt(s, 'ravager');
    s.tick++;
    e.firing = true;
    new WeaponFireSystem().tick(s); // window open
    e.alive = false;
    const before = p.hp + p.shield;
    new HitResolveSystem().tick(s);
    expect(p.hp + p.shield).toBe(before);
  });

  it('a swing staged with openSwing behaves the same as one WeaponFireSystem opened', () => {
    // Guards against the arc reading anything WeaponFireSystem happens to set beyond the
    // window itself — `openSwing` is documented as the one definition of "a swing starts",
    // and a test that could only stage one through step 3 would not be checking that.
    const s = createGameState(CFG);
    const { p, e } = swingingAt(s, 'stalker');
    e.firing = false;
    openSwing(e.weapon!);
    const before = p.hp + p.shield;
    s.tick++;
    new HitResolveSystem().tick(s);
    expect(p.hp + p.shield).toBeLessThan(before);
  });
});
