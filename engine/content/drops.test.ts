import { describe, it, expect } from 'vitest';
import { Prng } from '@dd/engine/math/prng';
import {
  rollDrop,
  DROP_TABLE,
  WEAPON_DROP_POOL,
  BUFF_DROP_POOL,
  CARD_ONLY_BUFF_IDS,
  HEAL_DROP_MULT_CAP,
} from '@dd/engine/content/drops';
import { WEAPON_SIM_BY_ID } from '@dd/engine/content/weapons';
import { RUN_BUFFS } from '@dd/engine/balance/runbuffs';
import { MATERIAL_DEFS, MATERIAL_DROP_POOL } from '@dd/engine/content/materials';

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

  it('buff drops resolve to a real buff id in the catalogue', () => {
    const p = new Prng(11);
    for (let i = 0; i < 2000; i++) {
      const d = rollDrop(p);
      if (d.kind === 'buff') {
        expect(BUFF_DROP_POOL).toContain(d.buffId);
        expect(RUN_BUFFS[d.buffId]).toBeDefined();
      }
    }
  });

  it('every buff in the drop pool exists in the catalogue', () => {
    for (const id of BUFF_DROP_POOL) expect(RUN_BUFFS[id]).toBeDefined();
  });

  // The partition that keeps a NEW buff family from being stranded (ENGINE_VERSION 60).
  // `cell_up` is deliberately undroppable — see `CARD_ONLY_BUFF_IDS` for why — but
  // "deliberately undroppable" and "somebody forgot to add it to the pool" look identical
  // from outside, and the second one ships a buff no player can ever obtain. Requiring
  // every catalogue id to be in exactly ONE of the two lists makes the difference a
  // decision somebody has to write down.
  it('every buff in the catalogue is either droppable or explicitly card-only, never neither', () => {
    for (const id of Object.keys(RUN_BUFFS)) {
      const droppable = BUFF_DROP_POOL.includes(id);
      const cardOnly = CARD_ONLY_BUFF_IDS.includes(id);
      expect(droppable || cardOnly, `${id} is reachable from nothing`).toBe(true);
      expect(droppable && cardOnly, `${id} is listed as both droppable and card-only`).toBe(false);
    }
  });

  it('a card-only buff never comes off the drop table, however long the stream runs', () => {
    // Asserted over a real sweep rather than by re-reading `BUFF_DROP_POOL` (which would
    // only restate the line above): this is the claim that the ROLL, not just the list,
    // excludes it.
    const p = new Prng(4242);
    let buffDrops = 0;
    for (let i = 0; i < 20000; i++) {
      const d = rollDrop(p);
      if (d.kind !== 'buff') continue;
      buffDrops++;
      expect(CARD_ONLY_BUFF_IDS).not.toContain(d.buffId);
    }
    expect(buffDrops, 'the sweep never rolled a buff at all').toBeGreaterThan(100);
  });

  it('names the card-only list by CONTENT, so emptying it is a decision and not a silent pass', () => {
    expect([...CARD_ONLY_BUFF_IDS]).toEqual(['cell_up']);
  });

  it('material drops resolve to a real material id + positive quantity', () => {
    const p = new Prng(13);
    for (let i = 0; i < 2000; i++) {
      const d = rollDrop(p);
      if (d.kind === 'material') {
        expect(MATERIAL_DROP_POOL).toContain(d.materialId);
        expect(MATERIAL_DEFS[d.materialId]).toBeDefined();
        expect(d.qty).toBeGreaterThan(0);
      }
    }
  });

  it('every material in the drop pool exists in the catalogue', () => {
    for (const id of MATERIAL_DROP_POOL) expect(MATERIAL_DEFS[id]).toBeDefined();
  });

  it('cinderscatter/frostseeker carry their frame + element (design/03 elemental-variant follow-up)', () => {
    expect(WEAPON_SIM_BY_ID.cinderscatter?.damageType).toBe('fire');
    expect(WEAPON_SIM_BY_ID.frostseeker?.damageType).toBe('ice');
    expect(WEAPON_DROP_POOL).toContain('cinderscatter');
    expect(WEAPON_DROP_POOL).toContain('frostseeker');
  });

  it('produces every kind over a large sample (material the most common)', () => {
    const counts: Record<string, number> = {};
    const p = new Prng(2024);
    const N = 5000;
    for (let i = 0; i < N; i++) {
      const k = rollDrop(p).kind;
      counts[k] = (counts[k] ?? 0) + 1;
    }
    for (const e of DROP_TABLE) expect(counts[e.kind] ?? 0).toBeGreaterThan(0);
    // material has the highest weight → should be the modal drop.
    const material = counts.material ?? 0;
    for (const e of DROP_TABLE) {
      if (e.kind !== 'material') expect(material).toBeGreaterThan(counts[e.kind] ?? 0);
    }
  });
});

// ── The re-weighted table + DropOpts (design/05, ENGINE_VERSION 57) ────────────
//
// The weights below are a design decision, not an implementation detail, and before
// this block nothing in 1346 engine tests noticed when they moved: the heal weight
// went 18 -> 2 and every suite stayed green. These pin the two properties the
// 2026-09-05 loot pass actually promised — potions are rare, and weapons kept the
// odds they had — plus the two invariants the floor-card multiplier rests on.

/** A Prng stand-in that records the weight array it was asked to draw from and the
 *  number of draws it served, so the table can be asserted exactly instead of
 *  sampled. `pick` chooses which DROP_TABLE index `weightedIndex` returns. */
