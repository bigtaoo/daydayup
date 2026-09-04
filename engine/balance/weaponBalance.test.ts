/**
 * Weapon BALANCE gates (design/03/05/14) — the roster's first ones.
 *
 * ## Why this file exists
 *
 * Characters have had a real balance suite since ROADMAP 2.3: `content/skins.test.ts`
 * asserts Pareto non-domination on the defensive axes, per-axis spread, and an equal-worth
 * budget band. Weapons — 24 player-facing ones, the thing design/03 calls "the heart of the
 * game" — had NOTHING of the kind. Their tests were all mechanical (does a beam tick, does
 * a swing window open) or presentational (i18n keys, rarity pips, muzzle parity). No test
 * anywhere compared two weapons.
 *
 * The two balance simulators do not fill that gap either, and it is worth being precise
 * about why: `client/sim/pvpBalanceSim.sim.ts` measures character win-rate, and
 * `client/sim/pveLevelSim.sim.ts` plays the shipped level with the STARTER loadout only
 * (`blaster` + `saber`). As of 2026-09-04 the other 22 player weapons had never appeared in
 * any simulation at all. `client/sim/weaponSweep.sim.ts` is the counterpart that changes
 * that; this file is the static half.
 *
 * ## What can and cannot be asserted here
 *
 * The honest limit, stated once (see `weaponProfile.ts` for the longer version): **a
 * mechanic has no price in this repo.** Homing, a blast radius, a hitscan beam, a bounce,
 * a chill — each is worth something and nothing says how much. So skins.test.ts's third
 * gate, the equal-worth budget band, has NO weapon analogue, and inventing a composite
 * "worth" score would only test the exchange rate I made up to build it.
 *
 * Measured while writing this file, as the concrete reason: across the 17 ranged weapons
 * there are 30 pairs where one Pareto-dominates another numerically, and every single one
 * of them differs mechanically from the weapon it dominates. Mean dps by tier runs
 * fine 8.41 → epic 5.63 → legend 3.75 — i.e. DOWN. Rarity here buys mechanics, not pace.
 * A budget-band gate over these numbers would fail on a roster that is working as designed.
 *
 * What is left is still worth gating, and is what this file does:
 *
 *   1. Within one MECHANICAL SIGNATURE, no weapon may Pareto-dominate another. Two guns
 *      that do the same kind of thing have only their numbers to justify both existing.
 *      This is the non-escapable claim — there is no mechanic to appeal to.
 *   2. Globally, a dominated weapon must at least DIFFER mechanically from its dominator.
 *      A strictly-worse mechanical duplicate is a dead weapon, and this is the gate that
 *      catches one being added.
 *   3. No two weapons are outright clones (same signature AND same numbers).
 *   4. Real spread on each axis, per kind — a roster of near-identical numbers is not a
 *      set of choices, whatever the flavour text says.
 *   5. Every mechanic the engine implements is reachable from at least one player weapon,
 *      so a shipped ballistic/pattern/element cannot go orphaned.
 *
 * Every sweep asserts its own group is non-empty first: a Pareto check over a set that
 * silently became a singleton passes with nothing behind it (design/18).
 *
 * ## Mutation battery
 *
 * DATA mutants (edits to `content/weaponSpecs/*.ts`, not to code — for a content gate that
 * is the mutation that matters). Recorded 2026-09-04; each row is a real edit,
 * `npx vitest run balance/weaponBalance.test.ts`, revert.
 *
 *   KILLED  `scattergun.bullets` 5 → 1, so the blaster dominates it at equal mechanics .. 2
 *   KILLED  `spear` nerfed on cooldown + reach + arc until `hammer` dominates it ........ 3
 *   KILLED  a blade shipped with `deflect: false` ...................................... 1
 *   KILLED  `emberblade` loses its element + tier, becoming a literal saber clone ....... 4
 *   KILLED  `gyre.ballistic` orbit → straight, orphaning the whole orbit shape ......... 5
 *   KILLED  `spear.cooldownSec` 0.3 → 0.08, blowing melee's deliberate dps band ........ 1
 *   KILLED  `lasercutter.cooldownSec` 0.8 → 0.1, making rarity a raw-dps ladder ........ 1
 *
 * No survivors.
 */
