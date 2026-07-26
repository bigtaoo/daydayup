// Adapter so RoomCanvas can edit either a whole PvE RoomPiece or one PvP
// ArenaRoom (in-place, local coordinates) through one interface — this is what
// "one shared room-detail component, two schemas" actually means in code.
import type { AabbGrid, PillarGrid, Point, PropPlacement, SpawnPoint, WaveScript } from '@dd/engine';
import type { CellTrait, LootMarker } from '@dd/engine/content/arenas';
import { RoomDocument } from '../state/RoomDocument';
import { ArenaDocument } from '../state/ArenaDocument';

export type ToolKind =
  | 'select'
  | 'solid'
  | 'pillar'
  | 'prop'
  | 'playerSpawn'
  | 'enemySpawn'
  | 'cellTrait'
  | 'lootMarker';

export type SelectionLayer =
  | 'solids'
  | 'pillars'
  | 'props'
  | 'playerSpawns'
  | 'enemySpawns'
  | 'cellTraits'
  | 'lootMarkers';

export interface Selection {
  layer: SelectionLayer;
  index: number;
}

export interface RoomEditTarget {
  readonly kind: 'pve' | 'pvp';
  getSize(): { w: number; h: number };
  getSolids(): AabbGrid[];
  getPillars(): PillarGrid[];
  getProps(): PropPlacement[];
  /** PvP rooms have no per-room player spawns (design/15 — those live once at
   * ArenaMap.spawns instead); always returns [] for a pvp target. */
  getPlayerSpawns(): Point[];
  getEnemySpawns(): SpawnPoint[];
  getEncounter(): WaveScript | undefined;
  /** Lazily initializes `encounter = {entries: []}` if absent, returning the (now
   * definitely present) WaveScript — used by "add wave entry" when there wasn't
   * one yet. */
  ensureEncounter(): WaveScript;
  /** Always [] for a pve target — PvE RoomPiece has no cellTraits field. */
  getCellTraits(): CellTrait[];
  /** Always [] for a pve target — PvE RoomPiece has no lootMarkers field. */
  getLootMarkers(): LootMarker[];
  mutate(fn: () => void): void;
  on(fn: () => void): () => void;
}

let idCounter = 0;
export function nextId(prefix: string): string {
  idCounter += 1;
  return `${prefix}_${idCounter}`;
}

export class RoomPieceTarget implements RoomEditTarget {
  readonly kind = 'pve';
  constructor(private doc: RoomDocument) {}

  getSize() {
    return this.doc.piece.sizeGrid;
  }
  getSolids() {
    return this.doc.piece.solids;
  }
  getPillars() {
    return (this.doc.piece.pillars ??= []);
  }
  getProps() {
    return (this.doc.piece.props ??= []);
  }
  getPlayerSpawns() {
    return this.doc.piece.spawns.player;
  }
  getEnemySpawns() {
    return this.doc.piece.spawns.enemy;
  }
  getEncounter() {
    return this.doc.piece.encounter;
  }
  ensureEncounter() {
    return (this.doc.piece.encounter ??= { entries: [] });
  }
  getCellTraits(): CellTrait[] {
    return [];
  }
  getLootMarkers(): LootMarker[] {
    return [];
  }
  mutate(fn: () => void) {
    this.doc.mutate(fn);
  }
  on(fn: () => void) {
    return this.doc.on(fn);
  }
}

export class ArenaRoomTarget implements RoomEditTarget {
  readonly kind = 'pvp';
  constructor(
    private doc: ArenaDocument,
    private roomId: string,
  ) {}

  private room() {
    const room = this.doc.map.rooms.find((r) => r.id === this.roomId);
    if (!room) throw new Error(`ArenaRoomTarget: room "${this.roomId}" not found`);
    return room;
  }

  getSize() {
    const r = this.room().rectGrid;
    return { w: r.w, h: r.h };
  }
  getSolids() {
    return this.room().solids;
  }
  getPillars() {
    const r = this.room();
    return (r.pillars ??= []);
  }
  getProps() {
    const r = this.room();
    return (r.props ??= []);
  }
  getPlayerSpawns(): Point[] {
    return [];
  }
  getEnemySpawns() {
    const r = this.room();
    return (r.spawns ??= []);
  }
  getEncounter() {
    return this.room().encounter;
  }
  ensureEncounter() {
    const r = this.room();
    return (r.encounter ??= { entries: [] });
  }
  getCellTraits() {
    const r = this.room();
    return (r.cellTraits ??= []);
  }
  getLootMarkers() {
    const r = this.room();
    return (r.lootMarkers ??= []);
  }
  mutate(fn: () => void) {
    this.doc.mutate(fn);
  }
  on(fn: () => void) {
    return this.doc.on(fn);
  }
}
