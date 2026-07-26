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
import { rollArenaDrop } from '../content/drops';
import { cosFp, BRAD_FULL } from '../math/trig';
import { roomGeometry, type RoomPiece, type WaveScript } from '../content/rooms';
import type { ArenaRoom } from '../content/arenas';
import { generateFloor } from '../world/dungeon';
import { ENEMY_TEAM_ID } from '../state/entities';
import type { PickupItem } from '../state/entities';
import type { ArenaRoomRuntime, GameState, WaveDef } from '../state/GameState';

/** One expanded, timed spawn entry — shared shape between dungeon's single global
 * schedule and the arena's per-room schedules (ArenaRoomRuntime.schedule). */
type ScheduleEntry = { atTick: number; spawnPoint: number; enemyType?: string };

/**
 * Expand a room's `encounter` (design/09 WaveScript) into a timed spawn schedule —
 * each entry becomes `count` copies (atTick + j*spacingTicks, so a burst can
 * trickle in), sorted by (atTick, authoring order) for deterministic dispatch
 * (and thus deterministic aiPrng draw order in spawnEnemyAt). A room with no
 * `encounter` falls back to every spawn point at tick 0 (an all-at-once room —
 * the common hand-authored case). Shared by both PvE dungeon rooms and PvP arena
 * rooms — same WaveScript vocabulary, different spawn-point source.
 */
function expandEncounter(
  encounter: WaveScript | undefined,
  spawnCount: number,
  typeAt: (i: number) => string | undefined,
): ScheduleEntry[] {
  const sched: (ScheduleEntry & { seq: number })[] = [];
  let seq = 0;
  if (encounter) {
    for (const entry of encounter.entries) {
      const spacing = entry.spacingTicks ?? 0;
      for (let j = 0; j < entry.count; j++) {
        sched.push({ atTick: entry.atTick + j * spacing, spawnPoint: entry.spawnPoint, enemyType: entry.enemyType, seq: seq++ });
      }
    }
  } else {
    for (let i = 0; i < spawnCount; i++) {
      sched.push({ atTick: 0, spawnPoint: i, enemyType: typeAt(i), seq: seq++ });
    }
  }
  sched.sort((a, b) => a.atTick - b.atTick || a.seq - b.seq);
  return sched.map(({ atTick, spawnPoint, enemyType }) => ({ atTick, spawnPoint, enemyType }));
}

export class SpawnSystem {
  tick(state: GameState): void {
    // Dungeon mode (ROADMAP 1.3 wired) drives spawns from the generated room sequence
    // instead of the flat wave list — a completely separate path, so every non-dungeon
    // config takes the byte-identical original code below (no ENGINE_VERSION bump).
    if (state.dungeonEnabled) return this.tickDungeon(state);

    // PvP arena mode (design/15, ROADMAP 4.3) — every room is already co-resident
    // (4.2b); this only lazily activates each room's encounter/loot the tick a
    // player first enters it (perf-only, NOT information-hiding — see content/arenas.ts
    // LootMarker's doc comment and design/15's honest anti-cheat-limit note).
    if (state.zoneEnabled) return this.tickArena(state);

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
      teamId: ENEMY_TEAM_ID, // hostile to every player team (design/15), never to other AI
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
      // Fresh floor: generate its stage plan (the only live roomgenPrng draw site) and
      // enter stage 0. Runs exactly once per floor — roomIndex is -1 only at run start
      // and immediately after a DESCEND (ExtractionSystem resets it).
      state.floorStages = generateFloor(
        state.dungeonConfig!,
        state.floorIndex,
        state.roomgenPrng,
        state.roomLibrary,
      ).stages;
      state.floorLayout = []; // reset the resolved path for the new floor
      this.enterStage(state, 0);
      return;
    }

    state.roomTick++;
    this.dispatchDueSpawns(state); // spawn any WaveScript entries now due (design/09 timing)

    // A room is cleared only once every scheduled spawn has been dispatched AND no
    // enemy remains — so a staggered encounter can't be skipped by killing its first
    // wave before the later ones appear.
    if (state.roomSpawnCursor < state.roomSchedule.length) return;
    if (state.enemies.length > 0) return;

    if (state.roomIndex >= state.floorStages.length - 1) {
      // The floor's capstone room is cleared → checkpoint. ExtractionSystem resolves
      // EXTRACT/DESCEND (or auto-EXTRACT on the last floor). Idempotent while it waits.
      state.wavesExhausted = true;
      return;
    }

