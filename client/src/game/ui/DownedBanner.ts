import { Container, Text } from 'pixi.js';
import { TICK_RATE, REVIVE_CHANNEL_TICKS } from '@dd/engine';
import { Panel, Bar } from './widgets';
import { t } from '../../i18n';

/**
 * Local-player downed feedback (design/10 open question "HUD for spectators / downed
 * co-op players") — the local seat's own counterpart to `AllyRow`'s teammate bleedout
 * readout. Before this, a downed local player saw nothing at all explaining why the
 * world had frozen around them: no bleedout countdown, no indication a teammate's
 * revive channel was even progressing. Centered, above the corner HUD panel so it
 * reads immediately regardless of what's on screen underneath.
 */
export class DownedBanner {
  readonly view = new Container();
  private readonly panel = new Panel({ radius: 10, color: 0x1a0b0e, alpha: 0.85, borderColor: 0xf56565, borderAlpha: 0.6 });
  private readonly title: Text;
  private readonly detail: Text;
  private readonly progress = new Bar({ w: 240, h: 10, fillColor: 0x68d391, trackColor: 0x2a1620 });

  private static readonly W = 260;
  private static readonly H = 92;

  constructor() {
    this.title = new Text({
      text: '',
      style: { fill: 0xfeb2b2, fontSize: 19, fontFamily: 'monospace', fontWeight: 'bold', align: 'center', padding: 6 },
    });
    this.title.anchor.set(0.5, 0);
    this.detail = new Text({
      text: '',
      style: { fill: 0xe2e8f0, fontSize: 13, fontFamily: 'monospace', align: 'center', padding: 6 },
    });
    this.detail.anchor.set(0.5, 0);
    this.progress.view.visible = false;
    this.panel.layout(DownedBanner.W, DownedBanner.H);
    this.view.addChild(this.panel.view, this.title, this.detail, this.progress.view);
    this.view.visible = false;
  }

  /** Re-anchor on viewport resize (same convention as PortalPrompt/HudView). */
  reposition(screenPx: { w: number; h: number }): void {
    const w = DownedBanner.W;
    const x = screenPx.w / 2 - w / 2;
    const y = screenPx.h * 0.28;
    this.panel.view.position.set(x, y);
    this.title.position.set(screenPx.w / 2, y + 14);
    this.detail.position.set(screenPx.w / 2, y + 42);
    this.progress.view.position.set(screenPx.w / 2 - 120, y + 64);
  }

  /** `downed`/`bleedoutTicks`/`reviveProgressTicks` are the local seat's own PlayerActor
   *  fields (ReviveSystem, ROADMAP 3.2). Bleedout is PAUSED (not decreasing) while a
   *  revive channel is active — showing the channel's own progress in that case reads
   *  truer than a stalled countdown number would. */
  set(downed: boolean, bleedoutTicks: number, reviveProgressTicks: number): void {
    this.view.visible = downed;
    if (!downed) return;
    const reviving = reviveProgressTicks > 0;
    this.title.text = reviving ? t('hud.downed.reviving') : t('hud.downed.title');
    this.progress.view.visible = reviving;
    if (reviving) {
      this.progress.set(reviveProgressTicks, REVIVE_CHANNEL_TICKS);
      this.detail.text = '';
    } else {
      this.detail.text = t('hud.downed.bleedout', { seconds: Math.ceil(bleedoutTicks / TICK_RATE) });
    }
  }

  /** Advance the progress bar's flash. Call once per render frame (dt in ms). */
  update(dt: number): void {
    if (this.progress.view.visible) this.progress.update(dt);
  }

  /** Test seams — see StatChip's own. */
  get titleText(): string {
    return this.title.text;
  }
  get detailText(): string {
    return this.detail.text;
  }
  get progressVisible(): boolean {
    return this.progress.view.visible;
  }
}
