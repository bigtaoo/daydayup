/**
 * Forge domain (design/14) — the between-run meta layer. Pure transactions over
 * MetaState, plus the persistence port and the seam where a crafted loadout actually
 * reaches a run via EngineConfig.loadout. The engine itself stays untouched by meta
 * beyond that one config field, so these can drive the real createGameEngine.
 */
import { describe, it, expect } from 'vitest';
import { createGameEngine, WEAPON_SIM_BY_ID, PLAYER_BASE, bankKey, parseBankKey } from '@dd/engine';
import {
  defaultMetaState, bankMaterials, unlockBlueprint, isUnlocked, canAfford, craft,
  clearLoadout, selectCharacter, grantCharacter, acquireBlueprint, purchasableBlueprints,
  bankTotal, MemoryMetaStore, createWebMetaStore, migrate,
} from './index';
import { BLUEPRINT_CATALOG } from '@dd/engine';

describe('bankMaterials', () => {
  it('folds a run bag into the account bank, summing by material id', () => {
    let m = defaultMetaState();
    m = bankMaterials(m, { mat_fire: 2, mat_ice: 1 });
    m = bankMaterials(m, { mat_fire: 3 });
    expect(m.materialBank.mat_fire).toBe(5);
    expect(m.materialBank.mat_ice).toBe(1);
  });
  it('does not mutate the input state (pure)', () => {
    const m = defaultMetaState();
    const next = bankMaterials(m, { mat_fire: 1 });
    expect(m.materialBank.mat_fire).toBeUndefined();
    expect(next).not.toBe(m);
  });
});

describe('unlockBlueprint', () => {
  it('grants a blueprint, is idempotent, and ignores unknown ids', () => {
    let m = defaultMetaState();
    expect(isUnlocked(m, 'cryobolt')).toBe(false); // a purchase blueprint, not a starter
    m = unlockBlueprint(m, 'cryobolt');
    expect(isUnlocked(m, 'cryobolt')).toBe(true);
    const again = unlockBlueprint(m, 'cryobolt');
    expect(again.unlockedBlueprints.filter((b) => b === 'cryobolt')).toHaveLength(1);
    expect(unlockBlueprint(m, 'not_a_weapon').unlockedBlueprints).toEqual(m.unlockedBlueprints);
  });
});

describe('craft', () => {
  it('crafts an unlocked, affordable blueprint: spends materials and stages it into the loadout', () => {
    let m = defaultMetaState(); // repeater is a starter (drop) blueprint, cost physical×3
    m = bankMaterials(m, { mat_physical: 4 });
    const res = craft(m, 'repeater');
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.meta.loadout).toEqual(['repeater']);
      expect(res.meta.materialBank.mat_physical).toBe(1); // 4 - 3
    }
  });

  it('rejects a locked blueprint', () => {
    const m = bankMaterials(defaultMetaState(), { mat_ice: 9 });
    expect(craft(m, 'cryobolt')).toEqual({ ok: false, reason: 'locked' });
  });

  it('rejects when materials are short', () => {
    const m = defaultMetaState(); // repeater unlocked, but empty bank
    expect(craft(m, 'repeater')).toEqual({ ok: false, reason: 'unaffordable' });
    expect(canAfford(m, BLUEPRINT_CATALOG.repeater!)).toBe(false);
  });

  it('rejects an unknown weapon id', () => {
    expect(craft(defaultMetaState(), 'ghost')).toEqual({ ok: false, reason: 'unknown' });
  });

  it('rejects once the loadout is full (WEAPON_SLOTS)', () => {
    let m = defaultMetaState();
    m = bankMaterials(m, { mat_physical: 3, mat_fire: 3 });
    m = unlockBlueprint(m, 'flamer'); // already a starter, but explicit
    const a = craft(m, 'repeater');
    expect(a.ok).toBe(true);
    const b = a.ok ? craft(a.meta, 'flamer') : a;
    expect(b.ok).toBe(true);
    if (b.ok) {
      expect(b.meta.loadout).toHaveLength(PLAYER_BASE.weaponSlots);
      // A third craft has nowhere to go, even with materials.
      const withMore = bankMaterials(b.meta, { mat_physical: 5 });
      expect(craft(withMore, 'repeater')).toEqual({ ok: false, reason: 'loadout-full' });
    }
  });
});

