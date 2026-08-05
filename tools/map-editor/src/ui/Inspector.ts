import { ENEMY_BLUEPRINTS } from '@dd/engine';
import type { DamageType, RoomEdge, RoomPiece, RoomRole } from '@dd/engine';
import type { RoomDocument } from '../state/RoomDocument';
import type { ArenaDocument } from '../state/ArenaDocument';
import type { DungeonFloorDocument } from '../state/DungeonFloorDocument';
import type { RoomEditTarget, Selection } from '../canvas/RoomEditTarget';
import type { ArenaSelection } from '../canvas/ArenaCanvas';
import type { DungeonFloorSelection } from '../canvas/DungeonFloorCanvas';
import { button, checkboxField, el, numberField, section, selectField, textField } from './fields';
import { renderEncounterTable } from './EncounterTable';

const ENEMY_TYPE_IDS = Object.keys(ENEMY_BLUEPRINTS);
const DAMAGE_TYPES: DamageType[] = ['physical', 'fire', 'ice', 'lightning', 'poison'];
const EDGES: RoomEdge[] = ['north', 'south', 'east', 'west'];

export type InspectorContext =
  | { kind: 'roomPiece'; doc: RoomDocument; target: RoomEditTarget; selection: Selection | null; onAfterDelete: () => void }
  | { kind: 'arenaRoom'; target: RoomEditTarget; selection: Selection | null; onBack: () => void; onAfterDelete: () => void }
  | { kind: 'arenaMap'; doc: ArenaDocument; selection: ArenaSelection; onDrillDown: (roomId: string) => void }
  | {
      kind: 'dungeonFloor';
      doc: DungeonFloorDocument;
      library: readonly RoomPiece[];
      selection: DungeonFloorSelection;
      onAfterDelete: () => void;
    };

/** Appends to `container` — callers own clearing it (main.ts's refreshSidebar
 * clears once, then may prepend other sections like the Room Library doc list
 * before calling this). */
export function renderInspector(container: HTMLElement, ctx: InspectorContext): void {
  if (ctx.kind === 'roomPiece') {
    renderRoomMetadata(container, ctx.doc);
    renderShapeSection(container, ctx.target, ctx.selection, ctx.onAfterDelete);
    renderEncounterTable(container, ctx.target);
  } else if (ctx.kind === 'arenaRoom') {
    const back = section('Arena Room (drilled in)');
    back.appendChild(button('← Back to arena map', ctx.onBack));
    container.appendChild(back);
    renderShapeSection(container, ctx.target, ctx.selection, ctx.onAfterDelete);
    renderEncounterTable(container, ctx.target);
  } else if (ctx.kind === 'arenaMap') {
    renderArenaMapMetadata(container, ctx.doc);
    renderArenaSelectionSection(container, ctx.doc, ctx.selection, ctx.onDrillDown);
  } else {
    renderDungeonFloorMetadata(container, ctx.doc, ctx.library);
    renderDungeonFloorSelectionSection(container, ctx.doc, ctx.library, ctx.selection, ctx.onAfterDelete);
  }
}

