/**
 * GameState — plain data, constructed from seed + config (design/08). Ordered
 * arrays only (push order = spawn order = iteration order); a state-local nextId()
 * (not a module global, so a headless re-judge can run alongside a live match);
 * injected per-concern PRNGs with distinct derived seeds; a per-tick events queue.
 * No Pixi, no DOM. Systems are the only code that mutates it.
 */
import { Prng } from '../math/prng';
import { toFp } from '../math/fixed';
import type { Fp } from '../math/fixed';
import { pxToFp } from '../content/convert';
import { makeWeapon } from '../content/weapons';
import { PLAYER } from '../content/players';
import type {
  EnemyActor,
  PickupItem,
  PlayerActor,
  Projectile,
  Winner,
} from './entities';
import type { GameEvent } from './events';

export type Phase = 'idle' | 'playing' | 'gameover';

/** A wave is a list of enemy spawn positions in world px (converted to grid-fp). */
export type WaveDef = readonly (readonly [number, number])[];

export interface EngineConfig {
  seed: number;
  worldW: number; // px (converted to grid-fp at construction via pxToFp)
  worldH: number; // px
  waves: readonly WaveDef[];
  playerStart?: readonly [number, number]; // px; defaults to world centre
}

// Distinct derived-seed constants so the streams never alias (design/06/08).
// roomgenPrng is deferred until room generation exists (design/07/09).
const SEED_AI = 0x1a2b3c4d;
const SEED_COMBAT = 0x5e6f7a8b;
const SEED_DROP = 0x9c0d1e2f;

export class GameState {
  readonly seed: number;
  phase: Phase = 'idle';
  tick = 0;

  private _nextId = 1;
  /** state-local monotonic entity-id allocator (design/08). */
  nextId(): number {
    return this._nextId++;
  }

  // Injected PRNG (distinct derived seeds).
  readonly aiPrng: Prng;
  readonly combatPrng: Prng;
  readonly dropPrng: Prng;

  // Entities — ordered arrays; index/id stable within a match.
  readonly players: PlayerActor[] = [];
  readonly enemies: EnemyActor[] = [];
  readonly projectiles: Projectile[] = [];
  readonly pickups: PickupItem[] = [];

  // World bounds (fp).
  readonly worldW: Fp;
  readonly worldH: Fp;

  // Wave director state (design/08 steps 10–11).
  waveIndex = -1; // -1 = run not started; 0-based into config.waves
  waveBreakTicks = 0; // countdown between a cleared wave and the next spawn
  wavesExhausted = false; // last wave dispatched → WinCondition can declare victory
  readonly waves: readonly WaveDef[];

  // Outcome + render channel.
  winner: Winner = null;
  events: GameEvent[] = [];

  constructor(config: EngineConfig) {
    this.seed = config.seed;
    this.aiPrng = new Prng(config.seed ^ SEED_AI);
    this.combatPrng = new Prng(config.seed ^ SEED_COMBAT);
    this.dropPrng = new Prng(config.seed ^ SEED_DROP);
    this.worldW = pxToFp(config.worldW);
    this.worldH = pxToFp(config.worldH);
    this.waves = config.waves;

    const [sx, sy] = config.playerStart ?? [config.worldW / 2, config.worldH / 2];
    this.players.push({
      id: this.nextId(),
      faction: 'player',
      gx: pxToFp(sx),
      gy: pxToFp(sy),
      z: toFp(0),
      vx: toFp(0),
      vy: toFp(0),
      vz: toFp(0),
      facing: 0 as PlayerActor['facing'],
      hp: PLAYER.maxHp,
      maxHp: PLAYER.maxHp,
      radius: PLAYER.radius,
      alive: true,
      weapon: makeWeapon(PLAYER.startWeapon),
      firing: false,
      prevButtons: 0,
    });
  }

  clearEvents(): void {
    this.events.length = 0;
  }
}

export function createGameState(config: EngineConfig): GameState {
  return new GameState(config);
}