    this.enterStage(state, state.roomIndex + 1); // advance to the next stage in this floor
  }

  /**
   * Resolve which candidate of stage `idx` to enter, append it to the resolved path
   * (so floorLayout[roomIndex] is always the live room), and load it. A linear stage
   * has one option; a branching stage's choice comes from chooseBranch.
   */
  private enterStage(state: GameState, idx: number): void {
    const candidates = state.floorStages[idx] ?? [];
    const room = candidates[this.chooseBranch(state, candidates)] ?? candidates[0];
    if (!room) return; // empty stage (shouldn't happen — generateFloor never emits one)
    state.floorLayout = [...state.floorLayout, room];
    this.loadRoom(state, idx, room);
  }

  /**
   * Pick which candidate to enter at a branching stage (design/05 reward-choice). A
   * single-option (linear) stage returns 0; for two, aiming west takes the first and
   * east the second; for more, the aim circle splits into equal sectors. Resolved from
   * player 0's aim — deterministic (facing is in the command stream) and needs no new
   * input. A door/portal selection UX is a presentation follow-up (design/10).
   */
  private chooseBranch(state: GameState, candidates: readonly RoomPiece[]): number {
    const n = candidates.length;
    if (n <= 1) return 0;
    const facing = state.players[0]?.facing ?? 0;
    if (n === 2) return cosFp(facing) < 0 ? 0 : 1;
    const frac = (((facing % BRAD_FULL) + BRAD_FULL) % BRAD_FULL) / BRAD_FULL;
    return Math.min(n - 1, Math.floor(frac * n));
  }

  /**
   * Make room `idx` of the current floor live: swap in its collision geometry, resize
   * the world to the room, teleport the players onto its spawn points, and spawn its
   * enemies. Content-swaps the walls/obstacles arrays (never reassigns the reference,
   * so readers stay valid). Emits `room_enter` for the render layer.
   */
  private loadRoom(state: GameState, idx: number, room: RoomPiece): void {
    state.roomIndex = idx;
    state.roomTick = 0; // restart the room-local clock for the WaveScript schedule

    const { walls, obstacles } = roomGeometry(room);
    state.walls.length = 0;
    state.walls.push(...walls);
    state.obstacles.length = 0;
    state.obstacles.push(...obstacles);
    state.rebuildSpatialIndex();

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

  /** Pre-expand a room's enemies into a timed spawn schedule — `expandEncounter`
   * above does the actual work; this just points it at a dungeon RoomPiece's
   * spawn-point source and stashes the result in the (single, global — one room
   * live at a time) dungeon schedule fields. */
  private buildSchedule(state: GameState, room: RoomPiece): void {
    state.roomSchedule = expandEncounter(room.encounter, room.spawns.enemy.length, (i) => room.spawns.enemy[i]?.type);
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

  // ── PvP arena mode (design/15, ROADMAP 4.3) ─────────────────────────────────────

  /**
   * Every arena room is already co-resident (4.2b) — this just lazily activates
   * each room's encounter + loot the tick a player's cached `roomId`
   * (EnvironmentSystem, step 8b — already fresh this tick, since it runs before
   * this step) first matches it, then dispatches whatever of its schedule is due.
   * An already-activated room only needs its own local clock ticked forward.
   */
  private tickArena(state: GameState): void {
    const map = state.arenaMap;
    if (!map) return;
    map.rooms.forEach((room, i) => {
      const rt = state.arenaRoomRuntime[i];
      if (!rt) return;
      if (!rt.activated) {
        const entered = state.players.some((p) => p.alive && p.roomId === room.id);
        if (!entered) return;
        rt.activated = true;
        rt.roomTick = 0;
        rt.schedule = expandEncounter(room.encounter, room.spawns?.length ?? 0, (idx) => room.spawns?.[idx]?.type);
        rt.cursor = 0;
        if (!rt.lootSpawned) {
          this.spawnArenaLoot(state, room);
          rt.lootSpawned = true;
        }
      } else {
        rt.roomTick++;
      }
      this.dispatchArenaSpawns(state, room, rt);
    });
  }

  /** Same dispatch shape as the dungeon's `dispatchDueSpawns`, just reading one
   * room's own runtime instead of the single global schedule — every arena room
   * runs its own independent clock/cursor since they're all co-resident at once. */
  private dispatchArenaSpawns(state: GameState, room: ArenaRoom, rt: ArenaRoomRuntime): void {
    const spawns = room.spawns ?? [];
    while (rt.cursor < rt.schedule.length) {
      const ev = rt.schedule[rt.cursor]!;
      if (ev.atTick > rt.roomTick) break;
      const sp = spawns[ev.spawnPoint];
      if (sp) this.spawnEnemyAt(state, toFpGrid(sp.x + room.rectGrid.x), toFpGrid(sp.y + room.rectGrid.y), ev.enemyType);
      rt.cursor++;
    }
  }

  /**
   * Spawn one pickup per `lootMarker`, once, the tick its room activates — the
   * arena's own drop table (design/15, ROADMAP 4.3: "same drop model as PvE, zero
   * account connection" — never a `material`). `tableId` isn't differentiated yet
   * (content/arenas.ts `LootMarker`'s doc comment: the real per-table catalog is
   * still "to design").
   */
  private spawnArenaLoot(state: GameState, room: ArenaRoom): void {
    for (const marker of room.lootMarkers ?? []) {
      const drop = rollArenaDrop(state.dropPrng);
      const item: PickupItem = {
        id: state.nextId(),
        kind: drop.kind,
        gx: toFpGrid(marker.point.x + room.rectGrid.x),
        gy: toFpGrid(marker.point.y + room.rectGrid.y),
        spawnTick: state.tick,
        alive: true,
      };
      if (drop.kind === 'weapon') item.weaponId = drop.weaponId;
      if (drop.kind === 'buff') item.buffId = drop.buffId;
      state.pickups.push(item);
    }
  }
}