class RecordingPrng {
  readonly weightsSeen: number[][] = [];
  draws = 0;
  constructor(private readonly pick: number) {}
  weightedIndex(weights: readonly number[]): number {
    this.weightsSeen.push([...weights]);
    this.draws++;
    return this.pick;
  }
  nextInt(_max: number): number {
    this.draws++;
    return 0;
  }
}

/** Index of a kind in DROP_TABLE — the tests below name kinds, not positions. */
const entryIndex = (kind: string) => DROP_TABLE.findIndex((e) => e.kind === kind);

describe('drop weights — how much loot a kill actually produces', () => {
  it('makes a health potion RARE: about 2-3% of kills, not the 21% it used to be', () => {
    // Measured, not asserted from the table's own numbers — re-deriving the weights
    // here would make this pass no matter what `rollDrop` did with them.
    const p = new Prng(4242);
    const n = 20_000;
    let heals = 0;
    for (let i = 0; i < n; i++) if (rollDrop(p).kind === 'heal') heals++;
    const rate = heals / n;
    expect(rate).toBeGreaterThan(0.015);
    expect(rate).toBeLessThan(0.04); // the pre-v57 table sat at 0.214 — nowhere near this
  });

  it('leaves the weapon rate exactly where it was — the allowance changed the COUNT, not the odds', () => {
    const p = new Prng(4242);
    const n = 20_000;
    let weapons = 0;
    for (let i = 0; i < n; i++) if (rollDrop(p).kind === 'weapon') weapons++;
    // 5/84 = 5.95%. If a future pass moves the weapon weight, this fails and the
    // ENGINE_VERSION_HISTORY claim that v57 left it alone stops being quietly false.
    expect(weapons / n).toBeGreaterThan(0.05);
    expect(weapons / n).toBeLessThan(0.07);
  });

  it('spends the heal multiplier out of MATERIAL, so the table total never moves', () => {
    // The invariant the floor card rests on: doubling potions must not quietly make
    // weapons rarer for a reason nothing on the card mentions.
    const base = new RecordingPrng(entryIndex('material'));
    rollDrop(base, 0, { healMult: 1 });
    const doubled = new RecordingPrng(entryIndex('material'));
    rollDrop(doubled, 0, { healMult: 2 });

    const w1 = base.weightsSeen[0]!;
    const w2 = doubled.weightsSeen[0]!;
    const sum = (w: number[]) => w.reduce((a, b) => a + b, 0);
    expect(sum(w2)).toBe(sum(w1));
    expect(w2[entryIndex('heal')]).toBe(w1[entryIndex('heal')]! * 2);
    expect(w2[entryIndex('weapon')]).toBe(w1[entryIndex('weapon')]);
    expect(w2[entryIndex('buff')]).toBe(w1[entryIndex('buff')]);
    expect(w2[entryIndex('material')]).toBe(w1[entryIndex('material')]! - w1[entryIndex('heal')]!);
  });

  it('clamps the heal multiplier to [1, HEAL_DROP_MULT_CAP] and rounds it', () => {
    const at = (healMult: number) => {
      const r = new RecordingPrng(entryIndex('material'));
      rollDrop(r, 0, { healMult });
      return r.weightsSeen[0]![entryIndex('heal')]!;
    };
    const base = at(1);
    expect(at(0)).toBe(base); // never REDUCES potions below the table's own floor
    expect(at(-5)).toBe(base);
    expect(at(2.4)).toBe(base * 2); // rounded — weightedIndex draws on integers only
    expect(at(1000)).toBe(base * HEAL_DROP_MULT_CAP);
    expect(at(HEAL_DROP_MULT_CAP)).toBe(base * HEAL_DROP_MULT_CAP);
  });
});

describe('DropOpts.weaponAllowed — a refused weapon degrades to material', () => {
  it('turns a rolled weapon into a material when the floor allowance is spent', () => {
    const r = new RecordingPrng(entryIndex('weapon'));
    expect(rollDrop(r, 0, { weaponAllowed: false }).kind).toBe('material');
    const allowed = new RecordingPrng(entryIndex('weapon'));
    expect(rollDrop(allowed, 0, { weaponAllowed: true }).kind).toBe('weapon');
  });

  it('costs the SAME number of dropPrng draws either way — the run stays aligned', () => {
    // Load-bearing for design/06: if refusing a weapon cost a different number of
    // draws, turning the per-floor allowance on would shift every later drop in the
    // run, and the quota could never be retuned without re-recording every replay.
    const refused = new RecordingPrng(entryIndex('weapon'));
    rollDrop(refused, 0, { weaponAllowed: false });
    const granted = new RecordingPrng(entryIndex('weapon'));
    rollDrop(granted, 0, { weaponAllowed: true });
    expect(refused.draws).toBe(granted.draws);
    expect(refused.draws).toBe(2); // one weighted table draw + one payload draw
  });

  it('defaults to allowing weapons, so every pre-v57 caller is unaffected', () => {
    const r = new RecordingPrng(entryIndex('weapon'));
    expect(rollDrop(r).kind).toBe('weapon');
    expect(rollDrop(new RecordingPrng(entryIndex('weapon')), 0, {}).kind).toBe('weapon');
  });

  it('never suppresses a kind other than weapon', () => {
    for (const kind of ['material', 'heal', 'buff']) {
      const r = new RecordingPrng(entryIndex(kind));
      expect(rollDrop(r, 0, { weaponAllowed: false }).kind).toBe(kind);
    }
  });
});
