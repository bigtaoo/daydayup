/**
 * `WeaponFireSystem` (step 3, design/08) — the first dedicated test for this file
 * (design/18-test-strategy.md, Layer 1: *"also missing today"*). Until now its
 * behaviour was covered only incidentally, by `ballistics.test.ts` (three spread-emission
 * cases), `bossai.test.ts` (the enrage latch) and whatever the golden hash happened to
 * walk through.
 *
 * ## The claim this file exists for: the PRNG draw-count contract
 *
 * `WeaponFireSystem`'s own header asserts a DETERMINISM contract that nothing tested:
 *
 *   > a single-pellet pinpoint shot draws nothing — the baseline guns advance no new
 *   > PRNG stream […] byte-identical to the pre-1.1 baseline
 *
 * and design/03's landing order repeats it ("a single-pellet weapon draws nothing
 * (unchanged baseline)"), as does design/07 for crit ("a build/enemy with `critChance=0`
 * never advances `combatPrng`" — the "hard wall" PvP replay independence rests on).
 * A draw-count claim is invisible to every other kind of assertion: an extra
 * `combatPrng.nextInt()` on the pinpoint path changes NO observable of a single shot,
 * it just shifts every later draw in the run by one — which surfaces as a desync in the
 * field, or as a golden-hash diff nobody can localize. So it is asserted here directly,
 * by reading `state.combatPrng.peek()` (the LCG's raw internal state — see `math/prng.ts`)
 * against a reference stream advanced a known number of times.
 *
 * Two draw sites feed one stream and have to be told apart (`cursorAfter`'s note):
 * spread jitter (`fireRanged`) and `rollCrit` (`spawnBullet`). `rollCrit` returns
 * WITHOUT drawing when `crit_chance === 0`, which is every enemy and every player who
 * hasn't picked up `crit_up` — so the default fixtures below isolate the spread draw for
 * free, and the crit draw is then re-introduced deliberately (the `crit_up` cases) to
 * pin that it is one draw per pellet, interleaved after that pellet's jitter.
 *
 * ## Mutation battery
 *
 * Recorded 2026-08-30 at ENGINE_VERSION 48, against `WeaponFireSystem.ts` only. Every row
 * is a real edit to the source, `npx vitest run systems/WeaponFireSystem.test.ts`, revert.
 *
 *   KILLED   pinpoint path draws anyway: `: a.facing` -> `: normBrad(a.facing +
 *            state.combatPrng.nextInt(1))` (the draw-count contract itself) ... 3 failing tests
 *   KILLED   radial draws: `radialDir(...)` -> `normBrad(radialDir(...) +
 *            state.combatPrng.nextInt(1))` ................................... 1
 *   KILLED   muzzle: `mulFp(cos, spec.muzzleOffset)` -> `mulFp(sin, ...)` on gx . 4
 *   KILLED   cooldown decrement gated on the actor acting: `if (w.cooldownTicks > 0)`
 *            -> `if (a.alive && a.firing && w.cooldownTicks > 0)` .............. 2
 *   KILLED   top-of-turn `w.justSwung = false` deleted (swing latches forever) ... 2
 *   KILLED   enrage latch made re-entrant (`!e.enraged &&` dropped) ............. 1
 *   KILLED   crit hoisted out of the pellet loop (rolled once per trigger) ...... 2
 *   KILLED   `ownerId: a.id` -> `ownerId: undefined` ........................... 3
 *   KILLED   `beamDir: spec.ballistic === 'beam' ? dir : undefined` -> `dir` .... 1
 *   KILLED   `bullet_fired` event's `facing: dir` -> `facing: a.facing` ........ 2
 *
 * No survivors. The first two rows are the ones worth reading twice: both change NOTHING
 * an ordinary assertion can see — same bullets, same positions, same damage, same events —
 * and are caught only by the `peek()` cursor. `nextInt(1)` is always 0, so those two
 * mutants are pure stream-advance, which is precisely the bug class this file is for.
 *
 * The muzzle row kills 4 of the 5 muzzle assertions rather than all of them: the 45°
 * case survives it, because `cosFp(8192) === sinFp(8192)` makes the two formulas agree
 * there. Recorded rather than hidden — a diagonal-only muzzle test would be a weak test.
 */
