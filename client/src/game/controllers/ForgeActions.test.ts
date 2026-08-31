/**
 * ForgeActions (extracted from Game.ts 2026-08-12, CLAUDE.md "500-line file
 * convention") — drives a real `Forge` screen + `MemoryMetaStore` (both directly
 * unit-testable without a live Pixi renderer, per this repo's own testing
 * conventions) through the exact craft/cycle/acquire/clear/browse transactions
 * Game.ts used to inline.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { DOMAdapter } from 'pixi.js';
import { defaultMetaState, purchasableBlueprints, MemoryMetaStore, type MetaState } from '../../meta';
import { Forge } from '../screens/Forge';
import { ForgeActions } from './ForgeActions';
import { setUiAudio } from '../../audio/uiSound';

// `Forge.render()` reads `Text.height` to flow its layout, which lazily measures text
// on a real `<canvas>` 2D context — absent under this repo's plain-node vitest
// environment. Same fake-canvas `DOMAdapter` seam `Forge.test.ts` already uses (the
// glyph metrics don't matter to any assertion below, only where content visually
// flows).
DOMAdapter.set({
  ...DOMAdapter.get(),
  createCanvas: (width?: number, height?: number) => {
    const ctx = {
      font: '',
      measureText(text: string) {
        const m = /(\d+(?:\.\d+)?)px/.exec(this.font as string);
        const fontSize = m ? parseFloat(m[1]!) : 10;
        const w = text.length * fontSize * 0.6;
        return { width: w, actualBoundingBoxAscent: fontSize * 0.8, actualBoundingBoxDescent: fontSize * 0.2 };
      },
    };
    return { width: width ?? 0, height: height ?? 0, getContext: () => ctx } as unknown as HTMLCanvasElement;
  },
  getCanvasRenderingContext2D: () => class {} as unknown as typeof CanvasRenderingContext2D,
});

function craftableMeta(): MetaState {
  // repeater is a starter (drop) blueprint, cost physical×3 (see meta/forge.test.ts).
  return { ...defaultMetaState(), materialBank: { mat_physical: 4 } };
}

describe('ForgeActions', () => {
  it('craftAt: crafts an affordable blueprint, moves the browse cursor, persists, and re-renders', () => {
    const forge = new Forge();
    const store = new MemoryMetaStore();
    const actions = new ForgeActions(forge, store);
    const meta = craftableMeta();
    const i = forge.order.indexOf('repeater');
    expect(i).toBeGreaterThanOrEqual(0);

    const next = actions.craftAt(meta, i, 800, 600);

    expect(next.loadout).toEqual(['repeater']);
    expect(next.materialBank.mat_physical).toBe(1); // 4 - 3
    expect(forge.selectedIndex).toBe(i); // browse cursor moved even though this call also crafts
    expect(store.load().loadout).toEqual(['repeater']); // persisted
  });

  it('craftAt: still moves the browse cursor and re-renders on a failed craft (unaffordable), without persisting', () => {
    const forge = new Forge();
    const store = new MemoryMetaStore();
    const actions = new ForgeActions(forge, store);
    const meta = defaultMetaState(); // no materials banked
    const i = forge.order.indexOf('repeater');

    const next = actions.craftAt(meta, i, 800, 600);

    expect(next).toBe(meta); // unchanged
    expect(forge.selectedIndex).toBe(i); // cursor still moves — same as before the split
    expect(store.load()).toEqual(defaultMetaState()); // nothing persisted
  });

  it('cycleCharacter: advances to the next owned character and persists; no-ops with < 2 owned', () => {
    const forge = new Forge();
    const store = new MemoryMetaStore();
    const actions = new ForgeActions(forge, store);
    const meta = defaultMetaState();
    expect(meta.ownedCharacters.length).toBeGreaterThan(1); // the free roster has more than one

    const next = actions.cycleCharacter(meta, 800, 600);

    expect(next.selectedSkin).not.toBe(meta.selectedSkin);
    expect(next.ownedCharacters).toContain(next.selectedSkin);
    expect(store.load().selectedSkin).toBe(next.selectedSkin);

    const single = { ...meta, ownedCharacters: [meta.selectedSkin] };
    expect(actions.cycleCharacter(single, 800, 600)).toBe(single); // no-op, unchanged reference
  });

  it('acquireBlueprint: unlocks the first purchasable blueprint and persists', () => {
    const forge = new Forge();
    const store = new MemoryMetaStore();
    const actions = new ForgeActions(forge, store);
    const meta = defaultMetaState();
    const candidate = purchasableBlueprints(meta)[0];
    expect(candidate).toBeDefined();

    const next = actions.acquireBlueprint(meta, 800, 600);

    expect(next.unlockedBlueprints).toContain(candidate);
    expect(store.load().unlockedBlueprints).toContain(candidate);
  });

  it('acquireBlueprint: no-ops when nothing is purchasable', () => {
    const forge = new Forge();
    const store = new MemoryMetaStore();
    const actions = new ForgeActions(forge, store);
    let meta = defaultMetaState();
    for (const id of purchasableBlueprints(meta)) meta = { ...meta, unlockedBlueprints: [...meta.unlockedBlueprints, id] };
    expect(purchasableBlueprints(meta)).toEqual([]);

    expect(actions.acquireBlueprint(meta, 800, 600)).toBe(meta);
  });

  it('clear: empties the staged loadout and persists', () => {
    const forge = new Forge();
    const store = new MemoryMetaStore();
    const actions = new ForgeActions(forge, store);
    const meta = { ...defaultMetaState(), loadout: ['repeater'] };

    const next = actions.clear(meta, 800, 600);

    expect(next.loadout).toEqual([]);
    expect(store.load().loadout).toEqual([]);
  });

  it('moveSelection: moves the browse cursor without touching meta or the store', () => {
    const forge = new Forge();
    const store = new MemoryMetaStore();
    const actions = new ForgeActions(forge, store);
    const meta = defaultMetaState();
    const before = forge.selectedIndex;

    actions.moveSelection(meta, 1, 800, 600);

    expect(forge.selectedIndex).not.toBe(before);
    expect(store.load()).toEqual(defaultMetaState()); // untouched
  });
});

/**
 * The UI cue this controller owns (design/11 UI cues, 2026-08-30). Every other button in the
 * client gets its click from the widget (`ui/widgets.ts`), because pressing it always does
 * something. These two do not: a craft can be unaffordable, locked or on a full loadout, and
 * ACQUIRE can have nothing left to buy. So both are built `sound: 'silent'` and the sound is
 * chosen HERE, from the outcome — otherwise a press that changes nothing is audibly identical
 * to one that works, which is the state this pass found the forge in.
 */
