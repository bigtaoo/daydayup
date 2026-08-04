import { describe, it, expect } from 'vitest';
import { createGameState } from '@dd/engine/state/GameState';
import type { GameState } from '@dd/engine/state/GameState';
import type { PickupItem, RangedSimSpec } from '@dd/engine/state/entities';
import type { Fp } from '@dd/engine/math/fixed';
import { PickupSystem } from '@dd/engine/systems';
import { toFpGrid } from '@dd/engine/content/convert';
import { createGameEngine } from '@dd/engine/GameEngine';
import { makeCommand } from '@dd/engine/state/input';
import type { Brad } from '@dd/engine/math/trig';

const CFG = { seed: 7, worldW: 1600, worldH: 1200, waves: [] as const };

/** A pickup sitting on top of the player, collectable this tick (spawnTick in the past). */
function dropOnPlayer(s: GameState, item: Omit<PickupItem, 'id' | 'gx' | 'gy' | 'spawnTick' | 'alive'>): void {
  const p = s.players[0]!;
  s.pickups.push({ id: s.nextId(), gx: p.gx, gy: p.gy, spawnTick: -1, alive: true, ...item });
}

describe('PickupSystem — the in-run power ramp (design/05)', () => {
  const sys = new PickupSystem();

  it('heal restores up to maxHp, never over', () => {
    const s = createGameState(CFG);
    const p = s.players[0]!;
    p.hp = 2;
    dropOnPlayer(s, { kind: 'heal' });
    sys.tick(s);
    expect(p.hp).toBe(3);

    p.hp = p.maxHp;
    dropOnPlayer(s, { kind: 'heal' });
    sys.tick(s);
    expect(p.hp).toBe(p.maxHp); // capped
  });

  it('a weapon drop is NOT collected on overlap alone (design/03: click-driven, not auto)', () => {
    const s = createGameState(CFG);
    const p = s.players[0]!;
    const before = p.weapon!.spec.name;
    dropOnPlayer(s, { kind: 'weapon', weaponId: 'cannon' });
    sys.tick(s); // no pickupTargetId set
    expect(p.weapon!.spec.name).toBe(before); // untouched
    expect(s.pickups).toHaveLength(1); // still sitting on the floor
    expect(s.pickups[0]!.alive).toBe(true);
  });

  it('clicking the wrong/stale item id does nothing, even while overlapping a real one', () => {
    const s = createGameState(CFG);
    const p = s.players[0]!;
    const before = p.weapon!.spec.name;
    dropOnPlayer(s, { kind: 'weapon', weaponId: 'cannon' });
    p.pickupTargetId = s.pickups[0]!.id + 999; // some other/stale id
    sys.tick(s);
    expect(p.weapon!.spec.name).toBe(before);
    expect(s.pickups[0]!.alive).toBe(true);
  });

  it('clicking (pickupTargetId matching the item) swaps the active slot and drops the outgoing weapon', () => {
    const s = createGameState(CFG);
    const p = s.players[0]!;
    const outgoingId = p.weapon!.spec.name;
    dropOnPlayer(s, { kind: 'weapon', weaponId: 'cannon' });
    p.pickupTargetId = s.pickups[0]!.id;
    sys.tick(s);

    const active = p.weapon!;
    expect(active.spec.name).toBe('cannon');
    expect(p.weapons[p.activeSlot]).toBe(active); // slot pointer updated
    expect((active.spec as RangedSimSpec).damage).toBe(3); // cannon's authored damage

    // The outgoing weapon lands back on the floor as a fresh pickup at the player.
    const dropped = s.pickups.find((x) => x.weaponId === outgoingId);
    expect(dropped).toBeDefined();
    expect(dropped!.alive).toBe(true);
    expect(dropped!.spawnTick).toBe(s.tick);
  });

  it('a click is a one-tick pulse — not re-applied on a later tick without a fresh click', () => {
    const s = createGameState(CFG);
    const p = s.players[0]!;
    dropOnPlayer(s, { kind: 'weapon', weaponId: 'cannon' });
    p.pickupTargetId = s.pickups[0]!.id;
    sys.tick(s); // swaps in cannon, drops the starter weapon at the same spot
    expect(p.weapon!.spec.name).toBe('cannon');
    p.pickupTargetId = 0; // ApplyInputSystem would reset this every tick without a fresh click

    // Advance past the dropped item's spawnTick guard so this actually exercises
    // whether the stale click re-fires, not just the "same-tick drop" guard.
    s.tick += 1;
    sys.tick(s);
    expect(p.weapon!.spec.name).toBe('cannon'); // unchanged, did not swap back
  });

  it('collects a weapon click from beyond pickupRadius but within the wider lootRevealRadius', () => {
    const s = createGameState(CFG);
    const p = s.players[0]!;
    // pickupRadius is ~0.47 grid; lootRevealRadius is 2.5 grid — 1 grid away is out of
    // the tight ring every other kind uses but well inside the panel's own ring.
    const id = s.nextId();
    s.pickups.push({ id, kind: 'weapon', weaponId: 'cannon', gx: (p.gx + toFpGrid(1)) as Fp, gy: p.gy, spawnTick: -1, alive: true });
    p.pickupTargetId = id;
    sys.tick(s);
    expect(p.weapon!.spec.name).toBe('cannon');
  });

  it('materials have no in-sim effect yet (a distinct, not-yet-banked currency)', () => {
    const s = createGameState(CFG);
    const p = s.players[0]!;
    const snapshot = JSON.stringify([p.hp, p.maxHp, p.weapons.map((w) => w.spec.damage)]);
    dropOnPlayer(s, { kind: 'material', materialId: 'mat_fire', qty: 1 });
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

  it('a bandage pickup adds to the squad-revive currency, uncapped (design/05/15)', () => {
    const s = createGameState(CFG);
    const p = s.players[0]!;
    expect(p.bandages).toBe(0);
    dropOnPlayer(s, { kind: 'bandage' });
    sys.tick(s);
    expect(p.bandages).toBe(1);
    dropOnPlayer(s, { kind: 'bandage' });
    sys.tick(s);
    expect(p.bandages).toBe(2); // no cap
  });

  it('a real PlayerCommand.pickupTargetId (via ApplyInputSystem, engine.step) actually collects — not just a directly-set actor field', () => {
    // Regression coverage for the real wiring, not PickupSystem in isolation: every
    // other case above sets PlayerActor.pickupTargetId directly, which would keep
    // passing unchanged even if the command→actor wiring were completely absent (as
    // it briefly was) — this is the ONLY place in the suite that drives a click
    // through the full path (CommandBuilder's would-be output → ApplyInputSystem →
    // PickupSystem).
    const e = createGameEngine(CFG);
    const p = e.state.players[0]!;
    const before = p.weapon!.spec.name;
    const id = e.state.nextId();
    e.state.pickups.push({ id, kind: 'weapon', weaponId: 'cannon', gx: p.gx, gy: p.gy, spawnTick: -1, alive: true });

    e.step([makeCommand({
      owner: 0, tick: e.state.tick + 1, moveBrad: 0 as Brad, moveMag: 0, buttons: 0,
      pickupTargetId: id,
    })]);

    expect(p.weapon!.spec.name).toBe('cannon');
    expect(p.weapon!.spec.name).not.toBe(before);
  });

  it('does not vacuum a pickup dropped this very tick (spawnTick guard)', () => {
    const s = createGameState(CFG);
    const p = s.players[0]!;
    s.tick = 5;
    s.pickups.push({ id: s.nextId(), kind: 'material', gx: p.gx, gy: p.gy, spawnTick: 5, alive: true });
    sys.tick(s);
    expect(s.pickups).toHaveLength(1); // still there next tick
    expect(s.pickups[0]!.alive).toBe(true);
  });
});