import { describe, it, expect } from 'vitest';
import { addFp, mulFp, toFp, type Fp } from '@dd/engine/math/fixed';
import { cosFp, sinFp, normBrad, type Brad } from '@dd/engine/math/trig';
import { createGameState, type GameState } from '@dd/engine/state/GameState';
import type { PlayerActor, RangedSimSpec, WeaponSimSpec } from '@dd/engine/state/entities';
import { ENEMY_TEAM_ID } from '@dd/engine/state/entities';
import { pxToFp } from '@dd/engine/content/convert';
import { buildEnemyActor, BLIGHTLORD } from '@dd/engine/content/enemies';
import {
  makeWeapon,
  BLASTER_SIM,
  SABER_SIM,
  SCATTERGUN_SIM,
  SEEKER_SIM,
  MORTAR_SIM,
  LASERCUTTER_SIM,
  TOMAHAWK_SIM,
  NOVABURST_SIM,
  GYRE_SIM,
  CAROM_SIM,
  ENEMY_GUN_SIM,
} from '@dd/engine/content/weapons';
import { radialDir } from '@dd/engine/content/ballistics';
import { buffedCooldown, buffedDamage, critDamage, sumBuffs, NO_BUFFS } from '@dd/engine/balance/runbuffs';
import { WeaponFireSystem } from '@dd/engine/systems';

const CFG = { seed: 2026, worldW: 1600, worldH: 1200, waves: [] as const };
const state = (): GameState => createGameState(CFG);

// The lone default seat spawns dead-centre (GameState.buildSeat: `worldW/2, worldH/2`).
// Pinned as literals because every muzzle assertion below is an absolute fp position.
const START_GX = pxToFp(800); // 25000 fp = 25 grid
const START_GY = pxToFp(600); // 18750 fp

/** Arm the default seat with `spec` and hold the trigger. Deliberately overwrites
 * `weapon` (the active pointer) rather than going through the loadout — WeaponFireSystem
 * only ever reads `a.weapon`, and this keeps each case's spec explicit. */
function armed(s: GameState, spec: WeaponSimSpec, facing = 0): PlayerActor {
  const p = s.players[0]!;
  p.weapon = makeWeapon(spec);
  p.facing = normBrad(facing);
  p.firing = true;
  return p;
}

/**
 * The `combatPrng` state after exactly `n` draws on a fresh CFG state — the only honest
 * way to assert a DRAW COUNT, since `Prng.peek()` exposes the LCG's internal state and
 * not a counter (`goldenHash.test.ts` records the same trap from the other direction:
 * peek() is ~1e10 on a fresh engine, so any "cursor > k" guard is true before a tick runs).
 *
 * `nextInt(2)` is used for the reference draws because the LCG's state transition is
 * independent of `max` — `Prng.next()` advances, then the result is `% max` — so N draws
 * of ANY bound land on the same state. That is what makes "did this fire draw N times?"
 * answerable without knowing what each draw was for.
 */
function cursorAfter(n: number): number {
  const ref = state().combatPrng;
  for (let i = 0; i < n; i++) ref.nextInt(2);
  return ref.peek();
}

/** A reference stream positioned exactly where `state()`'s combatPrng starts, for
 * replicating the draw SEQUENCE (not just its length) a fire is supposed to make. */
const refStream = () => state().combatPrng;