describe('tier-gated recipes (design/14 minTier)', () => {
  it('bankKey / parseBankKey: tier 0 is the flat key, tier ≥ 1 carries a #tag', () => {
    expect(bankKey('mat_fire', 0)).toBe('mat_fire'); // byte-identical to the pre-tier key
    expect(bankKey('mat_fire', 2)).toBe('mat_fire#2');
    expect(parseBankKey('mat_fire')).toEqual({ materialId: 'mat_fire', tier: 0 });
    expect(parseBankKey('mat_fire#2')).toEqual({ materialId: 'mat_fire', tier: 2 });
  });

  it('bankTotal sums an element across every tier', () => {
    let m = defaultMetaState();
    m = bankMaterials(m, { [bankKey('mat_fire', 0)]: 2, [bankKey('mat_fire', 3)]: 4, mat_ice: 1 });
    expect(bankTotal(m, 'fire')).toBe(6); // 2 (t0) + 4 (t3)
    expect(bankTotal(m, 'fire', 1)).toBe(4); // only tier ≥ 1
    expect(bankTotal(m, 'ice')).toBe(1);
  });

  it('a minTier cost rejects below-threshold materials but accepts qualifying ones', () => {
    // emberblade: fire×2 minTier 1 + physical×2. It is an event blueprint → unlock first.
    let m = unlockBlueprint(defaultMetaState(), 'emberblade');
    m = bankMaterials(m, { mat_fire: 5, mat_physical: 5 }); // all tier 0 — fire is too low
    expect(canAfford(m, BLUEPRINT_CATALOG.emberblade!)).toBe(false);
    expect(craft(m, 'emberblade')).toEqual({ ok: false, reason: 'unaffordable' });

    m = bankMaterials(m, { [bankKey('mat_fire', 1)]: 2 }); // refined fire from a deeper floor
    expect(canAfford(m, BLUEPRINT_CATALOG.emberblade!)).toBe(true);
    const res = craft(m, 'emberblade');
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.meta.materialBank['mat_fire#1']).toBeUndefined(); // the 2 tier-1 fire spent
      expect(res.meta.materialBank.mat_fire).toBe(5); // the tier-0 fire is untouched (below gate)
      expect(res.meta.materialBank.mat_physical).toBe(3); // 5 - 2
    }
  });

  it('spends the LOWEST qualifying tier first, preserving scarce high-tier materials', () => {
    let m = defaultMetaState(); // repeater: physical×3, no minTier → any tier qualifies
    m = bankMaterials(m, { mat_physical: 2, [bankKey('mat_physical', 2)]: 5 });
    const res = craft(m, 'repeater');
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.meta.materialBank.mat_physical).toBeUndefined(); // tier 0 drained first (2)
      expect(res.meta.materialBank['mat_physical#2']).toBe(4); // then 1 from tier 2 → 5-1
    }
  });
});

describe('loadout & character selection', () => {
  it('clearLoadout empties the staged loadout', () => {
    let m = bankMaterials(defaultMetaState(), { mat_physical: 3 });
    const r = craft(m, 'repeater');
    m = r.ok ? r.meta : m;
    expect(clearLoadout(m).loadout).toEqual([]);
  });
  it('selectCharacter switches to an owned character and ignores an unowned one', () => {
    const m = defaultMetaState();
    expect(selectCharacter(m, 'skirmisher').selectedSkin).toBe('skirmisher');
    expect(selectCharacter(m, 'paid_hero_not_owned').selectedSkin).toBe(m.selectedSkin);
  });
});

