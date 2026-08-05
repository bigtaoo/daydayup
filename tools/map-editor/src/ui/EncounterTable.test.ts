import { describe, it, expect, vi, afterEach } from 'vitest';
import type { RoomPiece } from '@dd/engine';
import { installFakeDom, FakeElement, findAllByTag } from './fakeDom';
import { RoomDocument } from '../state/RoomDocument';
import { RoomPieceTarget } from '../canvas/RoomEditTarget';
import { renderEncounterTable } from './EncounterTable';

afterEach(() => vi.unstubAllGlobals());

function blankPiece(): RoomPiece {
  return {
    id: 'room_1',
    sizeGrid: { w: 20, h: 20 },
    solids: [],
    spawns: { player: [], enemy: [] },
    exits: [],
  };
}

function buildTarget(piece: RoomPiece) {
  const doc = new RoomDocument(piece);
  const target = new RoomPieceTarget(doc);
  return { doc, target };
}

function container(): FakeElement {
  return new FakeElement('div') as unknown as FakeElement;
}

describe('renderEncounterTable — no spawns, no entries', () => {
  it('shows a hint instead of a table and skips the add button entirely', () => {
    installFakeDom();
    const { target } = buildTarget(blankPiece());
    const root = container();

    renderEncounterTable(root as unknown as HTMLElement, target);

    expect(findAllByTag(root, 'table')).toHaveLength(0);
    expect(findAllByTag(root, 'button')).toHaveLength(0);
    const hint = findAllByTag(root, 'div').find((d) => d.className === 'hint');
    expect(hint!.textContent).toBe('Place at least one enemy spawn before authoring an encounter.');
  });
});

describe('renderEncounterTable — spawns present, no entries yet', () => {
  it('renders no table but offers "+ Add wave entry"', () => {
    installFakeDom();
    const piece = blankPiece();
    piece.spawns.enemy.push({ x: 1, y: 2 });
    const { target } = buildTarget(piece);
    const root = container();

    renderEncounterTable(root as unknown as HTMLElement, target);

    expect(findAllByTag(root, 'table')).toHaveLength(0);
    const buttons = findAllByTag(root, 'button');
    expect(buttons).toHaveLength(1);
    expect(buttons[0]!.textContent).toBe('+ Add wave entry');
  });

  it('adding an entry creates a WaveScript pointed at spawn 0 with the first enemy type', () => {
    installFakeDom();
    const piece = blankPiece();
    piece.spawns.enemy.push({ x: 1, y: 2 });
    const { target } = buildTarget(piece);
    const root = container();
    renderEncounterTable(root as unknown as HTMLElement, target);

    const addBtn = findAllByTag(root, 'button')[0]!;
    addBtn.onclick!();

    expect(piece.encounter).toEqual({
      entries: [{ atTick: 0, enemyType: 'basic', spawnPoint: 0, count: 1 }],
    });
  });
});

describe('renderEncounterTable — entries present, no spawns left (dangling)', () => {
  it('falls back to a raw number input for spawnPoint and a "place a spawn" hint instead of the add button', () => {
    installFakeDom();
    const piece = blankPiece();
    piece.encounter = { entries: [{ atTick: 0, enemyType: 'basic', spawnPoint: 0, count: 1 }] };
    const { target } = buildTarget(piece);
    const root = container();

    renderEncounterTable(root as unknown as HTMLElement, target);

    expect(findAllByTag(root, 'table')).toHaveLength(1);
    expect(findAllByTag(root, 'select')).toHaveLength(1); // just the enemyType select, no spawnPoint select
    expect(findAllByTag(root, 'button')).toHaveLength(1); // just the delete button — no add
    const hint = findAllByTag(root, 'div').find((d) => d.className === 'hint');
    expect(hint!.textContent).toBe('Place an enemy spawn to add a new wave entry.');
  });
});

