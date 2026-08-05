import { describe, it, expect, vi, afterEach } from 'vitest';
import type { RoomPiece, DungeonFloorMap } from '@dd/engine';
import type { ArenaMap } from '@dd/engine/content/arenas';
import { installFakeDom, FakeElement, findAllByTag, findFieldInput, findCheckboxByLabel } from './fakeDom';
import { RoomDocument } from '../state/RoomDocument';
import { ArenaDocument } from '../state/ArenaDocument';
import { DungeonFloorDocument } from '../state/DungeonFloorDocument';
import { RoomPieceTarget, ArenaRoomTarget } from '../canvas/RoomEditTarget';
import { renderInspector } from './Inspector';

afterEach(() => vi.unstubAllGlobals());

function blankRoomPiece(): RoomPiece {
  return {
    id: 'room_1',
    sizeGrid: { w: 20, h: 20 },
    solids: [],
    spawns: { player: [], enemy: [] },
    exits: [],
  };
}

function blankArenaMap(): ArenaMap {
  return { id: 'arena_1', sizeGrid: { w: 200, h: 200 }, rooms: [], doors: [], spawns: [], eyeCandidates: [] };
}

function blankDungeonFloorMap(): DungeonFloorMap {
  return { id: 'floor_1', rooms: [], doors: [] };
}

function container(): FakeElement {
  return new FakeElement('div');
}

function h3Titles(root: FakeElement): string[] {
  return findAllByTag(root, 'h3').map((h) => h.textContent);
}

// ---------------------------------------------------------------------------
// Dispatch-by-document-kind
// ---------------------------------------------------------------------------

describe('renderInspector — dispatch by document kind', () => {
  it('roomPiece: metadata + exits + shape + encounter sections, in that order', () => {
    installFakeDom();
    const doc = new RoomDocument(blankRoomPiece());
    const target = new RoomPieceTarget(doc);
    const root = container();

    renderInspector(root as unknown as HTMLElement, { kind: 'roomPiece', doc, target, selection: null, onAfterDelete: vi.fn() });

    expect(h3Titles(root)).toEqual(['Room Piece', 'Exits', 'Selected', 'Encounter (WaveScript)']);
  });

  it('arenaRoom: a "drilled in" back-section, then shape + encounter sections', () => {
    installFakeDom();
    const arenaDoc = new ArenaDocument(blankArenaMap());
    arenaDoc.map.rooms.push({ id: 'r1', rectGrid: { x: 0, y: 0, w: 5, h: 5 }, solids: [] });
    const target = new ArenaRoomTarget(arenaDoc, 'r1');
    const root = container();
    const onBack = vi.fn();

    renderInspector(root as unknown as HTMLElement, { kind: 'arenaRoom', target, selection: null, onBack, onAfterDelete: vi.fn() });

    expect(h3Titles(root)).toEqual(['Arena Room (drilled in)', 'Selected', 'Encounter (WaveScript)']);
    const backBtn = findAllByTag(root, 'button').find((b) => b.textContent === '← Back to arena map')!;
    backBtn.onclick!();
    expect(onBack).toHaveBeenCalledTimes(1);
  });

  it('arenaMap: map metadata + selection sections, no encounter table', () => {
    installFakeDom();
    const doc = new ArenaDocument(blankArenaMap());
    const root = container();

    renderInspector(root as unknown as HTMLElement, { kind: 'arenaMap', doc, selection: null, onDrillDown: vi.fn() });

    expect(h3Titles(root)).toEqual(['Arena Map', 'Selected']);
  });

  it('dungeonFloor: floor metadata + selection sections, no encounter table', () => {
    installFakeDom();
    const doc = new DungeonFloorDocument(blankDungeonFloorMap());
    const root = container();

    renderInspector(root as unknown as HTMLElement, { kind: 'dungeonFloor', doc, library: [], selection: null, onAfterDelete: vi.fn() });

    expect(h3Titles(root)).toEqual(['Dungeon Floor', 'Selected']);
  });
});

