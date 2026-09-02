import { Container, Text } from 'pixi.js';
import { WEAPON_SIM_BY_ID, type PickupItem } from '@dd/engine';
import { getWeaponTexture } from '../../render/weaponSkins';
import { rarityColor } from '../theme';
import { Panel, Button } from './widgets';
import { t, getLocale } from '../../i18n';

const ROW_W = 220;
const ROW_H = 34;
const ROW_GAP = 6;
const PAD = 10;
const HEADER_H = 30;
const CLOSE_SIZE = 20;

/**
 * The ground-weapon click-to-collect panel (design/03, ENGINE_VERSION 32 — replaces
 * the old single-nearest "ground compare card" + tap-INTERACT gesture). Shown whenever
 * one or more weapon pickups are within range (`ui/pickupProximity.ts#nearbyWeaponPickups`,
 * driven by HudView): every nearby weapon gets its own row (real icon via
 * `render/weaponSkins.ts`, same art `WeaponCard`/Forge mount, + name), and tapping a
 * row is the pickup action itself — `onPick` routes to `CommandBuilder.requestPickup`,
 * a one-shot latch that becomes `PlayerCommand.pickupTargetId` (PickupSystem does the
 * actual, server-authoritative proximity check). Closing the panel just leaves every
 * listed weapon on the floor.
 *
 * Non-blocking, and non-blocking about the ATTACK button too (live report, *"附近有可以
 * 拾取的武器时，不要阻断了玩家攻击"*): a press that lands on this panel is swallowed
 * (`onPressStart` → `CommandBuilder.suppressFireUntilRelease`, needed because WebInput's
 * raw mousedown sets `firing` independent of what a Pixi button consumed), and every
 * other click still shoots. Until 2026-09-02 the whole fire button was gated on `isOpen`
 * instead, which disarmed the player for as long as any floor weapon sat within
 * `SIM.lootRevealRadius` — i.e. for most of a fight, since every kill drops one.
 */
export class WeaponPickupPrompt {
  readonly view = new Container();
  private readonly panel = new Panel({ radius: 10, color: 0x0b0e14, alpha: 0.9, borderColor: 0x4c566a, borderAlpha: 0.55 });
  private readonly titleText: Text;
  private readonly closeBtn: Button;
  private rows: Button[] = [];
  // Rebuild only when the SET of nearby ids changes (same "redraw on key change"
  // convention as WeaponCard/DownedBanner) — not every frame.
  private lastKey = ' '; // sentinel, guaranteed to differ from the first real key
  // The nearby-id-set signature at the moment the player last hit close — stays hidden
  // while the live signature still matches it; any change (a weapon enters/leaves
  // range, including leaving the area entirely) clears this and lets it reopen.
  private closedForKey: string | null = null;

  onPick: ((itemId: number) => void) | null = null;
  /** Fired the instant a press LANDS anywhere on this panel — its rows, its close button
   *  or the chrome between them. Capture phase, so `Button`'s own pointerdown
   *  `stopPropagation()` (widgets.ts) can't hide a row press from it, and BEFORE the
   *  browser's `mousedown` reaches WebInput, so the latch is already set by the time the
   *  next command is built. Game.ts routes it to CommandBuilder.suppressFireUntilRelease(). */
  onPressStart: (() => void) | null = null;

  get isOpen(): boolean {
    return this.view.visible;
  }

  constructor() {
    this.titleText = new Text({
      text: '',
      style: { fill: 0x90cdf4, fontSize: 13, fontFamily: 'monospace', fontWeight: 'bold', padding: 6 },
    });
    this.titleText.position.set(PAD, 8);
    this.titleText.eventMode = 'none'; // decoration — the press belongs to the panel (see below)

    this.closeBtn = new Button('×', { w: CLOSE_SIZE, h: CLOSE_SIZE, fontSize: 14, color: 0x2a3140, sound: 'ui.back' });
    this.closeBtn.onTap = () => {
      this.closedForKey = this.lastKey;
      this.view.visible = false;
    };

    this.view.addChild(this.panel.view, this.titleText, this.closeBtn.view);
    this.view.visible = false;
    // `static` makes the panel itself a real event target, not just a bag of buttons: a
    // press on the chrome between two rows lands on `Panel`'s own background and must be
    // swallowed on exactly the same terms as a press on a row. (Pixi only notifies a
    // listener on a container that `isInteractive()`, so without this the capture handler
    // below would never run for either kind of press.)
    this.view.eventMode = 'static';
    // `on('pointerdowncapture')` rather than `addEventListener(..., { capture: true })`,
    // which is the same registration (FederatedEventTarget maps one to the other): the
    // DOM-shaped method arrives with the events MIXIN, installed only once a browser
    // `Application` has initialised, so a panel constructed in a headless test would throw
    // on it. `on` is the underlying EventEmitter and is always there.
    this.view.on('pointerdowncapture', () => this.onPressStart?.());
  }

  update(nearby: readonly PickupItem[]): void {
    // Locale is part of the key (same convention as WeaponCard's own `lastKey`): this
    // panel's strings are translated, so a language change must invalidate the cache
    // even though the nearby weapon set didn't move.
    const idKey = nearby.length ? [...nearby].map((p) => p.id).sort((a, b) => a - b).join(',') : '';
    const key = `${getLocale()}|${idKey}`;
    if (key !== this.lastKey) {
      this.lastKey = key;
      this.closedForKey = null; // the set changed — any prior close no longer applies
      this.rebuild(nearby);
    }
    this.view.visible = nearby.length > 0 && this.closedForKey !== key;
  }

  private rebuild(nearby: readonly PickupItem[]): void {
    for (const row of this.rows) row.view.destroy({ children: true });
    this.rows = [];

    this.titleText.text = t('hud.pickupPrompt.title');

    const h = HEADER_H + (nearby.length ? nearby.length * (ROW_H + ROW_GAP) - ROW_GAP + PAD : 0) + PAD;
    this.panel.layout(ROW_W + PAD * 2, h);
    this.closeBtn.view.position.set(ROW_W + PAD * 2 - CLOSE_SIZE - 6, 6);

    nearby.forEach((item, i) => {
      const spec = item.weaponId ? WEAPON_SIM_BY_ID[item.weaponId] : undefined;
      const row = new Button(spec?.name ?? item.weaponId ?? '?', { w: ROW_W, h: ROW_H, fontSize: 13 });
      if (spec) row.setIcon(getWeaponTexture(item.weaponId, spec.kind), rarityColor(spec));
      row.view.position.set(PAD, HEADER_H + i * (ROW_H + ROW_GAP));
      const id = item.id;
      row.onTap = () => this.onPick?.(id);
      this.rows.push(row);
      this.view.addChild(row.view);
    });
  }
}