describe('ForgeActions — the UI cue follows the outcome', () => {
  function recorder() {
    const log: string[] = [];
    setUiAudio({
      preload: async () => {}, play: (cue) => { log.push(cue); },
      setSfxVolume: () => {}, setMusicVolume: () => {}, updateMusic: () => {}, resume: () => {},
    });
    return log;
  }

  afterEach(() => setUiAudio(null));

  it('craftAt: ui.tap when the craft lands', () => {
    const log = recorder();
    const forge = new Forge();
    const actions = new ForgeActions(forge, new MemoryMetaStore());
    actions.craftAt(craftableMeta(), forge.order.indexOf('repeater'), 800, 600);
    expect(log).toEqual(['ui.tap']);
  });

  it('craftAt: ui.denied when it cannot be afforded', () => {
    const log = recorder();
    const forge = new Forge();
    const actions = new ForgeActions(forge, new MemoryMetaStore());
    actions.craftAt(defaultMetaState(), forge.order.indexOf('repeater'), 800, 600);
    expect(log).toEqual(['ui.denied']);
  });

  it('craftAt: ui.denied on an empty row, where there is no blueprint at all', () => {
    // The row taps are bounds-guarded upstream, but the digit keys reach this directly.
    const log = recorder();
    const forge = new Forge();
    const actions = new ForgeActions(forge, new MemoryMetaStore());
    actions.craftAt(craftableMeta(), forge.order.length + 5, 800, 600);
    expect(log).toEqual(['ui.denied']);
  });

  it('acquireBlueprint: ui.tap when something was acquired, ui.denied when the shelf is empty', () => {
    const log = recorder();
    const forge = new Forge();
    const actions = new ForgeActions(forge, new MemoryMetaStore());
    let meta = defaultMetaState();
    expect(purchasableBlueprints(meta).length).toBeGreaterThan(0);
    // Buy everything on offer, then press once more against an empty shelf.
    while (purchasableBlueprints(meta).length > 0) meta = actions.acquireBlueprint(meta, 800, 600);
    const bought = log.length;
    expect(log.every((c) => c === 'ui.tap')).toBe(true);
    const after = actions.acquireBlueprint(meta, 800, 600);
    expect(after).toBe(meta); // nothing changed...
    expect(log.slice(bought)).toEqual(['ui.denied']); // ...and it says so
  });

  it('says nothing at all with no audio attached — the forge still works headless', () => {
    setUiAudio(null);
    const forge = new Forge();
    const actions = new ForgeActions(forge, new MemoryMetaStore());
    expect(() => actions.craftAt(craftableMeta(), forge.order.indexOf('repeater'), 800, 600)).not.toThrow();
  });
});