describe('monetization scaffolding (grant APIs, ROADMAP 2.4)', () => {
  it('grantCharacter adds an unowned character and is idempotent', () => {
    const m = defaultMetaState();
    const before = m.ownedCharacters.length;
    const g = grantCharacter(m, 'paid_hero');
    expect(g.ownedCharacters).toContain('paid_hero');
    expect(grantCharacter(g, 'paid_hero').ownedCharacters).toHaveLength(before + 1); // idempotent
  });

  it('purchasableBlueprints lists locked non-drop blueprints; acquire removes one from the shelf', () => {
    const m = defaultMetaState();
    const shelf = purchasableBlueprints(m);
    expect(shelf.length).toBeGreaterThan(0);
    for (const id of shelf) {
      expect(BLUEPRINT_CATALOG[id]!.source).not.toBe('drop');
      expect(isUnlocked(m, id)).toBe(false);
    }
    const bought = acquireBlueprint(m, shelf[0]!);
    expect(isUnlocked(bought, shelf[0]!)).toBe(true);
    expect(purchasableBlueprints(bought)).not.toContain(shelf[0]);
  });
});

describe('persistence (MetaStore)', () => {
  it('MemoryMetaStore round-trips state', () => {
    const store = new MemoryMetaStore();
    const m = bankMaterials(defaultMetaState(), { mat_poison: 7 });
    store.save(m);
    expect(store.load().materialBank.mat_poison).toBe(7);
  });
  it('createWebMetaStore loads a default account with no prior save (or no storage at all)', () => {
    // Works whether or not localStorage exists in the test env: a fresh key (or the
    // no-storage fallback) both yield the default account rather than throwing.
    const store = createWebMetaStore('daydayup.meta.test.fresh');
    const m = store.load();
    expect(m.loadout).toEqual([]);
    expect(m.unlockedBlueprints.length).toBeGreaterThanOrEqual(1);
  });
  it('migrate backfills missing fields and unions unlocks/ownership with defaults', () => {
    const d = defaultMetaState();
    const old = migrate({ unlockedBlueprints: ['cryobolt'], materialBank: { mat_fire: 2 } });
    expect(old.materialBank.mat_fire).toBe(2);
    expect(old.unlockedBlueprints).toEqual(expect.arrayContaining([...d.unlockedBlueprints, 'cryobolt']));
    expect(old.selectedSkin).toBe(d.selectedSkin); // backfilled
    expect(old.loadout).toEqual([]);
    expect(old.hasSeenTutorial).toBe(false); // backfilled — a save from before the tutorial existed
    expect(migrate(null)).toEqual(d); // garbage → default
    expect(migrate('nonsense')).toEqual(d);
  });

  // design/10 screen-flow gap: hasSeenTutorial (new field) must both backfill to false
  // for an old save that predates the tutorial AND survive migration once set — a save
  // written by a build that HAS it must never regress back to "unseen".
  it('migrate preserves hasSeenTutorial:true from a save that already has it', () => {
    const saved = migrate({ hasSeenTutorial: true });
    expect(saved.hasSeenTutorial).toBe(true);
  });

  it('migrate ignores a non-boolean hasSeenTutorial and falls back to the default', () => {
    const d = defaultMetaState();
    const saved = migrate({ hasSeenTutorial: 'yes' });
    expect(saved.hasSeenTutorial).toBe(d.hasSeenTutorial);
  });

  // ROADMAP: materialBank used to be the one field migrate() spread through unchecked
  // instead of validating like every sibling field — a corrupted/hand-edited save with
  // a string qty passed straight through and broke forge.ts's `sum + e.qty` reduce
  // (string concatenation) instead of failing safe.
  describe('migrate — materialBank value validation', () => {
    it('drops a non-numeric qty (e.g. a hand-edited string) instead of passing it through', () => {
      const saved = migrate({ materialBank: { mat_fire: '5', mat_ice: 3 } });
      expect(saved.materialBank.mat_fire).toBeUndefined();
      expect(saved.materialBank.mat_ice).toBe(3);
    });

    it('drops non-finite qtys (NaN/Infinity)', () => {
      const saved = migrate({ materialBank: { mat_fire: NaN, mat_ice: Infinity, mat_poison: 4 } });
      expect(saved.materialBank).toEqual({ mat_poison: 4 });
    });

    it('a materialBank that is itself not an object (array, string, number) falls back to empty, not a crash', () => {
      expect(migrate({ materialBank: ['not', 'an', 'object'] }).materialBank).toEqual({});
      expect(migrate({ materialBank: 'nonsense' }).materialBank).toEqual({});
      expect(migrate({ materialBank: 5 }).materialBank).toEqual({});
    });

    it('a fully well-typed materialBank round-trips exactly (no behavior change for a healthy save)', () => {
      const saved = migrate({ materialBank: { mat_fire: 2, 'mat_ice#1': 7 } });
      expect(saved.materialBank).toEqual({ mat_fire: 2, 'mat_ice#1': 7 });
    });

    it('a corrupted qty can no longer corrupt bankTotal via string concatenation (the actual failure this caused)', () => {
      const saved = migrate({ materialBank: { mat_fire: '5', mat_ice: 3 } });
      // Before the fix, summing a string qty alongside a real number produced string
      // concatenation ("0" + 3 + "5" style) instead of numeric addition; now the bad
      // entry is simply absent, so the sum is the healthy remainder only.
      expect(bankTotal(saved, 'ice')).toBe(3);
    });
  });
});

