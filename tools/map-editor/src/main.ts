import type { RoomPiece, DungeonFloorMap } from '@dd/engine';
import type { ArenaMap } from '@dd/engine/content/arenas';
import { RoomCanvas } from './canvas/RoomCanvas';
import { ArenaCanvas, type ArenaTool } from './canvas/ArenaCanvas';
import { DungeonFloorCanvas, type DungeonFloorTool } from './canvas/DungeonFloorCanvas';
import { RoomPieceTarget, ArenaRoomTarget, type ToolKind } from './canvas/RoomEditTarget';
import { RoomDocument } from './state/RoomDocument';
import { ArenaDocument } from './state/ArenaDocument';
import { DungeonFloorDocument } from './state/DungeonFloorDocument';
import { renderInspector } from './ui/Inspector';
import { saveJson, openJson } from './ui/DocumentIO';
import { validateRoomPiece, validateArenaMap, validateDungeonFloorMap } from './validate';
import { button, el, selectField } from './ui/fields';
import { visibleHost, onRoomCanvas, roomToolsForMode, type Mode, type ArenaView } from './modeLogic';

const roomCanvasHost = document.getElementById('roomCanvasHost') as HTMLElement;
const arenaCanvasHost = document.getElementById('arenaCanvasHost') as HTMLElement;
const dungeonFloorCanvasHost = document.getElementById('dungeonFloorCanvasHost') as HTMLElement;
const topbar = document.getElementById('topbar') as HTMLElement;
const inspector = document.getElementById('inspector') as HTMLElement;

const roomCanvas = new RoomCanvas(roomCanvasHost);
const arenaCanvas = new ArenaCanvas(arenaCanvasHost);
const dungeonFloorCanvas = new DungeonFloorCanvas(dungeonFloorCanvasHost);

let mode: Mode = 'roomLibrary';
let autosaveKeyCounter = 0;
let roomDocs: RoomDocument[] = [new RoomDocument(RoomDocument.blank('room_1'), String(autosaveKeyCounter++))];
let activeRoomDocIndex = 0;
let roomTool: ToolKind = 'select';

let arenaDoc = new ArenaDocument(ArenaDocument.loadAutosave() ?? ArenaDocument.blank('arena_1'));
let arenaView: ArenaView = { kind: 'map' };
let arenaTool: ArenaTool = 'select';

let dungeonFloorDoc = new DungeonFloorDocument(DungeonFloorDocument.loadAutosave() ?? DungeonFloorDocument.blank('floor_1'));
let dungeonFloorTool: DungeonFloorTool = 'select';
let pendingPieceId: string | null = null;

/** Whatever RoomPieces are currently open in the "PvE Room Library" tab — the
 * palette a dungeon floor's room instances are picked from (design/05
 * "Hand-authored PvE floors": the editor resolves against whatever's open, not
 * a claim about the eventual runtime library). */
function currentRoomLibrary(): RoomPiece[] {
  return roomDocs.map((d) => d.piece);
}

function syncDungeonFloorLibrary(): void {
  dungeonFloorCanvas.setLibrary(currentRoomLibrary());
  if (pendingPieceId && !currentRoomLibrary().some((p) => p.id === pendingPieceId)) pendingPieceId = null;
}

async function init(): Promise<void> {
  await roomCanvas.mount();
  await arenaCanvas.mount();
  await dungeonFloorCanvas.mount();
  roomCanvas.onSelectionChange(() => refreshSidebar());
  arenaCanvas.onSelectionChange(() => refreshSidebar());
  dungeonFloorCanvas.onSelectionChange(() => refreshSidebar());
  arenaCanvas.onDrillDown((roomId) => {
    arenaView = { kind: 'room', roomId };
    syncArenaView();
  });
  syncDungeonFloorLibrary();
  setMode('roomLibrary');
}

function setActiveRoomDoc(index: number): void {
  activeRoomDocIndex = index;
  roomCanvas.setTarget(new RoomPieceTarget(roomDocs[index]!));
  refreshSidebar();
}

/** Applies modeLogic.ts's `visibleHost` decision to the three real mounted canvas
 * hosts — the only side-effecting half of that decision, kept here in main.ts. */
function applyVisibleHost(host: ReturnType<typeof visibleHost>): void {
  roomCanvasHost.style.display = host === 'room' ? '' : 'none';
  arenaCanvasHost.style.display = host === 'arena' ? '' : 'none';
  dungeonFloorCanvasHost.style.display = host === 'dungeonFloor' ? '' : 'none';
}

function setMode(next: Mode): void {
  mode = next;
  if (mode === 'roomLibrary') {
    applyVisibleHost(visibleHost(mode, arenaView));
    roomCanvas.setTool(roomTool);
    roomCanvas.setTarget(new RoomPieceTarget(roomDocs[activeRoomDocIndex]!));
  } else if (mode === 'dungeonFloor') {
    applyVisibleHost(visibleHost(mode, arenaView));
    syncDungeonFloorLibrary();
    dungeonFloorCanvas.setTool(dungeonFloorTool);
    dungeonFloorCanvas.setDocument(dungeonFloorDoc);
  } else {
    arenaView = { kind: 'map' };
    syncArenaView();
  }
  renderTopbar();
  refreshSidebar();
}