describe('PRNG draw-count contract (design/03 landing order, design/07 crit hard wall)', () => {
  it('a 1-pellet pinpoint shot draws NOTHING — the baseline gun advances no stream', () => {
    const s = state();
    const before = s.combatPrng.peek();
    armed(s, BLASTER_SIM);
    new WeaponFireSystem().tick(s);

    expect(s.projectiles).toHaveLength(1); // it really did fire — not a vacuous "no draw"
    expect(s.combatPrng.peek()).toBe(before);
    expect(s.combatPrng.peek()).toBe(cursorAfter(0));
  });

  it('a radial multi-pellet volley draws NOTHING — the ring is deterministic', () => {
    const s = state();
    const before = s.combatPrng.peek();
    armed(s, NOVABURST_SIM);
    new WeaponFireSystem().tick(s);

    expect(s.projectiles).toHaveLength(NOVABURST_SIM.bullets); // 10 pellets, zero draws
    expect(s.combatPrng.peek()).toBe(before);

    // …and the ring really is `radialDir`'s even step, not jitter that happens to look even.
    for (let i = 0; i < NOVABURST_SIM.bullets; i++) {
      const dir = radialDir(0 as Brad, i, NOVABURST_SIM.bullets);
      expect(s.projectiles[i]!.vx).toBe(mulFp(cosFp(dir), NOVABURST_SIM.bulletSpeed));
      expect(s.projectiles[i]!.vy).toBe(mulFp(sinFp(dir), NOVABURST_SIM.bulletSpeed));
    }
  });

  it('a spread multi-pellet volley draws EXACTLY ONE per pellet, in pellet order', () => {
    const s = state();
    armed(s, SCATTERGUN_SIM);
    new WeaponFireSystem().tick(s);

    expect(s.projectiles).toHaveLength(SCATTERGUN_SIM.bullets);
    // No crit buff on this seat → rollCrit returns without drawing, so the whole cursor
    // movement below is the spread jitter and nothing else.
    expect(s.combatPrng.peek()).toBe(cursorAfter(SCATTERGUN_SIM.bullets));

    // Stronger than the count: replicate the exact sequence the system is supposed to
    // consume, and check each pellet flew the direction that draw produced.
    const ref = refStream();
    const half = SCATTERGUN_SIM.spreadHalf;
    for (let i = 0; i < SCATTERGUN_SIM.bullets; i++) {
      const dir = normBrad(0 + (ref.nextInt(half * 2 + 1) - half));
      expect(s.projectiles[i]!.vx).toBe(mulFp(cosFp(dir), SCATTERGUN_SIM.bulletSpeed));
      expect(s.projectiles[i]!.vy).toBe(mulFp(sinFp(dir), SCATTERGUN_SIM.bulletSpeed));
    }
  });

  it('crit is the OTHER draw site: a pinpoint gun on a crit build draws exactly one', () => {
    // Isolates the two sites from each other. Same weapon as the first case (which drew
    // zero); the only difference is `crit_chance > 0`, so this single draw can only be
    // rollCrit — which is what licenses reading the spread case's cursor as pure jitter.
    const s = state();
    const p = armed(s, BLASTER_SIM);
    p.buffs = ['crit_up'];
    new WeaponFireSystem().tick(s);

    expect(s.projectiles).toHaveLength(1);
    expect(s.combatPrng.peek()).toBe(cursorAfter(1));
  });

  it('spread + crit draws two per pellet, interleaved jitter-then-crit', () => {
    const s = state();
    const p = armed(s, SCATTERGUN_SIM);
    p.buffs = ['crit_up'];
    new WeaponFireSystem().tick(s);

    expect(s.combatPrng.peek()).toBe(cursorAfter(2 * SCATTERGUN_SIM.bullets));

    // The count alone would pass under either ordering; replicating jitter-then-crit
    // per pellet is what pins the order (spawnBullet rolls crit after fireRanged picked
    // the pellet's dir). If the two were swapped, every direction below would be wrong.
    const sums = sumBuffs(p.buffs);
    const ref = refStream();
    const half = SCATTERGUN_SIM.spreadHalf;
    for (let i = 0; i < SCATTERGUN_SIM.bullets; i++) {
      const dir = normBrad(0 + (ref.nextInt(half * 2 + 1) - half));
      const isCrit = ref.nextInt(1000) < sums.crit_chance;
      expect(s.projectiles[i]!.vx).toBe(mulFp(cosFp(dir), SCATTERGUN_SIM.bulletSpeed));
      expect(s.projectiles[i]!.damage).toBe(critDamage(buffedDamage(SCATTERGUN_SIM.damage, sums), isCrit));
    }
  });

  it('an enraged boss still draws nothing — enrage carries no crit_chance', () => {
    // design/07's hard wall applies to the enrage BuffSums too: it sets mult_damage /
    // mult_firerate only, so a boss's escalation must not start advancing combatPrng.
    const s = state();
    const boss = buildEnemyActor(s, pxToFp(400), pxToFp(400), 'blightlord');
    s.enemies.push(boss);
    boss.firing = true;
    boss.weapon!.cooldownTicks = 0;
    boss.hp = 1; // deep under the 30% threshold
    const before = s.combatPrng.peek();
    new WeaponFireSystem().tick(s);

    expect(boss.enraged).toBe(true);
    expect(s.projectiles).toHaveLength(1);
    expect(s.combatPrng.peek()).toBe(before);
  });
});

