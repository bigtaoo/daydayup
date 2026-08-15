/**
 * Enum → `TranslationKey` lookup tables (split out of `WeaponCard.ts`, which originally
 * owned these but needed them shared with `Forge.ts`/`compareCard.ts` too — CLAUDE.md's
 * 500-line file convention, form ① "independent function/data module": these are pure,
 * stateless lookup tables, not a class, so a sibling file with zero ceremony is enough).
 *
 * Each map is `as const satisfies Record<Enum, TranslationKey>` rather than a
 * `` `hud.rarity.${tier}` `` template cast — the whole point of `TranslationKey` being a
 * compile-time union (design/17-i18n.md) is that a renamed/missing key is a build error;
 * a template-literal cast throws that guarantee away. `satisfies` also makes a new
 * engine-side rarity tier / damage type fail the build here until it has a label, instead
 * of silently rendering the raw key at runtime.
 */
import type { DamageType, RarityTier, WeaponSimSpec } from '@dd/engine';
import type { TranslationKey } from '.';

export const RARITY_KEY = {
  common: 'hud.rarity.common',
  fine: 'hud.rarity.fine',
  epic: 'hud.rarity.epic',
  legend: 'hud.rarity.legend',
  legendary: 'hud.rarity.legendary',
} as const satisfies Record<RarityTier, TranslationKey>;

export const KIND_KEY = {
  ranged: 'hud.kind.ranged',
  melee: 'hud.kind.melee',
} as const satisfies Record<WeaponSimSpec['kind'], TranslationKey>;

export const ELEMENT_KEY = {
  physical: 'hud.element.physical',
  fire: 'hud.element.fire',
  ice: 'hud.element.ice',
  lightning: 'hud.element.lightning',
  poison: 'hud.element.poison',
} as const satisfies Record<DamageType, TranslationKey>;

/** Compact material-bank/cost-line abbreviation (Forge.ts) — a separate namespace from
 * `ELEMENT_KEY` above (the full element name shown in the HUD weapon card) since a
 * short code and a full noun aren't the same string in every language; English's
 * values match `short()`'s old `e.slice(0,3).toUpperCase()` output byte-for-byte. */
export const ELEMENT_SHORT_KEY = {
  physical: 'hud.elementShort.physical',
  fire: 'hud.elementShort.fire',
  ice: 'hud.elementShort.ice',
  lightning: 'hud.elementShort.lightning',
  poison: 'hud.elementShort.poison',
} as const satisfies Record<DamageType, TranslationKey>;
