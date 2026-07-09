/**
 * GameEngine — the single orchestrator (design/08). Owns a GameState and the 11
 * systems, instantiated once and run in the frozen step() order. That order IS the
 * determinism contract; reordering it (or changing how a system iterates a
 * collection) bumps ENGINE_VERSION.
 *
 * step(commands) is the direct entry (headless/tests). The InputSource seam
 * (advance/submit) pulls confirmed frames from the source; runHeadless() (replay.ts)
 * drives it for re-judge/replay, and the render layer's accumulator drives it live
 * (Stage D). A net stall (take → null) surfaces as advance() → null; local/replay
 * sources never stall.
 */
import { createGameState, type EngineConfig, type GameState } from './state/GameState';
import { LocalInputSource, type InputSource, type PlayerCommand } from './state/commands';
import type { GameEvent } from './state/events';
import {
  AIDecideSystem,
  ApplyInputSystem,
  DeathDropsSystem,
  DeflectSystem,
  HitResolveSystem,
  MovementSystem,
  PickupSystem,
  ProjectileStepSystem,
  SpawnSystem,
  WeaponFireSystem,
  WinConditionSystem,
} from './systems';

export class GameEngine {
  readonly state: GameState;
  private readonly input: InputSource;

  private readonly applyInput = new ApplyInputSystem();
  private readonly aiDecide = new AIDecideSystem();
  private readonly weaponFire = new WeaponFireSystem();
  private readonly movement = new MovementSystem();
  private readonly projectileStep = new ProjectileStepSystem();
  private readonly deflect = new DeflectSystem();
  private readonly hitResolve = new HitResolveSystem();
  private readonly deathDrops = new DeathDropsSystem();
  private readonly pickup = new PickupSystem();
  private readonly spawns = new SpawnSystem();
  private readonly winCondition = new WinConditionSystem();

  constructor(config: EngineConfig, input: InputSource) {
    this.state = createGameState(config);
    this.input = input;
  }

  /**
   * Advance one sim frame with the confirmed commands for this tick. The fixed
   * system order is the determinism contract (design/08). Returns the events
   * produced this step (also readable as state.events until the next step).
   */
  step(commands: readonly PlayerCommand[]): GameEvent[] {
    const s = this.state;
    if (s.phase === 'gameover') return s.events; // don't clear events (design/08)
    if (s.phase === 'idle') s.phase = 'playing';
    s.clearEvents();
    s.tick++;

    this.applyInput.tick(s, commands); // 1
    this.aiDecide.tick(s); //             2  (PvE)
    this.weaponFire.tick(s); //           3
    this.movement.tick(s); //             4
    this.projectileStep.tick(s); //       5
    this.deflect.tick(s); //              6  (melee swing parries bullets in its arc)
    this.hitResolve.tick(s); //           7
    this.deathDrops.tick(s); //           8
    this.pickup.tick(s); //               9
    this.spawns.tick(s); //              10  (PvE)
    this.winCondition.tick(s); //        11

    return s.events;
  }

  /** Submit a command to the input source (Stage E net/replay seam). */
  submit(cmd: PlayerCommand): void {
    this.input.submit(cmd);
  }

  /**
   * Pull the confirmed commands for `frame` from the input source and step. Returns
   * null on a net stall (input not yet confirmed); LocalInputSource never stalls.
   * The full frame-broadcast/replay behavior is Stage E.
   */
  advance(frame: number): GameEvent[] | null {
    const cmds = this.input.take(frame);
    if (cmds === null) return null;
    return this.step(cmds);
  }
}

/**
 * Factory (design/08). `input` defaults to a non-stalling LocalInputSource so
 * single-player and tests need no net setup.
 */
export function createGameEngine(config: EngineConfig, input: InputSource = new LocalInputSource()): GameEngine {
  return new GameEngine(config, input);
}
