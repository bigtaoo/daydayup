// Split out of Game.ts, 2026-09-03 — the forge outpost's KEYBOARD routing, and the four
// verbs both it and the Loadout screen's buttons run through.
//
// The four `craft/cycle/clear/acquire` wrappers looked like pure ceremony in the shell (each
// was three lines: measure, delegate, store the result), and that is exactly why they are
// worth having in one place: they are the SINGLE source of truth for both input paths, so a
// digit key and a row tap can never diverge. `ForgeActions` (2026-08-12) owns what each verb
// does to the meta; this owns which key means which verb, and the phase guard around all of
// them.
//
// It is the only controller here that names a keyboard at all. `onKey` takes a `code` string
// rather than an event, so the table can be exercised without a DOM.
import type { Layers } from '../scene/layers';
import type { Forge } from '../screens/Forge';
import type { ForgeActions } from './ForgeActions';
import type { RunState } from '../runState';

export interface ForgeInputDeps {
  run: RunState;
  layers: Layers;
  forge: Forge;
  forgeActions: ForgeActions;
  screenSize: () => { w: number; h: number };
  /** O opens the settings overlay (a touch entry point is the SETTINGS button). */
  openSettings: () => void;
  /** Enter descends into a run — the same verb the START RUN button and Fire run. */
  confirm: () => void;
}

export class ForgeInput {
  constructor(private readonly deps: ForgeInputDeps) {}

  private fit(): { w: number; h: number } {
    return this.deps.layers.menu.fit(this.deps.screenSize());
  }

  /**
   * Apply a forge control (web keyboard, design/14). Mutates meta through the pure forge
   * transactions, persists, and re-renders. No-op outside the forge phase. Digits/C/X/B
   * route through the SAME methods the Loadout screen's buttons call — one source of truth
   * for both input paths, not duplicated logic.
   *
   * A touch forge is a follow-up (like the touch INTERACT control), which is why this is
   * guarded to the DOM at the call site and only acts in the forge phase.
   */
  onKey(code: string): void {
    if (this.deps.run.phase !== 'forge') return;
    const digit = /^Digit([1-9])$/.exec(code);
    if (digit) {
      const i = Number(digit[1]) - 1;
      if (this.deps.forge.order[i]) this.craftAt(i);
    } else if (code === 'KeyC') {
      this.cycleCharacter();
    } else if (code === 'KeyX') {
      this.clear();
    } else if (code === 'KeyB') {
      this.acquireBlueprint();
    } else if (code === 'KeyO') {
      this.deps.openSettings();
    } else if (code === 'Enter' || code === 'NumpadEnter') {
      this.deps.confirm();
    } else if (code === 'ArrowUp' || code === 'ArrowDown') {
      // Browse cursor only (design/10 compare card) — never crafts, so it can't be confused
      // with the digit keys'/row taps' immediate craft.
      const { w, h } = this.fit();
      this.deps.forgeActions.moveSelection(this.deps.run.meta, code === 'ArrowUp' ? -1 : 1, w, h);
    }
  }

  craftAt(i: number): void {
    const { w, h } = this.fit();
    this.deps.run.meta = this.deps.forgeActions.craftAt(this.deps.run.meta, i, w, h);
  }

  cycleCharacter(): void {
    const { w, h } = this.fit();
    this.deps.run.meta = this.deps.forgeActions.cycleCharacter(this.deps.run.meta, w, h);
  }

  acquireBlueprint(): void {
    const { w, h } = this.fit();
    this.deps.run.meta = this.deps.forgeActions.acquireBlueprint(this.deps.run.meta, w, h);
  }

  clear(): void {
    const { w, h } = this.fit();
    this.deps.run.meta = this.deps.forgeActions.clear(this.deps.run.meta, w, h);
  }
}
