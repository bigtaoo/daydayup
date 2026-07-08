/**
 * Step 10 — Spawns (PvE only). A scripted wave director: spawn the first wave
 * immediately, then, once a wave is fully cleared, run a short break before the
 * next; when the last wave is dispatched, flag wavesExhausted for WinCondition.
 * Enemies spawn with an aiPrng-seeded initial cooldown so their fire phases don't
 * lock-step (replaces the demo's non-deterministic `gx % 1` jitter).
 *
 * Ports Game.ts updateWaves()/spawnNextWave() + WaveDirector, float px → fp.
 * Wave data still lives in EngineConfig (px); the @dd/engine content catalog for
 * waves/enemy blueprints is design/09 (Stage C+).
 */
import { toFp } from '../math/fixed';
import { ENEMY_BLASTER, makeWeapon, SIM } from '../sim.config';
import type { GameState, WaveDef } from '../state/GameState';

export class SpawnSystem {
  tick(state: GameState): void {
    if (state.enemies.length > 0 || state.wavesExhausted) return;

    if (state.waveIndex === -1) {
      this.advance(state); // -1 → wave 0, no break before the first wave
      return;
    }

    // Current wave cleared: run the inter-wave break, then advance.
    if (state.waveBreakTicks <= 0) {
      state.waveBreakTicks = SIM.waveBreakTicks;
      state.events.push({ type: 'wave_clear', wave: state.waveIndex + 1 });
    }
    state.waveBreakTicks--;
    if (state.waveBreakTicks <= 0) {
      state.waveBreakTicks = 0;
      this.advance(state);
    }
  }

  private advance(state: GameState): void {
    const next = state.waveIndex + 1;
    if (next >= state.waves.length) {
      state.wavesExhausted = true;
      return;
    }
    state.waveIndex = next;
    this.spawnWave(state, state.waves[next]!);
  }

  private spawnWave(state: GameState, wave: WaveDef): void {
    for (const [px, py] of wave) {
      const weapon = makeWeapon(ENEMY_BLASTER);
      weapon.cooldownTicks = state.aiPrng.nextInt(ENEMY_BLASTER.fireRateTicks); // fire-phase jitter
      state.enemies.push({
        id: state.nextId(),
        faction: 'enemy',
        gx: toFp(px),
        gy: toFp(py),
        z: toFp(0),
        vx: toFp(0),
        vy: toFp(0),
        vz: toFp(0),
        facing: 0 as GameState['enemies'][number]['facing'],
        hp: SIM.enemy.maxHp,
        maxHp: SIM.enemy.maxHp,
        radius: SIM.enemy.radius,
        alive: true,
        weapon,
        firing: false,
      });
    }
  }
}