describe('muzzle spawn formula (design/18 — one of the two changes that motivated the doc)', () => {
  // A bullet is born at `actor + muzzleOffset · (cos, sin)` of the FIRE direction, with no
  // wall test of any kind (design/18 names that omission explicitly). The expectations are
  // written as literals rather than re-derived through cosFp/mulFp, so a change to either
  // the formula or the trig table is visible here instead of cancelling itself out.

  it('facing 0 (east): the offset lands entirely on gx, gy untouched', () => {
    const s = state();
    armed(s, BLASTER_SIM, 0);
    new WeaponFireSystem().tick(s);
    const b = s.projectiles[0]!;

    expect(BLASTER_SIM.muzzleOffset).toBe(938); // toFpGrid(0.9375) — the starter's barrel length
    expect(b.gx).toBe((START_GX + 938) as Fp); // cosFp(0) = 1000 → mulFp(1000, 938) = 938
    expect(b.gy).toBe(START_GY);
    expect(b.z).toBe(BLASTER_SIM.bulletZ); // muzzle height rides along (cosmetic, design/07)
  });

  it('facing 16384 (south): the offset lands entirely on gy', () => {
    const s = state();
    armed(s, BLASTER_SIM, 16384);
    new WeaponFireSystem().tick(s);
    const b = s.projectiles[0]!;

    expect(b.gx).toBe(START_GX); // cosFp(π/2) = 0
    expect(b.gy).toBe((START_GY + 938) as Fp);
  });

  it('facing 8192 (45°): both axes take the truncated fp product', () => {
    const s = state();
    armed(s, BLASTER_SIM, 8192);
    new WeaponFireSystem().tick(s);
    const b = s.projectiles[0]!;

    // sinFp(8192) = cosFp(8192) = 707 (the committed table's √2/2), and mulFp truncates:
    // trunc(707 · 938 / 1000) = 663. Both the table value and the truncation are pinned.
    expect(sinFp(8192)).toBe(707);
    expect(b.gx).toBe((START_GX + 663) as Fp);
    expect(b.gy).toBe((START_GY + 663) as Fp);
  });

  it('each weapon kind spawns at ITS OWN muzzleOffset', () => {
    // Per-weapon, because the offset is spec data that content edits move (design/18 cites
    // `muzzleGrid` as exactly the kind of change that silently breaks replays).
    // Every weapon here is pinpoint or radial, so pellet 0 flies dead east and the muzzle
    // reads off one axis. SCATTERGUN is deliberately absent: its pellet 0 is JITTERED, so
    // it has no fixed east position — its own muzzleOffset is pinned instead by the
    // bullet_fired suite below, which re-derives each pellet from its own dir.
    const cases: [RangedSimSpec, number][] = [
      [BLASTER_SIM, 938], // 0.9375 grid — the shared gun barrel
      [NOVABURST_SIM, 500], // 0.5 — the ring spawns tight to the body
      [GYRE_SIM, 1600], // 1.6 — straight onto the orbit circle
      [LASERCUTTER_SIM, 938], // a beam still spawns at a muzzle, it just doesn't travel
    ];
    for (const [spec, offset] of cases) {
      expect(spec.muzzleOffset, spec.name).toBe(offset);
      const s = state();
      armed(s, spec, 0);
      new WeaponFireSystem().tick(s);
      // Pellet 0 of a radial ring is straight ahead (radialDir's i=0 step is 0), so every
      // weapon here can be read off the same east-facing bullet.
      expect(s.projectiles[0]!.gx, spec.name).toBe((START_GX + offset) as Fp);
      expect(s.projectiles[0]!.gy, spec.name).toBe(START_GY);
    }
  });

  it('velocity is the same cos/sin scaled by the spec bulletSpeed', () => {
    const s = state();
    armed(s, BLASTER_SIM, 0);
    new WeaponFireSystem().tick(s);
    expect(BLASTER_SIM.bulletSpeed).toBe(330); // toFpPerTick(10 grid/s), convert.ts's worked example
    expect(s.projectiles[0]!.vx).toBe(330 as Fp);
    expect(s.projectiles[0]!.vy).toBe(0 as Fp);
    expect(s.projectiles[0]!.radius).toBe(BLASTER_SIM.bulletRadius);
    expect(s.projectiles[0]!.lifeTicks).toBe(BLASTER_SIM.bulletLifeTicks);
  });
});

describe('cooldown — whole ticks, fire only at zero (design/08)', () => {
  it('counts down one whole tick per tick and stays silent until it reaches 0', () => {
    const s = state();
    const p = armed(s, BLASTER_SIM);
    p.weapon!.cooldownTicks = 3;
    const fire = new WeaponFireSystem();

    fire.tick(s);
    expect(p.weapon!.cooldownTicks).toBe(2);
    expect(s.projectiles).toHaveLength(0);
    fire.tick(s);
    expect(p.weapon!.cooldownTicks).toBe(1);
    expect(s.projectiles).toHaveLength(0);
  });

  it('a weapon at cooldownTicks === 1 fires THIS tick (decrement happens first)', () => {
    // The order in `actor()` is decrement-then-test, so 1 means "ready this tick", not
    // "ready next tick". Pinned because it is the difference of one whole tick of DPS.
    const s = state();
    const p = armed(s, BLASTER_SIM);
    p.weapon!.cooldownTicks = 1;
    new WeaponFireSystem().tick(s);
    expect(s.projectiles).toHaveLength(1);
  });

  it('after firing, the gap is exactly fireRateTicks ticks of silence', () => {
    const s = state();
    const p = armed(s, BLASTER_SIM);
    const fire = new WeaponFireSystem();

    fire.tick(s); // shot 1 (starts ready)
    expect(s.projectiles).toHaveLength(1);
    expect(p.weapon!.cooldownTicks).toBe(BLASTER_SIM.fireRateTicks);
    expect(BLASTER_SIM.fireRateTicks).toBe(6); // toTicks(0.2) — 5 shots/s at 30 Hz

    for (let i = 0; i < BLASTER_SIM.fireRateTicks - 1; i++) fire.tick(s);
    expect(s.projectiles).toHaveLength(1); // still just the one
    fire.tick(s);
    expect(s.projectiles).toHaveLength(2); // the 6th tick after the shot
  });

  it('run buffs shorten the gap through buffedCooldown, never the raw spec value', () => {
    const s = state();
    const p = armed(s, BLASTER_SIM);
    p.buffs = ['rof_up']; // +40% attack speed (design/14)
    new WeaponFireSystem().tick(s);

    const sums = sumBuffs(p.buffs);
    expect(p.weapon!.cooldownTicks).toBe(buffedCooldown(BLASTER_SIM.fireRateTicks, sums));
    expect(p.weapon!.cooldownTicks).toBe(4); // round(6 · 1000 / 1400)
    expect(p.weapon!.cooldownTicks).toBeLessThan(BLASTER_SIM.fireRateTicks);
  });

  it('melee recovery goes through the same buffedCooldown path', () => {
    const s = state();
    const p = armed(s, SABER_SIM);
    p.buffs = ['rof_up'];
    new WeaponFireSystem().tick(s);
    expect(p.weapon!.cooldownTicks).toBe(buffedCooldown(SABER_SIM.swingCooldownTicks, sumBuffs(p.buffs)));
    expect(SABER_SIM.swingCooldownTicks).toBe(11); // toTicks(0.37)
    expect(p.weapon!.cooldownTicks).toBe(8); // round(11 · 1000 / 1400)
  });
});

