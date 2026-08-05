import { describe, it, expect } from 'vitest';
import { visibleHost, onRoomCanvas, roomToolsForMode, type ArenaView } from './modeLogic';

const MAP: ArenaView = { kind: 'map' };
const ROOM: ArenaView = { kind: 'room', roomId: 'r1' };

describe('visibleHost', () => {
  it('roomLibrary always shows the room canvas, regardless of arenaView', () => {
    expect(visibleHost('roomLibrary', MAP)).toBe('room');
    expect(visibleHost('roomLibrary', ROOM)).toBe('room');
  });

  it('dungeonFloor always shows the dungeon-floor canvas, regardless of arenaView', () => {
    expect(visibleHost('dungeonFloor', MAP)).toBe('dungeonFloor');
    expect(visibleHost('dungeonFloor', ROOM)).toBe('dungeonFloor');
  });

  it('arena shows the arena canvas when arenaView is "map"', () => {
    expect(visibleHost('arena', MAP)).toBe('arena');
  });

  it('arena shows the (shared) room canvas when drilled into a room', () => {
    expect(visibleHost('arena', ROOM)).toBe('room');
  });
});

describe('onRoomCanvas', () => {
  it('is true in roomLibrary mode', () => {
    expect(onRoomCanvas('roomLibrary', MAP)).toBe(true);
  });

  it('is true in arena mode drilled into a room', () => {
    expect(onRoomCanvas('arena', ROOM)).toBe(true);
  });

  it('is false in arena mode at the map level', () => {
    expect(onRoomCanvas('arena', MAP)).toBe(false);
  });

  it('is false in dungeonFloor mode', () => {
    expect(onRoomCanvas('dungeonFloor', MAP)).toBe(false);
  });
});

describe('roomToolsForMode', () => {
  const ALL_TOOLS = [
    { id: 'select', label: 'Select' },
    { id: 'solid', label: 'Solid' },
    { id: 'playerSpawn', label: 'Player Spawn' },
    { id: 'enemySpawn', label: 'Enemy Spawn' },
    { id: 'cellTrait', label: 'Cell Trait' },
    { id: 'lootMarker', label: 'Loot Marker' },
  ] as const;

  it('in roomLibrary (PvE) mode, offers playerSpawn but not cellTrait/lootMarker', () => {
    const ids = roomToolsForMode('roomLibrary', ALL_TOOLS).map((t) => t.id);
    expect(ids).toEqual(['select', 'solid', 'playerSpawn', 'enemySpawn']);
  });

  it('in arena (PvP) mode, offers cellTrait/lootMarker but not playerSpawn', () => {
    const ids = roomToolsForMode('arena', ALL_TOOLS).map((t) => t.id);
    expect(ids).toEqual(['select', 'solid', 'enemySpawn', 'cellTrait', 'lootMarker']);
  });

  it('tools with neither restriction (select/solid/enemySpawn) are always offered', () => {
    expect(roomToolsForMode('roomLibrary', ALL_TOOLS).map((t) => t.id)).toEqual(
      expect.arrayContaining(['select', 'solid', 'enemySpawn']),
    );
    expect(roomToolsForMode('arena', ALL_TOOLS).map((t) => t.id)).toEqual(
      expect.arrayContaining(['select', 'solid', 'enemySpawn']),
    );
  });
});
