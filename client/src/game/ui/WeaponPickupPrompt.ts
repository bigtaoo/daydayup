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
 * Non-blocking, same as `PortalPrompt`: the run keeps simulating while this is open
 * (Game.ts suppresses fire while `isOpen`, so a click on a row doesn't also fire a shot
 * — WebInput's raw mousedown sets `firing` independent of what a Pixi button consumed).
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

  get isOpen(): boolean {
    return this.view.visible;
  }

  constructor() {
    this.titleText = new Text({
      text: '',
      style: { fill: 0x90cdf4, fontSize: 13, fontFamily: 'monospace', fontWeight: 'bold', padding: 6 },
    });
    this.titleText.position.set(PAD, 8);

    this.closeBtn = new Button('×', { w: CLOSE_SIZE, h: CLOSE_SIZE, fontSize: 14, color: 0x2a3140 });
    this.closeBtn.onTap = () => {
      this.closedForKey = this.lastKey;
      this.view.visible = false;
    };

    this.view.addChild(this.panel.view, this.titleText, this.closeBtn.view);
    this.view.visible = false;
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