describe('meta loadout reaches the run via EngineConfig.loadout', () => {
  const names = (loadout?: readonly string[]) => {
    const eng = createGameEngine({ seed: 1, worldW: 800, worldH: 600, waves: [], loadout });
    return eng.state.players[0]!.weapons.map((w) => w.spec.name);
  };

  it('a crafted loadout becomes the player’s carried weapons', () => {
    const start = bankMaterials(defaultMetaState(), { mat_physical: 3, mat_fire: 3 });
    const r1 = craft(start, 'repeater');
    const r2 = r1.ok ? craft(r1.meta, 'flamer') : r1;
    const loadout = r2.ok ? r2.meta.loadout : [];
    expect(loadout).toEqual(['repeater', 'flamer']);
    expect(names(loadout)).toEqual([WEAPON_SIM_BY_ID.repeater!.name, WEAPON_SIM_BY_ID.flamer!.name]);
  });

  it('an absent loadout keeps the default starter loadout (byte-compatible with old configs)', () => {
    expect(names(undefined)).toEqual(PLAYER_BASE.startWeapons.map((s) => s.name));
  });

  // Was "an empty loadout falls back to the auto pistol". That rule fired on every
  // ORDINARY run — a fresh save stages `[]`, and Game.beginRun consumes the staged
  // loadout immediately (design/05 "one run each"), so runs 2+ were always empty — and
  // it left the player holding a single gun with no melee weapon and no second slot, at
  // which point the HUD's swap chip hides itself and the swap verb vanishes. See
  // engine/content/players.test.ts for resolveLoadout's own rules.
  it('an empty loadout still spawns the full starter pair, not a lone pistol', () => {
    expect(names([])).toEqual(PLAYER_BASE.startWeapons.map((s) => s.name));
  });

  it('a HALF-crafted loadout keeps the crafted weapon and fills the other slot by kind', () => {
    const start = bankMaterials(defaultMetaState(), { mat_physical: 3 });
    const r = craft(start, 'repeater');
    expect(r.ok).toBe(true);
    const loadout = r.ok ? r.meta.loadout : [];
    expect(loadout).toEqual(['repeater']);
    // The crafted gun replaces the DEFAULT GUN; the starter saber stays in slot 2, so a
    // player who crafted one weapon can still swap to melee.
    expect(names(loadout)).toEqual(['repeater', WEAPON_SIM_BY_ID.saber!.name]);
  });

  it('unknown ids are dropped; too many are capped at WEAPON_SLOTS', () => {
    expect(names(['ghost'])).toEqual(PLAYER_BASE.startWeapons.map((s) => s.name)); // all unknown → starter pair
    expect(names(['repeater', 'flamer', 'cannon'])).toHaveLength(PLAYER_BASE.weaponSlots);
  });

  it('every run carries a second slot for the swap control to point at', () => {
    // The invariant the live report was actually about — asserted at the seam a real run
    // goes through, not just against resolveLoadout in isolation.
    for (const loadout of [undefined, [], ['ghost'], ['repeater'], ['emberblade']]) {
      expect(names(loadout).length).toBe(PLAYER_BASE.weaponSlots);
    }
  });
});
