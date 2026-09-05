import { Container, Text } from 'pixi.js';
import { BLUEPRINT_CATALOG, SKIN_DEFS, WEAPON_SPECS } from '@dd/engine';
import { Panel, Button } from '../ui/widgets';
import { clampPageStart, pageCount } from '../ui/paging';
import { getUiTexture } from '../../render/uiSkins';
import { playUiCue } from '../../audio/uiSound';
import { formatSkuPrice, type SkuGrant, type StoreSku } from '../../net/billing';
import type { StorePurchase, CatalogFailure, PurchaseFailure } from '../controllers/StorePurchase';
import type { MetaState } from '../../meta';
import { t, tName, type TranslationKey } from '../../i18n';

/** Rows per page. The server table is ten SKUs today and will grow; a fixed pool plus the
 * paging helpers the Forge grid already uses beats letting the list run off the panel — the
 * exact bug `Forge`'s own `buyableText` comment records. */
const PAGE_SIZE = 6;

/** Every failure code either half of the flow can produce, mapped to the ONE player-facing
 * line for it. Exhaustive `Record`s rather than a `switch` with a default, so a new code in
 * `StorePurchase` is a compile error here instead of a silent fallthrough to generic copy. */
const PURCHASE_MESSAGE: Record<PurchaseFailure, TranslationKey> = {
  busy: 'store.busy',
  'not-logged-in': 'store.loginRequired',
  'no-platform': 'store.unavailableHere',
  'not-configured': 'store.notConfigured',
  'order-failed': 'store.orderFailed',
  'payment-failed': 'store.paymentFailed',
  'timed-out': 'store.pending',
};

const CATALOG_MESSAGE: Record<CatalogFailure, TranslationKey> = {
  busy: 'store.busy',
  'not-logged-in': 'store.loginRequired',
  'no-platform': 'store.unavailableHere',
  'list-failed': 'store.listFailed',
};

/**
 * The store (design/19-server-platform.md §4, design/14's bounded direct purchase) — real
 * money for a named blueprint, replacing the Forge's `demo: free grant` ACQUIRE.
 *
 * Pure presentation over an injected `StorePurchase`, the same split every other screen here
 * uses. Two things it deliberately does NOT do:
 *
 *   - **It never computes a price.** Rows render `amountCents`/`currency` exactly as the
 *     listing returned them. There is no local price table to drift from
 *     `server/src/billsvc/skus.ts`, and nothing here totals or discounts anything.
 *   - **It never decides whether this build may sell.** That is `platform/storePlatform.ts`,
 *     read through `StorePurchase`; this screen only refuses to render an entry it was told
 *     not to. See that file for why an iOS build showing a web checkout is a rule break
 *     rather than a rough edge.
 *
 * Every button is `sound: 'silent'`: a store press can end in a purchase, a refusal, or a
 * swallowed double-tap, and only the transaction knows which — so the cue is played from
 * the outcome (design/11, same reasoning as the Forge's craft rows).
 */
export class StoreScreen {
  readonly view = new Container();
  private panel = new Panel({ alpha: 0.85, background: 'hub' });
  private title: Text;
  private statusText: Text;
  private pageLabel: Text;
  private rows: Button[];
  private prevPageBtn: Button;
  private nextPageBtn: Button;
  private backBtn: Button;

  private skus: StoreSku[] = [];
  private meta: MetaState | null = null;
  /** SKUs bought during THIS visit. `meta` is the snapshot `show()` was handed, so it does
   * not learn about a purchase made since — without this the row a player just paid for
   * would keep offering itself for sale until they left and came back. */
  private boughtHere = new Set<string>();
  private pageStart = 0;
  private lastW = 0;
  private lastH = 0;
  /** Bumped by `hide()`, checked when an async load/buy settles — the same `attemptToken`
   * convention LoginScreen/Matchmaking/PartyScreen use, so a purchase that resolves after
   * the player walked away cannot repaint a screen that is no longer up. */
  private attemptToken = 0;

  onBack: (() => void) | null = null;