function syncArenaView(): void {
  applyVisibleHost(visibleHost(mode, arenaView));
  if (arenaView.kind === 'map') {
    arenaCanvas.setTool(arenaTool);
    arenaCanvas.setDocument(arenaDoc);
  } else {
    roomCanvas.setTool(roomTool);
    roomCanvas.setTarget(new ArenaRoomTarget(arenaDoc, arenaView.roomId));
  }
  renderTopbar();
  refreshSidebar();
}

function refreshSidebar(): void {
  inspector.innerHTML = '';
  if (mode === 'roomLibrary') {
    renderRoomDocList(inspector);
    const doc = roomDocs[activeRoomDocIndex]!;
    renderInspector(inspector, {
      kind: 'roomPiece',
      doc,
      target: new RoomPieceTarget(doc),
      selection: roomCanvas.getSelection(),
      onAfterDelete: () => roomCanvas.setSelection(null),
    });
  } else if (mode === 'dungeonFloor') {
    renderInspector(inspector, {
      kind: 'dungeonFloor',
      doc: dungeonFloorDoc,
      library: currentRoomLibrary(),
      selection: dungeonFloorCanvas.getSelection(),
      onAfterDelete: () => dungeonFloorCanvas.setSelection(null),
    });
  } else if (arenaView.kind === 'room') {
    renderInspector(inspector, {
      kind: 'arenaRoom',
      target: new ArenaRoomTarget(arenaDoc, arenaView.roomId),
      selection: roomCanvas.getSelection(),
      onBack: () => {
        arenaView = { kind: 'map' };
        syncArenaView();
      },
      onAfterDelete: () => roomCanvas.setSelection(null),
    });
  } else {
    renderInspector(inspector, {
      kind: 'arenaMap',
      doc: arenaDoc,
      selection: arenaCanvas.getSelection(),
      onDrillDown: (roomId) => {
        arenaView = { kind: 'room', roomId };
        syncArenaView();
      },
    });
  }
}

function renderRoomDocList(container: HTMLElement): void {
  const sec = el('div', 'section');
  const h = el('h3');
  h.textContent = 'Room Library';
  sec.appendChild(h);

  const list = el('ul', 'doclist');
  roomDocs.forEach((doc, i) => {
    const li = el('li');
    li.textContent = doc.piece.id || '(untitled)';
    if (i === activeRoomDocIndex) li.classList.add('selected');
    li.onclick = () => setActiveRoomDoc(i);
    list.appendChild(li);
  });
  sec.appendChild(list);

  const row = el('div');
  row.style.display = 'flex';
  row.style.gap = '6px';
  row.style.marginTop = '6px';
  row.appendChild(
    button('+ New', () => {
      roomDocs.push(new RoomDocument(RoomDocument.blank(`room_${roomDocs.length + 1}`), String(autosaveKeyCounter++)));
      setActiveRoomDoc(roomDocs.length - 1);
    }),
  );
  row.appendChild(
    button('Open…', async () => {
      const opened = await openJson<RoomPiece>();
      if (!opened) return;
      roomDocs.push(new RoomDocument(opened.data, String(autosaveKeyCounter++)));
      setActiveRoomDoc(roomDocs.length - 1);
    }),
  );
  row.appendChild(
    button('Save', async () => {
      const doc = roomDocs[activeRoomDocIndex]!;
      const issues = validateRoomPiece(doc.piece);
      if (issues.length) {
        alert('Cannot save — fix these first:\n' + issues.map((i) => `• ${i.message}`).join('\n'));
        return;
      }
      await saveJson(doc.piece, `${doc.piece.id}.json`);
    }),
  );
  sec.appendChild(row);
  container.appendChild(sec);
}

const ROOM_TOOLS: { id: ToolKind; label: string }[] = [
  { id: 'select', label: 'Select' },
  { id: 'solid', label: 'Solid' },
  { id: 'pillar', label: 'Pillar' },
  { id: 'prop', label: 'Prop' },
  { id: 'playerSpawn', label: 'Player Spawn' },
  { id: 'enemySpawn', label: 'Enemy Spawn' },
  { id: 'cellTrait', label: 'Cell Trait' },
  { id: 'lootMarker', label: 'Loot Marker' },
];

const ARENA_TOOLS: { id: ArenaTool; label: string }[] = [
  { id: 'select', label: 'Select' },
  { id: 'room', label: 'Room' },
  { id: 'door', label: 'Door' },
  { id: 'eye', label: 'Eye Candidate' },
  { id: 'spawn', label: 'Player Spawn' },
];

const DUNGEON_FLOOR_TOOLS: { id: DungeonFloorTool; label: string }[] = [
  { id: 'select', label: 'Select' },
  { id: 'place', label: 'Place' },
  { id: 'door', label: 'Door' },
];

