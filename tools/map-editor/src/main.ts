import type { RoomPiece } from '@dd/engine';
import type { ArenaMap } from '@dd/engine/content/arenas';
import { RoomCanvas } from './canvas/RoomCanvas';
import { ArenaCanvas, type ArenaTool } from './canvas/ArenaCanvas';
import { RoomPieceTarget, ArenaRoomTarget, type ToolKind } from './canvas/RoomEditTarget';
import { RoomDocument } from './state/RoomDocument';
import { ArenaDocument } from './state/ArenaDocument';
import { renderInspector } from './ui/Inspector';
import { saveJson, openJson } from './ui/DocumentIO';
import { validateRoomPiece, validateArenaMap } from './validate';
import { button, el } from './ui/fields';

type Mode = 'roomLibrary' | 'arena';
type ArenaView = { kind: 'map' } | { kind: 'room'; roomId: string };

const roomCanvasHost = document.getElementById('roomCanvasHost') as HTMLElement;
const arenaCanvasHost = document.getElementById('arenaCanvasHost') as HTMLElement;
const topbar = document.getElementById('topbar') as HTMLElement;
const inspector = document.getElementById('inspector') as HTMLElement;

const roomCanvas = new RoomCanvas(roomCanvasHost);
const arenaCanvas = new ArenaCanvas(arenaCanvasHost);

let mode: Mode = 'roomLibrary';
let autosaveKeyCounter = 0;
let roomDocs: RoomDocument[] = [new RoomDocument(RoomDocument.blank('room_1'), String(autosaveKeyCounter++))];
let activeRoomDocIndex = 0;
let roomTool: ToolKind = 'select';

let arenaDoc = new ArenaDocument(ArenaDocument.loadAutosave() ?? ArenaDocument.blank('arena_1'));
let arenaView: ArenaView = { kind: 'map' };
let arenaTool: ArenaTool = 'select';

async function init(): Promise<void> {
  await roomCanvas.mount();
  await arenaCanvas.mount();
  roomCanvas.onSelectionChange(() => refreshSidebar());
  arenaCanvas.onSelectionChange(() => refreshSidebar());
  arenaCanvas.onDrillDown((roomId) => {
    arenaView = { kind: 'room', roomId };
    syncArenaView();
  });
  setMode('roomLibrary');
}

function setActiveRoomDoc(index: number): void {
  activeRoomDocIndex = index;
  roomCanvas.setTarget(new RoomPieceTarget(roomDocs[index]!));
  refreshSidebar();
}

function setMode(next: Mode): void {
  mode = next;
  if (mode === 'roomLibrary') {
    roomCanvasHost.style.display = '';
    arenaCanvasHost.style.display = 'none';
    roomCanvas.setTool(roomTool);
    roomCanvas.setTarget(new RoomPieceTarget(roomDocs[activeRoomDocIndex]!));
  } else {
    arenaView = { kind: 'map' };
    syncArenaView();
  }
  renderTopbar();
  refreshSidebar();
}

function syncArenaView(): void {
  if (arenaView.kind === 'map') {
    roomCanvasHost.style.display = 'none';
    arenaCanvasHost.style.display = '';
    arenaCanvas.setTool(arenaTool);
    arenaCanvas.setDocument(arenaDoc);
  } else {
    arenaCanvasHost.style.display = 'none';
    roomCanvasHost.style.display = '';
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

function renderTopbar(): void {
  topbar.innerHTML = '';

  const modeRow = el('div');
  modeRow.style.display = 'flex';
  modeRow.style.gap = '4px';
  const roomBtn = button('PvE Room Library', () => setMode('roomLibrary'));
  const arenaBtn = button('PvP Arena', () => setMode('arena'));
  (mode === 'roomLibrary' ? roomBtn : arenaBtn).classList.add('active');
  modeRow.appendChild(roomBtn);
  modeRow.appendChild(arenaBtn);
  topbar.appendChild(modeRow);

  const toolRow = el('div');
  toolRow.style.display = 'flex';
  toolRow.style.gap = '4px';
  toolRow.style.flexWrap = 'wrap';

  const onRoomCanvas = mode === 'roomLibrary' || arenaView.kind === 'room';
  if (onRoomCanvas) {
    const isPve = mode === 'roomLibrary';
    for (const t of ROOM_TOOLS) {
      if (t.id === 'playerSpawn' && !isPve) continue; // PvP rooms have no per-room player spawn (design/15)
      if ((t.id === 'cellTrait' || t.id === 'lootMarker') && isPve) continue; // PvE RoomPiece has neither field
      const b = button(t.label, () => {
        roomTool = t.id;
        roomCanvas.setTool(t.id);
        renderTopbar();
      });
      if (roomTool === t.id) b.classList.add('active');
      toolRow.appendChild(b);
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
}

void init();