function renderRoomMetadata(container: HTMLElement, doc: RoomDocument): void {
  const sec = section('Room Piece');
  sec.appendChild(textField('id', doc.piece.id, (v) => doc.mutate((p) => (p.id = v))));
  sec.appendChild(
    textField('tags (comma list)', (doc.piece.tags ?? []).join(','), (v) =>
      doc.mutate((p) => (p.tags = v.split(',').map((s) => s.trim()).filter(Boolean))),
    ),
  );
  sec.appendChild(
    selectField('role', doc.piece.role ?? 'normal', ['normal', 'extraction', 'boss'], (v) =>
      doc.mutate((p) => (p.role = v === 'normal' ? undefined : (v as RoomRole))),
    ),
  );
  sec.appendChild(numberField('sizeGrid.w', doc.piece.sizeGrid.w, (v) => doc.mutate((p) => (p.sizeGrid.w = Math.max(1, Math.round(v))))));
  sec.appendChild(numberField('sizeGrid.h', doc.piece.sizeGrid.h, (v) => doc.mutate((p) => (p.sizeGrid.h = Math.max(1, Math.round(v))))));
  container.appendChild(sec);

  const exitsSec = section('Exits');
  for (const edge of EDGES) {
    const existing = doc.piece.exits.find((e) => e.edge === edge);
    const row = el('div');
    row.appendChild(
      checkboxField(edge, !!existing, (checked) =>
        doc.mutate((p) => {
          if (checked) {
            if (!p.exits.some((e) => e.edge === edge)) p.exits.push({ edge });
          } else {
            p.exits = p.exits.filter((e) => e.edge !== edge);
          }
        }),
      ),
    );
    if (existing) {
      row.appendChild(
        textField(`${edge}.toTag`, existing.toTag ?? '', (v) =>
          doc.mutate((p) => {
            const e = p.exits.find((e) => e.edge === edge);
            if (e) e.toTag = v || undefined;
          }),
        ),
      );
    }
    exitsSec.appendChild(row);
  }
  container.appendChild(exitsSec);
}

function removeSelected(target: RoomEditTarget, selection: Selection): void {
  switch (selection.layer) {
    case 'solids':
      target.getSolids().splice(selection.index, 1);
      break;
    case 'pillars':
      target.getPillars().splice(selection.index, 1);
      break;
    case 'props':
      target.getProps().splice(selection.index, 1);
      break;
    case 'playerSpawns':
      target.getPlayerSpawns().splice(selection.index, 1);
      break;
    case 'enemySpawns':
      target.getEnemySpawns().splice(selection.index, 1);
      break;
    case 'cellTraits':
      target.getCellTraits().splice(selection.index, 1);
      break;
    case 'lootMarkers':
      target.getLootMarkers().splice(selection.index, 1);
      break;
  }
}

