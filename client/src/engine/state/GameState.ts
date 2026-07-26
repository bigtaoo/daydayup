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
import { WEAPON_SIM_BY_ID } from '../content/weapons';
import { resolveSkin, toShieldBreakSim, type SkinId } from '../content/skins';
import { buildRunSpecs, buildArenaSpecs, type ArenaPresetId } from '../balance/build';
import { UniformGrid } from '../systems/spatialGrid';
import {
  buildArenaGeometry,
  buildArenaCellTraits,
  buildArenaRoomRects,
  type ArenaMap,
  type CellTrait,
  type RoomId,
} from '../content/arenas';
import type {
  AABB,
  EnemyActor,
  Obstacle,
  PickupItem,
  PlayerActor,
  Projectile,
  WeaponSimSpec,
  WeaponState,
  Winner,
} from './entities';
import type { GameEvent } from './events';
import type { DungeonConfig } from '../world/dungeon';
import type { RoomPiece } from '../content/rooms';

export type Phase = 'idle' | 'playing' | 'gameover';

/**
 * One enemy spawn in a wave: world-px position, plus an optional enemy `type` that
 * SpawnSystem resolves through ENEMY_BLUEPRINTS (missing = 'basic'). The `[x, y]`
 * form stays valid, so old wave data needs no change (design/09 forward-compat).
 */
export type SpawnSpec = readonly [number, number, string?];
/** A wave is a list of enemy spawn entries (positions in world px → grid-fp). */
export type WaveDef = readonly SpawnSpec[];

/**
 * One co-op seat (design/05/06, ROADMAP 3.1 — "the thing that spawns a SECOND
 * player"). Each entry becomes one PlayerActor whose `owner` == its index here, so a
 * command's `owner` routes to the right seat (ApplyInputSystem). Every field mirrors
 * the single-player top-level config so a seat is self-describing:
 *   - `skinId`   chosen character (unknown/absent → default, resolveSkin)
 *   - `loadout`  crafted weapon ids (unknown dropped; empty → auto pistol)
 *   - `start`    spawn px (absent → world centre; dungeon mode overrides on room load)
 * The engine has always iterated `state.players` by owner, so N seats need no system
 * change — only this construction path. See `EngineConfig.players`.
 */
export interface PlayerConfig {
  skinId?: SkinId;
  loadout?: readonly string[];
  start?: readonly [number, number]; // px
  // Team identity for combat targeting (design/15, ROADMAP 4.2a). ABSENT (every
  // config before this feature, and every co-op config today) → every seat
  // defaults to the SAME team (0, see buildSeat) — allies never damage each
  // other, byte-identical to the pre-teamId behavior. A PvP arena build (4.2c,
  // not yet built) assigns each seat its OWN distinct teamId instead; a future
  // squad build assigns the same teamId to several seats. Independent of the
  // seat's `owner`/array index (state/commands.ts) — see entities.ts's note.
  teamId?: number;
}

