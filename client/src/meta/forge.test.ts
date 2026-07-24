/**
 * Forge domain (design/14) — the between-run meta layer. Pure transactions over
 * MetaState, plus the persistence port and the seam where a crafted loadout actually
 * reaches a run via EngineConfig.loadout. The engine itself stays untouched by meta
 * beyond that one config field, so these can drive the real createGameEngine.
 */
import { describe, it, expect } from 'vitest';
import { createGameEngine, WEAPON_SIM_BY_ID, PLAYER_BASE } from '@dd/engine';
import {
  defaultMetaState, bankMaterials, unlockBlueprint, isUnlocked, canAfford, craft,
  clearLoadout, selectCharacter, MemoryMetaStore, createWebMetaStore, migrate,
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
    expect(migrate(null)).toEqual(d); // garbage → default
    expect(migrate('nonsense')).toEqual(d);
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

  it('an empty loadout falls back to the auto pistol (design/05 "none → auto pistol")', () => {
    expect(names([])).toEqual([WEAPON_SIM_BY_ID.blaster!.name]);
  });

  it('unknown ids are dropped; too many are capped at WEAPON_SLOTS', () => {
    expect(names(['ghost'])).toEqual([WEAPON_SIM_BY_ID.blaster!.name]); // all unknown → pistol
    expect(names(['repeater', 'flamer', 'cannon'])).toHaveLength(PLAYER_BASE.weaponSlots);
  });
});
