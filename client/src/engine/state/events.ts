/**
 * Events are the only engine→render channel (design/08). Each step clears and
 * rebuilds state.events; render/audio consume them once per frame. Engine decides
 * outcomes, never the reverse — an event is a transient fact, never read back by a
 * later system this tick.
 */
import type { Fp } from '../math/fixed';
import type { Brad } from '../math/trig';
import type { DamageType } from '../content/damage';
import type { Faction, PickupKind, Winner } from './entities';

export type GameEvent =
  | { type: 'bullet_fired'; faction: Faction; gx: Fp; gy: Fp; facing: Brad }
  | { type: 'hit'; target: number; faction: Faction; gx: Fp; gy: Fp; damage: number; damageType: DamageType; shieldRemaining?: number }
  // A hit (or DoT) that emptied a non-zero shield pool (design/07 two-pool). Render
  // plays a break fx; the sim uses it to fire a character's shield-break passive (0.5).
  | { type: 'shield_break'; id: number; gx: Fp; gy: Fp }
  | { type: 'clash'; gx: Fp; gy: Fp } // two opposing-faction bullets met and cancelled
  | { type: 'deflect'; gx: Fp; gy: Fp }
  // An elemental status was applied or ticked on a target (render plays the fx —
  // burn flames, chill frost, shock arc, poison bubbles). Transient, fx-only (08).
  | { type: 'status'; effect: 'burn' | 'chill' | 'shock' | 'poison'; target: number; gx: Fp; gy: Fp }
  | { type: 'death'; id: number; faction: Faction; gx: Fp; gy: Fp }
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
  | { type: 'win'; winner: Winner };
