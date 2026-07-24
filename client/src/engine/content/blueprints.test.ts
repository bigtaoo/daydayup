/**
 * Blueprint catalog integrity (design/14). The recipes are engine content, so they must
 * reference real weapons and real elemental materials — validated at load (design/09
 * "fail loud, never at use"). These tests pin that guard and the starter set.
 */
import { describe, it, expect } from 'vitest';
import { BLUEPRINT_CATALOG, STARTER_BLUEPRINTS, validateBlueprints } from '@dd/engine/content/blueprints';
import { WEAPON_SPECS } from '@dd/engine/content/weapons';
import { DAMAGE_TYPES } from '@dd/engine/content/damage';

describe('BLUEPRINT_CATALOG', () => {
  it('passes load-time validation (every weaponId + material element is real)', () => {
    expect(() => validateBlueprints()).not.toThrow();
  });

  it('every blueprint names a real weapon and positive elemental costs', () => {
    for (const [id, bp] of Object.entries(BLUEPRINT_CATALOG)) {
      expect(bp.weaponId, id).toBe(id); // key === weaponId by convention
      expect(WEAPON_SPECS[bp.weaponId], id).toBeDefined();
      expect(bp.cost.length, id).toBeGreaterThan(0);
      for (const c of bp.cost) {
        expect(DAMAGE_TYPES).toContain(c.element);
        expect(c.qty).toBeGreaterThan(0);
      }
    }
  });

  it('starter blueprints are exactly the drop-source ones and all in the catalog', () => {
    const drops = Object.values(BLUEPRINT_CATALOG).filter((b) => b.source === 'drop').map((b) => b.weaponId);
    expect([...STARTER_BLUEPRINTS].sort()).toEqual([...drops].sort());
    for (const id of STARTER_BLUEPRINTS) expect(BLUEPRINT_CATALOG[id]).toBeDefined();
    expect(STARTER_BLUEPRINTS.length).toBeGreaterThanOrEqual(1);
  });

  it('fails loud on an unknown weaponId', () => {
    expect(() => validateBlueprints({ ghost: { weaponId: 'nope', nameKey: 'x', source: 'drop', cost: [{ element: 'fire', qty: 1 }] } })).toThrow(/weaponId/);
  });

  it('fails loud on an unknown material element', () => {
    expect(() =>
      validateBlueprints({ bad: { weaponId: 'repeater', nameKey: 'x', source: 'drop', cost: [{ element: 'plasma' as never, qty: 1 }] } }),
    ).toThrow(/element/);
  });
});