function renderShapeSection(container: HTMLElement, target: RoomEditTarget, selection: Selection | null, onAfterDelete: () => void): void {
  const sec = section('Selected');
  if (!selection) {
    const hint = el('div', 'hint');
    hint.textContent = 'Nothing selected — pick a tool from the top bar and click/drag on the canvas to place a shape.';
    sec.appendChild(hint);
    container.appendChild(sec);
    return;
  }

  switch (selection.layer) {
    case 'solids': {
      const s = target.getSolids()[selection.index];
      if (s) {
        sec.appendChild(numberField('x', s.x, (v) => target.mutate(() => (s.x = Math.round(v)))));
        sec.appendChild(numberField('y', s.y, (v) => target.mutate(() => (s.y = Math.round(v)))));
        sec.appendChild(numberField('w', s.w, (v) => target.mutate(() => (s.w = Math.max(1, Math.round(v))))));
        sec.appendChild(numberField('h', s.h, (v) => target.mutate(() => (s.h = Math.max(1, Math.round(v))))));
      }
      break;
    }
    case 'pillars': {
      const p = target.getPillars()[selection.index];
      if (p) {
        sec.appendChild(numberField('center.x', p.center.x, (v) => target.mutate(() => (p.center.x = Math.round(v)))));
        sec.appendChild(numberField('center.y', p.center.y, (v) => target.mutate(() => (p.center.y = Math.round(v)))));
        sec.appendChild(numberField('radius', p.radius, (v) => target.mutate(() => (p.radius = Math.max(0.1, v))), 0.1));
      }
      break;
    }
    case 'props': {
      const p = target.getProps()[selection.index];
      if (p) {
        sec.appendChild(textField('id', p.id, (v) => target.mutate(() => (p.id = v))));
        sec.appendChild(numberField('x', p.x, (v) => target.mutate(() => (p.x = Math.round(v)))));
        sec.appendChild(numberField('y', p.y, (v) => target.mutate(() => (p.y = Math.round(v)))));
      }
      break;
    }
    case 'playerSpawns': {
      const p = target.getPlayerSpawns()[selection.index];
      if (p) {
        sec.appendChild(numberField('x', p.x, (v) => target.mutate(() => (p.x = Math.round(v)))));
        sec.appendChild(numberField('y', p.y, (v) => target.mutate(() => (p.y = Math.round(v)))));
      }
      break;
    }
    case 'enemySpawns': {
      const p = target.getEnemySpawns()[selection.index];
      if (p) {
        sec.appendChild(numberField('x', p.x, (v) => target.mutate(() => (p.x = Math.round(v)))));
        sec.appendChild(numberField('y', p.y, (v) => target.mutate(() => (p.y = Math.round(v)))));
        sec.appendChild(selectField('type', p.type ?? ENEMY_TYPE_IDS[0]!, ENEMY_TYPE_IDS, (v) => target.mutate(() => (p.type = v))));
      }
      break;
    }
    case 'cellTraits': {
      const t = target.getCellTraits()[selection.index];
      if (t) {
        const r = t.rectGrid;
        sec.appendChild(numberField('rect.x', r.x, (v) => target.mutate(() => (r.x = Math.round(v)))));
        sec.appendChild(numberField('rect.y', r.y, (v) => target.mutate(() => (r.y = Math.round(v)))));
        sec.appendChild(numberField('rect.w', r.w, (v) => target.mutate(() => (r.w = Math.max(1, Math.round(v))))));
        sec.appendChild(numberField('rect.h', r.h, (v) => target.mutate(() => (r.h = Math.max(1, Math.round(v))))));
        sec.appendChild(textField('kind', t.kind, (v) => target.mutate(() => (t.kind = v))));
        sec.appendChild(
          checkboxField('timed (phased)', t.timed, (v) =>
            target.mutate(() => {
              t.timed = v;
              if (v && !t.phase) t.phase = { armTicks: 30, activeTicks: 30 };
            }),
          ),
        );
        if (t.timed) {
          const phase = (t.phase ??= { armTicks: 30, activeTicks: 30 });
          sec.appendChild(numberField('phase.armTicks', phase.armTicks, (v) => target.mutate(() => (phase.armTicks = Math.max(0, Math.round(v))))));
          sec.appendChild(numberField('phase.activeTicks', phase.activeTicks, (v) => target.mutate(() => (phase.activeTicks = Math.max(0, Math.round(v))))));
          sec.appendChild(numberField('phase.offsetTicks', phase.offsetTicks ?? 0, (v) => target.mutate(() => (phase.offsetTicks = Math.round(v)))));
        }
        sec.appendChild(numberField('damage', t.damage ?? 0, (v) => target.mutate(() => (t.damage = Math.max(0, Math.round(v))))));
        sec.appendChild(selectField('damageType', t.damageType ?? 'physical', DAMAGE_TYPES, (v) => target.mutate(() => (t.damageType = v as DamageType))));
      }
      break;
    }
    case 'lootMarkers': {
      const m = target.getLootMarkers()[selection.index];
      if (m) {
        sec.appendChild(numberField('point.x', m.point.x, (v) => target.mutate(() => (m.point.x = Math.round(v)))));
        sec.appendChild(numberField('point.y', m.point.y, (v) => target.mutate(() => (m.point.y = Math.round(v)))));
        sec.appendChild(textField('tableId', m.tableId, (v) => target.mutate(() => (m.tableId = v))));
        const hint = el('div', 'hint');
        hint.textContent = 'Only one implicit arena-wide drop table exists today — tableId is carried but not yet validated against a real catalog.';
        sec.appendChild(hint);
      }
      break;
    }
  }

  sec.appendChild(
    button(
      'Delete selected',
      () => {
        if (!confirm('Delete selected item?')) return;
        target.mutate(() => removeSelected(target, selection));
        onAfterDelete();
      },
      true,
    ),
  );
  container.appendChild(sec);
}