import { describe, it, expect } from 'vitest';
import { BALLISTIC_IDS } from '../content/ballistics';
import { DAMAGE_TYPES } from '../content/damage';
import { WEAPON_SPECS } from '../content/weapons';
import type { MeleeSpec, RangedSpec } from '../content/weaponTypes';
import { RARITY_ORDER } from './rarity';
import { bySignature, dominates, hitsPerTrigger, reachGrid, weaponProfile, weaponProfiles, NON_PLAYER_WEAPON_IDS } from './weaponProfile';

const PROFILES = weaponProfiles();
const RANGED = PROFILES.filter((p) => p.kind === 'ranged');
const MELEE = PROFILES.filter((p) => p.kind === 'melee');

describe('the profile set covers the player-facing roster', () => {
  it('is every authored weapon except the mob loadout', () => {
    expect(PROFILES.map((p) => p.id).sort()).toEqual(
      Object.keys(WEAPON_SPECS).filter((id) => !NON_PLAYER_WEAPON_IDS.includes(id)).sort(),
    );
  });

  it('is big enough for a comparison to mean anything, in both kinds', () => {
    expect(RANGED.length).toBeGreaterThanOrEqual(16);
    expect(MELEE.length).toBeGreaterThanOrEqual(7);
  });

  it('every profile carries the same axis set within its kind', () => {
    const rangedAxes = Object.keys(RANGED[0]!.axes).sort();
    const meleeAxes = Object.keys(MELEE[0]!.axes).sort();
    for (const p of RANGED) expect(Object.keys(p.axes).sort(), p.id).toEqual(rangedAxes);
    for (const p of MELEE) expect(Object.keys(p.axes).sort(), p.id).toEqual(meleeAxes);
    // Cross-kind axes are deliberately DIFFERENT — a sword has no reach-vs-speed trade and
    // a gun has no arc. If these ever coincided, `dominates` would silently start comparing
    // across kinds, which is the one thing it must not do.
    expect(rangedAxes).not.toEqual(meleeAxes);
  });

  it('every axis is a finite, non-negative number (higher-is-better, so no NaN escape hatch)', () => {
    for (const p of PROFILES) {
      for (const [axis, v] of Object.entries(p.axes)) {
        expect(Number.isFinite(v), `${p.id}.${axis} = ${v}`).toBe(true);
        expect(v, `${p.id}.${axis}`).toBeGreaterThanOrEqual(0);
      }
    }
  });
});

// ── Gate 1: within one mechanical signature, nothing dominates ────────────────

describe('GATE — no weapon Pareto-dominates another with the SAME mechanical signature', () => {
  const groups = [...bySignature(PROFILES)].filter(([, g]) => g.length > 1);

  it('there really are multi-member signature groups to check (or this gate is a no-op)', () => {
    // Named rather than counted: if a group's membership changes, the failure should say
    // which weapons stopped being mechanically comparable, not just that a number moved.
    const named = groups.map(([sig, g]) => `${sig} :: ${g.map((p) => p.id).sort().join(',')}`).sort();
    expect(named).toEqual([
      'melee melee/physical/deflect/- :: hammer,saber,spear',
      'ranged straight/spread/fire/-/-/- :: cinderscatter,flamer',
      'ranged straight/spread/physical/-/-/- :: blaster,cannon,repeater,scattergun',
    ]);
    // 9 weapons across 3 groups → 4·3 + 3·2 + 2·1 = 20 ordered pairs compared below.
    expect(groups.reduce((n, [, g]) => n + g.length * (g.length - 1), 0)).toBe(20);
  });

  it.each(groups.map(([sig]) => sig))('%s', (sig) => {
    const group = bySignature(PROFILES).get(sig)!;
    const bad: string[] = [];
    for (const a of group) {
      for (const b of group) {
        if (a === b) continue;
        if (dominates(a, b)) {
          const worse = Object.keys(a.axes)
            .map((k) => `${k} ${b.axes[k]} vs ${a.axes[k]}`)
            .join('; ');
          bad.push(`${b.id} is dominated by ${a.id} (same mechanics, nothing to trade): ${worse}`);
        }
      }
    }
    expect(bad).toEqual([]);
  });
});