export interface EngineConfig {
  seed: number;
  worldW: number; // px (converted to grid-fp at construction via pxToFp)
  worldH: number; // px
  waves: readonly WaveDef[];
  // Co-op seats (design/05/06, ROADMAP 3.1). PRESENT → one PlayerActor per entry, in
  // order (owner index = array index). ABSENT (every config before this feature) → the
  // single-player path below (the top-level skinId/loadout/playerStart build exactly one
  // seat), byte-identical — additive, no ENGINE_VERSION bump. When `players` is given the
  // top-level skinId/loadout/playerStart are ignored (each seat is self-describing); a
  // one-entry `players` list is exactly equivalent to the single-player top-level form.
  players?: readonly PlayerConfig[];
  skinId?: SkinId; // chosen character (design/14); unknown/absent → default (resolveSkin)
  // Brought-in loadout (design/05/14, ROADMAP 2.2) — up to WEAPON_SLOTS weapon ids the
  // player crafted at the forge and carried into this run. Resolved through
  // WEAPON_SIM_BY_ID (unknown ids dropped, design/09 forward-compat); an empty/all-unknown
  // list falls back to the auto pistol ("none → auto pistol", design/05). ABSENT (every
  // config before this feature) → the PLAYER_BASE.startWeapons default, byte-identical —
  // additive, no ENGINE_VERSION bump.
  loadout?: readonly string[];
  playerStart?: readonly [number, number]; // px; defaults to world centre
  // Static round solids (pillars), in world px [x, y, radius]. Converted to
  // grid-fp at construction; MovementSystem pushes actors out of them (design/07).
  obstacles?: readonly (readonly [number, number, number])[];
  // Static rectangular solids (AABB tile/wall geometry, design/07/09 ROADMAP 1.2),
  // in world px [x, y, w, h] (top-left corner + extents). Converted to grid-fp at
  // construction; MovementSystem/ProjectileStepSystem resolve against them exactly
  // like `obstacles` above, just with a rect test instead of a circle test.
  walls?: readonly (readonly [number, number, number, number])[];
  // Floors AFTER the first (design/05/09, ROADMAP 1.4/1.5) — `waves` above is floor
  // 0; each entry here is one additional floor's wave list. PRESENCE enables the
  // extraction-checkpoint / materials-banking loop (ExtractionSystem); every config
  // that omits it (every config before this feature existed) is completely
  // untouched — additive, no ENGINE_VERSION bump. Reaching the end of a floor's
  // waves with no enemies left is the per-floor checkpoint: EXTRACT (bank + end
  // the run) or DESCEND (bank + reload the next entry here) via a held/tapped
  // INTERACT (see ExtractionSystem). The last floor (index === floors.length) has
  // no descend option — reaching its checkpoint auto-resolves as EXTRACT, matching
  // design/05 "the last floor's boss room IS its extraction room."
  floors?: readonly (readonly WaveDef[])[];
  // Seeded dungeon mode (design/05/09, ROADMAP 1.3 wired live). An ALTERNATIVE to the
  // flat `floors` list above: instead of hand-listing each floor's waves, a floor is
  // GENERATED from a hand-authored RoomPiece library (`world/dungeon.ts generateFloor`
  // draws the roomgenPrng) and traversed room-by-room, each room swapping in its own
  // collision geometry (`content/rooms.ts roomGeometry`) and enemies. PRESENCE enables
  // the same extraction/materials loop as `floors` (floorsEnabled below). Additive: a
  // config that omits it (every config before this feature) never draws roomgenPrng,
  // never mutates walls/obstacles, and is byte-identical — no ENGINE_VERSION bump.
  // `waves`/`worldW`/`worldH` above are ignored in dungeon mode (each room supplies its
  // own bounds); pass `waves: []` and any placeholder bounds.
  dungeon?: { config: DungeonConfig; library: readonly RoomPiece[] };
  // PvP arena mode (design/15, ROADMAP 4.2b/c) — an ALTERNATIVE to the flat
  // `walls`/`obstacles`/`worldW`/`worldH` above: every `ArenaRoom` in the map is
  // stitched into ONE co-resident world at construction (`content/arenas.ts
  // buildArenaGeometry`), unlike dungeon mode's one-room-live-at-a-time swap.
  // PRESENCE overrides `walls`/`obstacles`/`worldW`/`worldH` entirely (pass
  // placeholders, same convention as dungeon mode's `waves: []` note above).
  // Additive: a config that omits it (every config before this feature) never
  // touches this path — byte-identical, no ENGINE_VERSION bump.
  arena?: ArenaMap;
  // Which `ARENA_PRESETS` entry (balance/build.ts) every seat's landing-kit weapons +
  // HP/shield scale come from when `arena` is set (ROADMAP 4.2c). One preset for the
  // whole match, not per-seat — `skinId` (per seat) is still what buildArenaSpecs scales
  // the RIGHT character's stats by. Absent → 'landing_basic' (today's only preset).
  arenaPreset?: ArenaPresetId;
}

// Distinct derived-seed constants so the streams never alias (design/06/08).
const SEED_AI = 0x1a2b3c4d;
const SEED_COMBAT = 0x5e6f7a8b;
const SEED_DROP = 0x9c0d1e2f;
const SEED_ROOMGEN = 0x3f4a5b6c;
const SEED_RING = 0x7d8e9f0a;
const SEED_INTEGRITY = 0x2c3d4e5f;

/**
 * The zone's live state (design/15, ROADMAP 4.2d) — a room-graph BFS shrink, not a
 * geometric circle. `dist`/`maxDist` are deliberately NOT stored here: they're a pure
 * deterministic function of `eye` + the static `arenaMap` (rooms/doors never change
 * mid-match), so ZoneSystem recomputes them at each (infrequent) stage transition
 * instead of duplicating derived data into replicated state.
 */
