import { describe, it, expect } from 'vitest';
import { WEAPON_SPECS, applyQuality } from '@dd/engine';
import { buildCompareRows, equippedSpecOfKind } from './compareCard';

describe('buildCompareRows', () => {
  it('returns null comparing a ranged spec against a melee spec', () => {
    expect(buildCompareRows(WEAPON_SPECS.blaster!, WEAPON_SPECS.saber!)).toBeNull();
  });

  it('builds ranged-specific rows (fire rate/spread/speed), damage post-quality', () => {
    const rows = buildCompareRows(WEAPON_SPECS.blaster!, WEAPON_SPECS.repeater!);
    expect(rows).not.toBeNull();
    const byLabel = Object.fromEntries(rows!.map((r) => [r.label, r]));
    expect(byLabel.Damage!.left).toBe(String(applyQuality(WEAPON_SPECS.blaster!.damage, WEAPON_SPECS.blaster!.rarity)));
    expect(byLabel.Damage!.right).toBe(String(applyQuality(WEAPON_SPECS.repeater!.damage, WEAPON_SPECS.repeater!.rarity)));
    expect(byLabel['Fire rate']).toBeDefined();
    expect(byLabel.Spread).toBeDefined();
    expect(byLabel.Speed).toBeDefined();
    expect(byLabel.Arc).toBeUndefined();
  });

  it('builds melee-specific rows (swing/arc/reach/deflect)', () => {
    const rows = buildCompareRows(WEAPON_SPECS.saber!, WEAPON_SPECS.hammer!);
    expect(rows).not.toBeNull();
    const byLabel = Object.fromEntries(rows!.map((r) => [r.label, r]));
    expect(byLabel.Swing).toBeDefined();
    expect(byLabel.Arc).toBeDefined();
    expect(byLabel.Reach).toBeDefined();
    expect(byLabel.Deflect).toBeDefined();
    expect(byLabel['Fire rate']).toBeUndefined();
  });

  it('every row has a value on both sides', () => {
    const rows = buildCompareRows(WEAPON_SPECS.blaster!, WEAPON_SPECS.cannon!)!;
    for (const r of rows) {
      expect(r.left.length).toBeGreaterThan(0);
      expect(r.right.length).toBeGreaterThan(0);
    }
  });
});

describe('equippedSpecOfKind', () => {
  it('finds the loadout entry matching the requested kind', () => {
    expect(equippedSpecOfKind(['cannon', 'hammer'], 'ranged')).toBe(WEAPON_SPECS.cannon);
    expect(equippedSpecOfKind(['cannon', 'hammer'], 'melee')).toBe(WEAPON_SPECS.hammer);
  });

  it('returns undefined when the loadout has no entry of that kind', () => {
    expect(equippedSpecOfKind(['cannon'], 'melee')).toBeUndefined();
  });

  it('returns undefined for an empty loadout', () => {
    expect(equippedSpecOfKind([], 'ranged')).toBeUndefined();
  });
});
