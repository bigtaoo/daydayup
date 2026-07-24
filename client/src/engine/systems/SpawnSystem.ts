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

    if (state.enemies.length > 0) return; // current room not yet cleared

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

    this.spawnRoomEnemies(state, room);
    state.events.push({ type: 'room_enter', floorIndex: state.floorIndex, roomIndex: idx, roomId: room.id });
  }

  /**
   * Spawn a room's enemies. If the piece authored a WaveScript encounter, its entries
   * drive the spawn (each entry references a `spawns.enemy` index); otherwise every
   * enemy spawn point spawns one mob of its authored type. The entries' TIMING
   * (atTick / spacingTicks) is not yet honored — every entry spawns at room-load — so
   * a scripted room currently behaves like an all-at-once wave (follow-up: a tick-
   * cursor WaveDirector, the shape design/09 locked WaveEntry for).
   */
  private spawnRoomEnemies(state: GameState, room: RoomPiece): void {
    if (room.encounter) {
      for (const entry of room.encounter.entries) {
        const sp = room.spawns.enemy[entry.spawnPoint];
        if (!sp) continue; // out-of-range index → skip (forward-compat, design/09)
        for (let i = 0; i < entry.count; i++) {
          this.spawnEnemyAt(state, toFpGrid(sp.x), toFpGrid(sp.y), entry.enemyType);
        }
      }
    } else {
      for (const sp of room.spawns.enemy) {
        this.spawnEnemyAt(state, toFpGrid(sp.x), toFpGrid(sp.y), sp.type);
      }
    }
  }
}
