/**
 * The level simulator: drive one full PvE run headlessly and record what it felt
 * like to be shot at.
 *
 * Built for a specific, repeated failure mode — a live report that a room's garrison
 * deletes the player before they can react ("一进游戏就被集火秒杀"). That bug has now
 * been "fixed" twice from reasoning alone (ENGINE_VERSION 40's fire-range gate, and
 * v37's chase before it) without anything in the repo able to say how much incoming
 * damage a room actually produces. This measures it:
 *
 *   - `reactionTicks` — activation → first damage taken. The number the report is
 *     really about; a player needs roughly a second to read a room.
 *   - `peakShooters` — most enemies firing at the player in the same tick, per room.
 *     The literal definition of 集火 (focus fire).
 *   - `peakBurstDamage` — worst 1-second damage window of the run, against the
 *     player's own effective HP pool (`hp + shield`), which is what decides whether
 *     a burst is survivable at all.
 *   - clear time and where the run ended, so a nerf can be checked for overshoot —
 *     an unkillable room and a boring one are both failures.
 *
 * It runs the REAL content through the REAL engine: `buildDungeonRunConfig` is the
 * same function `Game.beginRun` calls, so the simulated run is byte-identical to
 * pressing START (design/06 anti-drift — no second hand-mirrored copy of the run
 * config), and `PveBotController` reaches the engine through nothing but
 * `PlayerCommand`s. What it is NOT is a claim about human skill: a bot's aim is
 * perfect and its nerve never breaks. Read it as a floor on difficulty ("even a
 * tireless kiter dies here"), not as a verdict on how a person will do.
 */
import { createGameEngine, type GameState } from '@dd/engine';
import { buildDungeonRunConfig } from '../../src/game/match/offlineConfig';
import { BOT_PROFILES, PveBotController, type BotProfile } from './PveBotController';
import { roomIdAt } from './pveNav';

/** One room's fight, from the tick it woke up to the tick it went quiet. */
export interface RoomEncounter {
  floorIndex: number;
  roomId: string;
  activatedTick: number;
  clearedTick: number | null;
  /** Enemies alive in the room the tick it activated. */
  garrison: number;
  /** Ticks from activation to the player's first point of damage in this room —
   *  null if the room never landed a hit. The run's reaction window. */
  reactionTicks: number | null;
  /** Most enemies of this room firing simultaneously (any single tick). */
  peakShooters: number;
  damageTaken: number;
}

export interface RunMetrics {
  seed: number;
  profileName: string;
  skinId: string;
  outcome: 'extracted' | 'died' | 'timeout';
  ticks: number;
  /** Deepest floor index reached (0-based), and the room the run ended in. */
  floorReached: number;
  endRoom: string | null;
  encounters: RoomEncounter[];
  enemiesKilled: number;
  damageTaken: number;
  /** Worst damage total inside any one-second (30-tick) window. */
  peakBurstDamage: number;
  /** The player's own effective pool (maxHp + maxShield) — what `peakBurstDamage`
   *  has to be read against. */
  effectiveHp: number;
  /** Lowest `(hp + shield) / (maxHp + maxShield)` seen while alive. */
  lowestHpFrac: number;
}

export interface RunOptions {
  seed: number;
  skinId?: string;
  /** Crafted loadout ids; `[]` (the default) is a fresh save's real state — the
   *  starter blaster + saber (`PLAYER_BASE.startWeapons`), i.e. exactly what a new
   *  player walks in with. */
  loadout?: string[];
  profileName?: keyof typeof BOT_PROFILES;
  profile?: BotProfile;
  maxTicks?: number;
}

const BURST_WINDOW_TICKS = 30; // 1s @30Hz
/** 5 floors of hand-authored rooms with a slow starter pistol is a long run; this is
 *  a runaway guard, not an expected outcome — a timeout is reported as its own
 *  result so it can never be mistaken for a survival. */
const DEFAULT_MAX_TICKS = 40_000;

