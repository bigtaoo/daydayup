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
import type { Fp } from '../math/fixed';
import { SIM } from '../sim.config';
import { pxToFp, toFpGrid } from '../content/convert';
import { freshStatus } from '../content/damage';
import { makeWeapon } from '../content/weapons';
import { BASIC_ENEMY, ENEMY_BLUEPRINTS } from '../content/enemies';
import { roomGeometry, type RoomPiece } from '../content/rooms';
import { generateFloor } from '../world/dungeon';
import type { GameState, WaveDef } from '../state/GameState';

export class SpawnSystem {
  tick(state: GameState): void {
    // Dungeon mode (ROADMAP 1.3 wired) drives spawns from the generated room sequence
    // instead of the flat wave list — a completely separate path, so every non-dungeon
    // config takes the byte-identical original code below (no ENGINE_VERSION bump).
    if (state.dungeonEnabled) return this.tickDungeon(state);

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
      this.spawnEnemyAt(state, pxToFp(px), pxToFp(py), type);
    }
  }

  /**
   * Instantiate one enemy at an already-converted (fp) position. Shared by the flat
   * wave director (px positions) and the dungeon room loader (grid positions); the
   * caller converts. Resolves the blueprint by `type` (missing/unknown → basic,
   * design/09 forward-compat); the aiPrng draw stays one-per-spawn regardless of
   * variant, so fire-phase jitter is unaffected by which mobs a wave/room contains.
   */
  private spawnEnemyAt(state: GameState, gx: Fp, gy: Fp, type?: string): void {
    const bp = ENEMY_BLUEPRINTS[type ?? 'basic'] ?? BASIC_ENEMY;
    const weapon = makeWeapon(bp.weapon);
    weapon.cooldownTicks = state.aiPrng.nextInt(bp.weapon.fireRateTicks); // fire-phase jitter
    state.enemies.push({
      id: state.nextId(),
      faction: 'enemy',
      gx,
      gy,
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

  // ── Dungeon mode (design/05/09, ROADMAP 1.3 wired live) ─────────────────────────

  /**
   * The room-by-room director. A floor is a generated `RoomPiece` sequence; one room
   * is live at a time. On entering a floor (roomIndex -1) it generates the layout and
   * loads room 0. Thereafter, when the live room is cleared (no enemies), it either
   * advances to the next room or — if that WAS the floor's capstone — raises
   * `wavesExhausted`, handing off to ExtractionSystem (step 12) exactly as the flat
   * wave director does. It never loads or advances while enemies remain, so a room is
   * "clear it to proceed" (the WaveScript timeline — staggered atTick spawns — is a
   * documented follow-up; entries spawn at room-load for now).
   */
  private tickDungeon(state: GameState): void {
    if (state.roomIndex === -1) {
      // Fresh floor: generate its rooms (the only live roomgenPrng draw site) and load
      // the first. Runs exactly once per floor — roomIndex is -1 only at run start and
      // immediately after a DESCEND (ExtractionSystem resets it).
      state.floorLayout = generateFloor(
        state.dungeonConfig!,
        state.floorIndex,
        state.roomgenPrng,
        state.roomLibrary,
      ).rooms;
      this.loadRoom(state, 0);
      return;
    }

    state.roomTick++;
    this.dispatchDueSpawns(state); // spawn any WaveScript entries now due (design/09 timing)

    // A room is cleared only once every scheduled spawn has been dispatched AND no
    // enemy remains — so a staggered encounter can't be skipped by killing its first
    // wave before the later ones appear.
    if (state.roomSpawnCursor < state.roomSchedule.length) return;
    if (state.enemies.length > 0) return;

    if (state.roomIndex >= state.floorLayout.length - 1) {
      // The floor's capstone room is cleared → checkpoint. ExtractionSystem resolves
      // EXTRACT/DESCEND (or auto-EXTRACT on the last floor). Idempotent while it waits.
      state.wavesExhausted = true;
      return;
    }

    this.loadRoom(state, state.roomIndex + 1); // advance to the next room in this floor
  }

  /**
   * Make room `idx` of the current floor live: swap in its collision geometry, resize
   * the world to the room, teleport the players onto its spawn points, and spawn its
   * enemies. Content-swaps the walls/obstacles arrays (never reassigns the reference,
   * so readers stay valid). Emits `room_enter` for the render layer.
   */
  private loadRoom(state: GameState, idx: number): void {
    state.roomIndex = idx;
    state.roomTick = 0; // restart the room-local clock for the WaveScript schedule
    const room = state.floorLayout[idx]!;

    const { walls, obstacles } = roomGeometry(room);
    state.walls.length = 0;
    state.walls.push(...walls);
    state.obstacles.length = 0;
    state.obstacles.push(...obstacles);

    state.worldW = toFpGrid(room.sizeGrid.w);
    state.worldH = toFpGrid(room.sizeGrid.h);

    // Teleport each player onto the room's player spawn (co-op players share spawn 0
    // if the room authored fewer points than there are players — single-player today).
    state.players.forEach((p, i) => {
      const sp = room.spawns.player[i] ?? room.spawns.player[0];
      if (sp) {
        p.gx = toFpGrid(sp.x);
        p.gy = toFpGrid(sp.y);
      }
    });

    this.buildSchedule(state, room);
    this.dispatchDueSpawns(state); // atTick-0 entries appear the tick the room loads
    state.events.push({ type: 'room_enter', floorIndex: state.floorIndex, roomIndex: idx, roomId: room.id });
  }

  /**
   * Pre-expand a room's enemies into a timed spawn schedule (design/09 WaveScript). A
   * piece with an `encounter` uses its entries — each becomes `count` timed events
   * (copy j at `atTick + j*spacingTicks`, so a burst can trickle in). A piece without
   * one falls back to every enemy spawn point at tick 0 (an all-at-once room — the
   * common hand-authored case). Sorted by (atTick, authoring order) so dispatch order
   * — and thus the aiPrng draw order in spawnEnemyAt — is deterministic (design/06).
   */
  private buildSchedule(state: GameState, room: RoomPiece): void {
    const sched: { atTick: number; spawnPoint: number; enemyType?: string; seq: number }[] = [];
    let seq = 0;
    if (room.encounter) {
      for (const entry of room.encounter.entries) {
        const spacing = entry.spacingTicks ?? 0;
        for (let j = 0; j < entry.count; j++) {
          sched.push({ atTick: entry.atTick + j * spacing, spawnPoint: entry.spawnPoint, enemyType: entry.enemyType, seq: seq++ });
        }
      }
    } else {
      for (let i = 0; i < room.spawns.enemy.length; i++) {
        sched.push({ atTick: 0, spawnPoint: i, enemyType: room.spawns.enemy[i]!.type, seq: seq++ });
      }
    }
    sched.sort((a, b) => (a.atTick - b.atTick) || (a.seq - b.seq));
    state.roomSchedule = sched.map(({ atTick, spawnPoint, enemyType }) => ({ atTick, spawnPoint, enemyType }));
    state.roomSpawnCursor = 0;
  }

  /** Spawn every scheduled entry whose `atTick` has arrived (relative to room load).
   * The schedule is sorted, so a single forward cursor suffices. A spawn point index
   * out of range is skipped (forward-compat, design/09). */
  private dispatchDueSpawns(state: GameState): void {
    const room = state.floorLayout[state.roomIndex];
    if (!room) return;
    while (state.roomSpawnCursor < state.roomSchedule.length) {
      const ev = state.roomSchedule[state.roomSpawnCursor]!;
      if (ev.atTick > state.roomTick) break;
      const sp = room.spawns.enemy[ev.spawnPoint];
      if (sp) this.spawnEnemyAt(state, toFpGrid(sp.x), toFpGrid(sp.y), ev.enemyType);
      state.roomSpawnCursor++;
    }
  }
}
