/**
 * Step — PvP zone + hazard-tile damage (design/15, ROADMAP 4.2d). One step, two data
 * sources, because both reduce to the same test: "is this actor's position inside a
 * triggering region right now." AI enemies go through the identical check as players
 * — no special-casing needed for "does the zone kill monsters too," it just does.
 *
 * Strict no-op when `!state.zoneEnabled` (every pre-4.2d config, and any PvE config)
 * — ExtractionSystem's precedent for "an added step that doesn't bump ENGINE_VERSION"
 * (GameEngine.ts). Runs after `ZoneSystem` (this tick's `state.zone.safe` is current)
 * and after `StatusEffectSystem` — same global-tick-cadence placement as burn/poison
 * (design/15).
 */
import { circleOverlapsAabb } from './geom';
import { isTraitActive, ZONE } from '../content/arenas';
import { takeDamage } from './combat';
import type { GameState, ZoneState } from '../state/GameState';
import type { Actor, AABB } from '../state/entities';
import type { RoomId } from '../content/arenas';

export class EnvironmentSystem {
  tick(state: GameState): void {
    if (!state.zoneEnabled || !state.zone) return;
    const zone = state.zone;

    for (const p of state.players) {
      if (!p.alive) continue;
      this.updateRoomId(state, p);
      this.applyZoneDamage(state, p, zone);
      this.applyTraitDamage(state, p);
    }
    for (const e of state.enemies) {
      if (!e.alive) continue;
      this.updateRoomId(state, e);
      this.applyZoneDamage(state, e, zone);
      this.applyTraitDamage(state, e);
    }
  }

  /**
   * Refresh `actor.roomId` — cheap amortized: most ticks the actor is still inside
   * its cached room's rect (design/15 "O(1) amortized, not an O(60) scan every
   * tick"), so the full room list is only scanned on the (rarer) tick it actually
   * crosses a boundary. A point inside no room's rect (a doorway gap) clears
   * `roomId` to undefined — treated as "not confirmed safe" by the zone check, never
   * as automatically safe. All comparisons are Fp integers (`arenaRoomRects`,
   * pre-converted at load) — no float conversion in this per-tick path.
   */
  private updateRoomId(state: GameState, a: Actor): void {
    if (a.roomId !== undefined) {
      const cached = state.arenaRoomRects.find((r) => r.id === a.roomId);
      if (cached && pointInAabb(a.gx, a.gy, cached.rect)) return;
    }
    const found = state.arenaRoomRects.find((r) => pointInAabb(a.gx, a.gy, r.rect));
    a.roomId = found?.id as RoomId | undefined;
  }

  private applyZoneDamage(state: GameState, a: Actor, zone: ZoneState): void {
    const inSafe = a.roomId !== undefined && zone.safe.includes(a.roomId);
    if (inSafe) return;
    const dmg = ZONE.damagePerTick + zone.escalation * ZONE.escalationStep;
    if (dmg <= 0) return;
    takeDamage(state, a, dmg, 'environment', 'physical');
    state.events.push({ type: 'zone_damage', target: a.id, dmg });
  }

  private applyTraitDamage(state: GameState, a: Actor): void {
    for (const entry of state.cellTraits) {
      if (!isTraitActive(entry.trait, state.tick)) continue;
      const dmg = entry.trait.damage ?? 0;
      if (dmg <= 0) continue;
      if (!circleOverlapsAabb(a.gx, a.gy, a.radius, entry.rect)) continue;
      takeDamage(state, a, dmg, 'environment', entry.trait.damageType ?? 'physical');
    }
  }
}

/** Plain point-in-AABB test, all Fp integers (half-open on the far edges, matching
 * `roomGeometry`'s x/y = top-left + w/h = extents convention). */
function pointInAabb(x: number, y: number, rect: AABB): boolean {
  return x >= rect.x && x < rect.x + rect.w && y >= rect.y && y < rect.y + rect.h;
}