describe('melee vs ranged branch (design/03 — the swing IS the parry)', () => {
  it('melee sets justSwung and spawns NO projectile', () => {
    const s = state();
    const p = armed(s, SABER_SIM);
    new WeaponFireSystem().tick(s);

    expect(p.weapon!.justSwung).toBe(true); // DeflectSystem (6) + HitResolveSystem (7) read this
    expect(s.projectiles).toHaveLength(0);
    expect(s.events.filter((e) => e.type === 'bullet_fired')).toHaveLength(0);
  });

  it('ranged never sets justSwung, and a stale true is cleared at the top of the turn', () => {
    const s = state();
    const p = armed(s, BLASTER_SIM);
    p.weapon!.justSwung = true; // as if last tick had been a melee swing
    new WeaponFireSystem().tick(s);
    expect(p.weapon!.justSwung).toBe(false);
    expect(s.projectiles).toHaveLength(1);
  });

  it('justSwung is reset even when the actor never gets to act', () => {
    // The reset is the FIRST statement of `actor()`, before cooldown, alive, firing — so a
    // swing lasts exactly one tick no matter what happens next. If it moved into the melee
    // branch, a swing on cooldown would keep parrying forever.
    const s = state();
    const p = armed(s, SABER_SIM);
    p.weapon!.justSwung = true;
    p.weapon!.cooldownTicks = 5;
    p.firing = false;
    p.alive = false;
    new WeaponFireSystem().tick(s);
    expect(p.weapon!.justSwung).toBe(false);
  });
});

describe('gating — !alive / !firing / no weapon (and what the cooldown does anyway)', () => {
  it('a dead actor fires nothing but its cooldown STILL ticks down', () => {
    // Pinning what the code really does, not what it might be assumed to do: the decrement
    // sits ABOVE the `!a.alive` early-out, so a downed player's weapon keeps recovering
    // while it is down and comes back ready. Load-bearing for revive (design/07 step 9).
    const s = state();
    const p = armed(s, BLASTER_SIM);
    p.weapon!.cooldownTicks = 3;
    p.alive = false;
    new WeaponFireSystem().tick(s);

    expect(s.projectiles).toHaveLength(0);
    expect(p.weapon!.cooldownTicks).toBe(2);
  });

  it('an actor not holding the trigger fires nothing but its cooldown still ticks down', () => {
    const s = state();
    const p = armed(s, BLASTER_SIM);
    p.weapon!.cooldownTicks = 3;
    p.firing = false;
    new WeaponFireSystem().tick(s);

    expect(s.projectiles).toHaveLength(0);
    expect(p.weapon!.cooldownTicks).toBe(2);
  });

  it('an unarmed actor is skipped entirely — no crash, no event', () => {
    const s = state();
    const p = s.players[0]!;
    p.weapon = null;
    p.firing = true;
    expect(() => new WeaponFireSystem().tick(s)).not.toThrow();
    expect(s.projectiles).toHaveLength(0);
    expect(s.events).toHaveLength(0);
  });

  it('a ready-but-idle weapon does not go NEGATIVE on cooldown', () => {
    const s = state();
    const p = armed(s, BLASTER_SIM);
    p.firing = false;
    for (let i = 0; i < 10; i++) new WeaponFireSystem().tick(s);
    expect(p.weapon!.cooldownTicks).toBe(0);
  });
});

