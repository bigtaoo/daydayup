/**
 * Team/hostility model (design/15, ROADMAP 4.2a). Before this, `Faction =
 * 'player'|'enemy'` was hardcoded as "the only two sides" throughout combat/
 * targeting code, so two players could never damage, deflect, or clash with
 * each other — the structural gap PvP needs closed. `teamId` + `isHostile`
 * replace those faction ternaries; these tests pin the two things that must
 * both hold: existing co-op (every seat defaults to the SAME team) stays
 * friendly-fire-free, and two seats on DIFFERENT teams can now fight.
 */
import { describe, it, expect } from 'vitest';
import { toFp, type Fp } from '@dd/engine/math/fixed';
import type { Brad } from '@dd/engine/math/trig';
import { pxToFp } from '@dd/engine/content/convert';
import { createGameState } from '@dd/engine/state/GameState';
import type { GameState } from '@dd/engine/state/GameState';
import { ENEMY_TEAM_ID, isHostile, type Projectile } from '@dd/engine/state/entities';
import { makeWeapon, SABER_SIM } from '@dd/engine/content/weapons';
import {
  DeflectSystem,
  HitResolveSystem,
  ProjectileStepSystem,
} from '@dd/engine/systems';

const CFG = { seed: 21, worldW: 1600, worldH: 1200, waves: [] as const };

/** A bullet placed exactly on its target's position (dx=dy=0), so overlap is
 * trivial and the test isolates targeting/hostility, not geometry. */
function bulletOn(state: GameState, at: { gx: Fp; gy: Fp }, teamId: number): Projectile {
  const b: Projectile = {
    id: state.nextId(), faction: 'player', teamId,
    gx: at.gx, gy: at.gy, z: toFp(0), vx: toFp(0), vy: toFp(0),
    radius: pxToFp(5), damage: 3, damageType: 'physical', lifeTicks: 90, alive: true,
  };
  state.projectiles.push(b);
  return b;
}

describe('isHostile (design/15)', () => {
  it('differs by teamId alone, independent of faction', () => {
    expect(isHostile({ teamId: 0 }, { teamId: 1 })).toBe(true);
    expect(isHostile({ teamId: 0 }, { teamId: 0 })).toBe(false);
    expect(isHostile({ teamId: 0 }, { teamId: ENEMY_TEAM_ID })).toBe(true);
    expect(isHostile({ teamId: ENEMY_TEAM_ID }, { teamId: ENEMY_TEAM_ID })).toBe(false);
  });
});

describe('co-op default: every seat shares team 0 (regression — no friendly fire)', () => {
  it('a bullet from one seat passes through an ally seat untouched', () => {
    const s = createGameState({
      ...CFG,
      players: [{ start: [400, 400] }, { start: [420, 400] }], // no teamId → both default to 0
    });
    const ally = s.players[1]!;
    const hpBefore = ally.hp;
    const shieldBefore = ally.shield;
    const b = bulletOn(s, ally, 0);
    new HitResolveSystem().tick(s);
    expect(ally.hp).toBe(hpBefore);
    expect(ally.shield).toBe(shieldBefore);
    expect(b.alive).toBe(true); // never consumed — passed straight through
  });
});

