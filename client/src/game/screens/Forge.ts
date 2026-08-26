import { Container, Sprite, Text } from 'pixi.js';
import {
  BLUEPRINT_CATALOG, SKIN_DEFS, DAMAGE_TYPES, PLAYER_BASE, WEAPON_SPECS, RARITY_TIERS, resolveLoadout,
  type WeaponBlueprint,
} from '@dd/engine';
import type { MetaState } from '../../meta';
import { bankTotal, canAfford, isUnlocked, purchasableBlueprints } from '../../meta';
import { Panel, Button } from '../ui/widgets';
import { BlueprintCard } from '../ui/BlueprintCard';
import { CompareCard, buildCompareRows, equippedSpecOfKind } from '../ui/compareCard';
import { pageCount, pageStartForIndex, clampPageStart, wrapIndex } from '../ui/paging';
import { RARITY_COLORS } from '../theme';
import { getWeaponTexture } from '../../render/weaponSkins';
import { getUiTexture } from '../../render/uiSkins';
import { t, tName } from '../../i18n';
import { ELEMENT_SHORT_KEY, SOURCE_KEY } from '../../i18n/contentKeys';

/** Cards shown at once (`BLUEPRINT_CATALOG` has more entries than fit above the fixed
 * bottom action bar — a real overflow found while wiring up real Buttons, since the old
 * text board just let everything spill past the screen uncorrected). Paged, not
 * scrolled — simpler, and the existing arrow-key browse cursor already gives a
 * keyboard-only way to reach any entry (it flips pages to keep the cursor visible).
 * `GRID_COLS` fills PAGE_SIZE into a 4×2 icon-card grid (below), not a vertical list. */