// ---------------------------------------------------------------------------
// roomPiece — representative edit flows
// ---------------------------------------------------------------------------

describe('renderInspector — roomPiece edit flows', () => {
  it('editing the id field mutates the piece', () => {
    installFakeDom();
    const piece = blankRoomPiece();
    const doc = new RoomDocument(piece);
    const target = new RoomPieceTarget(doc);
    const root = container();
    renderInspector(root as unknown as HTMLElement, { kind: 'roomPiece', doc, target, selection: null, onAfterDelete: vi.fn() });

    const idInput = findFieldInput(root, 'id');
    idInput.value = 'room_renamed';
    idInput.onchange!();

    expect(piece.id).toBe('room_renamed');
  });

  it('checking an exit edge adds it; unchecking removes it', () => {
    installFakeDom();
    const piece = blankRoomPiece();
    const doc = new RoomDocument(piece);
    const target = new RoomPieceTarget(doc);
    const root = container();
    renderInspector(root as unknown as HTMLElement, { kind: 'roomPiece', doc, target, selection: null, onAfterDelete: vi.fn() });

    const northCheckbox = findCheckboxByLabel(root, 'north');
    northCheckbox.checked = true;
    northCheckbox.onchange!();
    expect(piece.exits).toEqual([{ edge: 'north' }]);

    northCheckbox.checked = false;
    northCheckbox.onchange!();
    expect(piece.exits).toEqual([]);
  });

  it('an existing exit renders a toTag field, editing which mutates that exit', () => {
    installFakeDom();
    const piece = blankRoomPiece();
    piece.exits.push({ edge: 'south', toTag: 'old' });
    const doc = new RoomDocument(piece);
    const target = new RoomPieceTarget(doc);
    const root = container();
    renderInspector(root as unknown as HTMLElement, { kind: 'roomPiece', doc, target, selection: null, onAfterDelete: vi.fn() });

    const toTagInput = findFieldInput(root, 'south.toTag');
    toTagInput.value = 'new';
    toTagInput.onchange!();

    expect(piece.exits[0]!.toTag).toBe('new');
  });

  it('with nothing selected, the Selected section shows a hint instead of fields', () => {
    installFakeDom();
    const piece = blankRoomPiece();
    const doc = new RoomDocument(piece);
    const target = new RoomPieceTarget(doc);
    const root = container();

    renderInspector(root as unknown as HTMLElement, { kind: 'roomPiece', doc, target, selection: null, onAfterDelete: vi.fn() });

    const hint = findAllByTag(root, 'div').find((d) => d.className === 'hint');
    expect(hint!.textContent).toContain('Nothing selected');
  });

  it('selecting a solid renders x/y/w/h fields wired to that solid', () => {
    installFakeDom();
    const piece = blankRoomPiece();
    piece.solids.push({ x: 1, y: 2, w: 3, h: 4 });
    const doc = new RoomDocument(piece);
    const target = new RoomPieceTarget(doc);
    const root = container();

    renderInspector(root as unknown as HTMLElement, {
      kind: 'roomPiece',
      doc,
      target,
      selection: { layer: 'solids', index: 0 },
      onAfterDelete: vi.fn(),
    });

    const xInput = findFieldInput(root, 'x');
    xInput.value = '99';
    xInput.onchange!();
    expect(piece.solids[0]!.x).toBe(99);
  });

  it('selecting an enemy spawn offers a type <select> wired to that spawn', () => {
    installFakeDom();
    const piece = blankRoomPiece();
    piece.spawns.enemy.push({ x: 0, y: 0 });
    const doc = new RoomDocument(piece);
    const target = new RoomPieceTarget(doc);
    const root = container();

    renderInspector(root as unknown as HTMLElement, {
      kind: 'roomPiece',
      doc,
      target,
      selection: { layer: 'enemySpawns', index: 0 },
      onAfterDelete: vi.fn(),
    });

    const typeSelect = findFieldInput(root, 'type');
    typeSelect.value = 'brute';
    typeSelect.onchange!();
    expect(piece.spawns.enemy[0]!.type).toBe('brute');
  });

  it('selecting a cellTrait and toggling "timed" on creates a default phase, revealing phase fields', () => {
    installFakeDom();
    // Arena rooms (not pve) actually own cellTraits; roomPiece's getCellTraits() always
    // returns [] (see RoomEditTarget), so exercise this branch through an ArenaRoomTarget.
    const arenaDoc = new ArenaDocument(blankArenaMap());
    arenaDoc.map.rooms.push({
      id: 'r1',
      rectGrid: { x: 0, y: 0, w: 5, h: 5 },
      solids: [],
      cellTraits: [{ id: 'ct1', rectGrid: { x: 0, y: 0, w: 1, h: 1 }, kind: 'spike', timed: false }],
    });
    const arenaTarget = new ArenaRoomTarget(arenaDoc, 'r1');
    const root = container();

    renderInspector(root as unknown as HTMLElement, {
      kind: 'arenaRoom',
      target: arenaTarget,
      selection: { layer: 'cellTraits', index: 0 },
      onBack: vi.fn(),
      onAfterDelete: vi.fn(),
    });

    // Before toggling: no phase.* fields yet.
    expect(() => findFieldInput(root, 'phase.armTicks')).toThrow();

    const timedCheckbox = findCheckboxByLabel(root, 'timed (phased)');
    timedCheckbox.checked = true;
    timedCheckbox.onchange!();

    const trait = arenaDoc.map.rooms[0]!.cellTraits![0]!;
    expect(trait.timed).toBe(true);
    expect(trait.phase).toEqual({ armTicks: 30, activeTicks: 30 });
  });

  it('Delete selected asks for confirmation; declining leaves the item untouched', () => {
    const { confirmMock } = installFakeDom(false);
    const piece = blankRoomPiece();
    piece.solids.push({ x: 1, y: 2, w: 3, h: 4 });
    const doc = new RoomDocument(piece);
    const target = new RoomPieceTarget(doc);
    const root = container();
    const onAfterDelete = vi.fn();

    renderInspector(root as unknown as HTMLElement, {
      kind: 'roomPiece',
      doc,
      target,
      selection: { layer: 'solids', index: 0 },
      onAfterDelete,
    });

    const delBtn = findAllByTag(root, 'button').find((b) => b.textContent === 'Delete selected')!;
    delBtn.onclick!();

    expect(confirmMock).toHaveBeenCalledTimes(1);
    expect(piece.solids).toHaveLength(1);
    expect(onAfterDelete).not.toHaveBeenCalled();
  });

  it('Delete selected removes the item and notifies the caller once confirmed', () => {
    installFakeDom(true);
    const piece = blankRoomPiece();
    piece.solids.push({ x: 1, y: 2, w: 3, h: 4 });
    const doc = new RoomDocument(piece);
    const target = new RoomPieceTarget(doc);
    const root = container();
    const onAfterDelete = vi.fn();

    renderInspector(root as unknown as HTMLElement, {
      kind: 'roomPiece',
      doc,
      target,
      selection: { layer: 'solids', index: 0 },
      onAfterDelete,
    });

    const delBtn = findAllByTag(root, 'button').find((b) => b.textContent === 'Delete selected')!;
    delBtn.onclick!();

    expect(piece.solids).toHaveLength(0);
    expect(onAfterDelete).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// arenaMap — representative edit flows
// ---------------------------------------------------------------------------

describe('renderInspector — arenaMap edit flows', () => {
  it('editing the map id mutates it', () => {
    installFakeDom();
    const doc = new ArenaDocument(blankArenaMap());
    const root = container();
    renderInspector(root as unknown as HTMLElement, { kind: 'arenaMap', doc, selection: null, onDrillDown: vi.fn() });

    const idInput = findFieldInput(root, 'id');
    idInput.value = 'arena_renamed';
    idInput.onchange!();

    expect(doc.map.id).toBe('arena_renamed');
  });

  it('with nothing selected, shows a hint', () => {
    installFakeDom();
    const doc = new ArenaDocument(blankArenaMap());
    const root = container();
    renderInspector(root as unknown as HTMLElement, { kind: 'arenaMap', doc, selection: null, onDrillDown: vi.fn() });

    const hint = findAllByTag(root, 'div').find((d) => d.className === 'hint' && d.textContent.includes('Nothing selected'));
    expect(hint).toBeDefined();
  });

  it('selecting a room shows its rectGrid fields, an eye-candidate checkbox, and drills down on click', () => {
    installFakeDom();
    const doc = new ArenaDocument(blankArenaMap());
    doc.map.rooms.push({ id: 'r1', rectGrid: { x: 0, y: 0, w: 5, h: 5 }, solids: [] });
    const root = container();
    const onDrillDown = vi.fn();
    renderInspector(root as unknown as HTMLElement, { kind: 'arenaMap', doc, selection: { kind: 'room', id: 'r1' }, onDrillDown });

    const xInput = findFieldInput(root, 'rectGrid.x');
    xInput.value = '10';
    xInput.onchange!();
    expect(doc.map.rooms[0]!.rectGrid.x).toBe(10);

    const openBtn = findAllByTag(root, 'button').find((b) => b.textContent === 'Open room detail →')!;
    openBtn.onclick!();
    expect(onDrillDown).toHaveBeenCalledWith('r1');
  });

  it('toggling "Eye candidate" on adds an entry (revealing a weight field); off removes it', () => {
    installFakeDom();
    const doc = new ArenaDocument(blankArenaMap());
    doc.map.rooms.push({ id: 'r1', rectGrid: { x: 0, y: 0, w: 5, h: 5 }, solids: [] });
    const root = container();
    renderInspector(root as unknown as HTMLElement, { kind: 'arenaMap', doc, selection: { kind: 'room', id: 'r1' }, onDrillDown: vi.fn() });

    expect(() => findFieldInput(root, 'eye weight')).toThrow();
    const eyeCheckbox = findCheckboxByLabel(root, 'Eye candidate');
    eyeCheckbox.checked = true;
    eyeCheckbox.onchange!();
    expect(doc.map.eyeCandidates).toEqual([{ roomId: 'r1', weight: 1 }]);

    eyeCheckbox.checked = false;
    eyeCheckbox.onchange!();
    expect(doc.map.eyeCandidates).toEqual([]);
  });

  it('selecting a player spawn shows x/y fields wired to it', () => {
    installFakeDom();
    const doc = new ArenaDocument(blankArenaMap());
    doc.map.spawns.push({ x: 1, y: 2 });
    const root = container();
    renderInspector(root as unknown as HTMLElement, { kind: 'arenaMap', doc, selection: { kind: 'spawn', index: 0 }, onDrillDown: vi.fn() });

    const xInput = findFieldInput(root, 'x');
    xInput.value = '42';
    xInput.onchange!();
    expect(doc.map.spawns[0]!.x).toBe(42);
  });
});

// ---------------------------------------------------------------------------
// dungeonFloor — representative edit flows
// ---------------------------------------------------------------------------

describe('renderInspector — dungeonFloor edit flows', () => {
  it('warns when the room library is empty', () => {
    installFakeDom();
    const doc = new DungeonFloorDocument(blankDungeonFloorMap());
    const root = container();
    renderInspector(root as unknown as HTMLElement, { kind: 'dungeonFloor', doc, library: [], selection: null, onAfterDelete: vi.fn() });

    const warn = findAllByTag(root, 'div').find((d) => d.className === 'hint error');
    expect(warn!.textContent).toContain('No RoomPieces open');
  });

  it('selecting a placed room shows offset fields and flags a missing piece as "NOT OPEN"', () => {
    installFakeDom();
    const doc = new DungeonFloorDocument(blankDungeonFloorMap());
    doc.map.rooms.push({ id: 'inst1', pieceId: 'missing_piece', offsetXGrid: 0, offsetYGrid: 0 });
    const root = container();

    renderInspector(root as unknown as HTMLElement, { kind: 'dungeonFloor', doc, library: [], selection: { kind: 'room', id: 'inst1' }, onAfterDelete: vi.fn() });

    const idRow = findAllByTag(root, 'div').find((d) => d.className === 'hint' && d.textContent.startsWith('id: inst1'));
    expect(idRow!.textContent).toContain('NOT OPEN');

    const offsetInput = findFieldInput(root, 'offsetXGrid');
    offsetInput.value = '3';
    offsetInput.onchange!();
    expect(doc.map.rooms[0]!.offsetXGrid).toBe(3);
  });

  it('selecting a door shows its passageGrid fields', () => {
    installFakeDom();
    const doc = new DungeonFloorDocument(blankDungeonFloorMap());
    doc.map.rooms.push({ id: 'a', pieceId: 'p1', offsetXGrid: 0, offsetYGrid: 0 }, { id: 'b', pieceId: 'p1', offsetXGrid: 5, offsetYGrid: 0 });
    doc.map.doors.push({ roomA: 'a', roomB: 'b', passageGrid: { x: 1, y: 1, w: 1, h: 1 } });
    const root = container();

    renderInspector(root as unknown as HTMLElement, { kind: 'dungeonFloor', doc, library: [], selection: { kind: 'door', index: 0 }, onAfterDelete: vi.fn() });

    const wInput = findFieldInput(root, 'passageGrid.w');
    wInput.value = '4';
    wInput.onchange!();
    expect(doc.map.doors[0]!.passageGrid.w).toBe(4);
  });

  it('deleting a selected room also removes doors that referenced it', () => {
    installFakeDom(true);
    const doc = new DungeonFloorDocument(blankDungeonFloorMap());
    doc.map.rooms.push({ id: 'a', pieceId: 'p1', offsetXGrid: 0, offsetYGrid: 0 }, { id: 'b', pieceId: 'p1', offsetXGrid: 5, offsetYGrid: 0 });
    doc.map.doors.push({ roomA: 'a', roomB: 'b', passageGrid: { x: 1, y: 1, w: 1, h: 1 } });
    const root = container();
    const onAfterDelete = vi.fn();

    renderInspector(root as unknown as HTMLElement, { kind: 'dungeonFloor', doc, library: [], selection: { kind: 'room', id: 'a' }, onAfterDelete });

    const delBtn = findAllByTag(root, 'button').find((b) => b.textContent === 'Delete selected')!;
    delBtn.onclick!();

    expect(doc.map.rooms.map((r) => r.id)).toEqual(['b']);
    expect(doc.map.doors).toHaveLength(0);
    expect(onAfterDelete).toHaveBeenCalledTimes(1);
  });

  it('deleting a selected door only removes that door', () => {
    installFakeDom(true);
    const doc = new DungeonFloorDocument(blankDungeonFloorMap());
    doc.map.rooms.push({ id: 'a', pieceId: 'p1', offsetXGrid: 0, offsetYGrid: 0 }, { id: 'b', pieceId: 'p1', offsetXGrid: 5, offsetYGrid: 0 });
    doc.map.doors.push({ roomA: 'a', roomB: 'b', passageGrid: { x: 1, y: 1, w: 1, h: 1 } });
    const root = container();
    const onAfterDelete = vi.fn();

    renderInspector(root as unknown as HTMLElement, { kind: 'dungeonFloor', doc, library: [], selection: { kind: 'door', index: 0 }, onAfterDelete });

    const delBtn = findAllByTag(root, 'button').find((b) => b.textContent === 'Delete selected')!;
    delBtn.onclick!();

    expect(doc.map.doors).toHaveLength(0);
    expect(doc.map.rooms).toHaveLength(2);
    expect(onAfterDelete).toHaveBeenCalledTimes(1);
  });
});
