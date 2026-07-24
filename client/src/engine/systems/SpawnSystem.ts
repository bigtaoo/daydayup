/**
 * Step 10 — Spawns (PvE only). A scripted wave director: spawn the first wave
 * immediately, then, once a wave is fully cleared, run a short break before the
 * next; when the last wave is dispatched, flag wavesExhausted for WinCondition.
 * Enemies spawn with an aiPrng-seeded initial cooldown so their fire phases don't
 * lock-step (replaces the demo's non-deterministic `gx % 1` jitter).
 *
 * Ports Game.ts updateWaves()/spawnNextWave() + WaveDirector, float px → grid-fp.
 * Wave positions still arrive via EngineConfig (px, converted with pxToFp); the
 * enemy blueprint (HP / footprint / loadout) now lives in content/enemies.ts (09).
 */
import { toFp } from '../math/fixed';
import { SIM } from '../sim.config';
import { pxToFp } from '../content/convert';
import { freshStatus } from '../content/damage';
import { makeWeapon } from '../content/weapons';
import { BASIC_ENEMY, ENEMY_BLUEPRINTS } from '../content/enemies';
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
    for (const [px, py, type] of wave) {
      // Resolve the blueprint by the entry's type (missing/unknown → basic, design/09
      // forward-compat). The aiPrng draw stays one-per-spawn regardless of variant,
      // so a wave's fire-phase jitter is unaffected by which mobs it contains.
      const bp = ENEMY_BLUEPRINTS[type ?? 'basic'] ?? BASIC_ENEMY;
      const weapon = makeWeapon(bp.weapon);
      weapon.cooldownTicks = state.aiPrng.nextInt(bp.weapon.fireRateTicks); // fire-phase jitter
      state.enemies.push({
        id: state.nextId(),
        faction: 'enemy',
        gx: pxToFp(px),
        gy: pxToFp(py),
        z: toFp(0),
        vx: toFp(0),
        vy: toFp(0),
        facing: 0 as GameState['enemies'][number]['facing'],
        hp: bp.maxHp,
        maxHp: bp.maxHp,
        shield: 0, // enemies have no shield pool (design/07 — shields are a character trait)
        maxShield: 0,
        ticksSinceHit: 0,
        radius: bp.radius,
        footprintRadius: bp.footprintRadius,
        alive: true,
        weapon,
        firing: false,
        status: freshStatus(),
        resist: bp.resist,
        tint: bp.tint,
        boss: bp.boss,
      });
    }
  }
}
