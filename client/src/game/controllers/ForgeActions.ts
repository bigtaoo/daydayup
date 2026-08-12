import type { MetaState, MetaStore } from '../../meta';
import { acquireBlueprint, clearLoadout, craft, purchasableBlueprints, selectCharacter } from '../../meta';
import { SKIN_DEFS } from '@dd/engine';
import type { Forge } from '../screens/Forge';

/**
 * The forge outpost's craft/cycle-character/acquire/clear/browse actions (design/14),
 * split out of Game.ts (CLAUDE.md "500-line file convention", form ② — independent
 * class + composition: this is a single, cleanly self-contained concern with no
 * cross-boundary calls back into Game — every method here takes the current `MetaState`
 * + the current screen size as plain parameters and returns the updated `MetaState`,
 * persisting it via the injected `MetaStore` and re-rendering the injected `Forge`
 * screen itself). `Game.onForgeKey`/the Forge screen's own button callbacks call
 * straight through to these methods — one source of truth for both input paths,
 * unchanged from before the split.
 */
export class ForgeActions {
  constructor(
    private readonly forge: Forge,
    private readonly store: MetaStore,
  ) {}

  /** Craft blueprint `i` into the loadout (digit key or a Loadout-screen row tap) —
   * also moves the browse cursor onto it, so the compare card previews what was just
   * crafted. Silently ignores locked/unaffordable/full, same as before. */
  craftAt(meta: MetaState, i: number, w: number, h: number): MetaState {
    this.forge.selectedIndex = i;
    const id = this.forge.order[i];
    let next = meta;
    if (id) {
      const res = craft(meta, id);
      if (res.ok) {
        next = res.meta;
        this.store.save(next);
      }
    }
    this.forge.render(next, w, h);
    return next;
  }

  /** Advance the chosen character to the next owned one (design/14 roster select). */
  cycleCharacter(meta: MetaState, w: number, h: number): MetaState {
    const owned = meta.ownedCharacters.filter((id) => SKIN_DEFS[id]);
    const next = owned.length < 2 ? meta : selectCharacter(meta, owned[(owned.indexOf(meta.selectedSkin) + 1) % owned.length]!);
    if (next !== meta) {
      this.store.save(next);
      this.forge.render(next, w, h);
    }
    return next;
  }

  /** Acquires the first purchasable blueprint (a real gap this pass closed — the row
   *  of buyable names in the info text was always display-only; only the `KeyB`
   *  keyboard shortcut could actually trigger it, unlike every other Forge action).
   *  `demo: free grant` scaffold (2.4) — real billing is a platform adapter's job. */
  acquireBlueprint(meta: MetaState, w: number, h: number): MetaState {
    const buyable = purchasableBlueprints(meta);
    if (!buyable[0]) return meta;
    const next = acquireBlueprint(meta, buyable[0]);
    this.store.save(next);
    this.forge.render(next, w, h);
    return next;
  }

  clear(meta: MetaState, w: number, h: number): MetaState {
    const next = clearLoadout(meta);
    this.store.save(next);
    this.forge.render(next, w, h);
    return next;
  }

  /** Browse cursor only (design/10 compare card) — never crafts, so it can't be
   * confused with the digit keys'/row taps' immediate craft. */
  moveSelection(meta: MetaState, delta: number, w: number, h: number): void {
    this.forge.moveSelection(delta);
    this.forge.render(meta, w, h);
  }
}
