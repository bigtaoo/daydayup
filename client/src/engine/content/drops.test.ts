import { describe, it, expect } from 'vitest';
import { Prng } from '@dd/engine/math/prng';
import { rollDrop, DROP_TABLE, WEAPON_DROP_POOL } from '@dd/engine/content/drops';
import { WEAPON_SIM_BY_ID } from '@dd/engine/content/weapons';

describe('rollDrop — deterministic drop table', () => {
  it('is reproducible from the same seed', () => {
    const a = new Prng(1234);
    const b = new Prng(1234);
    for (let i = 0; i < 100; i++) {
      expect(rollDrop(a)).toEqual(rollDrop(b));
    }
  });

  it('diverges on a different seed', () => {
    const s1 = new Prng(1);
    const s2 = new Prng(2);
    const a = Array.from({ length: 50 }, () => rollDrop(s1));
    const b = Array.from({ length: 50 }, () => rollDrop(s2));
    expect(a).not.toEqual(b);
  });

  it('only ever yields kinds in the table', () => {
    const kinds = new Set(DROP_TABLE.map((e) => e.kind));
    const p = new Prng(99);
    for (let i = 0; i < 500; i++) expect(kinds.has(rollDrop(p).kind)).toBe(true);
  });

  it('weapon drops resolve to a real, player-facing weapon spec', () => {
    const p = new Prng(7);
    for (let i = 0; i < 2000; i++) {
      const d = rollDrop(p);
      if (d.kind === 'weapon') {
        expect(WEAPON_DROP_POOL).toContain(d.weaponId);
        expect(WEAPON_SIM_BY_ID[d.weaponId]).toBeDefined();
      }
    }
  });

  it('produces every kind over a large sample (coins the most common)', () => {
    const counts: Record<string, number> = {};
    const p = new Prng(2024);
    const N = 5000;
    for (let i = 0; i < N; i++) {
      const k = rollDrop(p).kind;
      counts[k] = (counts[k] ?? 0) + 1;
    }
    for (const e of DROP_TABLE) expect(counts[e.kind] ?? 0).toBeGreaterThan(0);
    // coin has the highest weight → should be the modal drop.
    const coin = counts.coin ?? 0;
    for (const e of DROP_TABLE) {
      if (e.kind !== 'coin') expect(coin).toBeGreaterThan(counts[e.kind] ?? 0);
    }
  });
});