function renderArenaMapMetadata(container: HTMLElement, doc: ArenaDocument): void {
  const sec = section('Arena Map');
  sec.appendChild(textField('id', doc.map.id, (v) => doc.mutate((m) => (m.id = v))));
  sec.appendChild(numberField('sizeGrid.w', doc.map.sizeGrid.w, (v) => doc.mutate((m) => (m.sizeGrid.w = Math.max(1, Math.round(v))))));
  sec.appendChild(numberField('sizeGrid.h', doc.map.sizeGrid.h, (v) => doc.mutate((m) => (m.sizeGrid.h = Math.max(1, Math.round(v))))));
  const hint = el('div', 'hint');
  hint.textContent = `${doc.map.rooms.length} rooms · ${doc.map.doors.length} doors · ${doc.map.eyeCandidates.length} eye candidates · ${doc.map.spawns.length} player spawns.`;
  sec.appendChild(hint);
  const camHint = el('div', 'hint');
  camHint.textContent = 'Scroll to zoom, right-drag to pan, "Fit View" to reset.';
  sec.appendChild(camHint);
  container.appendChild(sec);
}

function renderArenaSelectionSection(container: HTMLElement, doc: ArenaDocument, selection: ArenaSelection, onDrillDown: (roomId: string) => void): void {
  const sec = section('Selected');
  if (!selection) {
    const hint = el('div', 'hint');
    hint.textContent = 'Nothing selected — draw a room, place a spawn, or pick a tool.';
    sec.appendChild(hint);
    container.appendChild(sec);
    return;
  }

  if (selection.kind === 'room') {
    const room = doc.map.rooms.find((r) => r.id === selection.id);
    if (!room) {
      container.appendChild(sec);
      return;
    }
    const idRow = el('div');
    idRow.textContent = `id: ${room.id}`;
    idRow.className = 'hint';
    sec.appendChild(idRow);
    const r = room.rectGrid;
    sec.appendChild(numberField('rectGrid.x', r.x, (v) => doc.mutate(() => (r.x = Math.round(v)))));
    sec.appendChild(numberField('rectGrid.y', r.y, (v) => doc.mutate(() => (r.y = Math.round(v)))));
    sec.appendChild(numberField('rectGrid.w', r.w, (v) => doc.mutate(() => (r.w = Math.max(1, Math.round(v))))));
    sec.appendChild(numberField('rectGrid.h', r.h, (v) => doc.mutate(() => (r.h = Math.max(1, Math.round(v))))));

    const isEye = doc.map.eyeCandidates.some((e) => e.roomId === room.id);
    sec.appendChild(
      checkboxField('Eye candidate', isEye, (checked) =>
        doc.mutate((m) => {
          if (checked) m.eyeCandidates.push({ roomId: room.id, weight: 1 });
          else m.eyeCandidates = m.eyeCandidates.filter((e) => e.roomId !== room.id);
        }),
      ),
    );
    if (isEye) {
      const cand = doc.map.eyeCandidates.find((e) => e.roomId === room.id)!;
      sec.appendChild(numberField('eye weight', cand.weight ?? 1, (v) => doc.mutate(() => (cand.weight = Math.max(0, v))), 0.1));
    }
    sec.appendChild(button('Open room detail →', () => onDrillDown(room.id)));
  } else if (selection.kind === 'spawn') {
    const p = doc.map.spawns[selection.index];
    if (p) {
      sec.appendChild(numberField('x', p.x, (v) => doc.mutate(() => (p.x = Math.round(v)))));
      sec.appendChild(numberField('y', p.y, (v) => doc.mutate(() => (p.y = Math.round(v)))));
    }
  }
  container.appendChild(sec);
}

