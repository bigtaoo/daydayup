/**
 * Run buffs — the in-run power layer that REPLACES affixes (design/05/09/14). With
 * the affix modifier layer cut (ROADMAP 0.1), the moment-to-moment power fantasy is
 * *finding a better weapon* + these **player-level, run-scoped** buffs: found in-run
 * (chests / rooms / shop — 05/14 to-design; the demo drops them off the DROP_TABLE),
 * applied to the player and ALL held weapons, and wiped at run end (they never carry
 * out, unlike materials). They are NOT attached to a weapon.
 *
 * DETERMINISM (design/06): a buff's magnitude lives here as an integer (`mult_*` in
 * per-mille ‰, `flat_*` absolute, `crit_chance` also per-mille). The Σ-clamp families
 * (`mult_damage`/`mult_firerate`/`flat_hp`/`crit_chance`) are summed per kind then
 * clamped by BUFF_CAPS — order-independent (design/09 "fixed application order →
 * deterministic"). Application uses integer arithmetic with a single Math.round, so
 * no float survives into stored state. An unknown buff id is silently ignored
 * (forward-compat, design/09); any change to this arithmetic or the catalogue bumps
 * ENGINE_VERSION (design/08).
 *
 * `crit` (ENGINE_VERSION 25/26 — design/07's original crit sketch): `crit_chance` is
 * a Σ-clamp buff family exactly like the other three; the multiplier itself
 * (`CRIT_DAMAGE_MULT_PERMILLE`) is a fixed constant, not a stacked stat (design/07
 * only ever varies the CHANCE, "critMult" is implied constant). `rollCrit` draws
 * `combatPrng` — but ONLY when `crit_chance > 0`, so a build/enemy that can never
 * crit never advances the stream (design/07's "PvP presets with critPct=0 never
 * advance combatPrng" hard wall, ported from percent to this codebase's per-mille
 * convention: `combatPrng.nextInt(1000) < crit_chance` instead of `nextInt(100) <
 * critPct`).
 */

/** What a buff modifies. All four stack Σ-then-clamp; no per-instance roll. */
export type RunBuffKind = 'mult_damage' | 'mult_firerate' | 'flat_hp' | 'crit_chance';

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
  crit_up: { kind: 'crit_chance', value: 150, nameKey: 'buff.crit_up.name' }, // +15% crit chance
};

/** Σ-then-clamp ceiling per kind (design/09 §caps). Value matches the kind's unit. */
export const BUFF_CAPS: Record<RunBuffKind, number> = {
  mult_damage: 2000, // +200% max — strong but bounded
  mult_firerate: 700, // +70% (cooldown floors at 1 tick regardless)
  flat_hp: 10, // +10 max HP
  crit_chance: 500, // 50% max chance — never a coinflip-or-better guarantee
};

/** Fixed crit damage multiplier (‰, design/07 "critMult") — NOT a stacked buff; only
 * the chance to trigger it stacks. First-pass number, tune against real play like
 * every other constant in this file. */
export const CRIT_DAMAGE_MULT_PERMILLE = 2000; // 2.0×

/** Resolved, clamped per-kind totals for one player's buff stack. */
export interface BuffSums {
  mult_damage: number; // ‰
  mult_firerate: number; // ‰
  flat_hp: number; // absolute
  crit_chance: number; // ‰ chance to trigger CRIT_DAMAGE_MULT_PERMILLE at fire/swing time
}

/** The identity — no buffs (enemies, or a player before any pickup). */
export const NO_BUFFS: BuffSums = { mult_damage: 0, mult_firerate: 0, flat_hp: 0, crit_chance: 0 };

/**
 * Sum a buff-id stack per kind, clamped by BUFF_CAPS. Σ-then-clamp → order-
 * independent (deterministic, design/06). Unknown ids ignored (forward-compat).
 */
export function sumBuffs(ids: readonly RunBuffId[]): BuffSums {
  const s: BuffSums = { mult_damage: 0, mult_firerate: 0, flat_hp: 0, crit_chance: 0 };
  for (const id of ids) {
    const def = RUN_BUFFS[id];
    if (!def) continue; // forward-compat: unknown buff id → skipped
    s[def.kind] += def.value;
  }
  s.mult_damage = Math.min(s.mult_damage, BUFF_CAPS.mult_damage);
  s.mult_firerate = Math.min(s.mult_firerate, BUFF_CAPS.mult_firerate);
  s.flat_hp = Math.min(s.flat_hp, BUFF_CAPS.flat_hp);
  s.crit_chance = Math.min(s.crit_chance, BUFF_CAPS.crit_chance);
  return s;
}

/**
 * Roll a crit at fire/swing time (design/07 "one frozen payload") — the ONLY place
 * `combatPrng` is drawn for crit. Skips the draw entirely when `crit_chance === 0`
 * (every enemy, and any player build with no crit buff) so a config that never crits
 * never advances the stream — design/07's hard wall, load-bearing for PvP presets
 * that want independent replays regardless of who's in them.
 */
export function rollCrit(sums: BuffSums, prng: { nextInt(bound: number): number }): boolean {
  if (sums.crit_chance <= 0) return false;
  return prng.nextInt(1000) < sums.crit_chance;
}

/** Apply the fixed crit multiplier to an already-buffed integer damage value. Identity
 * (returns `dmg` unchanged) when `isCrit` is false. */
export function critDamage(dmg: number, isCrit: boolean): number {
  return isCrit ? Math.round((dmg * CRIT_DAMAGE_MULT_PERMILLE) / 1000) : dmg;
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