const PAGE_SIZE = 8;
const GRID_COLS = 4;
const GRID_GAP_X = 14;
const GRID_GAP_Y = 14;
const GRID_ROWS = Math.ceil(PAGE_SIZE / GRID_COLS);
const GRID_W = GRID_COLS * BlueprintCard.W + (GRID_COLS - 1) * GRID_GAP_X;
const GRID_H = GRID_ROWS * BlueprintCard.H + (GRID_ROWS - 1) * GRID_GAP_Y;

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
  private panel = new Panel({ alpha: 0.82, background: 'hub' });
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
  private acquireBtn: Button;
  private prevPageBtn: Button;
  private nextPageBtn: Button;
  /** Fixed pool of PAGE_SIZE icon cards, reused across pages (relabeled + shown/hidden
   * per render) rather than one card per catalog entry — keeps the widget count
   * bounded regardless of how many blueprints exist. Laid out as a `GRID_COLS`-wide
   * grid, not a vertical list (design/14 icon-card pass). */
  private rowCards: BlueprintCard[];
  private compareCard = new CompareCard();
  /** The forger NPC (design/13's "Outpost/hub" NPC gap) — decorative, corner-anchored
   * art, hidden until its texture is generated (uiSkins.ts's non-blocking preload) and
   * hidden again on any viewport too narrow to fit it beside the centered row column
   * without overlapping (mirrors renderCompareCard's own no-room-hide check below). */
  private npcSprite = new Sprite();

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
  /** Acquires the first purchasable blueprint (`purchasableBlueprints`'s own order — a
   * real gap this pass closed: the `buyableText` line below was always display-only,
   * with no tap equivalent to the keyboard's `KeyB`, unlike every other Forge action).
   * `demo: free grant` scaffold, same as the keyboard path (2.4). */
  onAcquire: (() => void) | null = null;

  constructor() {
    // `padding` guards against a real observed font-metrics clipping bug (see
    // widgets.ts's Button doc comment for the full explanation).
    this.title = new Text({ text: t('forge.title'), style: { fill: 0xf7fafc, fontSize: 30, fontWeight: 'bold', fontFamily: 'sans-serif', padding: 16 } });
    this.title.anchor.set(0.5, 0);
    // wordWrap: the buyable-blueprint list appended below (`Store (demo: free): ...`)
    // has no fixed length — without wrapping it was a real bug, running off both
    // edges of the screen as one unbroken line instead of staying inside the panel.
    // breakWords: defense-in-depth for CJK locales (design/17-i18n.md) — Pixi's
    // wordWrap only breaks at whitespace, so a translated line with no natural break
    // point would otherwise overflow instead of wrapping; today's actual copy is
    // already length-capped (see `buyableText` below) so this isn't a live bug, but
    // costs nothing to guard against a future longer translated line doing the same.
    this.infoText = new Text({ text: '', style: { fill: 0xcbd5e0, fontSize: 14, fontFamily: 'monospace', lineHeight: 20, align: 'center', padding: 24, wordWrap: true, wordWrapWidth: 760, breakWords: true } });
    this.infoText.anchor.set(0.5, 0);
    this.hint = new Text({ text: t('forge.hint'), style: { fill: 0x90cdf4, fontSize: 12, fontFamily: 'monospace', padding: 10 } });
    this.hint.anchor.set(0.5, 1);
    this.pageLabel = new Text({ text: '', style: { fill: 0x90cdf4, fontSize: 12, fontFamily: 'monospace', padding: 14 } });
    this.pageLabel.anchor.set(0.5);

    this.backBtn = new Button(t('forge.backButton'), { w: 90, h: 30, fontSize: 12 });
    this.backBtn.onTap = () => this.onBack?.();

    this.charText = new Text({ text: '', style: { fill: 0xf7fafc, fontSize: 17, fontFamily: 'monospace', fontWeight: 'bold', padding: 18 } });
    this.charText.anchor.set(0.5);
    this.prevCharBtn = new Button('‹', { w: 32, h: 30, fontSize: 16 });
    this.prevCharBtn.onTap = () => this.onCycleCharacter?.();
    this.nextCharBtn = new Button('›', { w: 32, h: 30, fontSize: 16 });
    this.nextCharBtn.onTap = () => this.onCycleCharacter?.();

    this.rowCards = Array.from({ length: PAGE_SIZE }, (_, slot) => {
      const c = new BlueprintCard();
      c.onTap = () => {
        const i = this.pageStart + slot;
        if (this.order[i] !== undefined) this.onCraftAt?.(i);
      };
      return c;
    });

    this.prevPageBtn = new Button(t('forge.pagePrevButton'), { w: 80, h: 26, fontSize: 11 });
    this.prevPageBtn.onTap = () => this.turnPage(-1);
    this.nextPageBtn = new Button(t('forge.pageNextButton'), { w: 80, h: 26, fontSize: 11 });
    this.nextPageBtn.onTap = () => this.turnPage(1);

    this.clearBtn = new Button(t('forge.clearLoadout'), { w: 160, h: 30, fontSize: 12 });
    this.clearBtn.onTap = () => this.onClear?.();
    this.clearBtn.setIcon(getUiTexture('icon_clear'));
    this.startBtn = new Button(t('forge.startRun'), { w: 220, h: 44, fontSize: 17 });
    this.startBtn.onTap = () => this.onStart?.();
    this.startBtn.setIcon(getUiTexture('icon_play'));
    this.acquireBtn = new Button(t('forge.acquireButton'), { w: 160, h: 30, fontSize: 12 });
    this.acquireBtn.onTap = () => this.onAcquire?.();

    this.npcSprite.anchor.set(0.5, 1);
    this.npcSprite.visible = false;

    this.view.addChild(
      this.panel.view, this.npcSprite, this.title, this.backBtn.view,
      this.prevCharBtn.view, this.charText, this.nextCharBtn.view,
      this.infoText, this.acquireBtn.view,
      ...this.rowCards.map((c) => c.view),
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
    return cost.map((c) => `${t(ELEMENT_SHORT_KEY[c.element])}×${c.qty}${c.minTier ? `≥t${c.minTier}` : ''}`).join(' ');
  }

  render(m: MetaState, w: number, h: number) {
    this.lastMeta = m;
    this.lastW = w;
    this.lastH = h;
    this.panel.layout(w, h);

    // Re-apply every label that isn't already rebuilt below on each call, so a
    // language change (design/17-i18n.md) takes effect next time the forge re-renders.
    this.title.text = t('forge.title');
    this.hint.text = t('forge.hint');
    this.backBtn.setText(t('forge.backButton'));
    this.prevPageBtn.setText(t('forge.pagePrevButton'));
    this.nextPageBtn.setText(t('forge.pageNextButton'));
    this.clearBtn.setText(t('forge.clearLoadout'));
    this.startBtn.setText(t('forge.startRun'));
    this.acquireBtn.setText(t('forge.acquireButton'));

    // Material bank — the five elemental kinds (design/14), summed across every rolled tier.
    const bank = DAMAGE_TYPES.map((e) => `${t(ELEMENT_SHORT_KEY[e])} ${bankTotal(m, e)}`).join('   ');

    const skin = SKIN_DEFS[m.selectedSkin];
    this.charText.text = skin ? t('forge.charStats', { skin: tName(skin.nameKey), hp: skin.maxHp, sh: skin.maxShield }) : m.selectedSkin;

    // Empty board text names the ACTUAL default pair (resolveLoadout's fill-by-kind
    // rule, ENGINE_VERSION 45) instead of the old "(none → auto pistol)" — that string
    // outlived the behaviour it described, and it was the only place the forge told the
    // player what an empty loadout means.
    const loadout = m.loadout.length
      ? m.loadout.join(', ')
      : t('forge.noneStarterPair', { weapons: PLAYER_BASE.startWeapons.map((w) => tName(w.nameKey)).join(' + ') });
    const buyable = purchasableBlueprints(m);
    // Named only when short; past 3 it collapses to a bare count instead of trying to
    // fit a variable-length name list — `buyable` can list every unlocked-but-uncrafted
    // blueprint at once (a real bug: unbounded, it used to run off both edges of the
    // screen as one line). A length cap alone isn't enough of a guarantee here: this
    // codebase has already hit a real Pixi word-wrap measurement quirk in this exact
    // sandboxed environment (see widgets.ts's Button `padding` comment) where Pixi's
    // own width numbers under-report what the glyphs actually render at, so a fixed,
    // content-independent worst-case length is safer than trusting wordWrap to clip a
    // longer line to its declared width.
    const buyableText = buyable.length <= 3 ? buyable.join(', ') : t('forge.moreAvailable', { count: buyable.length });
    this.infoText.text =
      t('forge.materialsLine', { bank, ownedChars: m.ownedCharacters.length }) + '\n' +
      t('forge.loadoutLine', { loadout, count: m.loadout.length, max: PLAYER_BASE.weaponSlots }) +
      (buyable.length ? '\n' + t('forge.storeLine', { items: buyableText }) : '');

    // Blueprint cards — icon, name, cost, status. The browse cursor (moveSelection /
    // a card tap) is a bright border instead of the old leading '»' glyph (design/14
    // icon-card pass — a grid has no "line start" for an inline glyph to sit at);
    // '▸staged' is a separate corner badge marking a crafted slot. Only the current
    // page's slice is shown; unused trailing slots on a partial last page are hidden.
    this.rowCards.forEach((card, slot) => {
      const i = this.pageStart + slot;
      const id = this.order[i];
      if (id === undefined) {
        card.view.visible = false;
        return;
      }
      card.view.visible = true;
      const bp = BLUEPRINT_CATALOG[id]!;
      const unlocked = isUnlocked(m, id);
      const staged = m.loadout.filter((x) => x === id).length;
      const affordable = canAfford(m, bp);
      const status = !unlocked
        ? (bp.source === 'drop' ? t('forge.lockedFind') : t('forge.lockedSource', { source: t(SOURCE_KEY[bp.source]) }))
        : affordable ? t('forge.craftable') : t('forge.needMaterials');
      const statusColor = !unlocked ? 0x718096 : affordable ? 0x68d391 : 0xf6ad55;
      const key = i < 9 ? `${i + 1}` : '·'; // only the first 9 have a digit-key shortcut
      const spec = WEAPON_SPECS[bp.weaponId];
      const borderColor = spec ? RARITY_COLORS[RARITY_TIERS[spec.rarity].colorKey] : 0x4c566a;
      card.set({
        key, name: spec ? tName(spec.nameKey) : id, cost: this.costText(bp.cost), status, statusColor, borderColor,
        selected: i === this.selectedIndex, staged, locked: !unlocked,
        icon: spec && getWeaponTexture(spec.id, spec.kind),
      });
    });
    this.pageLabel.text = t('forge.pageLabel', { current: Math.floor(this.pageStart / PAGE_SIZE) + 1, total: pageCount(this.order.length, PAGE_SIZE) });

    // Layout: title top, back button top-left corner, character row, info block,
    // paged blueprint rows filling the middle. clear/start/hint are a FIXED bottom
    // action bar anchored to `h`, not flowed down from the row/compare-card stack
    // above — they used to be, with the flowed position merely clamped to fit once
    // it overflowed the screen. That clamp never moved the rows/compare-card out of
    // the way, so on any viewport short enough to overflow, START RUN ended up
    // floating on top of the still-there weapon list instead of below it (the real
    // bug behind the "screen is a mess" report). The compare card now hides itself
    // if there's no longer room for it above the fixed bar, rather than overlapping it.
    const cx = w / 2;
    const halfGrid = GRID_W / 2;
    let y = Math.max(20, h * 0.05);
    this.title.position.set(cx, y);
    this.backBtn.view.position.set(16, 16);
    y += 44;
    this.prevCharBtn.view.position.set(cx - 150, y);
    this.charText.position.set(cx, y + 15);
    this.nextCharBtn.view.position.set(cx + 118, y);
    y += 44;
    this.infoText.style.wordWrapWidth = Math.min(760, w - 80);
    this.infoText.position.set(cx, y);
    y += this.infoText.height + 14;
    // Acquire button (a real gap this pass closed): only shown when there's actually
    // something to acquire, right-aligned with the grid below it — reserves its own
    // row so it never overlaps the first blueprint card.
    this.acquireBtn.view.visible = buyable.length > 0;
    if (this.acquireBtn.view.visible) {
      this.acquireBtn.view.position.set(cx + halfGrid - 160, y);
      y += 36;
    }
    // Blueprint grid — `GRID_COLS` cards per row, wrapping into `GRID_ROWS` (design/14
    // icon-card pass, replaces the old one-Button-per-row vertical list).
    this.rowCards.forEach((card, slot) => {
      const col = slot % GRID_COLS;
      const row = Math.floor(slot / GRID_COLS);
      card.view.position.set(
        cx - halfGrid + col * (BlueprintCard.W + GRID_GAP_X),
        y + row * (BlueprintCard.H + GRID_GAP_Y),
      );
    });
    y += GRID_H + 8;
    this.prevPageBtn.view.position.set(cx - halfGrid, y);
    this.pageLabel.position.set(cx, y + 13);
    this.nextPageBtn.view.position.set(cx + halfGrid - 80, y);
    y += 40;

    const footerY = h - 60;
    this.clearBtn.view.position.set(cx - halfGrid, footerY + 7);
    this.startBtn.view.position.set(cx - 110, footerY);
    this.hint.position.set(cx, h - 6);

    // Forger NPC — corner decoration, right of the centered blueprint grid. Only
    // shown once its art exists AND the viewport is wide enough to fit it without
    // overlapping the grid (same "hide if no room" shape as the compare card).
    const npcTex = getUiTexture('npc_forger');
    const npcRightMargin = w - (cx + 300);
    if (npcTex && npcRightMargin > 130) {
      this.npcSprite.texture = npcTex;
      const targetH = Math.min(220, h * 0.32);
      this.npcSprite.scale.set(targetH / npcTex.height);
      this.npcSprite.position.set(w - 24 - (npcTex.width * this.npcSprite.scale.x) / 2, footerY + 40);
      this.npcSprite.visible = true;
    } else {
      this.npcSprite.visible = false;
    }

    const cardShown = this.renderCompareCard(m, cx, y);
    if (cardShown && y + this.compareCard.view.height + 16 > footerY) this.compareCard.hide();

    this.view.visible = true;
  }

  /** design/10's loadout-detail decision: the browse cursor's blueprint vs whichever
   * loadout entry shares its weapon kind. The comparator is what the run would ACTUALLY
   * spawn carrying (`resolveLoadout`, ENGINE_VERSION 45) — so a half-crafted loadout
   * still diffs a melee candidate against the starter saber that would fill the free
   * slot, instead of hiding the card as if that slot were empty. Hidden only when there
   * genuinely is no same-kind comparator (a loadout holding two of the OTHER kind) —
   * nothing useful to diff against. */
  private renderCompareCard(m: MetaState, cx: number, y: number): boolean {
    const candidateId = this.order[this.selectedIndex];
    const candidate = candidateId ? WEAPON_SPECS[BLUEPRINT_CATALOG[candidateId]!.weaponId] : undefined;
    const effectiveLoadout = resolveLoadout(m.loadout).map((w) => w.name);
    const equipped = candidate ? equippedSpecOfKind(effectiveLoadout, candidate.kind) : undefined;
    const rows = candidate && equipped ? buildCompareRows(equipped, candidate) : null;

    if (!candidate || !equipped || !rows) {
      this.compareCard.hide();
      return false;
    }
    this.compareCard.set({
      w: Math.min(420, cx * 2 - 48),
      leftName: t('forge.equippedHeader', { id: tName(equipped.nameKey) }),
      leftColor: RARITY_COLORS[RARITY_TIERS[equipped.rarity].colorKey],
      rightName: t('forge.candidateHeader', { id: tName(candidate.nameKey) }),
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
