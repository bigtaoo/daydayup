/**
 * RoomEditTarget adapters (`RoomPieceTarget`/`ArenaRoomTarget`) — pure logic over a
 * real `RoomDocument`/`ArenaDocument` (constructed via their own `blank()` statics,
 * per the task's "exercise the real integration" instruction rather than
 * hand-rolled fakes), covering the `??=` lazy-init fields and `mutate`/`on`
 * delegation to the underlying document.
 */
import { describe, it, expect } from 'vitest';
import type { ArenaMap, ArenaRoom } from '@dd/engine/content/arenas';
import { RoomDocument } from '../state/RoomDocument';
import { ArenaDocument } from '../state/ArenaDocument';
import { RoomPieceTarget, ArenaRoomTarget } from './RoomEditTarget';

function blankRoom(id: string): ArenaRoom {
  return { id, rectGrid: { x: 0, y: 0, w: 10, h: 8 }, solids: [] };
}

function arenaWithRoom(room: ArenaRoom): ArenaMap {
  const map = ArenaDocument.blank('arena_1');
  map.rooms.push(room);
  return map;
}

describe('RoomPieceTarget', () => {
  it('kind is "pve"', () => {
    const target = new RoomPieceTarget(new RoomDocument(RoomDocument.blank('room_1')));
    expect(target.kind).toBe('pve');
  });

  it('getSize returns the piece sizeGrid', () => {
    const doc = new RoomDocument(RoomDocument.blank('room_1'));
    const target = new RoomPieceTarget(doc);
    expect(target.getSize()).toEqual({ w: 20, h: 20 });
  });

  it('getSolids returns the live piece.solids array', () => {
    const doc = new RoomDocument(RoomDocument.blank('room_1'));
    doc.piece.solids.push({ x: 1, y: 1, w: 2, h: 2 });
    const target = new RoomPieceTarget(doc);
    expect(target.getSolids()).toEqual([{ x: 1, y: 1, w: 2, h: 2 }]);
  });

  it('getPillars lazily initializes piece.pillars to [] and returns the live array', () => {
    const doc = new RoomDocument(RoomDocument.blank('room_1'));
    expect(doc.piece.pillars).toBeUndefined();
    const target = new RoomPieceTarget(doc);
    const pillars = target.getPillars();
    expect(pillars).toEqual([]);
    expect(doc.piece.pillars).toBe(pillars); // same array now installed on the piece
    pillars.push({ center: { x: 5, y: 5 }, radius: 1 });
    expect(doc.piece.pillars).toEqual([{ center: { x: 5, y: 5 }, radius: 1 }]);
  });

  it('getPillars does not clobber an already-present pillars array', () => {
    const doc = new RoomDocument(RoomDocument.blank('room_1'));
    doc.piece.pillars = [{ center: { x: 1, y: 1 }, radius: 2 }];
    const target = new RoomPieceTarget(doc);
    expect(target.getPillars()).toBe(doc.piece.pillars);
  });

  it('getProps lazily initializes piece.props to [] and returns the live array', () => {
    const doc = new RoomDocument(RoomDocument.blank('room_1'));
    expect(doc.piece.props).toBeUndefined();
    const target = new RoomPieceTarget(doc);
    const props = target.getProps();
    expect(props).toEqual([]);
    expect(doc.piece.props).toBe(props);
  });

  it('getPlayerSpawns/getEnemySpawns read piece.spawns.player/enemy', () => {
    const doc = new RoomDocument(RoomDocument.blank('room_1'));
    doc.piece.spawns.player.push({ x: 1, y: 1 });
    doc.piece.spawns.enemy.push({ x: 2, y: 2, type: 'basic' });
    const target = new RoomPieceTarget(doc);
    expect(target.getPlayerSpawns()).toEqual([{ x: 1, y: 1 }]);
    expect(target.getEnemySpawns()).toEqual([{ x: 2, y: 2, type: 'basic' }]);
  });

  it('getEncounter is undefined until ensureEncounter is called', () => {
    const doc = new RoomDocument(RoomDocument.blank('room_1'));
    const target = new RoomPieceTarget(doc);
    expect(target.getEncounter()).toBeUndefined();
  });

  it('ensureEncounter lazily creates {entries: []} and is idempotent', () => {
    const doc = new RoomDocument(RoomDocument.blank('room_1'));
    const target = new RoomPieceTarget(doc);
    const first = target.ensureEncounter();
    expect(first).toEqual({ entries: [] });
    expect(target.getEncounter()).toBe(first);
    const second = target.ensureEncounter();
    expect(second).toBe(first); // does not replace an existing encounter
  });

  it('getCellTraits and getLootMarkers are always [] — PvE RoomPiece has no such fields', () => {
    const doc = new RoomDocument(RoomDocument.blank('room_1'));
    const target = new RoomPieceTarget(doc);
    expect(target.getCellTraits()).toEqual([]);
    expect(target.getLootMarkers()).toEqual([]);
  });

  it('mutate delegates to the underlying RoomDocument.mutate', () => {
    const doc = new RoomDocument(RoomDocument.blank('room_1'));
    const target = new RoomPieceTarget(doc);
    target.mutate(() => {
      target.getSolids().push({ x: 9, y: 9, w: 1, h: 1 });
    });
    expect(doc.piece.solids).toEqual([{ x: 9, y: 9, w: 1, h: 1 }]);
  });

  it('on delegates to the underlying RoomDocument.on, including unsubscribe', () => {
    const doc = new RoomDocument(RoomDocument.blank('room_1'));
    const target = new RoomPieceTarget(doc);
    let calls = 0;
    const off = target.on(() => {
      calls += 1;
    });
    target.mutate(() => {});
    expect(calls).toBe(1);
    off();
    target.mutate(() => {});
    expect(calls).toBe(1);
  });
});