export function runLevel(opts: RunOptions): RunMetrics {
  const profileName = opts.profileName ?? 'careful';
  const profile = opts.profile ?? BOT_PROFILES[profileName];
  const skinId = opts.skinId ?? 'vanguard';
  const maxTicks = opts.maxTicks ?? DEFAULT_MAX_TICKS;

  const engine = createGameEngine(
    buildDungeonRunConfig({
      seed: opts.seed,
      coop: false,
      localSeat: { skinId, loadout: opts.loadout ?? [] },
      allySkinId: 'juggernaut', // ignored: single-player config has no ally seat
    }),
  );
  const bot = new PveBotController(profile);
  const tracker = new EncounterTracker();

  let outcome: RunMetrics['outcome'] = 'timeout';
  let ticks = 0;
  while (ticks < maxTicks) {
    const nextTick = engine.state.tick + 1;
    engine.step([bot.build(engine.state, 0, nextTick)]);
    ticks++;
    tracker.observe(engine.state);
    if (engine.state.phase === 'gameover') {
      outcome = engine.state.winner === 0 ? 'extracted' : 'died';
      break;
    }
  }

  const s = engine.state;
  return {
    seed: opts.seed,
    profileName,
    skinId,
    outcome,
    ticks,
    floorReached: s.floorIndex,
    endRoom: tracker.playerRoom,
    encounters: tracker.encounters,
    enemiesKilled: tracker.enemiesKilled,
    damageTaken: tracker.damageTaken,
    peakBurstDamage: tracker.peakBurstDamage,
    effectiveHp: tracker.effectiveHp,
    lowestHpFrac: tracker.lowestHpFrac,
  };
}

/**
 * Per-tick observer. Deliberately reads room ACTIVATION off
 * `dungeonRoomRuntime[i].activated` rather than the `room_enter` event: activation
 * is the moment the garrison is allowed to act (AIDecideSystem's one and only
 * behaviour gate), which is precisely what the reaction window is measured from.
 */
class EncounterTracker {
  readonly encounters: RoomEncounter[] = [];
  enemiesKilled = 0;
  damageTaken = 0;
  peakBurstDamage = 0;
  effectiveHp = 0;
  lowestHpFrac = 1;
  playerRoom: string | null = null;

  private readonly open = new Map<string, RoomEncounter>(); // key: `${floor}:${roomId}`
  private readonly window: number[] = [];

  observe(s: GameState): void {
    const p = s.players[0];
    if (!p) return;
    this.effectiveHp = p.maxHp + p.maxShield;
    if (p.alive) {
      this.lowestHpFrac = Math.min(this.lowestHpFrac, (p.hp + p.shield) / Math.max(1, this.effectiveHp));
      const here = roomIdAt(s, p.gx, p.gy);
      if (here !== undefined) this.playerRoom = here;
    }

    this.trackRooms(s);
    this.trackShooters(s);
    this.trackDamage(s, p.id);
  }

  /** Open an encounter the tick a room activates; close it when it goes quiet. */
  private trackRooms(s: GameState): void {
    for (let i = 0; i < s.dungeonRooms.length; i++) {
      const room = s.dungeonRooms[i]!;
      const rt = s.dungeonRoomRuntime[i];
      if (!rt?.activated) continue;
      const key = `${s.floorIndex}:${room.id}`;
      let enc = this.open.get(key);
      if (!enc) {
        enc = {
          floorIndex: s.floorIndex,
          roomId: room.id,
          activatedTick: s.tick,
          clearedTick: null,
          garrison: s.enemies.reduce((n, e) => n + (e.alive && e.roomId === room.id ? 1 : 0), 0),
          reactionTicks: null,
          peakShooters: 0,
          damageTaken: 0,
        };
        this.open.set(key, enc);
        this.encounters.push(enc);
      }
      // `hasLiveEnemy` is DoorSystem's own per-room scan (design/05) — the same
      // signal the door lock uses, so "cleared" here means exactly what the game
      // means by it.
      if (enc.clearedTick === null && !rt.hasLiveEnemy) enc.clearedTick = s.tick;
    }
  }

  private trackShooters(s: GameState): void {
    const firing = new Map<string, number>();
    for (const e of s.enemies) {
      if (!e.alive || !e.firing || e.roomId === undefined) continue;
      firing.set(e.roomId, (firing.get(e.roomId) ?? 0) + 1);
    }
    for (const [roomId, n] of firing) {
      const enc = this.open.get(`${s.floorIndex}:${roomId}`);
      if (enc && n > enc.peakShooters) enc.peakShooters = n;
    }
  }

  private trackDamage(s: GameState, playerId: number): void {
    let tickDamage = 0;
    for (const ev of s.events) {
      if (ev.type === 'death' && ev.faction === 'enemy') this.enemiesKilled++;
      if (ev.type !== 'hit' || ev.target !== playerId) continue;
      tickDamage += ev.damage;
    }
    this.damageTaken += tickDamage;

    this.window.push(tickDamage);
    if (this.window.length > BURST_WINDOW_TICKS) this.window.shift();
    const burst = this.window.reduce((a, b) => a + b, 0);
    if (burst > this.peakBurstDamage) this.peakBurstDamage = burst;

    if (tickDamage > 0 && this.playerRoom !== null) {
      const enc = this.open.get(`${s.floorIndex}:${this.playerRoom}`);
      if (enc) {
        enc.damageTaken += tickDamage;
        if (enc.reactionTicks === null) enc.reactionTicks = s.tick - enc.activatedTick;
      }
    }
  }
}