describe('enrage (design/09 traits, ENGINE_VERSION 27) — a one-way latch on the buff path', () => {
  const enragedBoss = (s: GameState) => {
    const boss = buildEnemyActor(s, pxToFp(400), pxToFp(400), 'blightlord');
    s.enemies.push(boss);
    boss.firing = true;
    boss.weapon!.cooldownTicks = 0;
    return boss;
  };

  it('emits `enrage` EXACTLY ONCE across many ticks below the threshold', () => {
    const s = state();
    const boss = enragedBoss(s);
    boss.hp = Math.floor((boss.maxHp * BLIGHTLORD.enrage!.hpThresholdPermille) / 1000); // exactly at 30%
    const fire = new WeaponFireSystem();

    // Events are NOT cleared between ticks here on purpose — the whole point is to count
    // emissions over a window, which a per-tick clearEvents() would hide. 20 ticks is far
    // more than the enraged cooldown, so the latch is re-tested many times over.
    for (let i = 0; i < 20; i++) fire.tick(s);

    expect(boss.enraged).toBe(true);
    expect(s.events.filter((e) => e.type === 'enrage')).toHaveLength(1);
    expect(s.events.find((e) => e.type === 'enrage')).toEqual({
      type: 'enrage',
      id: boss.id,
      gx: boss.gx,
      gy: boss.gy,
    });
  });

  it('reuses the SAME BuffSums path as a player run buff — no separate enemy scaling', () => {
    const s = state();
    const boss = enragedBoss(s);
    boss.hp = 1;
    new WeaponFireSystem().tick(s);

    // The composition design/09 promises: enrage → BuffSums → buffedDamage/buffedCooldown,
    // the identical functions `sumBuffs(p.buffs)` feeds for a player.
    const sums = { ...NO_BUFFS, mult_damage: 500, mult_firerate: 500 };
    expect(s.projectiles[0]!.damage).toBe(buffedDamage(ENEMY_GUN_SIM.damage, sums));
    expect(s.projectiles[0]!.damage).toBe(2); // round(1 · 1500/1000) — up from the base 1
    expect(boss.weapon!.cooldownTicks).toBe(buffedCooldown(ENEMY_GUN_SIM.fireRateTicks, sums));
    expect(boss.weapon!.cooldownTicks).toBe(30); // round(45 · 1000/1500)
  });

  it('above the threshold a boss fires completely unbuffed', () => {
    const s = state();
    const boss = enragedBoss(s);
    boss.hp = boss.maxHp;
    new WeaponFireSystem().tick(s);

    expect(boss.enraged).toBe(false);
    expect(s.events.some((e) => e.type === 'enrage')).toBe(false);
    expect(s.projectiles[0]!.damage).toBe(ENEMY_GUN_SIM.damage);
    expect(boss.weapon!.cooldownTicks).toBe(ENEMY_GUN_SIM.fireRateTicks);
  });

  it('a mob with no enrage trait never latches, however low its hp', () => {
    const s = state();
    const mob = buildEnemyActor(s, pxToFp(400), pxToFp(400), 'basic');
    s.enemies.push(mob);
    mob.firing = true;
    mob.weapon!.cooldownTicks = 0;
    mob.hp = 1;
    new WeaponFireSystem().tick(s);

    expect(mob.enraged).toBe(false);
    expect(s.events.some((e) => e.type === 'enrage')).toBe(false);
    expect(s.projectiles[0]!.damage).toBe(ENEMY_GUN_SIM.damage); // NO_BUFFS is the identity
  });
});

describe('crit — rolled once per pellet at fire time, frozen into damage (design/07)', () => {
  it('every pellet gets its OWN roll, not one roll shared by the trigger', () => {
    const s = state();
    const p = armed(s, SCATTERGUN_SIM);
    p.buffs = ['crit_up', 'crit_up', 'crit_up', 'crit_up']; // 4 × 150‰, Σ-clamped to the 500 cap
    const sums = sumBuffs(p.buffs);
    expect(sums.crit_chance).toBe(500);
    new WeaponFireSystem().tick(s);

    const base = buffedDamage(SCATTERGUN_SIM.damage, sums);
    const ref = refStream();
    const half = SCATTERGUN_SIM.spreadHalf;
    const expected: number[] = [];
    for (let i = 0; i < SCATTERGUN_SIM.bullets; i++) {
      ref.nextInt(half * 2 + 1); // this pellet's jitter draw
      expected.push(critDamage(base, ref.nextInt(1000) < sums.crit_chance));
    }
    expect(s.projectiles.map((b) => b.damage)).toEqual(expected);
    // Anti-vacuity: at a 50% chance this volley must actually contain BOTH outcomes, or
    // the equality above would also hold for a "crit is never rolled" implementation.
    expect(new Set(expected).size, 'seed no longer produces a mixed volley — retune CFG.seed').toBe(2);
  });

  it('a zero-crit build gets exactly the buffed base damage, every pellet', () => {
    const s = state();
    const p = armed(s, SCATTERGUN_SIM);
    p.buffs = ['dmg_up']; // damage buff but no crit_chance → rollCrit short-circuits
    new WeaponFireSystem().tick(s);

    const base = buffedDamage(SCATTERGUN_SIM.damage, sumBuffs(p.buffs));
    for (const b of s.projectiles) expect(b.damage).toBe(base);
    expect(base).toBeGreaterThan(SCATTERGUN_SIM.damage); // the buff did land
  });

  it('the frozen damage survives later ticks — nothing re-rolls it', () => {
    const s = state();
    const p = armed(s, BLASTER_SIM);
    p.buffs = ['crit_up'];
    const fire = new WeaponFireSystem();
    fire.tick(s);
    const frozen = s.projectiles[0]!.damage;

    // Keep firing (and keep drawing crit rolls) for a full cooldown cycle: the first
    // bullet's payload must not move, whatever the stream does afterwards.
    for (let i = 0; i < 12; i++) fire.tick(s);
    expect(s.projectiles.length).toBeGreaterThan(1);
    expect(s.projectiles[0]!.damage).toBe(frozen);
  });
});

