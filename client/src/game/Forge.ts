import { Container, Text } from 'pixi.js';
import {
  BLUEPRINT_CATALOG, SKIN_DEFS, DAMAGE_TYPES, PLAYER_BASE, WEAPON_SPECS, RARITY_TIERS,
  type WeaponBlueprint, type DamageType,
} from '@dd/engine';
import type { MetaState } from '../meta';
import { bankTotal, canAfford, isUnlocked, purchasableBlueprints } from '../meta';
import { Panel, Button } from './ui/widgets';
import { CompareCard, buildCompareRows, equippedSpecOfKind } from './ui/compareCard';
import { pageCount, pageStartForIndex, clampPageStart, wrapIndex } from './ui/paging';
import { RARITY_COLORS } from './config';

/** Rows shown at once (`BLUEPRINT_CATALOG` has more entries than fit above the fixed
 * bottom action bar — a real overflow found while wiring up real Buttons, since the old
 * text board just let everything spill past the screen uncorrected). Paged, not
 * scrolled — simpler, and the existing arrow-key browse cursor already gives a
 * keyboard-only way to reach any entry (it flips pages to keep the cursor visible). */
const PAGE_SIZE = 8;

/**
 * The forge outpost (design/14, ROADMAP 2.2/2.3) — the between-run hub where the player
 * spends banked materials to craft weapons for the next run and picks a character. Pure
 * presentation: it reads a MetaState and renders it; all mutation goes through the meta/
 * forge transactions, driven by Game via the `onX` callbacks below (same pattern as
 * PauseMenu.ts/Settings.ts) — the keyboard path (Game's `onForgeKey`) drives the exact
 * same underlying Game methods as these buttons, so both input paths stay in sync by
 * construction rather than by duplicated logic. Clickable rows replace the old
 * keyboard-only text board (design/10's screen-flow gap); the keyboard shortcuts still
 * work unchanged as a second input path.
 */
export class Forge {
  readonly view = new Container();
  private panel = new Panel({ alpha: 0.82 });
  private title: Text;
  private infoText: Text;
  private hint: Text;
  private pageLabel: Text;
  private backBtn: Button;
  private prevCharBtn: Button;
  private nextCharBtn: Button;
  private charText: Text;
  private clearBtn: Button;
  private startBtn: Button;
  private prevPageBtn: Button;
  private nextPageBtn: Button;
  /** Fixed pool of PAGE_SIZE row buttons, reused across pages (relabeled + shown/hidden
   * per render) rather than one button per catalog entry — keeps the widget count
   * bounded regardless of how many blueprints exist. */
  private rowBtns: Button[];
  private compareCard = new CompareCard();

  // Cached from the last render() call so the page-nav buttons (pure browse, no meta
  // mutation) can re-render themselves without needing a Game-level round-trip.
  private lastMeta: MetaState | null = null;
  private lastW = 0;
  private lastH = 0;

  /** Stable blueprint order = display order = the number key that crafts each of the
   * first PAGE_SIZE entries (design/10 loadout-detail decision). */
  readonly order: string[] = Object.keys(BLUEPRINT_CATALOG);

  /** Cursor over `order` (design/10's open "how much detail to show" question — an
   * arrow-key browse cursor OR a row tap moves it, so a player can preview a
   * blueprint's stats via the compare card without necessarily committing materials). */
  selectedIndex = 0;
  private pageStart = 0;

  onBack: (() => void) | null = null;
  /** Both the ‹ and › buttons drive this — the underlying roster cycle (Game.ts's
   * `cycleCharacter`) is forward-only today; a true reverse cycle is a follow-up, not
   * something to invent here. */
  onCycleCharacter: (() => void) | null = null;
  onClear: (() => void) | null = null;
  onStart: (() => void) | null = null;
  /** Tapping a row both previews (moves `selectedIndex`) AND crafts it — one tap, no
   * separate select-then-confirm step (design/10's "favor fewer, clearer actions"
   * clutter decision). */
  onCraftAt: ((i: number) => void) | null = null;

