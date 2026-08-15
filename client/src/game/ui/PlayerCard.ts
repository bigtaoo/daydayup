import { Container, Graphics, Sprite, Text } from 'pixi.js';
import { SKIN_DEFS, REVIVE_CHANNEL_TICKS } from '@dd/engine';
import { getRigSkin } from '../../render/skinRegistry';
import { THEME } from '../theme';
import { Bar } from './widgets';
import { drawHudIcon } from './hudIcons';
import { estimateMonoWidth } from './textWidth';
import { t, tName } from '../../i18n';

/** The bone slot every playable rig skin binds its main body art to (client/public/
 *  skins/<name>/frames.json) — reused here as a portrait instead of commissioning a
 *  separate headshot, so a new character needs no extra art to show up in the HUD. */
const PORTRAIT_SLOT = 'shell';

/**
 * "Who you are playing" as a card (design/10 HUD): the character's own art, its name,
 * and the two defensive pools (design/07). Replaces the bare HP bar plus a skin name
 * buried at the head of a monospace info line — the portrait is what makes the card
 * identify the blue orb you're driving, which reading a name never did.
 */
export class PlayerCard {
  readonly view = new Container();
  static readonly HEIGHT = 46;
  private static readonly PORTRAIT = 44;
  private static readonly TEXT_X = 52;
  private static readonly BAR_W = 150;
  private static readonly NAME_SIZE = 14;

  private readonly frame = new Graphics();
  private readonly fallback = new Graphics();
  private portrait: Sprite | null = null;
  private readonly name: Text;
  private readonly hpBar = new Bar({ w: PlayerCard.BAR_W, h: 14, fillColor: 0xf56565, trackColor: 0x2a1620, label: true });
  private readonly shieldBar = new Bar({ w: PlayerCard.BAR_W, h: 8, fillColor: THEME.colors.shield, label: false });
  private lastSkinId = '';

  constructor() {
    const box = PlayerCard.PORTRAIT;
    this.frame
      .roundRect(0, 0, box, box, 9)
      .fill({ color: 0x18202f, alpha: 0.92 })
      .roundRect(0.5, 0.5, box - 1, box - 1, 9)
      .stroke({ color: 0x63b3ed, alpha: 0.55, width: 1.5 });
    this.name = new Text({
      text: '',
      style: { fill: 0xf7fafc, fontSize: PlayerCard.NAME_SIZE, fontFamily: 'monospace', fontWeight: 'bold', padding: 8 },
    });
    this.name.position.set(PlayerCard.TEXT_X, 0);
    this.hpBar.view.position.set(PlayerCard.TEXT_X, 18);
    this.shieldBar.view.position.set(PlayerCard.TEXT_X, 36);
    this.view.addChild(this.frame, this.fallback, this.name, this.hpBar.view, this.shieldBar.view);
  }

  /** `skinId` is a `SKIN_DEFS` key (meta.selectedSkin); shield pools of 0 hide that bar
   *  entirely rather than drawing an always-empty track. */
  set(skinId: string, hp: number, maxHp: number, shield: number, maxShield: number): void {
    if (skinId !== this.lastSkinId) {
      this.lastSkinId = skinId;
      // Deliberately NOT `resolveSkin()` (which forward-compat-falls back to the
      // DEFAULT character for an unknown id) — that's right for gameplay-critical stat
      // resolution, but wrong here: an unrecognized id should echo itself back (same as
      // before this translation pass), not silently relabel the card as Vanguard.
      const def = SKIN_DEFS[skinId];
      this.name.text = def ? tName(def.nameKey) : skinId.toUpperCase();
      this.bindPortrait(skinId);
    }
    this.hpBar.set(Math.max(0, hp), maxHp);
    this.shieldBar.view.visible = maxShield > 0;
    if (maxShield > 0) this.shieldBar.set(Math.max(0, shield), maxShield);
  }

  /** Advance the bars' decrease-flash. Call once per render frame (dt in ms). */
  update(dt: number): void {
    this.hpBar.update(dt);
    if (this.shieldBar.view.visible) this.shieldBar.update(dt);
  }

  estimatedWidth(): number {
    return PlayerCard.TEXT_X + Math.max(PlayerCard.BAR_W, estimateMonoWidth(this.name.text, PlayerCard.NAME_SIZE));
  }

  /** Test seam — see StatChip's own. */
  get displayName(): string {
    return this.name.text;
  }