export interface ZoneState {
  eye: RoomId;
  stage: number; // 0 = every reachable room still safe
  phase: 'warn' | 'hold';
  ticksToPhaseEnd: number;
  safe: RoomId[]; // rooms safe AT the current stage
  closing: RoomId[]; // only meaningful during 'warn': rooms about to drop at stage+1
  escalation: number; // extra damagePerTick increments once the final stage is reached
}

/**
 * One `ArenaRoom`'s lazy-activation + WaveScript runtime (design/15, ROADMAP 4.3).
 * `activated` flips true the tick a player's cached `roomId` first matches this
 * room — perf-only lazy activation (design/15: the map ships bundled, so this is
 * NOT an information-hiding measure). `schedule`/`cursor` mirror the dungeon
 * mode's `roomSchedule`/`roomSpawnCursor` shape exactly, just per-room instead of
 * globally-one-room-at-a-time (arena rooms are all co-resident, ROADMAP 4.2b).
 */
export interface ArenaRoomRuntime {
  activated: boolean;
  roomTick: number; // ticks since activation (room-local clock, mirrors dungeon's roomTick)
  schedule: { atTick: number; spawnPoint: number; enemyType?: string }[];
  cursor: number;
  lootSpawned: boolean;
}

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
  // Dungeon layout/selection (design/05/08/09, ROADMAP 1.3) — the fourth PRNG the
  // locked GameState schema names. Not yet drawn from by any live system:
  // GameEngine.step() doesn't call the floor generator (world/dungeon.ts
  // generateFloor) — that's wiring the demo's single arena into a real multi-floor
  // run, 1.4/1.5. Reserved now so the schema matches design/08 exactly.
  readonly roomgenPrng: Prng;
  // PvP zone eye draw + future per-seat spawn assignment (design/15, ROADMAP 4.2d) —
  // a distinct stream so tuning/observing the zone never shifts any gameplay-affecting
  // draw sequence (aiPrng/combatPrng/dropPrng), same reasoning as every other stream.
  readonly ringPrng: Prng;
  // Anti-cheat "padding" stream (design/15, ROADMAP 4.4) — drawn once per tick
  // (GameEngine.step) purely to raise how much the periodic-checkpoint state hash
  // moves tick-to-tick, so a diverged client surfaces sooner. NEVER read by any
  // gameplay system — mixing it into aiPrng/combatPrng/dropPrng would shift real
  // draw sequences whenever this tuning changes, for no anti-cheat benefit.
  readonly integrityPrng: Prng;

  // Entities — ordered arrays; index/id stable within a match.
  readonly players: PlayerActor[] = [];
  readonly enemies: EnemyActor[] = [];
  readonly projectiles: Projectile[] = [];
  readonly pickups: PickupItem[] = [];

  // Round solids (design/07). Set once at construction and never mutated for a
  // non-dungeon config; in dungeon mode SpawnSystem.loadRoom repopulates the array
  // CONTENTS (never the reference) as each room loads. The `readonly` on the field is
  // the reference, not the contents — the reassignment-free swap keeps every reader valid.
  readonly obstacles: Obstacle[] = [];
  // Rectangular solids (design/07/09 ROADMAP 1.2) — same lifecycle as `obstacles`:
  // static for a non-dungeon config, per-room content-swapped in dungeon mode.
  readonly walls: AABB[] = [];
  // Broadphase index over the two arrays above (ROADMAP 4.2b) — a derived cache, not
  // gameplay state, rebuilt every time `walls`/`obstacles` are repopulated (here, and
  // by SpawnSystem.loadRoom via rebuildSpatialIndex()).
  spatialIndex!: UniformGrid;

  // World bounds (fp). Mutable ONLY in dungeon mode (each room resizes them as it
  // loads — SpawnSystem.loadRoom); a non-dungeon config sets them once at construction
  // and never touches them again, exactly as before (they were `readonly` pre-1.3).
  worldW: Fp;
  worldH: Fp;

  // Wave director state (design/08 steps 10–11).
  waveIndex = -1; // -1 = run not started; 0-based into the CURRENT floor's waves
  waveBreakTicks = 0; // countdown between a cleared wave and the next spawn
  wavesExhausted = false; // current floor's last wave dispatched
  // Mutable (unlike the other static-at-construction arrays above): ExtractionSystem
  // reassigns this to the next floor's wave list on DESCEND (design/05, ROADMAP 1.4).
  waves: readonly WaveDef[];

  // Extraction / materials-banking (design/05/09, ROADMAP 1.4/1.5). All no-ops
  // unless `floorsEnabled` (EngineConfig.floors was provided) — see ExtractionSystem.
  readonly floorsEnabled: boolean;
  readonly extraFloors: readonly (readonly WaveDef[])[]; // config.floors ?? []
  floorIndex = 0; // 0-based; floor 0 is the original `waves`, floor k>=1 is extraFloors[k-1]
  // This floor's un-banked buffer (materialId → qty) — auto-collected on pickup
  // (PickupSystem), merged into `bankedMaterials` on EXTRACT/DESCEND, and silently
  // discarded on a run-ending death (forfeit is just "never merged" — no extra code).
  floorMaterials: Partial<Record<string, number>> = {};
  // The run's carry-out bag — the ONLY thing that leaves a run (design/05). Never
  // wiped by death; only ever grows, at an extraction checkpoint.
  bankedMaterials: Partial<Record<string, number>> = {};
  extractHoldTicks = 0; // ticks INTERACT has been held at the checkpoint this attempt

  // Seeded dungeon mode (design/05/09, ROADMAP 1.3 wired live). All inert unless
  // `dungeonEnabled` (EngineConfig.dungeon was provided) — see SpawnSystem's dungeon
  // branch. `dungeonEnabled` also forces `floorsEnabled` on, so ExtractionSystem runs.
  readonly dungeonEnabled: boolean;
  readonly dungeonConfig?: DungeonConfig;
  readonly roomLibrary: readonly RoomPiece[];
  // The CURRENT floor's generated STAGE plan (world/dungeon.ts generateFloor): each
  // stage is the candidate room(s) offered at that step (1 for linear, branchFactor for
  // branching); the last stage is the single capstone. Regenerated per floor when
  // SpawnSystem sees a fresh floor (roomIndex -1).
  floorStages: readonly (readonly RoomPiece[])[] = [];
  // The RESOLVED path this run has actually taken through the current floor — the room
  // chosen at each stage entered so far, in order. Grows by one per stage; for a linear
  // floor this ends up equal to `floorStages` flattened. `floorLayout[roomIndex]` is the
  // live room (render + HUD read it). Reset to [] when a fresh floor is generated.
  floorLayout: readonly RoomPiece[] = [];
  // Index of the live STAGE (into floorStages / the resolved floorLayout); -1 = no room
  // loaded yet (run start, or just DESCENDed → SpawnSystem regenerates + loads stage 0).
  roomIndex = -1;
  // Ticks since the live room loaded (room-local clock for WaveScript timing). Drives
  // the staggered spawn schedule below; reset to 0 by SpawnSystem.loadRoom.
  roomTick = 0;
  // The live room's spawn schedule (design/09 WaveScript), pre-expanded at room load:
  // each WaveEntry becomes `count` timed spawn events (copy j at atTick + j*spacingTicks),
  // sorted by (atTick, authoring order) so dispatch is deterministic. Empty for a room
  // with no enemies. `roomSpawnCursor` is how many have been dispatched so far — a room
  // is not "cleared" (and won't advance) until the cursor reaches the end AND no enemies
  // remain, so staggered spawns can't be skipped by killing the early ones fast.
  roomSchedule: { atTick: number; spawnPoint: number; enemyType?: string }[] = [];
  roomSpawnCursor = 0;

  // PvP arena mode (design/15, ROADMAP 4.2b/c/d). All inert unless `zoneEnabled`
  // (EngineConfig.arena was provided) — ZoneSystem/EnvironmentSystem are strict
  // no-ops otherwise (ExtractionSystem's precedent, GameEngine.ts).
  readonly zoneEnabled: boolean;
  readonly arenaMap?: ArenaMap;
  // Every cellTrait, pre-converted to an absolute-Fp rect ONCE at construction (same
  // "convert once, never inside a system" rule as walls/obstacles) — see
  // `content/arenas.ts buildArenaCellTraits`. Empty when `arenaMap` is absent.
  readonly cellTraits: { trait: CellTrait; rect: AABB }[] = [];
  // Every room's rect, pre-converted to Fp ONCE (same rule) — the room-membership
  // point-in-rect test (`EnvironmentSystem`) reads this, never `arenaMap` directly.
  readonly arenaRoomRects: { id: RoomId; rect: AABB }[] = [];
  // The zone's per-match-drawn eye + current stage (design/15) — undefined until
  // ZoneSystem's first tick draws it (PRNG draws happen inside systems, not the
  // constructor, matching `roomgenPrng`'s existing precedent above).
  zone?: ZoneState;
  // PvP finish order (design/15, ROADMAP 4.2e) — seat INDICES (into `players`, same
  // convention as `Winner`'s doc comment), in ELIMINATION order (worst place first);
  // the winner (`state.winner`) is implicitly 1st and never pushed here. Populated by
  // WinConditionSystem's arena-mode branch only; empty for every PvE config.
  readonly placements: number[] = [];
  // Per-room lazy-activation + encounter runtime (design/15, ROADMAP 4.3) — parallel
  // array to `arenaMap.rooms` (index-aligned, never a Map: same array-order
  // determinism convention as everywhere else). Initialized eagerly at construction
  // (plain state, no PRNG draw, so — unlike `zone` — there's no reason to defer this
  // to a system's first tick); `SpawnSystem` is the only mutator.
  readonly arenaRoomRuntime: ArenaRoomRuntime[] = [];

  // Outcome + render channel.
  winner: Winner = null;
  events: GameEvent[] = [];

  constructor(config: EngineConfig) {
    this.seed = config.seed;
    this.aiPrng = new Prng(config.seed ^ SEED_AI);
    this.combatPrng = new Prng(config.seed ^ SEED_COMBAT);
    this.dropPrng = new Prng(config.seed ^ SEED_DROP);
    this.roomgenPrng = new Prng(config.seed ^ SEED_ROOMGEN);
    this.ringPrng = new Prng(config.seed ^ SEED_RING);
    this.integrityPrng = new Prng(config.seed ^ SEED_INTEGRITY);
    this.worldW = pxToFp(config.worldW);
    this.worldH = pxToFp(config.worldH);
    this.waves = config.waves;
    // Dungeon mode is a second way to enable the extraction/materials loop (design/05),
    // so floorsEnabled is true for EITHER opt-in. A config with neither is untouched.
    this.dungeonEnabled = config.dungeon !== undefined;
    this.dungeonConfig = config.dungeon?.config;
    this.roomLibrary = config.dungeon?.library ?? [];
    this.floorsEnabled = config.floors !== undefined || this.dungeonEnabled;
    this.extraFloors = config.floors ?? [];

    this.zoneEnabled = config.arena !== undefined;
    this.arenaMap = config.arena;

    if (config.arena) {
      // Arena mode overrides the flat obstacles/walls/worldW/worldH above entirely —
      // every room's geometry, stitched at its own offset, replaces the demo's single
      // flat layout (see EngineConfig.arena).
      const geo = buildArenaGeometry(config.arena);
      this.worldW = geo.worldW;
      this.worldH = geo.worldH;
      this.obstacles.push(...geo.obstacles);
      this.walls.push(...geo.walls);
      this.cellTraits.push(...buildArenaCellTraits(config.arena));
      this.arenaRoomRects.push(...buildArenaRoomRects(config.arena));
      for (const _room of config.arena.rooms) {
        this.arenaRoomRuntime.push({ activated: false, roomTick: 0, schedule: [], cursor: 0, lootSpawned: false });
      }
    } else {
      for (const [ox, oy, orad] of config.obstacles ?? []) {
        this.obstacles.push({ gx: pxToFp(ox), gy: pxToFp(oy), radius: pxToFp(orad) });
      }
      for (const [wx, wy, ww, wh] of config.walls ?? []) {
        this.walls.push({ x: pxToFp(wx), y: pxToFp(wy), w: pxToFp(ww), h: pxToFp(wh) });
      }
    }
    this.rebuildSpatialIndex();

    // One PlayerActor per co-op seat (design/05/06, ROADMAP 3.1). ABSENT `players` →
    // exactly one seat built from the single-player top-level fields, byte-identical to
    // before (the seat list is `[{ skinId, loadout, start }]`, so the same buildSeat call
    // with the same nextId()==1 runs — additive, no ENGINE_VERSION bump). PRESENT → one
    // seat per entry, in order, so owner index == array index (ApplyInputSystem routing).
    const seats: readonly PlayerConfig[] =
      config.players ?? [{ skinId: config.skinId, loadout: config.loadout, start: config.playerStart }];
    for (const seat of seats) this.players.push(this.buildSeat(config, seat));
  }

  /**
   * Build one co-op seat's PlayerActor (design/05/06, ROADMAP 3.1). PvP arena mode
   * (`config.arena` set, ROADMAP 4.2c) branches to `buildArenaSpecs` for the body/
   * weapon stats instead of the PvE run-builder path below: the fairness wall
   * (design/05/06/09) means `seat.loadout` (persistent meta gear) must never reach a
   * PvP seat — `buildArenaSpecs` structurally cannot take it (no such parameter), so
   * branching here enforces that at the one place seats are actually built, not just
   * by convention at the call site.
   */
  private buildSeat(config: EngineConfig, seat: PlayerConfig): PlayerActor {
    const [sx, sy] = seat.start ?? [config.worldW / 2, config.worldH / 2];
    // Merge the chosen character (SkinDef defensive identity) with PLAYER_BASE shared
    // constants (design/09/14). Unknown/absent skin → the default (forward-compat).
    const skin = resolveSkin(seat.skinId);

    let weapons: WeaponState[];
    let maxHp: number;
    let maxShield: number;
    if (config.arena) {
      // PvP (design/15): the landing-kit preset's weapons + this character's HP/shield,
      // both scaled by PVP_SCALE_FACTOR — `seat.loadout` is deliberately never read here.
      const built = buildArenaSpecs(config.arenaPreset ?? 'landing_basic', seat.skinId);
      weapons = built.weapons;
      maxHp = built.maxHp;
      maxShield = built.maxShield;
    } else {
      // PvE: resolve the loadout through the run builder (design/09 fairness wall) — the
      // base meta loadout carried in at match start. A `seat.loadout` (crafted weapon
      // ids, ROADMAP 2.2) resolves through WEAPON_SIM_BY_ID — unknown ids dropped
      // (forward-compat), an empty result falling back to the auto pistol (design/05
      // "none → auto pistol"). Absent → the shared PLAYER_BASE default (byte-identical
      // to before — additive).
      let baseLoadout: readonly WeaponSimSpec[];
      if (seat.loadout) {
        const resolved = seat.loadout
          .map((id) => WEAPON_SIM_BY_ID[id])
          .filter((s): s is WeaponSimSpec => s !== undefined);
        baseLoadout = (resolved.length > 0 ? resolved : [WEAPON_SIM_BY_ID['blaster']!]).slice(0, PLAYER_BASE.weaponSlots);
      } else {
        baseLoadout = PLAYER_BASE.startWeapons;
      }
      weapons = buildRunSpecs(baseLoadout);
      maxHp = skin.maxHp;
      maxShield = skin.maxShield;
    }

    return {
      id: this.nextId(),
      faction: 'player',
      teamId: seat.teamId ?? 0, // shared default team (design/15) — see PlayerConfig.teamId
      gx: pxToFp(sx),
      gy: pxToFp(sy),
      z: toFp(0),
      vx: toFp(0),
      vy: toFp(0),
      facing: 0 as PlayerActor['facing'],
      hp: maxHp,
      maxHp,
      shield: maxShield, // spawn with a full shield (design/07)
      maxShield,
      ticksSinceHit: 0,
      radius: PLAYER_BASE.radius,
      footprintRadius: PLAYER_BASE.footprintRadius,
      alive: true,
      weapon: weapons[0] ?? null, // active pointer = weapons[activeSlot]
      weapons,
      activeSlot: 0,
      buffs: [], // run-scoped buff stack (design/14); filled by 'buff' pickups
      firing: false,
      interacting: false,
      downed: false, // co-op downed/revive (design/05/07, ROADMAP 3.2)
      bleedoutTicks: 0,
      reviveProgressTicks: 0,
      prevButtons: 0,
      status: freshStatus(),
      shieldBreak: skin.shieldBreak ? toShieldBreakSim(skin.shieldBreak) : undefined,
    };
  }

  clearEvents(): void {
    this.events.length = 0;
  }

  /** Rebuild the broadphase index from the current walls/obstacles contents (ROADMAP
   * 4.2b). Call after repopulating either array — the constructor does this once;
   * SpawnSystem.loadRoom does it again on every room swap. */
  rebuildSpatialIndex(): void {
    this.spatialIndex = new UniformGrid(this.walls, this.obstacles);
  }
}

export function createGameState(config: EngineConfig): GameState {
  return new GameState(config);
}
