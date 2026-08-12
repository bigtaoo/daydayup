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
    lifespanSec: 3.0,
    bulletRadius: 0.15,
    muzzleGrid: 0.625, // grid (demo 20px/32)
    bulletZ: 0.5,
  },
};