describe('ArenaRoomTarget', () => {
  it('kind is "pvp"', () => {
    const room = blankRoom('room_1');
    const doc = new ArenaDocument(arenaWithRoom(room));
    const target = new ArenaRoomTarget(doc, 'room_1');
    expect(target.kind).toBe('pvp');
  });

  it('throws a descriptive error when the room id is not found', () => {
    const doc = new ArenaDocument(ArenaDocument.blank('arena_1'));
    const target = new ArenaRoomTarget(doc, 'missing_room');
    expect(() => target.getSize()).toThrow('ArenaRoomTarget: room "missing_room" not found');
  });

  it('getSize derives {w, h} from the room rectGrid', () => {
    const room = blankRoom('room_1');
    const doc = new ArenaDocument(arenaWithRoom(room));
    const target = new ArenaRoomTarget(doc, 'room_1');
    expect(target.getSize()).toEqual({ w: 10, h: 8 });
  });

  it('getSolids returns the live room.solids array', () => {
    const room = blankRoom('room_1');
    room.solids.push({ x: 1, y: 1, w: 2, h: 2 });
    const doc = new ArenaDocument(arenaWithRoom(room));
    const target = new ArenaRoomTarget(doc, 'room_1');
    expect(target.getSolids()).toEqual([{ x: 1, y: 1, w: 2, h: 2 }]);
  });

  it('getPillars lazily initializes room.pillars to [] and returns the live array', () => {
    const room = blankRoom('room_1');
    const doc = new ArenaDocument(arenaWithRoom(room));
    const target = new ArenaRoomTarget(doc, 'room_1');
    expect(room.pillars).toBeUndefined();
    const pillars = target.getPillars();
    expect(pillars).toEqual([]);
    expect(room.pillars).toBe(pillars);
  });

  it('getProps lazily initializes room.props to [] and returns the live array', () => {
    const room = blankRoom('room_1');
    const doc = new ArenaDocument(arenaWithRoom(room));
    const target = new ArenaRoomTarget(doc, 'room_1');
    expect(room.props).toBeUndefined();
    const props = target.getProps();
    expect(props).toEqual([]);
    expect(room.props).toBe(props);
  });

  it('getPlayerSpawns is always [] — PvP per-room player spawns live on ArenaMap.spawns instead', () => {
    const room = blankRoom('room_1');
    const doc = new ArenaDocument(arenaWithRoom(room));
    const target = new ArenaRoomTarget(doc, 'room_1');
    expect(target.getPlayerSpawns()).toEqual([]);
  });

  it('getEnemySpawns lazily initializes room.spawns to [] and returns the live array', () => {
    const room = blankRoom('room_1');
    const doc = new ArenaDocument(arenaWithRoom(room));
    const target = new ArenaRoomTarget(doc, 'room_1');
    expect(room.spawns).toBeUndefined();
    const spawns = target.getEnemySpawns();
    expect(spawns).toEqual([]);
    expect(room.spawns).toBe(spawns);
  });

  it('getEncounter is undefined until ensureEncounter is called, and ensureEncounter is idempotent', () => {
    const room = blankRoom('room_1');
    const doc = new ArenaDocument(arenaWithRoom(room));
    const target = new ArenaRoomTarget(doc, 'room_1');
    expect(target.getEncounter()).toBeUndefined();
    const first = target.ensureEncounter();
    expect(first).toEqual({ entries: [] });
    expect(target.getEncounter()).toBe(first);
    expect(target.ensureEncounter()).toBe(first);
  });

  it('getCellTraits lazily initializes room.cellTraits to [] and returns the live array', () => {
    const room = blankRoom('room_1');
    const doc = new ArenaDocument(arenaWithRoom(room));
    const target = new ArenaRoomTarget(doc, 'room_1');
    expect(room.cellTraits).toBeUndefined();
    const traits = target.getCellTraits();
    expect(traits).toEqual([]);
    expect(room.cellTraits).toBe(traits);
  });

  it('getLootMarkers lazily initializes room.lootMarkers to [] and returns the live array', () => {
    const room = blankRoom('room_1');
    const doc = new ArenaDocument(arenaWithRoom(room));
    const target = new ArenaRoomTarget(doc, 'room_1');
    expect(room.lootMarkers).toBeUndefined();
    const markers = target.getLootMarkers();
    expect(markers).toEqual([]);
    expect(room.lootMarkers).toBe(markers);
  });

  it('mutate delegates to the underlying ArenaDocument.mutate', () => {
    const room = blankRoom('room_1');
    const doc = new ArenaDocument(arenaWithRoom(room));
    const target = new ArenaRoomTarget(doc, 'room_1');
    target.mutate(() => {
      target.getSolids().push({ x: 3, y: 3, w: 1, h: 1 });
    });
    expect(room.solids).toEqual([{ x: 3, y: 3, w: 1, h: 1 }]);
  });

  it('on delegates to the underlying ArenaDocument.on, including unsubscribe', () => {
    const room = blankRoom('room_1');
    const doc = new ArenaDocument(arenaWithRoom(room));
    const target = new ArenaRoomTarget(doc, 'room_1');
    let calls = 0;
    const off = target.on(() => {
      calls += 1;
    });
    target.mutate(() => {});
    expect(calls).toBe(1);
    off();
    target.mutate(() => {});
    expect(calls).toBe(1);
  });
});
