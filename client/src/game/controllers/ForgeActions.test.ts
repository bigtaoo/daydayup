/**
 * ForgeActions (extracted from Game.ts 2026-08-12, CLAUDE.md "500-line file
 * convention") — drives a real `Forge` screen + `MemoryMetaStore` (both directly
 * unit-testable without a live Pixi renderer, per this repo's own testing
 * conventions) through the exact craft/cycle/acquire/clear/browse transactions
 * Game.ts used to inline.
 */
import { describe, it, expect } from 'vitest';
import { DOMAdapter } from 'pixi.js';
import { defaultMetaState, purchasableBlueprints, MemoryMetaStore, type MetaState } from '../../meta';
import { Forge } from '../screens/Forge';
import { ForgeActions } from './ForgeActions';

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