describe('PvP: seats on different teamIds can damage each other', () => {
  it('a bullet from team 0 hits a team-1 rival seat and is consumed', () => {
    const s = createGameState({
      ...CFG,
      players: [
        { start: [400, 400], teamId: 0 },
        { start: [420, 400], teamId: 1 },
      ],
    });
    const rival = s.players[1]!;
    const before = rival.shield > 0 ? rival.shield : rival.hp;
    const b = bulletOn(s, rival, 0);
    new HitResolveSystem().tick(s);
    const after = rival.shield > 0 ? rival.shield : rival.hp;
    expect(after).toBeLessThan(before);
    expect(b.alive).toBe(false); // consumed on the hostile hit
  });

  it('a melee swing hits a rival seat in its arc but not an ally seat in the SAME arc', () => {
    const s = createGameState({
      ...CFG,
      // Both other seats sit inside the saber's wide 162° arc / ~46px range (content/
      // weapons.ts) — geometry alone would include EITHER, so only teamId decides.
      players: [
        { start: [400, 400], teamId: 0 },
        { start: [420, 400], teamId: 1 }, // rival, 20px east
        { start: [410, 415], teamId: 0 }, // ally, ~18px east-south-east — same arc, same range
      ],
    });
    const swinger = s.players[0]!;
    swinger.weapon = makeWeapon(SABER_SIM);
    swinger.weapons = [swinger.weapon];
    swinger.weapon.justSwung = true;
    swinger.facing = 0 as Brad; // facing +x, toward the rival
    const rival = s.players[1]!;
    const ally = s.players[2]!;
    const rivalShieldBefore = rival.shield;
    const allyShieldBefore = ally.shield;
    new HitResolveSystem().tick(s);
    expect(rival.shield).toBeLessThan(rivalShieldBefore); // hostile, in arc → hit
    expect(ally.shield).toBe(allyShieldBefore); // same team → untouched, even though also in range
  });

  it('deflect parries a hostile rival bullet, not an ally bullet, in the swing arc', () => {
    const s = createGameState({
      ...CFG,
      players: [
        { start: [400, 400], teamId: 0 },
        { start: [420, 400], teamId: 1 },
      ],
    });
    const swinger = s.players[0]!;
    swinger.weapon = makeWeapon(SABER_SIM); // deflect: true (design/03)
    swinger.weapons = [swinger.weapon];
    swinger.weapon.justSwung = true;
    swinger.facing = 0 as Brad;

    const rivalBullet = bulletOn(s, { gx: swinger.gx, gy: swinger.gy }, 1);
    new DeflectSystem().tick(s);
    expect(rivalBullet.teamId).toBe(0); // reassigned to the deflector's own team
    expect(rivalBullet.faction).toBe('player');

    const allyBullet = bulletOn(s, { gx: swinger.gx, gy: swinger.gy }, 0);
    const velBefore = { vx: allyBullet.vx, vy: allyBullet.vy };
    new DeflectSystem().tick(s);
    expect(allyBullet.vx).toBe(velBefore.vx); // untouched — same team, never a deflect candidate
    expect(allyBullet.vy).toBe(velBefore.vy);
  });

  it('two rival bullets clash and cancel; two same-team bullets pass through each other', () => {
    const s = createGameState(CFG);
    const rivalA = bulletOn(s, { gx: pxToFp(500), gy: pxToFp(500) }, 0);
    const rivalB = bulletOn(s, { gx: pxToFp(500), gy: pxToFp(500) }, 1);
    new HitResolveSystem().tick(s);
    expect(rivalA.alive).toBe(false);
    expect(rivalB.alive).toBe(false);

    const s2 = createGameState(CFG);
    const allyA = bulletOn(s2, { gx: pxToFp(500), gy: pxToFp(500) }, 0);
    const allyB = bulletOn(s2, { gx: pxToFp(500), gy: pxToFp(500) }, 0);
    new HitResolveSystem().tick(s2);
    expect(allyA.alive).toBe(true);
    expect(allyB.alive).toBe(true);
  });

  it('homing turns toward a hostile seat, not an ally seat at the mirrored position', () => {
    const s = createGameState({
      ...CFG,
      players: [
        { start: [400, 400], teamId: 5 }, // an ally, to the WEST of the bullet
        { start: [420, 400], teamId: 1 }, // a rival, to the EAST of the bullet
      ],
    });
    // The bullet's own team matches the "ally" seat (5), so only the rival (1) is hostile.
    const b: Projectile = {
      id: s.nextId(), faction: 'player', teamId: 5,
      gx: pxToFp(410), gy: pxToFp(400), z: toFp(0),
      vx: toFp(0), vy: toFp(-1), // moving away from both, straight up
      radius: pxToFp(5), damage: 1, damageType: 'physical', lifeTicks: 90, alive: true,
      ballistic: 'homing', turnRateBrad: 0xffff, speed: toFp(1),
    };
    s.projectiles.push(b);
    new ProjectileStepSystem().tick(s);
    expect(b.vx).toBeGreaterThan(0); // turned EAST, toward the rival — not west, toward the ally
  });
});
