import { describe, it, expect } from 'vitest';
import { createGameState, PickupSystem, PLAYER_BASE, SIM } from '@dd/engine';
import type { PickupItem, Fp } from '@dd/engine';
import { nearbyWeaponPickups, WEAPON_PROMPT_RADIUS_FP } from './pickupProximity';

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

/**
 * If the panel offers a weapon, clicking it must actually collect it.
 *
 * This is the one shape of *"无法拾取"* that no engine test can see, because the two halves of
 * the gate live on opposite sides of the sim boundary: the render layer decides whether to SHOW
 * a clickable row (`nearbyWeaponPickups` at `WEAPON_PROMPT_RADIUS_FP`), and
 * `PickupSystem` independently decides whether to HONOUR the resulting `pickupTargetId`. A panel
 * that offers what the sim refuses is a row you can click all day with nothing happening — and
 * it would be invisible to `engine/`'s suite and to the client's, both of which are green while
 * each half is individually correct.
 *
 * The two predicates are deliberately not identical, and that asymmetry is the safe direction:
 * the panel measures centre-to-centre, the sim adds the player's own body radius, so the sim's
 * acceptance region strictly CONTAINS the panel's. Asserted as that implication over a sweep
 * rather than as `expect(panelRadius).toBe(simRadius)` — equating the constants would forbid the
 * margin that makes it safe, and would pass just as happily if both were wrong together.
 */
describe('the panel never offers a pickup the sim will refuse', () => {
  function stateWithWeaponAt(dx: number): { s: ReturnType<typeof createGameState>; item: PickupItem } {
    const s = createGameState({ seed: 1, worldW: 40000, worldH: 40000, waves: [] });
    const p = s.players[0]!;
    p.gx = 20000 as Fp;
    p.gy = 20000 as Fp;
    const item: PickupItem = {
      id: s.nextId(),
      kind: 'weapon',
      gx: (20000 + dx) as Fp,
      gy: 20000 as Fp,
      spawnTick: 0,
      alive: true,
      weaponId: 'repeater',
    };
    s.pickups.push(item);
    return { s, item };
  }

  /** Does the sim hand it over when the player clicks this exact item? */
  function simAccepts(dx: number): boolean {
    const { s, item } = stateWithWeaponAt(dx);
    s.tick = 1; // past the spawn-tick guard, which is a separate rule from proximity
    s.players[0]!.pickupTargetId = item.id;
    new PickupSystem().tick(s);
    return !s.pickups.some((q) => q.id === item.id && q.alive);
  }

  /** Does the render panel offer a clickable row for it? */
  function panelOffers(dx: number): boolean {
    const { s, item } = stateWithWeaponAt(dx);
    const p = s.players[0]!;
    return nearbyWeaponPickups([item], p.gx, p.gy, WEAPON_PROMPT_RADIUS_FP).length > 0;
  }

  it('every distance the panel shows a weapon at is a distance the sim collects it at', () => {
    // Swept in 25 fp steps across the whole interesting range, so the boundary is crossed
    // rather than assumed to be where the constants say it is.
    const offered: number[] = [];
    const betrayed: number[] = [];
    for (let dx = 0; dx <= 4000; dx += 25) {
      if (!panelOffers(dx)) continue;
      offered.push(dx);
      if (!simAccepts(dx)) betrayed.push(dx);
    }
    expect(offered.length, 'the panel never offered anything — the sweep missed its range').toBeGreaterThan(10);
    expect(betrayed, 'the panel offers a weapon at these fp distances and the sim refuses the click').toEqual([]);
  });

  it('and the margin is real — the sim reaches FURTHER than the panel, never the other way', () => {
    // The anti-vacuity half. If the two predicates happened to coincide exactly, the test above
    // would still pass while leaving no room for a rounding difference to break it later.
    const simEdge = lastTrue(simAccepts);
    const panelEdge = lastTrue(panelOffers);
    expect(panelEdge).toBeGreaterThan(0);
    expect(simEdge, 'the sim no longer reaches past the panel — the safe asymmetry is gone').toBeGreaterThan(
      panelEdge,
    );
    // And it is the player's own body that provides the margin, which is why widening the body
    // can never turn this red but narrowing the sim's radius would.
    expect(simEdge - panelEdge).toBeLessThanOrEqual((PLAYER_BASE.radius as number) + 25);
  });

  it('the tight auto-collect kinds are a different, much shorter reach — and the panel ignores them', () => {
    // Recorded because it is the asymmetry a reader will trip over next: a `buff` or `material`
    // has no panel at all and is collected by walking onto it, at `pickupRadius + body` rather
    // than `lootRevealRadius + body`. Nothing is wrong with that; it is just a far smaller
    // number than the one the weapon panel trains a player to expect.
    expect(SIM.lootRevealRadius as number).toBeGreaterThan(SIM.pickupRadius as number);
    const buff: PickupItem = { id: 9, kind: 'buff', gx: 0 as Fp, gy: 0 as Fp, spawnTick: 0, alive: true };
    expect(nearbyWeaponPickups([buff], 0 as Fp, 0 as Fp, WEAPON_PROMPT_RADIUS_FP)).toEqual([]);
  });
});

/** The largest swept distance at which `pred` still holds, scanning outward. */
function lastTrue(pred: (dx: number) => boolean): number {
  let last = -1;
  for (let dx = 0; dx <= 4000; dx += 25) if (pred(dx)) last = dx;
  return last;
}
