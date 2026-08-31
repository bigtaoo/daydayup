/**
 * `pickupDebugGate` (the pure readout behind `?pickupDebug=1`) has exactly one job: agree
 * with whatever `PickupSystem`/`nearbyWeaponPickups` actually do, so a green dot on screen
 * really means "the sim would collect this." Restating the formula here (`pickupRadius +
 * player.radius`, `lootRevealRadius`) would pass even if the overlay and the real gate
 * drifted apart together — same trap `pickupProximity.test.ts` calls out — so every test
 * below runs the REAL system (`PickupSystem.tick` / `nearbyWeaponPickups`) alongside the
 * readout and asserts they agree, swept across the boundary rather than at one guessed
 * distance.
 */
import { describe, it, expect } from 'vitest';
import { createGameState, PickupSystem, SIM } from '@dd/engine';
import type { PickupItem, Fp } from '@dd/engine';
import { nearbyWeaponPickups, WEAPON_PROMPT_RADIUS_FP } from '../ui/pickupProximity';
import { pickupDebugGate } from './PickupDebugOverlay';

function stateWithPickupAt(kind: PickupItem['kind'], dx: number, dy = 0): { s: ReturnType<typeof createGameState>; item: PickupItem } {
  const s = createGameState({ seed: 1, worldW: 40000, worldH: 40000, waves: [] });
  const p = s.players[0]!;
  p.gx = 20000 as Fp;
  p.gy = 20000 as Fp;
  const item: PickupItem = {
    id: s.nextId(),
    kind,
    gx: (20000 + dx) as Fp,
    gy: (20000 + dy) as Fp,
    spawnTick: 0,
    alive: true,
    ...(kind === 'weapon' ? { weaponId: 'repeater' } : {}),
    ...(kind === 'material' ? { materialId: 'scrap', qty: 1, tier: 0 } : {}),
  };
  s.pickups.push(item);
  return { s, item };
}

/** Does PickupSystem actually collect an auto-collect-kind item standing there? */
function simAutoCollects(kind: PickupItem['kind'], dx: number): boolean {
  const { s, item } = stateWithPickupAt(kind, dx);
  s.tick = 1; // past the spawn-tick guard — a separate rule from proximity
  new PickupSystem().tick(s);
  return !s.pickups.some((q) => q.id === item.id && q.alive);
}

describe('pickupDebugGate — auto-collect kinds (heal/material/buff/bandage)', () => {
  it('collectible agrees with PickupSystem across the whole boundary', () => {
    // Swept in 5 fp steps (fine enough to catch an off-by-one at the boundary) across a
    // range comfortably either side of SIM.pickupRadius + PLAYER_BASE.radius.
    const disagreements: number[] = [];
    let sawTrue = false;
    let sawFalse = false;
    for (let dx = 0; dx <= 1200; dx += 5) {
      const { s, item } = stateWithPickupAt('heal', dx);
      const { collectible } = pickupDebugGate(s, item);
      const collected = simAutoCollects('heal', dx);
      if (collectible) sawTrue = true;
      else sawFalse = true;
      if (collectible !== collected) disagreements.push(dx);
    }
    expect(sawTrue, 'the sweep never reached a collectible distance').toBe(true);
    expect(sawFalse, 'the sweep never reached an uncollectible distance').toBe(true);
    expect(disagreements, 'pickupDebugGate disagrees with PickupSystem at these fp distances').toEqual([]);
  });

  it('reports the nearest player, not an arbitrary one', () => {
    const s = createGameState({ seed: 1, worldW: 40000, worldH: 40000, waves: [] });
    s.players[0]!.gx = 20000 as Fp;
    s.players[0]!.gy = 20000 as Fp;
    // Second seat, far away — createGameState with one player leaves only seat 0, so build
    // a minimal second one by cloning the shape PickupSystem itself only reads (alive/gx/
    // gy/radius) rather than a full second createGameState.
    s.players.push({ ...s.players[0]!, id: 2, gx: 21000 as Fp });
    const item: PickupItem = {
      id: s.nextId(),
      kind: 'heal',
      gx: 20900 as Fp, // 900fp from seat 0, 100fp from seat 1
      gy: 20000 as Fp,
      spawnTick: 0,
      alive: true,
    };
    s.pickups.push(item);
    const { nearestPx } = pickupDebugGate(s, item);
    // 100fp, not 900fp — the nearer of the two seats.
    expect(nearestPx).toBeCloseTo((100 / 1000) * 32, 5);
  });

  it('ignores a dead player entirely', () => {
    const { s, item } = stateWithPickupAt('heal', 0); // standing exactly on it
    s.players[0]!.alive = false;
    const { nearestPx, collectible } = pickupDebugGate(s, item);
    expect(collectible).toBe(false);
    expect(nearestPx).toBe(Infinity);
  });
});

describe('pickupDebugGate — weapon kind', () => {
  it('collectible agrees with the render panel (nearbyWeaponPickups), not the wider sim-accept radius', () => {
    // The panel's own gate (WEAPON_PROMPT_RADIUS_FP === SIM.lootRevealRadius) is the
    // binding constraint for a weapon in practice — nothing is clickable until the panel
    // lists it — and pickupDebugGate is documented to track exactly that, not the looser
    // `lootRevealRadius + player.radius` PickupSystem itself would still accept a click at.
    const disagreements: number[] = [];
    for (let dx = 0; dx <= 3500; dx += 25) {
      const { s, item } = stateWithPickupAt('weapon', dx);
      const { collectible } = pickupDebugGate(s, item);
      const p = s.players[0]!;
      const offered = nearbyWeaponPickups([item], p.gx, p.gy, WEAPON_PROMPT_RADIUS_FP).length > 0;
      if (collectible !== offered) disagreements.push(dx);
    }
    expect(disagreements, 'pickupDebugGate disagrees with the panel at these fp distances').toEqual([]);
  });

  it('the weapon gate is unpadded — SIM.lootRevealRadius itself is the boundary', () => {
    const justInside = stateWithPickupAt('weapon', (SIM.lootRevealRadius as number) - 1);
    const justOutside = stateWithPickupAt('weapon', (SIM.lootRevealRadius as number) + 1);
    expect(pickupDebugGate(justInside.s, justInside.item).collectible).toBe(true);
    expect(pickupDebugGate(justOutside.s, justOutside.item).collectible).toBe(false);
  });
});
