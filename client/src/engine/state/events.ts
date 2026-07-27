/**
 * Events are the only engine→render channel (design/08). Each step clears and
 * rebuilds state.events; render/audio consume them once per frame. Engine decides
 * outcomes, never the reverse — an event is a transient fact, never read back by a
 * later system this tick.
 */
import type { Fp } from '../math/fixed';
import type { Brad } from '../math/trig';
import type { DamageType } from '../content/damage';
import type { DamageSrc, Faction, PickupKind, Winner } from './entities';

export type GameEvent =
  | { type: 'bullet_fired'; faction: Faction; gx: Fp; gy: Fp; facing: Brad }
  // `faction` is a DamageSrc, not just Faction — zone/hazard-tile damage (design/15,
  // ROADMAP 4.2d) reports 'environment' here, since there is no attacker on the other side.
  | { type: 'hit'; target: number; faction: DamageSrc; gx: Fp; gy: Fp; damage: number; damageType: DamageType; shieldRemaining?: number }
  // A hit (or DoT) that emptied a non-zero shield pool (design/07 two-pool). Render
  // plays a break fx; the sim uses it to fire a character's shield-break passive (0.5).
  | { type: 'shield_break'; id: number; gx: Fp; gy: Fp }
  | { type: 'clash'; gx: Fp; gy: Fp } // two opposing-faction bullets met and cancelled
  | { type: 'deflect'; gx: Fp; gy: Fp }
  // An elemental status was applied or ticked on a target (render plays the fx —
  // burn flames, chill frost, shock arc, poison bubbles). Transient, fx-only (08).
  | { type: 'status'; effect: 'burn' | 'chill' | 'shock' | 'poison'; target: number; gx: Fp; gy: Fp }
  | { type: 'death'; id: number; faction: Faction; gx: Fp; gy: Fp }
  // A boss-tier enemy dropped below its enrage HP threshold (design/09 aspirational
  // `traits`, now real). Fires ONCE, the tick it first triggers — fx/audio only,
  // never read back into sim decisions (the enraged bonus itself lives on the actor).
  | { type: 'enrage'; id: number; gx: Fp; gy: Fp }
  // Co-op downed/revive (design/05/07/08, ROADMAP 3.2). A player was incapacitated
  // (revivable, not dead) / brought back up by a teammate's revive channel. fx-only.
  | { type: 'downed'; id: number; gx: Fp; gy: Fp }
  | { type: 'revived'; id: number; gx: Fp; gy: Fp }
  | { type: 'pickup'; kind: PickupKind; gx: Fp; gy: Fp; weaponId?: string; buffId?: string; materialId?: string; qty?: number; tier?: number }
  | { type: 'wave_clear'; wave: number }
  // A floor's checkpoint resolved to DESCEND (design/05, ROADMAP 1.4) — the floor
  // buffer just banked and the next floor's waves are loading. EXTRACT reuses the
  // existing 'win' event (a successful run end either way).
  | { type: 'descend'; floorIndex: number }
  // A generated dungeon room just became live (design/05/09, ROADMAP 1.3 wired) — its
  // collision geometry, world bounds, and enemies were swapped in (SpawnSystem). The
  // render layer will use this to rebuild the room's ground/walls; fx-only, transient.
  | { type: 'room_enter'; floorIndex: number; roomIndex: number; roomId: string }
  // PvP zone (design/15, ROADMAP 4.2d) — render/HUD/minimap-only, never fed back into
  // sim decisions (the `06` render/logic split, unchanged). `zone_warn` telegraphs the
  // NEXT stage's soon-to-close rooms; `zone_close` fires the instant they go live;
  // `zone_damage` mirrors 'hit' for environmental/hazard-tile ticks with no attacker.
  | { type: 'zone_warn'; stage: number; closing: readonly string[] }
  | { type: 'zone_close'; stage: number }
  | { type: 'zone_damage'; target: number; dmg: number }
  | { type: 'win'; winner: Winner };
