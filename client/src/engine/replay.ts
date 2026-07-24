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
    prng: [s.aiPrng.peek(), s.combatPrng.peek(), s.dropPrng.peek(), s.roomgenPrng.peek()],
    players: s.players.map((p) => [
      p.id, p.gx, p.gy, p.z, p.vx, p.vy, p.facing, p.hp, p.maxHp, p.alive,
      // Two-pool health (design/07): shield absorbs first and its idle regen advances
      // ticksSinceHit every tick, so both must be hashed to catch a regen divergence.
      p.shield, p.maxShield, p.ticksSinceHit,
      p.activeSlot, p.firing, p.prevButtons,
      // Run-buff stack (design/14): buffs scale damage/firerate at use time, so a buff
      // divergence would otherwise only surface indirectly — hash the ids directly.
      p.buffs,
      // Resolved spec fields: a weapon drop swaps the active slot's spec, so include
      // the numbers (not just name) to catch a loadout divergence.
      p.weapons.map((w) => [
        w.spec.name, w.cooldownTicks, w.justSwung, w.spec.damage,
        w.spec.kind === 'ranged' ? [w.spec.fireRateTicks, w.spec.bulletSpeed] : [w.spec.range],
      ]),
    ]),
    enemies: s.enemies.map((e) => [e.id, e.gx, e.gy, e.z, e.vx, e.vy, e.facing, e.hp, e.shield, e.alive]),
    projectiles: s.projectiles.map((b) => [
      b.id, b.gx, b.gy, b.z, b.vx, b.vy, b.faction, b.damage, b.lifeTicks, b.alive,
      // Ballistic runtime (design/03/09, ROADMAP 1.1): homing/boomerang/lob/beam carry
      // extra per-tick state (turn progress, landing flag, beam duration) that can
      // diverge without necessarily moving gx/gy/vx/vy the very same tick.
      b.ballistic ?? '', b.ticksAlive ?? 0, b.landed ?? false, b.beamTicksLeft ?? 0,
      // orbit: the live angle + owner catch a circular-motion divergence before it moves
      // gx/gy (stable 0/-1 for every non-orbit bullet, so byte-identical there).
      b.orbitAngleBrad ?? 0, b.ownerId ?? -1,
    ]),
    pickups: s.pickups.map((k) => [
      k.id, k.kind, k.gx, k.gy, k.spawnTick, k.alive,
      k.weaponId ?? '', k.buffId ?? '', k.materialId ?? '', k.qty ?? 0, k.tier ?? 0,
    ]),
    // Extraction / materials-banking (design/05, ROADMAP 1.4/1.5). floorIndex/
    // extractHoldTicks are plain numbers; the two material maps are sorted by key so
    // the hash doesn't depend on Object.entries' (already-deterministic) insertion
    // order matching between two independently-constructed-but-equal states.
    floorIndex: s.floorIndex,
    extractHoldTicks: s.extractHoldTicks,
    floorMaterials: sortedEntries(s.floorMaterials),
    bankedMaterials: sortedEntries(s.bankedMaterials),
    // Dungeon-mode room cursor (ROADMAP 1.3 wired). -1 for a non-dungeon config (never
    // changes), so this is a stable constant there — the golden-replay test compares two
    // independent runs, so a new always-equal field is safe (no bump). Room SELECTION is
    // deterministic from roomgenPrng (already hashed above); this catches a progression
    // divergence (advanced to a different room) that hasn't yet moved an entity.
    roomIndex: s.roomIndex,
    // The resolved live room's id — for a branching floor two runs can share roomIndex
    // yet be in different rooms (a different branch chosen), so hash the identity too.
    // '' for a non-dungeon config (stable). '' also before the first room loads.
    roomId: s.floorLayout[s.roomIndex]?.id ?? '',
    // Room-local WaveScript clock + how many scheduled spawns have fired. Stable 0 for
    // a non-dungeon config; catches a timing divergence (an entry dispatched a tick
    // early/late) before it surfaces in the enemy list.
    roomTick: s.roomTick,
    roomSpawnCursor: s.roomSpawnCursor,
  };
}

function sortedEntries(m: Partial<Record<string, number>>): [string, number][] {
  return Object.entries(m)
    .map(([k, v]) => [k, v ?? 0] as [string, number])
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
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