  constructor(private readonly purchase: StorePurchase) {
    this.title = new Text({ text: t('store.title'), style: { fill: 0xf7fafc, fontSize: 30, fontWeight: 'bold', fontFamily: 'sans-serif', padding: 16 } });
    this.title.anchor.set(0.5, 0);
    // wordWrap for the same reason the Forge's info line has it: these lines are translated
    // and one of them carries a server-supplied failure message of no fixed length.
    this.statusText = new Text({ text: '', style: { fill: 0x90cdf4, fontSize: 13, fontFamily: 'monospace', lineHeight: 19, align: 'center', padding: 16, wordWrap: true, wordWrapWidth: 620, breakWords: true } });
    this.statusText.anchor.set(0.5, 0);
    this.pageLabel = new Text({ text: '', style: { fill: 0x90cdf4, fontSize: 12, fontFamily: 'monospace', padding: 14 } });
    this.pageLabel.anchor.set(0.5);

    this.rows = Array.from({ length: PAGE_SIZE }, (_, slot) => {
      const skuRowBtn = new Button('', { w: 460, h: 34, fontSize: 13, sound: 'silent' });
      skuRowBtn.onTap = () => {
        const sku = this.skus[this.pageStart + slot];
        if (sku) void this.buy(sku);
      };
      return skuRowBtn;
    });

    this.prevPageBtn = new Button(t('store.pagePrev'), { w: 80, h: 26, fontSize: 11 });
    this.prevPageBtn.onTap = () => this.turnPage(-1);
    this.nextPageBtn = new Button(t('store.pageNext'), { w: 80, h: 26, fontSize: 11 });
    this.nextPageBtn.onTap = () => this.turnPage(1);

    // Label carries NO arrow glyph: `setIcon` below draws one, and `store.back` used to
    // carry a `←` as well, which rendered as "← ← FORGE" on a build with the art loaded.
    // Same shape as LoginScreen's own back button, whose label is the bare word.
    this.backBtn = new Button(t('store.back'), { w: 140, h: 32, fontSize: 13, sound: 'ui.back' });
    this.backBtn.onTap = () => this.onBack?.();
    this.backBtn.setIcon(getUiTexture('icon_back'));

    this.view.addChild(
      this.panel.view, this.title, this.statusText,
      ...this.rows.map((r) => r.view),
      this.prevPageBtn.view, this.pageLabel, this.nextPageBtn.view, this.backBtn.view,
    );
    this.view.eventMode = 'static';
    this.view.visible = false;
  }

  /** Open the store and kick a listing. `meta` is what the player already owns — an owned
   * SKU is shown as owned and cannot be bought a second time, which is the one mistake here
   * that costs real money. */
  show(w: number, h: number, meta: MetaState): void {
    this.meta = meta;
    this.boughtHere.clear();
    this.skus = [];
    this.pageStart = 0;
    this.statusText.text = t('store.loading');
    this.retext();
    this.render(w, h);
    this.view.visible = true;
    void this.load();
  }

  hide(): void {
    this.view.visible = false;
    this.attemptToken++;
  }

  /** Re-render against a fresh viewport (ScreenNav.relayout) without re-listing. */
  resize(w: number, h: number): void {
    this.render(w, h);
  }

  /** Re-apply every static label from the active locale — MainMenu's `retext()` convention
   * (design/17-i18n.md). */
  private retext(): void {
    this.title.text = t('store.title');
    this.prevPageBtn.setText(t('store.pagePrev'));
    this.nextPageBtn.setText(t('store.pageNext'));
    this.backBtn.setText(t('store.back'));
  }

  private async load(): Promise<void> {
    const token = this.attemptToken;
    const result = await this.purchase.loadCatalog();
    if (token !== this.attemptToken) return;
    if (!result.ok) {
      this.skus = [];
      this.statusText.text = t(CATALOG_MESSAGE[result.code]);
      this.render(this.lastW, this.lastH);
      return;
    }
    this.skus = result.skus;
    this.pageStart = 0;
    this.statusText.text = result.skus.length ? t('store.pickOne') : t('store.empty');
    this.render(this.lastW, this.lastH);
  }