describe('the spawned projectile freezes its whole payload from the spec (design/07)', () => {
  it('identity fields come from the firing actor, not the spec', () => {
    const s = state();
    const p = armed(s, BLASTER_SIM);
    new WeaponFireSystem().tick(s);
    const b = s.projectiles[0]!;

    expect(b.ownerId).toBe(p.id); // set on EVERY bullet since v28 (k_lifesteal needs it)
    expect(b.faction).toBe('player');
    expect(b.teamId).toBe(p.teamId); // design/15 — the targeting predicate reads this
    expect(b.alive).toBe(true);
    expect(b.id).toBeGreaterThan(p.id); // allocated from state.nextId()
  });

  it('an enemy bullet carries the enemy team, so it can never hit another mob', () => {
    const s = state();
    const mob = buildEnemyActor(s, pxToFp(400), pxToFp(400), 'basic');
    s.enemies.push(mob);
    mob.firing = true;
    mob.weapon!.cooldownTicks = 0;
    new WeaponFireSystem().tick(s);

    expect(s.projectiles[0]!.faction).toBe('enemy');
    expect(s.projectiles[0]!.teamId).toBe(ENEMY_TEAM_ID);
    expect(s.projectiles[0]!.ownerId).toBe(mob.id);
  });

  it('each ballistic freezes its own params, and ONLY its own', () => {
    // The per-ballistic conditionals in spawnBullet are load-bearing: ProjectileStepSystem
    // branches on the presence of `ticksAlive`/`orbitAngleBrad`/`beamDir`, so leaking one
    // onto the wrong bullet changes how it flies.
    const check = (spec: RangedSimSpec, assert: (b: NonNullable<GameState['projectiles'][number]>) => void) => {
      const s = state();
      armed(s, spec, 0);
      new WeaponFireSystem().tick(s);
      assert(s.projectiles[0]!);
    };

    check(BLASTER_SIM, (b) => {
      expect(b.ballistic).toBe('straight');
      expect(b.speed).toBeUndefined(); // homing-only
      expect(b.ticksAlive).toBeUndefined(); // boomerang-only
      expect(b.beamDir).toBeUndefined(); // beam-only
      expect(b.orbitAngleBrad).toBeUndefined(); // orbit-only
      expect(b.piercing).toBe(false);
      expect(b.lifestealPermille).toBeUndefined();
      expect(b.ricochetsLeft).toBeUndefined();
    });

    check(SEEKER_SIM, (b) => {
      expect(b.ballistic).toBe('homing');
      expect(b.turnRateBrad).toBe(SEEKER_SIM.turnRateBrad);
      expect(b.speed).toBe(SEEKER_SIM.bulletSpeed); // the magnitude turnToward preserves
    });

    check(MORTAR_SIM, (b) => {
      expect(b.ballistic).toBe('lob');
      expect(b.blastRadius).toBe(MORTAR_SIM.blastRadius);
      expect(b.landed).toBeUndefined(); // set by ProjectileStepSystem at lifespan end, not here
    });

    check(LASERCUTTER_SIM, (b) => {
      expect(b.ballistic).toBe('beam');
      expect(b.beamTicksLeft).toBe(LASERCUTTER_SIM.beamTicks);
      expect(b.beamTickInterval).toBe(LASERCUTTER_SIM.beamTickInterval);
      expect(b.beamRange).toBe(LASERCUTTER_SIM.beamRange);
      expect(b.beamDir).toBe(0 as Brad); // frozen fire-time facing — a beam never tracks
    });

    check(TOMAHAWK_SIM, (b) => {
      expect(b.ballistic).toBe('boomerang');
      expect(b.returnAfterTicks).toBe(TOMAHAWK_SIM.returnAfterTicks);
      expect(b.ticksAlive).toBe(0); // its own counter starts here
    });

    check(GYRE_SIM, (b) => {
      expect(b.ballistic).toBe('orbit');
      expect(b.orbitRadius).toBe(GYRE_SIM.orbitRadius);
      expect(b.orbitAngularVelBrad).toBe(GYRE_SIM.orbitAngularVelBrad);
      expect(b.orbitAngleBrad).toBe(0 as Brad); // starts at the fire direction
    });

    check(CAROM_SIM, (b) => {
      expect(b.ricochetsLeft).toBe(CAROM_SIM.ricochetCount); // k_ricochet, v28
      expect(b.ricochetsLeft).toBe(2);
      expect(b.piercing).toBe(false); // the opposite trade-off from piercing, deliberately off
    });
  });

  it('damageType is frozen from the spec, not re-read on impact', () => {
    const s = state();
    armed(s, BLASTER_SIM);
    new WeaponFireSystem().tick(s);
    expect(s.projectiles[0]!.damageType).toBe(BLASTER_SIM.damageType);
    expect(s.projectiles[0]!.damageType).toBe('physical');
  });
});