function renderDungeonFloorMetadata(container: HTMLElement, doc: DungeonFloorDocument, library: readonly RoomPiece[]): void {
  const sec = section('Dungeon Floor');
  sec.appendChild(textField('id', doc.map.id, (v) => doc.mutate((m) => (m.id = v))));
  const hint = el('div', 'hint');
  const entranceId = doc.map.rooms[0]?.id;
  const capstoneId = doc.map.rooms[doc.map.rooms.length - 1]?.id;
  hint.textContent =
    `${doc.map.rooms.length} rooms · ${doc.map.doors.length} doors. ` +
    (entranceId ? `Entrance: "${entranceId}". ` : '') +
    (capstoneId ? `Capstone: "${capstoneId}".` : '');
  sec.appendChild(hint);
  const camHint = el('div', 'hint');
  camHint.textContent = 'Scroll to zoom, right-drag to pan, "Fit View" to reset. Array order matters — the FIRST room placed is the entrance, the LAST is the capstone (extraction/boss).';
  sec.appendChild(camHint);
  if (library.length === 0) {
    const warn = el('div', 'hint error');
    warn.textContent = 'No RoomPieces open — switch to "PvE Room Library" and open/author some pieces first, then come back here to place them.';
    sec.appendChild(warn);
  }
  container.appendChild(sec);
}

function renderDungeonFloorSelectionSection(
  container: HTMLElement,
  doc: DungeonFloorDocument,
  library: readonly RoomPiece[],
  selection: DungeonFloorSelection,
  onAfterDelete: () => void,
): void {
  const sec = section('Selected');
  if (!selection) {
    const hint = el('div', 'hint');
    hint.textContent = 'Nothing selected — pick "Place" and a piece above, then click the canvas to drop a room instance; or pick "Door" and click two adjacent rooms.';
    sec.appendChild(hint);
    container.appendChild(sec);
    return;
  }

  if (selection.kind === 'room') {
    const room = doc.map.rooms.find((r) => r.id === selection.id);
    if (!room) {
      container.appendChild(sec);
      return;
    }
    const piece = library.find((p) => p.id === room.pieceId);
    const idRow = el('div');
    idRow.textContent = `id: ${room.id} · piece: ${room.pieceId}${piece ? ` (${piece.sizeGrid.w}×${piece.sizeGrid.h})` : ' — NOT OPEN'}`;
    idRow.className = 'hint';
    sec.appendChild(idRow);
    sec.appendChild(numberField('offsetXGrid', room.offsetXGrid, (v) => doc.mutate(() => (room.offsetXGrid = Math.round(v)))));
    sec.appendChild(numberField('offsetYGrid', room.offsetYGrid, (v) => doc.mutate(() => (room.offsetYGrid = Math.round(v)))));
  } else {
    const door = doc.map.doors[selection.index];
    if (door) {
      const idRow = el('div');
      idRow.textContent = `${door.roomA} ↔ ${door.roomB}`;
      idRow.className = 'hint';
      sec.appendChild(idRow);
      const p = door.passageGrid;
      sec.appendChild(numberField('passageGrid.x', p.x, (v) => doc.mutate(() => (p.x = Math.round(v)))));
      sec.appendChild(numberField('passageGrid.y', p.y, (v) => doc.mutate(() => (p.y = Math.round(v)))));
      sec.appendChild(numberField('passageGrid.w', p.w, (v) => doc.mutate(() => (p.w = Math.max(1, Math.round(v))))));
      sec.appendChild(numberField('passageGrid.h', p.h, (v) => doc.mutate(() => (p.h = Math.max(1, Math.round(v))))));
    }
  }

  sec.appendChild(
    button(
      'Delete selected',
      () => {
        if (!confirm('Delete selected item?')) return;
        doc.mutate((map) => {
          if (selection.kind === 'room') {
            const i = map.rooms.findIndex((r) => r.id === selection.id);
            if (i >= 0) map.rooms.splice(i, 1);
            map.doors = map.doors.filter((d) => d.roomA !== selection.id && d.roomB !== selection.id);
          } else {
            map.doors.splice(selection.index, 1);
          }
        });
        onAfterDelete();
      },
      true,
    ),
  );
  container.appendChild(sec);
}
