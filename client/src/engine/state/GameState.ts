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
import { freshStatus } from '../content/damage';
import { PLAYER_BASE } from '../content/players';
import { resolveSkin, toShieldBreakSim, type SkinId } from '../content/skins';
import { buildRunSpecs } from '../balance/build';
import type {
  AABB,
  EnemyActor,
  Obstacle,
  PickupItem,
  PlayerActor,
  Projectile,
  Winner,
} from './entities';
import type { GameEvent } from './events';

export type Phase = 'idle' | 'playing' | 'gameover';

/**
 * One enemy spawn in a wave: world-px position, plus an optional enemy `type` that
 * SpawnSystem resolves through ENEMY_BLUEPRINTS (missing = 'basic'). The `[x, y]`
 * form stays valid, so old wave data needs no change (design/09 forward-compat).
 */
export type SpawnSpec = readonly [number, number, string?];
/** A wave is a list of enemy spawn entries (positions in world px → grid-fp). */
export type WaveDef = readonly SpawnSpec[];

export interface EngineConfig {
  seed: number;
  worldW: number; // px (converted to grid-fp at construction via pxToFp)
  worldH: number; // px
  waves: readonly WaveDef[];
  skinId?: SkinId; // chosen character (design/14); unknown/absent → default (resolveSkin)
  playerStart?: readonly [number, number]; // px; defaults to world centre
  // Static round solids (pillars), in world px [x, y, radius]. Converted to
  // grid-fp at construction; MovementSystem pushes actors out of them (design/07).
  obstacles?: readonly (readonly [number, number, number])[];
  // Static rectangular solids (AABB tile/wall geometry, design/07/09 ROADMAP 1.2),
  // in world px [x, y, w, h] (top-left corner + extents). Converted to grid-fp at
  // construction; MovementSystem/ProjectileStepSystem resolve against them exactly
  // like `obstacles` above, just with a rect test instead of a circle test.
  walls?: readonly (readonly [number, number, number, number])[];
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

  // Static round solids — set once at construction, never mutated (design/07).
  readonly obstacles: Obstacle[] = [];
  // Static rectangular solids (design/07/09 ROADMAP 1.2) — set once, never mutated.
  readonly walls: AABB[] = [];

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

    for (const [ox, oy, orad] of config.obstacles ?? []) {
      this.obstacles.push({ gx: pxToFp(ox), gy: pxToFp(oy), radius: pxToFp(orad) });
    }
    for (const [wx, wy, ww, wh] of config.walls ?? []) {
      this.walls.push({ x: pxToFp(wx), y: pxToFp(wy), w: pxToFp(ww), h: pxToFp(wh) });
    }

    const [sx, sy] = config.playerStart ?? [config.worldW / 2, config.worldH / 2];
    // Merge the chosen character (SkinDef defensive identity) with PLAYER_BASE shared
    // constants (design/09/14). Unknown/absent skin → the default (forward-compat).
    const skin = resolveSkin(config.skinId);
    // Resolve the loadout through the run builder (design/09 fairness wall): the
    // base meta loadout carried in at match start.
    const weapons = buildRunSpecs(PLAYER_BASE.startWeapons);
    this.players.push({
      id: this.nextId(),
      faction: 'player',
      gx: pxToFp(sx),
      gy: pxToFp(sy),
      z: toFp(0),
      vx: toFp(0),
      vy: toFp(0),
      facing: 0 as PlayerActor['facing'],
      hp: skin.maxHp,
      maxHp: skin.maxHp,
      shield: skin.maxShield, // spawn with a full shield (design/07)
      maxShield: skin.maxShield,
      ticksSinceHit: 0,
      radius: PLAYER_BASE.radius,
      footprintRadius: PLAYER_BASE.footprintRadius,
      alive: true,
      weapon: weapons[0] ?? null, // active pointer = weapons[activeSlot]
      weapons,
      activeSlot: 0,
      buffs: [], // run-scoped buff stack (design/14); filled by 'buff' pickups
      firing: false,
      prevButtons: 0,
      status: freshStatus(),
      shieldBreak: skin.shieldBreak ? toShieldBreakSim(skin.shieldBreak) : undefined,
    });
  }

  clearEvents(): void {
    this.events.length = 0;
  }
}

export function createGameState(config: EngineConfig): GameState {
  return new GameState(config);
}