// ── Gate 2: a dominated weapon must at least be mechanically different ───────

describe('GATE — every numerically dominated weapon differs MECHANICALLY from its dominator', () => {
  it('ranged: no strictly-worse mechanical duplicate', () => {
    const bad: string[] = [];
    for (const a of RANGED) {
      for (const b of RANGED) {
        if (a === b || !dominates(a, b)) continue;
        if (a.signature === b.signature) bad.push(`${b.id} < ${a.id} (both ${a.signature})`);
      }
    }
    expect(bad).toEqual([]);
  });

  it('melee: no strictly-worse mechanical duplicate', () => {
    const bad: string[] = [];
    for (const a of MELEE) {
      for (const b of MELEE) {
        if (a === b || !dominates(a, b)) continue;
        if (a.signature === b.signature) bad.push(`${b.id} < ${a.id} (both ${a.signature})`);
      }
    }
    expect(bad).toEqual([]);
  });

  it('and domination is COMMON, so the gate above is doing work rather than never firing', () => {
    // The measurement that motivated the design of these gates: dominations are everywhere,
    // and the mechanic is always what justifies them. A roster with zero dominations would
    // make gate 2 vacuous — this is the evidence it is not.
    let pairs = 0;
    for (const a of RANGED) for (const b of RANGED) if (a !== b && dominates(a, b)) pairs++;
    expect(pairs, 'ranged numeric domination pairs').toBeGreaterThanOrEqual(20);
  });
});

// ── Gate 3: no clones ─────────────────────────────────────────────────────────

describe('GATE — no two weapons are the same weapon twice', () => {
  it('no pair shares a signature AND every axis value', () => {
    const seen = new Map<string, string>();
    for (const p of PROFILES) {
      const key = `${p.kind}|${p.signature}|${Object.entries(p.axes).map(([k, v]) => `${k}=${v}`).join(',')}`;
      const prior = seen.get(key);
      expect(prior, `${p.id} is a numeric+mechanical clone of ${prior}`).toBeUndefined();
      seen.set(key, p.id);
    }
  });

  it('an elemental sibling IS allowed to share its frame\'s numbers — that is the design', () => {
    // design/03's frame × element bet: `emberblade` is the saber's numbers plus burn, and
    // that is the intended shape, not a clone. It is only the SIGNATURE that has to differ,
    // and it does (element is part of it). Asserted so the clone gate above is never
    // "fixed" by collapsing this case.
    const saber = PROFILES.find((p) => p.id === 'saber')!;
    const ember = PROFILES.find((p) => p.id === 'emberblade')!;
    expect(ember.axes).toEqual(saber.axes);
    expect(ember.signature).not.toBe(saber.signature);
  });
});

// ── Gate 4: real spread on each axis ─────────────────────────────────────────

