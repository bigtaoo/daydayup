/**
 * Drop-only physical weapons + the mob loadout (split out of weaponSpecs.ts, CLAUDE.md
 * "500-line file convention", form ①; see starter.ts's header for the split rationale).
 * repeater/cannon are opposite poles of the same "gun" identity (uptime vs punch);
 * enemygun is the basic mob's loadout, never player-selectable.
 */
import type { WeaponSpec } from '../weaponTypes';

export const DROP_ONLY_WEAPON_SPECS: Record<string, WeaponSpec> = {
  // ── Repeater (drop-only: fast, weak) ─────────────────────────────────────────
  // The "spray" gun — a weapon drop that trades punch for uptime, a wall of chip damage.
  repeater: {
    id: 'repeater',
    kind: 'ranged',
    nameKey: 'weapon.repeater.name',
    skinRef: 'gun_default',
    rarity: 'fine', // 蓝 — a slightly nicer floor drop

    cooldownSec: 0.1, // 3 ticks — 10 shots/s
    bullets: 1,
    spreadDeg: 0,
    bulletSpeed: 12, // grid/s
    damage: 1,
    ballistic: 'straight',
    // Energy per trigger pull (design/03/05, balance/energy.ts): the pace weapon: 20/s, exactly break-even — sustainable, and the cheapest pull in the game
    energyCost: 2,
    lifespanSec: 2.0,
    bulletRadius: 0.12,
    muzzleGrid: 0.9375,
    bulletZ: 0.5,
  },

  // ── Cannon (drop-only: slow, heavy) ──────────────────────────────────────────
  // The opposite pole — big single hits that two-shot a basic enemy raw. Slow
  // enough that positioning matters.
  cannon: {
    id: 'cannon',
    kind: 'ranged',
    nameKey: 'weapon.cannon.name',
    skinRef: 'gun_default',
    rarity: 'epic', // 紫 — a standout heavy-hitter drop

    cooldownSec: 0.6, // 18 ticks
    bullets: 1,
    spreadDeg: 0,
    bulletSpeed: 8, // grid/s
    damage: 3,
    ballistic: 'straight',
    // Energy per trigger pull (design/03/05, balance/energy.ts): the heavy single shot —
    // 23/s, above the regen line, so three damage a trigger is something you spend for
    energyCost: 14,
    lifespanSec: 3.0,
    bulletRadius: 0.28,
    muzzleGrid: 1.0,
    bulletZ: 0.5,
  },

  // ── Enemy gun (basic mob loadout — not player-selectable) ───────────────────
  // Demo Game.ts enemy: fireInterval 90f, bullet dmg 1, muzzle 20px, same ballistic.
  //   cooldownSec 1.5 → 45 ticks    muzzleGrid 0.625 (20px)
  enemygun: {
    id: 'enemygun',
    kind: 'ranged',
    nameKey: 'weapon.enemygun.name',
    skinRef: 'gun_default',
    rarity: 'common', // 白 — mob loadout, never player-facing

    cooldownSec: 1.5, // 90 frames @60fps
    bullets: 1,
    spreadDeg: 0,
    bulletSpeed: 10, // grid/s
    damage: 1,
    ballistic: 'straight',
    // Energy per trigger pull (design/03/05, balance/energy.ts): enemies are never charged (WeaponFireSystem) — required by the schema, read by nothing
    energyCost: 0,
    lifespanSec: 3.0,
    bulletRadius: 0.15,
    muzzleGrid: 0.625, // grid (demo 20px/32)
    bulletZ: 0.5,
  },

  // ── Enemy melee loadouts (ENGINE_VERSION 59, design/05/09) ──────────────────
  // The roster had NO melee mob at all until now: every one of the eight blueprints
  // carried `ENEMY_GUN_SIM`, and `EnemyBlueprint.weapon` was typed `RangedSimSpec`, so
  // an all-ranged garrison was not a content choice — it was a type constraint.
  //
  // That mattered the moment the ammo economy landed (design/03/05,
  // `balance/energy.ts`): a player who runs an expensive frame dry falls back on the
  // melee half of the loadout, and against an all-ranged roster that fallback means
  // walking into every gun on the floor with the shield's idle regen (the sustain
  // design/05 chose over potions) unable to tick while you do it. A melee mob is what
  // makes the ranged half worth its price back — something you WANT the gun for.
  //
  // Neither carries `deflect`. A mob that parries your bullets back at you is a much
  // larger design change than this pass (it inverts design/03's core mechanic, which
  // is the player's alone today), and it would make the ranged half strictly worse
  // against exactly the mobs it exists to counter. Recorded as a deliberate no, not an
  // oversight; `enemies.test.ts` pins it.
  //
  // Neither is player-facing, so both are excluded from `WEAPON_SIM_BY_ID` alongside
  // `enemygun` — they can never roll as a weapon drop.

  // The rusher's claw: quick, short, one point of damage. Its threat is arriving, not
  // the swing — see `STALKER`'s move speed.
  enemyclaw: {
    id: 'enemyclaw',
    kind: 'melee',
    nameKey: 'weapon.enemyclaw.name',
    skinRef: 'sword_default',
    rarity: 'common', // 白 — mob loadout, never player-facing

    cooldownSec: 0.9, // 27 ticks — slower than the player's saber (11), so a rush is readable
    damage: 1, // same per-hit as ENEMY_GUN_SIM; the difference is that it has to reach you
    arcDeg: 90, // a narrow lunge, not a sweep — it commits to one direction
    rangeGrid: 1.1, // ~35 px reach; STALKER's engageRangeFp parks it inside this
    swingSec: 0.2, // active hit window ⊂ cooldown — long enough to read the wind-up and step out
    knockback: 4, // a shove, not a launch
    deflect: false, // see the section note above — deliberate
    deflectSpeed: 0, // unused while deflect is false; 0 rather than a lie about a speed
  },

  // The heavy's maul: slow, wide, and it moves you. The counterpart to `enemyclaw` —
  // one you dodge by timing, one you dodge by distance.
  enemymaul: {
    id: 'enemymaul',
    kind: 'melee',
    nameKey: 'weapon.enemymaul.name',
    skinRef: 'sword_default',
    rarity: 'common', // 白 — mob loadout, never player-facing

    cooldownSec: 1.8, // 54 ticks — the slowest attack in the game, telegraphed by its window
    damage: 2, // twice a gun shot, at contact range only
    arcDeg: 150, // a wide sweep: standing beside it is not standing clear of it
    rangeGrid: 1.5,
    swingSec: 0.33, // 10 ticks of active window — the long tell that makes it fair
    knockback: 14, // it shoves you out of its own reach, which is what opens the next gap
    deflect: false,
    deflectSpeed: 0,
  },
};