  private async buy(sku: StoreSku): Promise<void> {
    // Owned already — refused HERE rather than at the server, because the server would
    // happily take the money for a second copy of a thing that grants nothing new.
    if (this.owns(sku)) {
      playUiCue('ui.denied');
      this.statusText.text = t('store.alreadyOwned', { item: this.skuLabel(sku) });
      this.render(this.lastW, this.lastH);
      return;
    }
    const token = this.attemptToken;
    this.statusText.text = t('store.purchasing', { item: this.skuLabel(sku) });
    this.render(this.lastW, this.lastH);

    // `buy` plays the cue (it is the half that knows the outcome) and carries its own
    // re-entrancy guard, so a double tap lands on `busy` rather than booking two orders.
    const result = await this.purchase.buy(sku.sku);
    if (token !== this.attemptToken) return;
    if (result.ok) this.boughtHere.add(sku.sku);

    if (!result.ok) {
      this.statusText.text = t(PURCHASE_MESSAGE[result.code]);
      this.render(this.lastW, this.lastH);
      return;
    }
    // Delivered. `refreshed: false` means this client could not re-read the entitlement —
    // the purchase stands, so the line says where it will show up rather than sounding like
    // a failure (`StorePurchase`'s own note on that arm).
    this.statusText.text = result.refreshed
      ? t('store.purchased', { item: this.skuLabel(sku) })
      : t('store.purchasedNoRefresh', { item: this.skuLabel(sku) });
    // Nothing to notify: `StorePurchase.refreshOwnership` has already written the server's
    // answer into the live meta, and BACK re-renders the forge from it. The store is a full
    // phase, so the forge is not on screen to refresh while this is up.
    this.render(this.lastW, this.lastH);
  }

  private turnPage(delta: number): void {
    this.pageStart = clampPageStart(this.pageStart, delta, this.skus.length, PAGE_SIZE);
    this.render(this.lastW, this.lastH);
  }

  /** Does the local meta already carry everything this SKU grants? A SKU granting nothing
   * this client understands (a kind billsvc adds later) is never "owned" — same
   * skip-the-unknown posture `entitlementOwnership` takes. */
  private owns(sku: StoreSku): boolean {
    if (this.boughtHere.has(sku.sku)) return true;
    const m = this.meta;
    if (!m || sku.grants.length === 0) return false;
    return sku.grants.every((g) =>
      g.kind === 'blueprint' ? m.unlockedBlueprints.includes(g.id)
      : g.kind === 'character' ? m.ownedCharacters.includes(g.id)
      : false);
  }

  /** The player-facing name: the localised CONTENT name where the grant names something
   * this build knows (design/09 — engine data carries keys, never display text), else the
   * server's own operator-facing title. */
  private skuLabel(sku: StoreSku): string {
    const named = sku.grants.map((g) => grantName(g)).filter((n): n is string => n !== null);
    return named.length ? named.join(' + ') : sku.title;
  }

  private render(w: number, h: number): void {
    this.lastW = w;
    this.lastH = h;
    this.panel.layout(w, h);
    const cx = w / 2;

    // Clamp after a listing shrank the page count out from under a page we were on.
    const pages = pageCount(this.skus.length, PAGE_SIZE);
    if (this.pageStart >= this.skus.length) this.pageStart = Math.max(0, (pages - 1) * PAGE_SIZE);

    let y = Math.max(20, h * 0.06);
    this.title.position.set(cx, y);
    y += 46;
    this.statusText.style.wordWrapWidth = Math.min(620, w - 80);
    this.statusText.position.set(cx, y);
    y += Math.max(28, this.statusText.height + 10);

    this.rows.forEach((row, slot) => {
      const sku = this.skus[this.pageStart + slot];
      if (!sku) {
        row.view.visible = false;
        return;
      }
      row.view.visible = true;
      const price = formatSkuPrice(sku.amountCents, sku.currency);
      row.setText(
        this.owns(sku)
          ? t('store.rowOwned', { item: this.skuLabel(sku) })
          : t('store.row', { item: this.skuLabel(sku), price }),
      );
      row.view.position.set(cx - 230, y + slot * 40);
    });
    y += PAGE_SIZE * 40 + 6;

    const paged = this.skus.length > PAGE_SIZE;
    this.prevPageBtn.view.visible = paged;
    this.nextPageBtn.view.visible = paged;
    this.pageLabel.visible = paged;
    if (paged) {
      this.prevPageBtn.view.position.set(cx - 230, y);
      this.pageLabel.text = t('store.pageLabel', { current: Math.floor(this.pageStart / PAGE_SIZE) + 1, total: pages });
      this.pageLabel.position.set(cx, y + 13);
      this.nextPageBtn.view.position.set(cx + 150, y);
    }

    this.backBtn.view.position.set(cx - 70, h - 56);
  }
}

/** Free function rather than a method: it reads only the engine catalogues, so it needs no
 * screen state and is the piece a test can exercise on its own. */
function grantName(g: SkuGrant): string | null {
  if (g.kind === 'blueprint') {
    const bp = BLUEPRINT_CATALOG[g.id];
    const spec = bp && WEAPON_SPECS[bp.weaponId];
    return spec ? tName(spec.nameKey) : null;
  }
  const skin = SKIN_DEFS[g.id];
  return skin ? tName(skin.nameKey) : null;
}