  constructor() {
    // `padding` guards against a real observed font-metrics clipping bug (see
    // widgets.ts's Button doc comment for the full explanation).
    this.title = new Text({ text: 'FORGE OUTPOST', style: { fill: 0xf7fafc, fontSize: 30, fontWeight: 'bold', fontFamily: 'sans-serif', padding: 16 } });
    this.title.anchor.set(0.5, 0);
    this.infoText = new Text({ text: '', style: { fill: 0xcbd5e0, fontSize: 14, fontFamily: 'monospace', lineHeight: 20, align: 'center', padding: 24 } });
    this.infoText.anchor.set(0.5, 0);
    this.hint = new Text({ text: '[↑↓]/[1-9]/[C]/[X]/[Enter] keyboard shortcuts still work', style: { fill: 0x90cdf4, fontSize: 12, fontFamily: 'monospace', padding: 34 } });
    this.hint.anchor.set(0.5, 1);
    this.pageLabel = new Text({ text: '', style: { fill: 0x90cdf4, fontSize: 12, fontFamily: 'monospace', padding: 14 } });
    this.pageLabel.anchor.set(0.5);

    this.backBtn = new Button('← MENU', { w: 90, h: 30, fontSize: 12 });
    this.backBtn.onTap = () => this.onBack?.();

    this.charText = new Text({ text: '', style: { fill: 0xf7fafc, fontSize: 17, fontFamily: 'monospace', fontWeight: 'bold', padding: 18 } });
    this.charText.anchor.set(0.5);
    this.prevCharBtn = new Button('‹', { w: 32, h: 30, fontSize: 16 });
    this.prevCharBtn.onTap = () => this.onCycleCharacter?.();
    this.nextCharBtn = new Button('›', { w: 32, h: 30, fontSize: 16 });
    this.nextCharBtn.onTap = () => this.onCycleCharacter?.();

    this.rowBtns = Array.from({ length: PAGE_SIZE }, (_, slot) => {
      const b = new Button('', { w: 560, h: 30, fontSize: 12 });
      b.onTap = () => {
        const i = this.pageStart + slot;
        if (this.order[i] !== undefined) this.onCraftAt?.(i);
      };
      return b;
    });

    this.prevPageBtn = new Button('‹ PAGE', { w: 80, h: 26, fontSize: 11 });
    this.prevPageBtn.onTap = () => this.turnPage(-1);
    this.nextPageBtn = new Button('PAGE ›', { w: 80, h: 26, fontSize: 11 });
    this.nextPageBtn.onTap = () => this.turnPage(1);

    this.clearBtn = new Button('CLEAR LOADOUT', { w: 160, h: 30, fontSize: 12 });
    this.clearBtn.onTap = () => this.onClear?.();
    this.startBtn = new Button('START RUN ▸', { w: 220, h: 44, fontSize: 17 });
    this.startBtn.onTap = () => this.onStart?.();

    this.view.addChild(
      this.panel.view, this.title, this.backBtn.view,
      this.prevCharBtn.view, this.charText, this.nextCharBtn.view,
      this.infoText,
      ...this.rowBtns.map((b) => b.view),
      this.prevPageBtn.view, this.pageLabel, this.nextPageBtn.view,
      this.clearBtn.view, this.compareCard.view, this.startBtn.view, this.hint,
    );
    this.view.eventMode = 'static';
    this.view.visible = false;
  }

  private turnPage(delta: number) {
    this.pageStart = clampPageStart(this.pageStart, delta, this.order.length, PAGE_SIZE);
    if (this.lastMeta) this.render(this.lastMeta, this.lastW, this.lastH);
  }

  /** Move the browse cursor, wrapping at both ends, and flip pages to keep it visible. */
  moveSelection(delta: number) {
    this.selectedIndex = wrapIndex(this.selectedIndex, delta, this.order.length);
    this.pageStart = pageStartForIndex(this.selectedIndex, PAGE_SIZE);
  }

  private costText(cost: readonly WeaponBlueprint['cost'][number][]): string {
    // Show the tier gate when a cost demands it (design/14): FIR×2≥t2 = two fire mats of
    // tier ≥ 2. Un-gated costs (minTier 0/absent) read as before.
    return cost.map((c) => `${short(c.element)}×${c.qty}${c.minTier ? `≥t${c.minTier}` : ''}`).join(' ');
  }