describe('GATE — the roster spans a real range on each axis (choices, not re-skins)', () => {
  const spread = (group: readonly { id: string; axes: Readonly<Record<string, number>> }[], axis: string) => {
    const vs = group.map((p) => p.axes[axis]!);
    return { min: Math.min(...vs), max: Math.max(...vs) };
  };

  it('ranged: pace, burst, punch and reach all span multiples, not percentages', () => {
    // Thresholds are deliberately loose (a multiple, not a knee on a shipped value): the
    // claim is "these axes are genuinely used", not "dps tops out at 12.5".
    expect(spread(RANGED, 'dps').max / spread(RANGED, 'dps').min).toBeGreaterThanOrEqual(3);
    expect(spread(RANGED, 'burst').max / spread(RANGED, 'burst').min).toBeGreaterThanOrEqual(5);
    expect(spread(RANGED, 'hitDamage').max / spread(RANGED, 'hitDamage').min).toBeGreaterThanOrEqual(2);
    expect(spread(RANGED, 'reachGrid').max / spread(RANGED, 'reachGrid').min).toBeGreaterThanOrEqual(10);
  });

  it('melee: the identity is the SWING SHAPE, not the damage — and the numbers say so', () => {
    // The measurement worth keeping in the tree: melee dps spans a factor of 1.5 while arc
    // spans 3.7x and knockback 4x. Melee weapons are near-flat on damage per second ON
    // PURPOSE (design/03: the melee frame is arc × range × window, and that shape doubles as
    // the parry-frequency axis). A future "let's spread melee dps out" pass has to come
    // through this test and say so.
    const dps = spread(MELEE, 'dps');
    expect(dps.max / dps.min, 'melee dps is intentionally tight').toBeLessThan(2);
    expect(spread(MELEE, 'arcDeg').max / spread(MELEE, 'arcDeg').min).toBeGreaterThanOrEqual(3);
    expect(spread(MELEE, 'knockback').max / spread(MELEE, 'knockback').min).toBeGreaterThanOrEqual(3);
    expect(spread(MELEE, 'reachGrid').max / spread(MELEE, 'reachGrid').min).toBeGreaterThanOrEqual(1.5);
    expect(spread(MELEE, 'windowSec').max / spread(MELEE, 'windowSec').min).toBeGreaterThanOrEqual(2);
  });

  it('no axis is dead — every one of them is actually varied by some weapon', () => {
    for (const [label, group] of [['ranged', RANGED], ['melee', MELEE]] as const) {
      for (const axis of Object.keys(group[0]!.axes)) {
        const { min, max } = spread(group, axis);
        expect(max, `${label}.${axis} is constant at ${min} across the whole roster`).toBeGreaterThan(min);
      }
    }
  });
});

// ── Gate 5: every implemented mechanic is reachable ──────────────────────────

describe('GATE — every mechanic the engine implements is on at least one player weapon', () => {
  it('every ballistic shape ships on a player-facing weapon', () => {
    const used = new Set(
      Object.entries(WEAPON_SPECS)
        .filter(([id, s]) => s.kind === 'ranged' && !NON_PLAYER_WEAPON_IDS.includes(id))
        .map(([, s]) => (s as RangedSpec).ballistic),
    );
    expect([...BALLISTIC_IDS].filter((b) => !used.has(b)), 'orphaned ballistic').toEqual([]);
  });

  it('both emission patterns ship', () => {
    const used = new Set(
      Object.values(WEAPON_SPECS)
        .filter((s): s is RangedSpec => s.kind === 'ranged')
        .map((s) => s.pattern ?? 'spread'),
    );
    expect([...used].sort()).toEqual(['radial', 'spread']);
  });

  it('every damage type ships, on both a gun and a blade', () => {
    for (const kind of ['ranged', 'melee'] as const) {
      const used = new Set(
        Object.entries(WEAPON_SPECS)
          .filter(([id, s]) => s.kind === kind && !NON_PLAYER_WEAPON_IDS.includes(id))
          .map(([, s]) => s.damageType ?? 'physical'),
      );
      const missing = [...DAMAGE_TYPES].filter((t) => !used.has(t));
      // Poison has no blade today — recorded as the one gap rather than asserted away, so
      // the roster's actual coverage is in the tree and a venom sword closes it visibly.
      expect(missing, `${kind} is missing damage types`).toEqual(kind === 'melee' ? ['poison'] : []);
    }
  });

  it('every melee weapon keeps deflect — the ranged-vs-melee trade-off is not optional', () => {
    // design/03: "Every melee frame keeps `deflect: true`, so the ranged-vs-melee trade-off
    // is untouched." A blade that silently shipped without it would quietly delete the
    // parry half of the game's core trade.
    const noDeflect = Object.entries(WEAPON_SPECS)
      .filter((e): e is [string, MeleeSpec] => e[1].kind === 'melee')
      .filter(([, s]) => !s.deflect)
      .map(([id]) => id);
    expect(noDeflect).toEqual([]);
  });

  it('every rarity tier above common carries a mechanic the starter kit does not', () => {
    // The positive form of "rarity is not a dps ladder": what a rarer weapon buys is a
    // MECHANIC. The starter kit is plain straight/physical and plain melee/physical.
    const starterSignatures = new Set(['straight/spread/physical/-/-/-', 'melee/physical/deflect/-']);
    for (const tier of RARITY_ORDER.filter((t) => t !== 'common')) {
      const inTier = PROFILES.filter((p) => p.rarity === tier);
      expect(inTier.length, `no weapon at tier ${tier}`).toBeGreaterThan(0);
      const withMechanic = inTier.filter((p) => !starterSignatures.has(p.signature));
      expect(withMechanic.length, `tier ${tier} is pure stat-inflation over the starter kit`).toBeGreaterThan(0);
    }
  });

  it('rarity is NOT a raw-dps ladder — the roster trades pace for mechanics', () => {
    // Recorded as a gate because it is a design decision that reads like a bug in a table:
    // mean ranged dps by tier runs fine > epic > legend. If a tuning pass ever makes rarity
    // monotonic in dps, this fails, and whoever did it should update design/03/14 (and
    // reconsider the "never crushing" rarity rule) rather than delete the test.
    const meanDps = (tier: string) => {
      const g = RANGED.filter((p) => p.rarity === tier);
      return g.length ? g.reduce((s, p) => s + p.axes.dps!, 0) / g.length : null;
    };
    const fine = meanDps('fine')!;
    const legend = meanDps('legend')!;
    expect(fine, 'fine-tier ranged mean dps').toBeGreaterThan(0);
    expect(legend, 'legend-tier ranged mean dps').toBeGreaterThan(0);
    expect(legend, 'a legendary gun is not a faster gun — it is a different gun').toBeLessThan(fine);
  });
});