  // Art is best-effort everywhere else in this codebase (design/02/12 "gameplay is
  // never blocked on art") and no less so here: an unloaded bundle leaves a plain
  // tinted disc in the frame rather than an empty hole.
  private bindPortrait(skinId: string): void {
    const atlasKey = SKIN_DEFS[skinId]?.atlasKey;
    const texture = atlasKey ? getRigSkin(atlasKey)?.bundle.textures.get(PORTRAIT_SLOT) : undefined;
    const box = PlayerCard.PORTRAIT;
    if (!texture) {
      this.portrait?.destroy();
      this.portrait = null;
      this.fallback.clear().circle(box / 2, box / 2, box * 0.32).fill({ color: 0x4fd1c5, alpha: 0.6 });
      return;
    }
    this.fallback.clear();
    if (!this.portrait) {
      this.portrait = new Sprite();
      this.portrait.anchor.set(0.5);
      this.view.addChildAt(this.portrait, 1); // above the frame, below the text
    }
    this.portrait.texture = texture;
    // Contain, not stretch — body art is square-ish but not guaranteed to be.
    const inner = box - 8;
    this.portrait.scale.set(Math.min(inner / texture.width, inner / texture.height));
    this.portrait.position.set(box / 2, box / 2);
  }
}

/**
 * The co-op teammate (ROADMAP 3.1/3.2), as a compact row: an ally glyph, the character
 * name, a health bar, and the bleedout countdown while downed. Same job the old
 * `hud.allyLine` string did, except a teammate bleeding out now reads as a draining bar
 * rather than a number in a sentence.
 */
export class AllyRow {
  readonly view = new Container();
  static readonly HEIGHT = 24;
  private static readonly TEXT_X = 18;
  private static readonly BAR_W = 110;

  private readonly icon = new Graphics();
  private readonly name: Text;
  private readonly status: Text;
  private readonly hpBar = new Bar({ w: AllyRow.BAR_W, h: 8, fillColor: 0x68d391, label: false });

  constructor() {
    drawHudIcon(this.icon, 'ally', 7, 7, 7, 0x68d391);
    this.name = new Text({
      text: '',
      style: { fill: 0xcbd5e0, fontSize: 11, fontFamily: 'monospace', fontWeight: 'bold', padding: 6 },
    });
    this.name.position.set(AllyRow.TEXT_X, 0);
    this.status = new Text({
      text: '',
      style: { fill: 0xf6ad55, fontSize: 10, fontFamily: 'monospace', fontWeight: 'bold', padding: 6 },
    });
    this.status.position.set(AllyRow.TEXT_X + AllyRow.BAR_W + 8, 4);
    this.hpBar.view.position.set(AllyRow.TEXT_X, 15);
    this.view.addChild(this.icon, this.name, this.hpBar.view, this.status);
  }

  /** `reviveProgressTicks` (default 0, ReviveSystem) — while a revive channel is
   *  actually progressing, bleedout is paused (frozen, not counting down), so showing
   *  the channel's own percentage reads truer than a stalled countdown would. */
  set(skinId: string, hp: number, maxHp: number, downed: boolean, bleedoutSeconds: number, reviveProgressTicks = 0): void {
    // Same "echo unknown ids back raw" reasoning as PlayerCard.set() above.
    const def = SKIN_DEFS[skinId];
    this.name.text = t('hud.ally.tag', { skin: def ? tName(def.nameKey) : skinId });
    this.hpBar.set(downed ? 0 : Math.max(0, hp), maxHp);
    if (downed && reviveProgressTicks > 0) {
      this.status.text = t('hud.ally.reviving', { pct: Math.round((reviveProgressTicks / REVIVE_CHANNEL_TICKS) * 100) });
    } else {
      this.status.text = downed ? t('hud.ally.downed', { seconds: bleedoutSeconds }) : '';
    }
    this.status.visible = downed;
  }

  update(dt: number): void {
    this.hpBar.update(dt);
  }

  estimatedWidth(): number {
    return (
      AllyRow.TEXT_X +
      Math.max(estimateMonoWidth(this.name.text, 11), AllyRow.BAR_W + 8 + estimateMonoWidth(this.status.text, 10))
    );
  }

  /** Test seam — see StatChip's own. */
  get nameText(): string {
    return this.name.text;
  }
  get statusText(): string {
    return this.status.text;
  }
}
