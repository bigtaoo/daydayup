import { ENEMY_BLUEPRINTS } from '@dd/engine';
import type { RoomEditTarget } from '../canvas/RoomEditTarget';
import { button, el, section } from './fields';

const ENEMY_TYPE_IDS = Object.keys(ENEMY_BLUEPRINTS);

/** A simple table editor for a room's WaveScript.entries — a deliberate
 * simplification vs. a drag-timeline (see the plan): materially cheaper to
 * build, fully covers the schema, and atTick/spacingTicks are exact tick
 * integers anyway.
 *
 * Existing entries always render (and stay deletable) even with zero enemy
 * spawns placed — e.g. after deleting a spawn a WaveEntry referenced, leaving
 * a dangling spawnPoint index validate.ts flags at save time. Only *adding* a
 * new entry requires a spawn to point it at. */
export function renderEncounterTable(container: HTMLElement, target: RoomEditTarget): void {
  const sec = section('Encounter (WaveScript)');
  const enemySpawns = target.getEnemySpawns();
  const entries = target.getEncounter()?.entries ?? [];

  if (entries.length === 0 && enemySpawns.length === 0) {
    const hint = el('div', 'hint');
    hint.textContent = 'Place at least one enemy spawn before authoring an encounter.';
    sec.appendChild(hint);
    container.appendChild(sec);
    return;
  }

  if (entries.length > 0) {
    const table = el('table');
    const thead = el('thead');
    thead.innerHTML = '<tr><th>atTick</th><th>enemyType</th><th>spawnPt</th><th>count</th><th>spacing</th><th>boss</th><th></th></tr>';
    table.appendChild(thead);
    const tbody = el('tbody');

    entries.forEach((entry, i) => {
      const tr = el('tr');
      const outOfRange = entry.spawnPoint < 0 || entry.spawnPoint >= enemySpawns.length;
      if (outOfRange) tr.classList.add('error');

      const atTick = el('input');
      atTick.type = 'number';
      atTick.value = String(entry.atTick);
      atTick.onchange = () => target.mutate(() => (target.getEncounter()!.entries[i]!.atTick = Number(atTick.value) || 0));

      const enemyType = el('select');
      for (const id of ENEMY_TYPE_IDS) {
        const o = document.createElement('option');
        o.value = id;
        o.textContent = id;
        if (id === entry.enemyType) o.selected = true;
        enemyType.appendChild(o);
      }
      enemyType.onchange = () => target.mutate(() => (target.getEncounter()!.entries[i]!.enemyType = enemyType.value));

      let spawnPointEl: HTMLElement;
      if (enemySpawns.length > 0) {
        const spawnPoint = el('select');
        enemySpawns.forEach((sp, spIdx) => {
          const o = document.createElement('option');
          o.value = String(spIdx);
          o.textContent = `#${spIdx} (${sp.x},${sp.y})`;
          if (spIdx === entry.spawnPoint) o.selected = true;
          spawnPoint.appendChild(o);
        });
        if (outOfRange) {
          const o = document.createElement('option');
          o.value = String(entry.spawnPoint);
          o.textContent = `#${entry.spawnPoint} (invalid)`;
          o.selected = true;
          spawnPoint.insertBefore(o, spawnPoint.firstChild);
        }
        spawnPoint.onchange = () => target.mutate(() => (target.getEncounter()!.entries[i]!.spawnPoint = Number(spawnPoint.value)));
        spawnPointEl = spawnPoint;
      } else {
        // No spawns left at all — fall back to a raw number input so the
        // dangling index is still visible/fixable (and the row stays deletable).
        const input = el('input');
        input.type = 'number';
        input.value = String(entry.spawnPoint);
        input.onchange = () => target.mutate(() => (target.getEncounter()!.entries[i]!.spawnPoint = Number(input.value) || 0));
        spawnPointEl = input;
      }

      const count = el('input');
      count.type = 'number';
      count.min = '1';
      count.value = String(entry.count);
      count.onchange = () => target.mutate(() => (target.getEncounter()!.entries[i]!.count = Math.max(1, Number(count.value) || 1)));

      const spacing = el('input');
      spacing.type = 'number';
      spacing.value = String(entry.spacingTicks ?? 0);
      spacing.onchange = () => target.mutate(() => (target.getEncounter()!.entries[i]!.spacingTicks = Number(spacing.value) || 0));

      const boss = el('input');
      boss.type = 'checkbox';
      boss.checked = !!entry.isBoss;
      boss.onchange = () => target.mutate(() => (target.getEncounter()!.entries[i]!.isBoss = boss.checked));

      const del = button('✕', () => target.mutate(() => target.getEncounter()!.entries.splice(i, 1)), true);

      for (const cellEl of [atTick, enemyType, spawnPointEl, count, spacing, boss, del]) {
        const td = el('td');
        td.appendChild(cellEl);
        tr.appendChild(td);
      }
      tbody.appendChild(tr);
    });

    table.appendChild(tbody);
    sec.appendChild(table);
  }

  if (enemySpawns.length > 0) {
    sec.appendChild(
      button('+ Add wave entry', () =>
        target.mutate(() => {
          target.ensureEncounter().entries.push({ atTick: 0, enemyType: ENEMY_TYPE_IDS[0] ?? 'basic', spawnPoint: 0, count: 1 });
        }),
      ),
    );
  } else {
    const hint = el('div', 'hint');
    hint.textContent = 'Place an enemy spawn to add a new wave entry.';
    sec.appendChild(hint);
  }

  container.appendChild(sec);
}
