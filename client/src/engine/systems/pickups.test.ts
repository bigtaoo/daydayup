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

  it('a weapon drop swaps the active slot for the dropped weapon', () => {
    const s = createGameState(CFG);
    const p = s.players[0]!;
    dropOnPlayer(s, { kind: 'weapon', weaponId: 'cannon' });
    sys.tick(s);
    const active = p.weapon!;
    expect(active.spec.name).toBe('cannon');
    expect(p.weapons[p.activeSlot]).toBe(active); // slot pointer updated
    expect((active.spec as RangedSimSpec).damage).toBe(3); // cannon's authored damage
  });

  it('coins have no sim effect (score is render-side)', () => {
    const s = createGameState(CFG);
    const p = s.players[0]!;
    const snapshot = JSON.stringify([p.hp, p.maxHp, p.weapons.map((w) => w.spec.damage)]);
    dropOnPlayer(s, { kind: 'coin' });
    sys.tick(s);
    expect(JSON.stringify([p.hp, p.maxHp, p.weapons.map((w) => w.spec.damage)])).toBe(snapshot);
  });

  it('a buff pickup is added to the player stack; unknown ids are ignored', () => {
    const s = createGameState(CFG);
    const p = s.players[0]!;
    dropOnPlayer(s, { kind: 'buff', buffId: 'dmg_up' });
    sys.tick(s);
    expect(p.buffs).toEqual(['dmg_up']);

    dropOnPlayer(s, { kind: 'buff', buffId: 'not_a_real_buff' });
    sys.tick(s);
    expect(p.buffs).toEqual(['dmg_up']); // forward-compat: unknown id → no-op
  });

  it('a flat_hp buff raises maxHp and heals by the same amount, clamped by the cap', () => {
    const s = createGameState(CFG);
    const p = s.players[0]!;
    const baseMax = p.maxHp;
    p.hp = 1;
    dropOnPlayer(s, { kind: 'buff', buffId: 'vit_up' }); // +2 maxHp
    sys.tick(s);
    expect(p.maxHp).toBe(baseMax + 2);
    expect(p.hp).toBe(3); // gaining max HP also healed +2

    // Past the +10 cap, extra vit_up buffs add nothing (Σ-then-clamp delta = 0).
    for (let i = 0; i < 10; i++) {
      dropOnPlayer(s, { kind: 'buff', buffId: 'vit_up' });
      sys.tick(s);
    }
    expect(p.maxHp).toBe(baseMax + 10);
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
