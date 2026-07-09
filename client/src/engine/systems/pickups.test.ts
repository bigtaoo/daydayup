import { describe, it, expect } from 'vitest';
import { createGameState } from '@dd/engine/state/GameState';
import type { GameState } from '@dd/engine/state/GameState';
import type { PickupItem, RangedSimSpec } from '@dd/engine/state/entities';
import { PickupSystem } from '@dd/engine/systems';

const CFG = { seed: 7, worldW: 1600, worldH: 1200, waves: [] as const };

/** A pickup sitting on top of the player, collectable this tick (spawnTick in the past). */
function dropOnPlayer(s: GameState, item: Omit<PickupItem, 'id' | 'gx' | 'gy' | 'spawnTick' | 'alive'>): void {
  const p = s.players[0]!;
  s.pickups.push({ id: s.nextId(), gx: p.gx, gy: p.gy, spawnTick: -1, alive: true, ...item });
}

describe('PickupSystem — the in-run power ramp (design/05)', () => {
  const sys = new PickupSystem();

  it('health heals up to maxHp, never over', () => {
    const s = createGameState(CFG);
    const p = s.players[0]!;
    p.hp = 2;
    dropOnPlayer(s, { kind: 'health' });
    sys.tick(s);
    expect(p.hp).toBe(3);

    p.hp = p.maxHp;
    dropOnPlayer(s, { kind: 'health' });
    sys.tick(s);
    expect(p.hp).toBe(p.maxHp); // capped
  });

  it('an affix pickup re-resolves every weapon slot from base + stack', () => {
    const s = createGameState(CFG);
    const p = s.players[0]!;
    const baseDmg = p.weapons.map((w) => w.spec.damage);
    dropOnPlayer(s, { kind: 'affix', affix: { id: 'dmg', value: 2 } });
    sys.tick(s);
    expect(p.affixes).toHaveLength(1);
    p.weapons.forEach((w, i) => expect(w.spec.damage).toBe(baseDmg[i]! + 2));
  });

  it('affixes stack across multiple pickups', () => {
    const s = createGameState(CFG);
    const p = s.players[0]!;
    const base = p.weapon!.spec.damage;
    for (let i = 0; i < 3; i++) {
      dropOnPlayer(s, { kind: 'affix', affix: { id: 'dmg', value: 1 } });
      sys.tick(s);
    }
    expect(p.weapon!.spec.damage).toBe(base + 3);
  });

  it('a vit affix grows maxHp and heals', () => {
    const s = createGameState(CFG);
    const p = s.players[0]!;
    p.hp = 1;
    const maxBefore = p.maxHp;
    dropOnPlayer(s, { kind: 'affix', affix: { id: 'vit', value: 2 } });
    sys.tick(s);
    expect(p.maxHp).toBe(maxBefore + 2);
    expect(p.hp).toBe(3);
  });

  it('a weapon drop swaps the active slot but keeps the affix stack', () => {
    const s = createGameState(CFG);
    const p = s.players[0]!;
    // Buff first, then pick up a cannon — the new gun should inherit the +2.
    dropOnPlayer(s, { kind: 'affix', affix: { id: 'dmg', value: 2 } });
    sys.tick(s);
    dropOnPlayer(s, { kind: 'weapon', weaponId: 'cannon' });
    sys.tick(s);
    const active = p.weapon!;
    expect(active.base.name).toBe('cannon');
    expect(p.weapons[p.activeSlot]).toBe(active); // slot pointer updated
    expect((active.spec as RangedSimSpec).damage).toBe((active.base as RangedSimSpec).damage + 2);
  });

  it('coins have no sim effect (score is render-side)', () => {
    const s = createGameState(CFG);
    const p = s.players[0]!;
    const snapshot = JSON.stringify([p.hp, p.maxHp, p.weapons.map((w) => w.spec.damage)]);
    dropOnPlayer(s, { kind: 'coin' });
    sys.tick(s);
    expect(JSON.stringify([p.hp, p.maxHp, p.weapons.map((w) => w.spec.damage)])).toBe(snapshot);
  });

  it('does not vacuum a pickup dropped this very tick (spawnTick guard)', () => {
    const s = createGameState(CFG);
    const p = s.players[0]!;
    s.tick = 5;
    s.pickups.push({ id: s.nextId(), kind: 'coin', gx: p.gx, gy: p.gy, spawnTick: 5, alive: true });
    sys.tick(s);
    expect(s.pickups).toHaveLength(1); // still there next tick
    expect(s.pickups[0]!.alive).toBe(true);
  });
});
