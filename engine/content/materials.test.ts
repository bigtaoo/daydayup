/**
 * bankKey / parseBankKey (design/14) — the run's material-buffer key format. The
 * `engine` workspace itself had zero direct coverage of this pair before now
 * (only `client/src/meta/forge.test.ts` exercised it, via the client's own
 * re-export) — this is the engine-local round-trip test.
 */
import { describe, it, expect } from 'vitest';
import { bankKey, parseBankKey, MATERIAL_DEFS } from '@dd/engine/content/materials';

describe('bankKey', () => {
  it('tier 0 is written WITHOUT a suffix — byte-identical to the flat legacy key', () => {
    expect(bankKey('mat_fire', 0)).toBe('mat_fire');
  });

  it('tier >= 1 appends a `#<tier>` suffix', () => {
    expect(bankKey('mat_fire', 1)).toBe('mat_fire#1');
    expect(bankKey('mat_ice', 3)).toBe('mat_ice#3');
  });
});

describe('parseBankKey', () => {
  it('a key with no `#` parses as tier 0 (legacy / tier-0 key)', () => {
    expect(parseBankKey('mat_fire')).toEqual({ materialId: 'mat_fire', tier: 0 });
  });

  it('a key with a `#<tier>` suffix parses out the material id and tier', () => {
    expect(parseBankKey('mat_ice#3')).toEqual({ materialId: 'mat_ice', tier: 3 });
  });

  it('a malformed tier suffix (non-numeric) falls back to tier 0', () => {
    expect(parseBankKey('mat_fire#abc')).toEqual({ materialId: 'mat_fire', tier: 0 });
  });
});

describe('bankKey / parseBankKey round-trip', () => {
  it.each([
    ['mat_physical', 0],
    ['mat_fire', 1],
    ['mat_ice', 2],
    ['mat_lightning', 5],
    ['mat_poison', 12],
  ] as const)('%s at tier %i round-trips through bankKey → parseBankKey', (materialId, tier) => {
    expect(parseBankKey(bankKey(materialId, tier))).toEqual({ materialId, tier });
  });

  it('round-trips for every real material id in the base catalog', () => {
    for (const def of Object.values(MATERIAL_DEFS)) {
      for (const tier of [0, 1, 4]) {
        expect(parseBankKey(bankKey(def.id, tier))).toEqual({ materialId: def.id, tier });
      }
    }
  });
});