  render(m: MetaState, w: number, h: number) {
    this.lastMeta = m;
    this.lastW = w;
    this.lastH = h;
    this.panel.layout(w, h);

    // Material bank — the five elemental kinds (design/14), summed across every rolled tier.
    const bank = DAMAGE_TYPES.map((e) => `${short(e)} ${bankTotal(m, e)}`).join('   ');

    const skin = SKIN_DEFS[m.selectedSkin];
    this.charText.text = skin ? `${m.selectedSkin}  (${skin.maxHp}HP / ${skin.maxShield}SH)` : m.selectedSkin;

    const loadout = m.loadout.length ? m.loadout.join(', ') : '(none → auto pistol)';
    const buyable = purchasableBlueprints(m);
    this.infoText.text =
      `Materials   ${bank}   |   owned chars: ${m.ownedCharacters.length}\n` +
      `Loadout     ${loadout}   (${m.loadout.length}/${PLAYER_BASE.weaponSlots})` +
      (buyable.length ? `\nStore (demo: free): ${buyable.join(', ')}  — [B] acquire next` : '');

    // Blueprint rows — [n] id  cost  status. A leading '»' marks the browse
    // cursor (moveSelection / a row tap) — independent of '▸staged', which marks a
    // crafted slot. Only the current page's slice is shown; unused trailing slots on a
    // partial last page are hidden.
    this.rowBtns.forEach((btn, slot) => {
      const i = this.pageStart + slot;
      const id = this.order[i];
      if (id === undefined) {
        btn.view.visible = false;
        return;
      }
      btn.view.visible = true;
      const bp = BLUEPRINT_CATALOG[id]!;
      const unlocked = isUnlocked(m, id);
      const staged = m.loadout.filter((x) => x === id).length;
      const affordable = canAfford(m, bp);
      const status = !unlocked
        ? (bp.source === 'drop' ? 'locked (find it)' : `locked (${bp.source})`)
        : affordable ? 'craftable' : 'need materials';
      const stagedTag = staged > 0 ? `  ▸staged×${staged}` : '';
      const cursor = i === this.selectedIndex ? '»' : ' ';
      const key = i < 9 ? `${i + 1}` : '·'; // only the first 9 have a digit-key shortcut
      btn.setText(`${cursor}[${key}] ${id.padEnd(11)} ${this.costText(bp.cost).padEnd(14)} ${status}${stagedTag}`);
    });
    this.pageLabel.text = `Page ${Math.floor(this.pageStart / PAGE_SIZE) + 1}/${pageCount(this.order.length, PAGE_SIZE)}`;

    // Layout: title top, back button top-left corner, character row, info block,
    // paged blueprint rows, clear/compare/start stacked bottom-up.
    const cx = w / 2;
    let y = Math.max(20, h * 0.05);
    this.title.position.set(cx, y);
    this.backBtn.view.position.set(16, 16);
    y += 44;
    this.prevCharBtn.view.position.set(cx - 150, y);
    this.charText.position.set(cx, y + 15);
    this.nextCharBtn.view.position.set(cx + 118, y);
    y += 44;
    this.infoText.position.set(cx, y);
    y += this.infoText.height + 14;
    for (const b of this.rowBtns) {
      b.view.position.set(cx - 280, y);
      y += 32;
    }
    this.prevPageBtn.view.position.set(cx - 280, y);
    this.pageLabel.position.set(cx, y + 13);
    this.nextPageBtn.view.position.set(cx + 200, y);
    y += 40;
    this.clearBtn.view.position.set(cx - 280, y);
    y += 40;
    const cardShown = this.renderCompareCard(m, cx, y);
    y += (cardShown ? this.compareCard.view.height + 24 : 0);
    this.startBtn.view.position.set(cx - 110, Math.min(y, h - 70));
    this.hint.position.set(cx, h - 8);

    this.view.visible = true;
  }

  /** design/10's loadout-detail decision: the browse cursor's blueprint vs whichever
   * loadout entry shares its weapon kind (empty loadout falls back to the auto-equip
   * pair, mirroring the board's own "(none → auto pistol)" text). Hidden when there's
   * no same-kind comparator (e.g. loadout already has 2 of the other kind) — nothing
   * useful to diff against. */
  private renderCompareCard(m: MetaState, cx: number, y: number): boolean {
    const candidateId = this.order[this.selectedIndex];
    const candidate = candidateId ? WEAPON_SPECS[BLUEPRINT_CATALOG[candidateId]!.weaponId] : undefined;
    const effectiveLoadout = m.loadout.length ? m.loadout : PLAYER_BASE.startWeapons.map((s) => s.name);
    const equipped = candidate ? equippedSpecOfKind(effectiveLoadout, candidate.kind) : undefined;
    const rows = candidate && equipped ? buildCompareRows(equipped, candidate) : null;

    if (!candidate || !equipped || !rows) {
      this.compareCard.hide();
      return false;
    }
    this.compareCard.set({
      w: Math.min(420, cx * 2 - 48),
      leftName: `Equipped: ${equipped.id}`,
      leftColor: RARITY_COLORS[RARITY_TIERS[equipped.rarity].colorKey],
      rightName: `Candidate: ${candidate.id}`,
      rightColor: RARITY_COLORS[RARITY_TIERS[candidate.rarity].colorKey],
      rows,
    });
    this.compareCard.view.position.set(cx - this.compareCard.view.width / 2, y);
    return true;
  }

  hide() {
    this.view.visible = false;
  }
}

/** Short element tag for the material board (physical→PHY, fire→FIR, …). */
function short(e: DamageType): string {
  return e.slice(0, 3).toUpperCase();
}
