/**
 * Run buffs — the in-run power layer that REPLACES affixes (design/05/09/14). With
 * the affix modifier layer cut (ROADMAP 0.1), the moment-to-moment power fantasy is
 * *finding a better weapon* + these **player-level, run-scoped** buffs: found in-run
 * (chests / rooms / shop — 05/14 to-design; the demo drops them off the DROP_TABLE),
 * applied to the player and ALL held weapons, and wiped at run end (they never carry
 * out, unlike materials). They are NOT attached to a weapon.
 *
 * DETERMINISM (design/06): a buff's magnitude lives here as an integer (`mult_*` in
 * per-mille ‰, `flat_*` absolute). The stack is summed per kind then clamped by
 * BUFF_CAPS — Σ-then-clamp, so the result is INDEPENDENT of pickup order (design/09
 * "fixed application order → deterministic"). Application uses integer arithmetic
 * with a single Math.round, so no float survives into stored state. An unknown buff
 * id is silently ignored (forward-compat, design/09); any change to this arithmetic
 * or the catalogue bumps ENGINE_VERSION (design/08).
 *
 * `crit` and other families named in the roadmap need a hit-time PRNG draw (a new
 * combatPrng use) and are deferred — this first pass ships the three pure Σ-clamp
 * numeric families (design/14 "mult_damage/mult_firerate/flat_hp/…").
 */

/** What a buff modifies. All three stack Σ-then-clamp; no per-instance roll. */
export type RunBuffKind = 'mult_damage' | 'mult_firerate' | 'flat_hp';

/** A catalogue id (string keeps it forward-compatible — unknown ids are ignored). */
export type RunBuffId = string;

interface RunBuffDef {
  kind: RunBuffKind;
  /** Magnitude: per-mille (‰) for `mult_*`, absolute for `flat_*`. */
  value: number;
  nameKey: string; // i18n KEY only, never display text (design/09)
}

/**
 * The buff catalogue (design/14 — final families/values are 05/09 to-design). Fixed
 * magnitudes per id; the player stack stores ids, `sumBuffs` resolves through this.
 */
export const RUN_BUFFS: Record<string, RunBuffDef> = {
  dmg_up: { kind: 'mult_damage', value: 500, nameKey: 'buff.dmg_up.name' }, // +50% damage
  rof_up: { kind: 'mult_firerate', value: 400, nameKey: 'buff.rof_up.name' }, // +40% attack speed
  vit_up: { kind: 'flat_hp', value: 2, nameKey: 'buff.vit_up.name' }, // +2 max HP (also heals +2)
};

/** Σ-then-clamp ceiling per kind (design/09 §caps). Value matches the kind's unit. */
export const BUFF_CAPS: Record<RunBuffKind, number> = {
  mult_damage: 2000, // +200% max — strong but bounded
  mult_firerate: 700, // +70% (cooldown floors at 1 tick regardless)
  flat_hp: 10, // +10 max HP
};

/** Resolved, clamped per-kind totals for one player's buff stack. */
export interface BuffSums {
  mult_damage: number; // ‰
  mult_firerate: number; // ‰
  flat_hp: number; // absolute
}

/** The identity — no buffs (enemies, or a player before any pickup). */
export const NO_BUFFS: BuffSums = { mult_damage: 0, mult_firerate: 0, flat_hp: 0 };

/**
 * Sum a buff-id stack per kind, clamped by BUFF_CAPS. Σ-then-clamp → order-
 * independent (deterministic, design/06). Unknown ids ignored (forward-compat).
 */
export function sumBuffs(ids: readonly RunBuffId[]): BuffSums {
  const s: BuffSums = { mult_damage: 0, mult_firerate: 0, flat_hp: 0 };
  for (const id of ids) {
    const def = RUN_BUFFS[id];
    if (!def) continue; // forward-compat: unknown buff id → skipped
    s[def.kind] += def.value;
  }
  s.mult_damage = Math.min(s.mult_damage, BUFF_CAPS.mult_damage);
  s.mult_firerate = Math.min(s.mult_firerate, BUFF_CAPS.mult_firerate);
  s.flat_hp = Math.min(s.flat_hp, BUFF_CAPS.flat_hp);
  return s;
}

/** Apply the damage buff to an integer base (per-mille, single round). Identity at 0. */
export function buffedDamage(base: number, sums: BuffSums): number {
  return Math.round((base * (1000 + sums.mult_damage)) / 1000);
}

/**
 * Buffed cooldown: faster attack = FEWER ticks between shots/swings. Floors at 1 so
 * it never reaches 0 (design mirrors the old mult_firerate affix). Identity at 0.
 */
export function buffedCooldown(baseTicks: number, sums: BuffSums): number {
  return Math.max(1, Math.round((baseTicks * 1000) / (1000 + sums.mult_firerate)));
}
