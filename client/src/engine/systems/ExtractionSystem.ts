/**
 * Step 12 — Extraction (design/05, ROADMAP 1.4/1.5, PvE only). A complete no-op
 * unless `state.floorsEnabled` (EngineConfig.floors was provided) — every config
 * that predates this feature leaves it doing nothing, every tick, forever. That is
 * why this new step needed no ENGINE_VERSION bump when first added: it is exactly as
 * inert for an old config as the AABB wall-collision loops (ROADMAP 1.2) are when
 * state.walls is empty.
 *
 * The per-floor checkpoint is "this floor's waves are exhausted and no enemies
 * remain" (the same condition WinConditionSystem used to auto-win on when floors
 * are disabled — see its own floorsEnabled guard). At that point:
 *   - the LAST floor has no descend option: reaching it auto-resolves as EXTRACT
 *     (design/05 "the last floor's boss room IS its extraction room" — the boss
 *     fight was the challenge, walking through the portal after is automatic).
 *   - any other floor offers a choice via player 0's explicit portal-popup pick
 *     (single-player only; co-op's shared decision is a Phase 3 concern):
 *     CONFIRM_EXTRACT banks and ends the run, CONFIRM_DESCEND banks and continues.
 *     This replaced an original hold-to-extract/tap-to-descend INTERACT gesture
 *     (design/10 legibility fix, 2026-08-02: a render-side portal + explicit two-
 *     button choice reads far better than "hold E" — ROADMAP.md always flagged the
 *     hold/tap timer as a first-pass placeholder pending exactly this).
 *
 * Both resolutions bank state.floorMaterials into state.bankedMaterials (design/05
 * "materials so far are locked in" on descend; "keep materials" on extract) — a
 * run-ending DEATH never reaches here, so the floor buffer is simply never merged,
 * which IS the "forfeit only this floor's un-banked buffer" rule, for free.
 */
import type { GameState } from '../state/GameState';

export class ExtractionSystem {
  tick(state: GameState): void {
    if (!state.floorsEnabled) return;
    if (state.phase === 'gameover') return;
    if (!(state.wavesExhausted && state.enemies.length === 0)) return;

    // Last-floor test differs by mode: the flat-`floors` list counts extraFloors; a
    // generated dungeon counts its configured floorCount (design/05 "the last floor's
    // boss room IS its extraction room" — reaching it auto-resolves EXTRACT either way).
    const isLastFloor = state.dungeonEnabled
      ? state.floorIndex >= state.dungeonConfig!.floorCount - 1
      : state.floorIndex >= state.extraFloors.length;
    if (isLastFloor) {
      this.resolveExtract(state);
      return;
    }

    const p = state.players[0];
    if (!p || !p.alive) return;
    if (p.confirmExtract) this.resolveExtract(state);
    else if (p.confirmDescend) this.resolveDescend(state);
  }

  /** Merge this floor's buffer into the run's carry-out bag and reset it. Insertion
   * order (= pickup order) is deterministic, so the merge is replay-stable (design/06). */
  private bankFloorMaterials(state: GameState): void {
    for (const [id, qty] of Object.entries(state.floorMaterials)) {
      state.bankedMaterials[id] = (state.bankedMaterials[id] ?? 0) + (qty ?? 0);
    }
    state.floorMaterials = {};
  }

  private resolveExtract(state: GameState): void {
    this.bankFloorMaterials(state);
    state.winner = 0; // single-player: player id 0 (matches the old wavesExhausted win)
    state.phase = 'gameover';
    state.events.push({ type: 'win', winner: 0 });
  }

  private resolveDescend(state: GameState): void {
    this.bankFloorMaterials(state);
    state.floorIndex++;
    if (state.dungeonEnabled) {
      // The next floor's stages are generated lazily by SpawnSystem when it sees a fresh
      // floor (roomIndex -1) — the single owner of roomgenPrng draws, same as floor 0.
      // Just reset the room cursor; the current geometry stays until stage 0 loads.
      state.roomIndex = -1;
      state.floorStages = [];
      state.floorLayout = [];
    } else {
      state.waves = state.extraFloors[state.floorIndex - 1]!;
    }
    state.waveIndex = -1;
    state.waveBreakTicks = 0;
    state.wavesExhausted = false;
    state.pickups.length = 0; // uncollected drops don't carry to the next floor
    state.events.push({ type: 'descend', floorIndex: state.floorIndex });
  }
}