describe('the bullet_fired event mirrors the projectile it announced (design/08 fx channel)', () => {
  it('carries the same gx/gy/facing the bullet got', () => {
    const s = state();
    const p = armed(s, BLASTER_SIM, 8192);
    new WeaponFireSystem().tick(s);

    const ev = s.events.filter((e) => e.type === 'bullet_fired');
    expect(ev).toHaveLength(1);
    expect(ev[0]).toEqual({
      type: 'bullet_fired',
      ownerId: p.id,
      faction: 'player',
      gx: s.projectiles[0]!.gx,
      gy: s.projectiles[0]!.gy,
      facing: 8192,
    });
  });

  it('one event per pellet, each matching its own pellet — not the shared actor facing', () => {
    // `facing: dir`, not `a.facing`: on a spread volley the five events must carry five
    // DIFFERENT angles, or the muzzle fx all point the same way while the bullets fan out.
    const s = state();
    armed(s, SCATTERGUN_SIM, 8192);
    new WeaponFireSystem().tick(s);

    const ev = s.events.filter((e) => e.type === 'bullet_fired');
    expect(ev).toHaveLength(SCATTERGUN_SIM.bullets);
    for (let i = 0; i < ev.length; i++) {
      const b = s.projectiles[i]!;
      expect(ev[i]!.gx).toBe(b.gx);
      expect(ev[i]!.gy).toBe(b.gy);
      // The event's facing is the pellet's own jittered dir: re-deriving the bullet's
      // position from it has to reproduce the bullet exactly.
      const dir = ev[i]!.facing;
      expect(addFp(START_GX, mulFp(cosFp(dir), SCATTERGUN_SIM.muzzleOffset))).toBe(b.gx);
      expect(addFp(START_GY, mulFp(sinFp(dir), SCATTERGUN_SIM.muzzleOffset))).toBe(b.gy);
    }
    expect(new Set(ev.map((e) => e.facing)).size).toBeGreaterThan(1); // really jittered
  });

  it('a radial volley announces the whole ring, pellet order preserved', () => {
    const s = state();
    armed(s, NOVABURST_SIM, 0);
    new WeaponFireSystem().tick(s);

    const ev = s.events.filter((e) => e.type === 'bullet_fired');
    expect(ev.map((e) => e.facing)).toEqual(
      Array.from({ length: NOVABURST_SIM.bullets }, (_, i) => radialDir(0 as Brad, i, NOVABURST_SIM.bullets)),
    );
  });
});

describe('every actor in the state gets its turn, players before enemies', () => {
  it('players and enemies both fire in one tick, in array order', () => {
    // `tick()` walks players then enemies; entity ids are allocated in that same order, so
    // a projectile array out of that order means the loop order moved (a determinism change).
    const s = state();
    const p = armed(s, BLASTER_SIM);
    const mob = buildEnemyActor(s, pxToFp(400), pxToFp(400), 'basic');
    s.enemies.push(mob);
    mob.firing = true;
    mob.weapon!.cooldownTicks = 0;
    new WeaponFireSystem().tick(s);

    expect(s.projectiles.map((b) => b.ownerId)).toEqual([p.id, mob.id]);
  });

  it('toFp(0) actors at the same spot still each get their own bullet id', () => {
    const s = state();
    armed(s, BLASTER_SIM);
    const a = buildEnemyActor(s, START_GX, START_GY, 'basic');
    const b = buildEnemyActor(s, START_GX, START_GY, 'basic');
    for (const e of [a, b]) {
      e.firing = true;
      e.weapon!.cooldownTicks = 0;
      e.z = toFp(0);
      s.enemies.push(e);
    }
    new WeaponFireSystem().tick(s);
    expect(new Set(s.projectiles.map((x) => x.id)).size).toBe(3);
  });
});
