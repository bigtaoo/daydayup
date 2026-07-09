/**
 * Replay, headless re-judge, and deterministic state hashing (design/06/08).
 *
 * A replay is **seed + config + input stream, never state** (design/08): a fresh
 * engine on the same seed reconstructs every frame bit-for-bit. That is the whole
 * anti-cheat / re-judge backstop — the server (or a test) re-runs the recorded
 * input through runHeadless() and compares the outcome. ENGINE_VERSION guards the
 * stream: ReplayInputSource refuses a mismatched version rather than replaying
 * garbage against changed sim math.
 *
 * Stage E delivers the recorded path (ReplayInputSource) and the shared
 * authoritative loop (runHeadless); the live NetInputSource is post-MVP (design/06).
 */
import { ENGINE_VERSION } from './config';
import { createGameEngine, GameEngine } from './GameEngine';
import type { EngineConfig, GameState } from './state/GameState';
import type { InputSource, PlayerCommand } from './state/commands';

/**
 * A recorded match: everything needed to reconstruct it. `commands` is the sparse,
 * flat input stream (a frame with no command replays as idle-hold, design/08).
 */
export interface Replay {
  version: number; // ENGINE_VERSION at record time
  config: EngineConfig;
  commands: readonly PlayerCommand[];
}

/** Build a Replay from a finished match's recorded command stream (design/08). */
export function toReplay(config: EngineConfig, commands: readonly PlayerCommand[]): Replay {
  return { version: ENGINE_VERSION, config, commands: commands.map((c) => ({ ...c })) };
}

/**
 * Replays a recorded input stream. Like LocalInputSource it never stalls — a frame
 * absent from the recording is idle-hold ([]), not a net stall (null). Refuses a
 * version mismatch loudly at construction (design/08 "fail loud, never replay
 * garbage"): an old stream against changed sim math would silently diverge.
 */
export class ReplayInputSource implements InputSource {
  private readonly byFrame = new Map<number, PlayerCommand[]>();

  constructor(private readonly replay: Replay) {
    if (replay.version !== ENGINE_VERSION) {
      throw new Error(
        `Replay version ${replay.version} != engine ${ENGINE_VERSION}; refusing to replay (design/08).`,
      );
    }
    for (const cmd of replay.commands) {
      const list = this.byFrame.get(cmd.tick);
      if (list) list.push(cmd);
      else this.byFrame.set(cmd.tick, [cmd]);
    }
  }

  /** Replays are read-only; the stream is fixed at construction. */
  submit(): void {
    throw new Error('ReplayInputSource is read-only');
  }

  take(frame: number): PlayerCommand[] {
    return this.byFrame.get(frame) ?? [];
  }

  get config(): EngineConfig {
    return this.replay.config;
  }
}

/**
 * The shared authoritative loop (design/06/08 runHeadless): drive an engine from
 * an InputSource for up to maxTicks, stopping early on gameover. No render, no
 * wall-clock — used for post-match re-judge, anti-cheat, and golden-replay tests.
 * A net stall (take → null) ends the loop; local/replay sources never stall.
 */
export function runHeadless(config: EngineConfig, input: InputSource, maxTicks: number): GameEngine {
  const engine = createGameEngine(config, input);
  for (let frame = 1; frame <= maxTicks; frame++) {
    if (engine.advance(frame) === null) break; // net stall
    if (engine.state.phase === 'gameover') break;
  }
  return engine;
}

/** Convenience: reconstruct a recorded match end-to-end from its Replay. */
export function runReplay(replay: Replay, maxTicks: number): GameEngine {
  return runHeadless(replay.config, new ReplayInputSource(replay), maxTicks);
}

// ── deterministic state hashing (re-judge / golden-replay comparison) ──────────

/**
 * A stable, order-sensitive snapshot of everything the determinism contract
 * covers (design/08). Only integer sim fields — positions/velocities are fp,
 * angles brad, so this is exact, not float-fuzzy. The three PRNG cursors are
 * included so a divergence that has not yet surfaced in an entity is still caught.
 * Iteration follows the ordered arrays (push = spawn = iteration order).
 */
export function serializeState(s: GameState): unknown {
  return {
    version: ENGINE_VERSION,
    tick: s.tick,
    phase: s.phase,
    winner: s.winner,
    waveIndex: s.waveIndex,
    waveBreakTicks: s.waveBreakTicks,
    wavesExhausted: s.wavesExhausted,
    prng: [s.aiPrng.peek(), s.combatPrng.peek(), s.dropPrng.peek()],
    players: s.players.map((p) => [
      p.id, p.gx, p.gy, p.z, p.vx, p.vy, p.facing, p.hp, p.maxHp, p.alive,
      p.activeSlot, p.firing, p.prevButtons,
      // Resolved spec fields (Stage F): affixes mutate damage/rate/speed/range but
      // NOT name, so name alone would miss an affix divergence — include the numbers.
      p.weapons.map((w) => [
        w.spec.name, w.cooldownTicks, w.justSwung, w.spec.damage,
        w.spec.kind === 'ranged' ? [w.spec.fireRateTicks, w.spec.bulletSpeed] : [w.spec.range],
      ]),
      p.affixes.map((a) => [a.id, a.value]),
    ]),
    enemies: s.enemies.map((e) => [e.id, e.gx, e.gy, e.z, e.vx, e.vy, e.facing, e.hp, e.alive]),
    projectiles: s.projectiles.map((b) => [
      b.id, b.gx, b.gy, b.z, b.vx, b.vy, b.faction, b.damage, b.lifeTicks, b.alive,
    ]),
    pickups: s.pickups.map((k) => [
      k.id, k.kind, k.gx, k.gy, k.spawnTick, k.alive,
      k.weaponId ?? '', k.affix ? [k.affix.id, k.affix.value] : 0,
    ]),
  };
}

/** 32-bit FNV-1a of the serialized state — a compact byte-equality token. */
export function hashState(s: GameState): number {
  const json = JSON.stringify(serializeState(s));
  let h = 0x811c9dc5;
  for (let i = 0; i < json.length; i++) {
    h ^= json.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}
