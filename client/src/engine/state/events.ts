/**
 * Events are the only engine→render channel (design/08). Each step clears and
 * rebuilds state.events; render/audio consume them once per frame. Engine decides
 * outcomes, never the reverse — an event is a transient fact, never read back by a
 * later system this tick.
 */
import type { Fp } from '../math/fixed';
import type { Brad } from '../math/trig';
import type { Affix } from '../balance/affixes';
import type { Faction, PickupKind, Winner } from './entities';

export type GameEvent =
  | { type: 'bullet_fired'; faction: Faction; gx: Fp; gy: Fp; facing: Brad }
  | { type: 'hit'; target: number; faction: Faction; gx: Fp; gy: Fp; damage: number }
  | { type: 'clash'; gx: Fp; gy: Fp } // two opposing-faction bullets met and cancelled
  | { type: 'deflect'; gx: Fp; gy: Fp }
  | { type: 'death'; id: number; faction: Faction; gx: Fp; gy: Fp }
  | { type: 'pickup'; kind: PickupKind; gx: Fp; gy: Fp; weaponId?: string; affix?: Affix }
  | { type: 'wave_clear'; wave: number }
  | { type: 'win'; winner: Winner };