// ── The derived metrics themselves ───────────────────────────────────────────

describe('reachGrid / hitsPerTrigger — the two derivations a naive metric gets wrong', () => {
  it('a beam reports its beamRange, not zero (bulletSpeed is 0 — it does not travel)', () => {
    const laser = WEAPON_SPECS.lasercutter as RangedSpec;
    expect(laser.bulletSpeed, 'a beam that travels is no longer hitscan').toBe(0);
    expect(reachGrid(laser)).toBe(laser.beamRangeGrid);
    expect(reachGrid(laser)).toBeGreaterThan(0);
  });

  it('an orbiting blade reports its orbit radius, not zero', () => {
    const gyre = WEAPON_SPECS.gyre as RangedSpec;
    expect(gyre.bulletSpeed).toBe(0);
    expect(reachGrid(gyre)).toBe(gyre.orbitRadiusGrid);
  });

  it('a boomerang reports its OUTBOUND leg, not its whole out-and-back lifespan', () => {
    const tomahawk = WEAPON_SPECS.tomahawk as RangedSpec;
    expect(reachGrid(tomahawk)).toBe(tomahawk.bulletSpeed * tomahawk.returnAfterSec!);
    // The naive metric would report the full lifespan, which is where it never gets to.
    expect(reachGrid(tomahawk)).toBeLessThan(tomahawk.bulletSpeed * tomahawk.lifespanSec);
  });

  it('a travelling bullet reports speed × lifespan', () => {
    const blaster = WEAPON_SPECS.blaster as RangedSpec;
    expect(reachGrid(blaster)).toBe(blaster.bulletSpeed * blaster.lifespanSec);
  });

  it('a beam channel counts its damage applications; everything else lands once', () => {
    expect(hitsPerTrigger(WEAPON_SPECS.lasercutter as RangedSpec)).toBe(4); // 0.4 s / 0.1 s
    expect(hitsPerTrigger(WEAPON_SPECS.blaster as RangedSpec)).toBe(1);
    expect(hitsPerTrigger(WEAPON_SPECS.scattergun as RangedSpec)).toBe(1); // 5 pellets, ONE application each
  });

  it('a beam authored with no cadence degrades to one hit rather than dividing by zero', () => {
    const broken = { ...(WEAPON_SPECS.lasercutter as RangedSpec), beamTickIntervalSec: 0 };
    expect(hitsPerTrigger(broken)).toBe(1);
    const noRange = { ...(WEAPON_SPECS.lasercutter as RangedSpec), beamRangeGrid: undefined };
    expect(reachGrid(noRange)).toBe(0);
  });

  it('every ballistic\'s absent-param arm degrades to 0 rather than NaN', () => {
    // The `?? 0` fallbacks. Unreachable from `WEAPON_SPECS` — a lob without a blast radius
    // or an orbit without a radius is a content error, not a weapon — but they are the arms
    // that decide whether a malformed spec reports 0 or poisons every comparison with NaN
    // (and `NaN >= x` is false, so a NaN axis would silently make a weapon dominate
    // nothing and be dominated by nothing: a weapon invisible to every gate above).
    const orbit = { ...(WEAPON_SPECS.gyre as RangedSpec), orbitRadiusGrid: undefined };
    const boomerang = { ...(WEAPON_SPECS.tomahawk as RangedSpec), returnAfterSec: undefined };
    const beam = { ...(WEAPON_SPECS.lasercutter as RangedSpec), beamSec: undefined };
    const noCadence = { ...(WEAPON_SPECS.lasercutter as RangedSpec), beamTickIntervalSec: undefined };
    expect(reachGrid(orbit)).toBe(0);
    expect(reachGrid(boomerang)).toBe(0);
    expect(hitsPerTrigger(beam)).toBe(0); // 0 s of channel = no applications
    // An ABSENT cadence, not a zero one — a different arm from the `beamTickIntervalSec: 0`
    // case below, and the one that would divide by zero if the guard read the field directly.
    expect(hitsPerTrigger(noCadence)).toBe(1);
    for (const broken of [orbit, boomerang, beam, noCadence]) {
      for (const v of Object.values(weaponProfile('broken', broken).axes)) expect(Number.isNaN(v)).toBe(false);
    }
  });

  it('the signature arms no SHIPPED weapon can reach still build correctly', () => {
    // Three arms the catalog cannot exercise, each for a reason already recorded elsewhere
    // in the tree. Covered with synthetic specs so the module is not carrying uncovered
    // branches, and named so the reason travels with them:
    //
    //   piercing        no weapon sets it at all (content/weapons.test.ts UNUSED_BY_CONTENT)
    //   ranged lifesteal  only `leech` has it, and `leech` is melee
    //                     (systems/rangedCatalog.test.ts pins this one)
    //   deflect: false   every blade deflects, asserted as a design invariant above — so the
    //                    FALSE arm is unreachable by construction, on purpose
    const pierce = weaponProfile('p', { ...(WEAPON_SPECS.blaster as RangedSpec), piercing: true });
    expect(pierce.signature).toContain('pierce');

    const drain = weaponProfile('d', { ...(WEAPON_SPECS.blaster as RangedSpec), lifestealPermille: 200 });
    expect(drain.signature).toContain('lifesteal');

    const noParry = weaponProfile('n', { ...(WEAPON_SPECS.saber as MeleeSpec), deflect: false });
    expect(noParry.signature).not.toContain('deflect');
    // …and it would be a DIFFERENT weapon from the saber, so the clone gate would still see
    // it — the signature is what carries the mechanic, and dropping deflect changes it.
    expect(noParry.signature).not.toBe(PROFILES.find((p) => p.id === 'saber')!.signature);
  });

  it('dominates() is a real Pareto test, not a sum comparison', () => {
    const a = { id: 'a', kind: 'ranged' as const, rarity: 'common' as const, signature: 's', axes: { x: 2, y: 2 } };
    const b = { id: 'b', kind: 'ranged' as const, rarity: 'common' as const, signature: 's', axes: { x: 1, y: 1 } };
    const trade = { id: 'c', kind: 'ranged' as const, rarity: 'common' as const, signature: 's', axes: { x: 5, y: 0 } };
    expect(dominates(a, b)).toBe(true);
    expect(dominates(b, a)).toBe(false);
    // A bigger TOTAL is not domination — c wins on x and loses on y, which is a trade.
    expect(dominates(trade, a)).toBe(false);
    expect(dominates(a, trade)).toBe(false);
    // Equal on everything is not domination either (needs one strict improvement).
    expect(dominates(a, { ...a, id: 'a2' })).toBe(false);
  });
});