describe('renderEncounterTable — a normal entry with spawns available', () => {
  function setup() {
    const piece = blankPiece();
    piece.spawns.enemy.push({ x: 1, y: 2 }, { x: 3, y: 4 });
    piece.encounter = {
      entries: [{ atTick: 10, enemyType: 'basic', spawnPoint: 1, count: 2, spacingTicks: 5, isBoss: false }],
    };
    const { target } = buildTarget(piece);
    const root = container();
    renderEncounterTable(root as unknown as HTMLElement, target);
    return { piece, target, root };
  }

  it('renders one row with no error class (spawnPoint is in range)', () => {
    installFakeDom();
    const { root } = setup();
    // tbody has exactly one <tr> (the header row lives inside <thead>, set via innerHTML,
    // so it never shows up as a fake child element at all).
    const tbodyRows = findAllByTag(findAllByTag(root, 'tbody')[0]!, 'tr');
    expect(tbodyRows).toHaveLength(1);
    expect(tbodyRows[0]!.hasClass('error')).toBe(false);
  });

  it('offers a spawnPoint <select> with one <option> per spawn, selecting the current one', () => {
    installFakeDom();
    const { root } = setup();
    const selects = findAllByTag(root, 'select');
    // selects[0] = enemyType, selects[1] = spawnPoint
    const spawnSelect = selects[1]!;
    expect(spawnSelect.children).toHaveLength(2);
    expect(spawnSelect.children.map((o) => o.selected)).toEqual([false, true]);
  });

  it('editing atTick mutates that entry only', () => {
    installFakeDom();
    const { piece, root } = setup();
    const atTickInput = findAllByTag(root, 'input').find((i) => i.type === 'number' && i.value === '10')!;
    atTickInput.value = '99';
    atTickInput.onchange!();
    expect(piece.encounter!.entries[0]!.atTick).toBe(99);
  });

  it('editing enemyType via its <select> mutates the entry', () => {
    installFakeDom();
    const { piece, root } = setup();
    const enemySelect = findAllByTag(root, 'select')[0]!;
    enemySelect.value = 'brute';
    enemySelect.onchange!();
    expect(piece.encounter!.entries[0]!.enemyType).toBe('brute');
  });

  it('editing spawnPoint via its <select> mutates the entry', () => {
    installFakeDom();
    const { piece, root } = setup();
    const spawnSelect = findAllByTag(root, 'select')[1]!;
    spawnSelect.value = '0';
    spawnSelect.onchange!();
    expect(piece.encounter!.entries[0]!.spawnPoint).toBe(0);
  });

  it('editing count floors at 1', () => {
    installFakeDom();
    const { piece, root } = setup();
    const countInput = findAllByTag(root, 'input').find((i) => i.min === '1')!;
    countInput.value = '0';
    countInput.onchange!();
    expect(piece.encounter!.entries[0]!.count).toBe(1);
  });

  it('editing spacingTicks mutates the entry', () => {
    installFakeDom();
    const { piece, root } = setup();
    const spacingInput = findAllByTag(root, 'input').find((i) => i.type === 'number' && i.value === '5')!;
    spacingInput.value = '20';
    spacingInput.onchange!();
    expect(piece.encounter!.entries[0]!.spacingTicks).toBe(20);
  });

  it('toggling the boss checkbox mutates isBoss', () => {
    installFakeDom();
    const { piece, root } = setup();
    const bossCheckbox = findAllByTag(root, 'input').find((i) => i.type === 'checkbox')!;
    bossCheckbox.checked = true;
    bossCheckbox.onchange!();
    expect(piece.encounter!.entries[0]!.isBoss).toBe(true);
  });

  it('clicking the row delete button removes just that entry', () => {
    installFakeDom();
    const { piece, root } = setup();
    const delBtn = findAllByTag(root, 'button').find((b) => b.textContent === '✕')!;
    delBtn.onclick!();
    expect(piece.encounter!.entries).toHaveLength(0);
  });

  it('the "+ Add wave entry" button is still offered alongside the table', () => {
    installFakeDom();
    const { root } = setup();
    const addBtn = findAllByTag(root, 'button').find((b) => b.textContent === '+ Add wave entry');
    expect(addBtn).toBeDefined();
  });
});

describe('renderEncounterTable — an entry whose spawnPoint is out of range (dangling reference)', () => {
  it('flags the row as an error and prepends a disabled-looking "(invalid)" option, selected', () => {
    installFakeDom();
    const piece = blankPiece();
    piece.spawns.enemy.push({ x: 1, y: 2 });
    piece.encounter = { entries: [{ atTick: 0, enemyType: 'basic', spawnPoint: 5, count: 1 }] };
    const { target } = buildTarget(piece);
    const root = container();

    renderEncounterTable(root as unknown as HTMLElement, target);

    const tbodyRow = findAllByTag(findAllByTag(root, 'tbody')[0]!, 'tr')[0]!;
    expect(tbodyRow.hasClass('error')).toBe(true);

    const spawnSelect = findAllByTag(root, 'select')[1]!;
    // The real spawn (#0) plus the prepended invalid option for #5.
    expect(spawnSelect.children).toHaveLength(2);
    expect(spawnSelect.children[0]!.textContent).toBe('#5 (invalid)');
    expect(spawnSelect.children[0]!.selected).toBe(true);
  });

  it('still lets the row be deleted even though it is out of range', () => {
    installFakeDom();
    const piece = blankPiece();
    piece.spawns.enemy.push({ x: 1, y: 2 });
    piece.encounter = { entries: [{ atTick: 0, enemyType: 'basic', spawnPoint: 5, count: 1 }] };
    const { target } = buildTarget(piece);
    const root = container();
    renderEncounterTable(root as unknown as HTMLElement, target);

    const delBtn = findAllByTag(root, 'button').find((b) => b.textContent === '✕')!;
    delBtn.onclick!();

    expect(piece.encounter!.entries).toHaveLength(0);
  });
});
