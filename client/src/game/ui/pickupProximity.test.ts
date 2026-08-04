import { describe, it, expect } from 'vitest';
import type { PickupItem, Fp } from '@dd/engine';
import { nearbyWeaponPickups } from './pickupProximity';

const fp = (n: number) => n as Fp;

function pickup(over: Partial<PickupItem>): PickupItem {
  return { id: 1, kind: 'weapon', gx: fp(0), gy: fp(0), spawnTick: 0, alive: true, ...over };
}

describe('nearbyWeaponPickups', () => {
  it('finds a weapon pickup within radius', () => {
    const p = pickup({ gx: fp(100), gy: fp(0), weaponId: 'repeater' });
    expect(nearbyWeaponPickups([p], fp(0), fp(0), fp(200))).toEqual([p]);
  });

  it('ignores pickups outside radius', () => {
    const p = pickup({ gx: fp(300), gy: fp(0) });
    expect(nearbyWeaponPickups([p], fp(0), fp(0), fp(200))).toEqual([]);
  });

  it('ignores non-weapon kinds even when close', () => {
    const p = pickup({ kind: 'heal', gx: fp(10), gy: fp(0) });
    expect(nearbyWeaponPickups([p], fp(0), fp(0), fp(200))).toEqual([]);
  });

  it('ignores dead (already-collected) pickups', () => {
    const p = pickup({ gx: fp(10), gy: fp(0), alive: false });
    expect(nearbyWeaponPickups([p], fp(0), fp(0), fp(200))).toEqual([]);
  });

  it('returns every candidate within radius, nearest first', () => {
    const far = pickup({ id: 1, gx: fp(150), gy: fp(0) });
    const near = pickup({ id: 2, gx: fp(50), gy: fp(0) });
    const outOfRange = pickup({ id: 3, gx: fp(500), gy: fp(0) });
    expect(nearbyWeaponPickups([far, near, outOfRange], fp(0), fp(0), fp(200))).toEqual([near, far]);
  });
});