function renderTopbar(): void {
  topbar.innerHTML = '';

  const modeRow = el('div');
  modeRow.style.display = 'flex';
  modeRow.style.gap = '4px';
  const roomBtn = button('PvE Room Library', () => setMode('roomLibrary'));
  const floorBtn = button('PvE Dungeon Floor', () => setMode('dungeonFloor'));
  const arenaBtn = button('PvP Arena', () => setMode('arena'));
  (mode === 'roomLibrary' ? roomBtn : mode === 'dungeonFloor' ? floorBtn : arenaBtn).classList.add('active');
  modeRow.appendChild(roomBtn);
  modeRow.appendChild(floorBtn);
  modeRow.appendChild(arenaBtn);
  topbar.appendChild(modeRow);

  const toolRow = el('div');
  toolRow.style.display = 'flex';
  toolRow.style.gap = '4px';
  toolRow.style.flexWrap = 'wrap';

  if (onRoomCanvas(mode, arenaView)) {
    for (const t of roomToolsForMode(mode, ROOM_TOOLS)) {
      const b = button(t.label, () => {
        roomTool = t.id;
        roomCanvas.setTool(t.id);
        renderTopbar();
      });
      if (roomTool === t.id) b.classList.add('active');
      toolRow.appendChild(b);
    }
  } else if (mode === 'dungeonFloor') {
    for (const t of DUNGEON_FLOOR_TOOLS) {
      const b = button(t.label, () => {
        dungeonFloorTool = t.id;
        dungeonFloorCanvas.setTool(t.id);
        renderTopbar();
      });
      if (dungeonFloorTool === t.id) b.classList.add('active');
      toolRow.appendChild(b);
    }
    if (dungeonFloorTool === 'place') {
      const library = currentRoomLibrary();
      const options = library.map((p) => p.id);
      if (options.length > 0) {
        const current = pendingPieceId && options.includes(pendingPieceId) ? pendingPieceId : options[0]!;
        pendingPieceId = current;
        dungeonFloorCanvas.setPendingPieceId(current);
        toolRow.appendChild(
          selectField('piece to place', current, options, (v) => {
            pendingPieceId = v;
            dungeonFloorCanvas.setPendingPieceId(v);
          }),
        );
      }
    }
  } else {
    for (const t of ARENA_TOOLS) {
      const b = button(t.label, () => {
        arenaTool = t.id;
        arenaCanvas.setTool(t.id);
        renderTopbar();
      });
      if (arenaTool === t.id) b.classList.add('active');
      toolRow.appendChild(b);
    }
  }
  topbar.appendChild(toolRow);

  if (mode === 'arena' && arenaView.kind === 'map') {
    const ioRow = el('div');
    ioRow.style.display = 'flex';
    ioRow.style.gap = '4px';
    ioRow.appendChild(
      button('New Arena', () => {
        if (!confirm('Discard the current arena and start a new blank one?')) return;
        arenaDoc = new ArenaDocument(ArenaDocument.blank('arena_1'));
        arenaView = { kind: 'map' };
        syncArenaView();
      }),
    );
    ioRow.appendChild(
      button('Open…', async () => {
        const opened = await openJson<ArenaMap>();
        if (!opened) return;
        arenaDoc = new ArenaDocument(opened.data);
        arenaView = { kind: 'map' };
        syncArenaView();
      }),
    );
    ioRow.appendChild(button('Fit View', () => arenaCanvas.fitView()));
    ioRow.appendChild(
      button('Save', async () => {
        const issues = validateArenaMap(arenaDoc.map);
        if (issues.length) {
          alert('Cannot save — fix these first:\n' + issues.map((i) => `• ${i.message}`).join('\n'));
          return;
        }
        await saveJson(arenaDoc.map, `${arenaDoc.map.id}.json`);
      }),
    );
    topbar.appendChild(ioRow);
  }

  if (mode === 'dungeonFloor') {
    const ioRow = el('div');
    ioRow.style.display = 'flex';
    ioRow.style.gap = '4px';
    ioRow.appendChild(
      button('New Floor', () => {
        if (!confirm('Discard the current floor and start a new blank one?')) return;
        dungeonFloorDoc = new DungeonFloorDocument(DungeonFloorDocument.blank('floor_1'));
        dungeonFloorCanvas.setDocument(dungeonFloorDoc);
        refreshSidebar();
      }),
    );
    ioRow.appendChild(
      button('Open…', async () => {
        const opened = await openJson<DungeonFloorMap>();
        if (!opened) return;
        dungeonFloorDoc = new DungeonFloorDocument(opened.data);
        dungeonFloorCanvas.setDocument(dungeonFloorDoc);
        refreshSidebar();
      }),
    );
    ioRow.appendChild(button('Fit View', () => dungeonFloorCanvas.fitView()));
    ioRow.appendChild(
      button('Save', async () => {
        const issues = validateDungeonFloorMap(dungeonFloorDoc.map, currentRoomLibrary());
        if (issues.length) {
          alert('Cannot save — fix these first:\n' + issues.map((i) => `• ${i.message}`).join('\n'));
          return;
        }
        await saveJson(dungeonFloorDoc.map, `${dungeonFloorDoc.map.id}.json`);
      }),
    );
    topbar.appendChild(ioRow);
  }
}

void init();
