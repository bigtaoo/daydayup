import { Container, Text } from 'pixi.js';
import { CONFIG, rarityColor } from './config';
import type { Layers } from './layers';
import { Bar, Panel, ToastQueue } from './ui/widgets';
import { estimateMonoWidth } from './ui/textWidth';
import { CompareCard } from './ui/compareCard';
import { nearestWeaponPickup } from './ui/pickupProximity';
import { Minimap, type MinimapPlayer } from './ui/Minimap';
import { FloorProgress } from './ui/FloorProgress';
import { WEAPON_SIM_BY_ID, EMBER_DUNGEON, SIM, type GameState } from '@dd/engine';
import { t } from '../i18n';

// Ground compare card proximity ring (design/03:125) — wider than PickupSystem's own
// collect radius (SIM.pickupRadius) so the card has a beat to show before auto-collect.
// Same constant PickupSystem uses to resolve an arena crate (SIM.lootRevealRadius) —
// sharing it means a resolved weapon pickup is always already known by the time this
// card's ring would want to show it, never one tick behind.
const GROUND_CARD_RADIUS_FP = SIM.lootRevealRadius;

/** The bits of Game's own state updateHud needs that aren't already on GameState. */
export interface HudContext {
  localOwner: number;
  score: number;
  selectedSkin: string;
  /** Co-op teammate line (ROADMAP 3.1) — shown for a local bot ally or the arenaDemo harness. */
  showAlly: boolean;
  allySkinId: string;
}

function totalBanked(s: GameState): number {
  let n = 0;
  for (const v of Object.values(s.bankedMaterials)) n += v ?? 0;
  return n;
}

/**
 * In-match HUD (design/10 widget kit), extracted out of Game.ts 2026-07-28 (that file
 * had accreted 6+ unrelated jobs — this is the "composed bars/text/toast" slice: HP/
 * shield/cooldown bars, the floor/PvP info line, the co-op ally line, the ground
 * weapon-compare card, toasts, and the PvP room-graph minimap). `view` is the
 * visibility root Game's own phase transitions toggle — same role `hudView` played
 * before extraction. `settingsBtn` deliberately stayed on Game: it's shown in the
 * FORGE phase too, not just during a run, so it isn't really part of "the HUD."
 */
export class HudView {
  readonly view = new Container();
  // Backing panel for the stat cluster (design/10 legibility fix, 2026-08-01: a raw
  // stack of Text over the game world read as visual noise, especially wherever the
  // world's own dark room background happened not to sit behind it) — purely
  // decorative, sized to the cluster's own fixed layout below.
  private statsPanel!: Panel;
  private hpBar!: Bar;
  private shieldBar!: Bar;
  private cdBar!: Bar;
  private weaponText!: Text;
  private infoText!: Text;
  private allyText!: Text;
  private toasts!: ToastQueue;
  private minimap!: Minimap;
  private floorProgress!: FloorProgress;
  // Ground compare card (design/03:125, locked spec: name/element/rarity, non-blocking,
  // render-only). Shown while standing near an uncollected floor weapon pickup.
  private readonly groundCard = new CompareCard();
  // Weapon pickup is button-driven (design/03:121-126, ENGINE_VERSION 21) — unlike
  // every other pickup kind, standing on it does nothing without this prompt's cue.
  private groundHint!: Text;

  build(layers: Layers, screenPx: { w: number; h: number }): void {
    this.statsPanel = new Panel({ radius: 8, color: 0x0b0e14, alpha: 0.55, borderColor: 0x4c566a, borderAlpha: 0.5 });
    this.hpBar = new Bar({ w: 160, h: 14, fillColor: 0xf56565, trackColor: 0x2a1620, label: true });
    this.shieldBar = new Bar({ w: 160, h: 9, fillColor: CONFIG.colors.shield, label: false });
    this.cdBar = new Bar({ w: 90, h: 7, fillColor: 0x63b3ed, label: false });
    // `padding` on every style below works around a real Pixi font-metrics mismatch
    // (see Button's own comment in ui/widgets.ts): its text measurement can come in
    // narrower than the canvas's actual paint-time glyph width, clipping the last
    // character(s) — this is what made "blaster [common] (ranged) dmg 12" render as
    // "...dm" (design/10 legibility fix, 2026-08-01).
    const smallStyle = { fill: 0xcbd5e0, fontSize: 13, fontFamily: 'monospace' as const, padding: 6 };
    this.weaponText = new Text({ text: '', style: { fill: 0xe2e8f0, fontSize: 14, fontFamily: 'monospace', padding: 6 } });
    this.infoText = new Text({ text: '', style: smallStyle });
    this.allyText = new Text({ text: '', style: smallStyle });
    this.toasts = new ToastQueue({ w: 220 });
    this.groundHint = new Text({
      text: t('hud.swapHint'),
      style: { fill: 0x90cdf4, fontSize: 13, fontFamily: 'monospace', fontWeight: 'bold', padding: 6 },
    });

    this.statsPanel.view.position.set(4, 4);
    this.hpBar.view.position.set(12, 10);
    this.shieldBar.view.position.set(12, 28);
    this.weaponText.position.set(12, 44);
    this.cdBar.view.position.set(12, 64);
    this.infoText.position.set(12, 78);
    this.floorProgress = new FloorProgress();
    this.floorProgress.view.position.set(12, 96);
    this.allyText.position.set(12, 112);
    // Placeholder size for the first frame before `update()` ever runs; `update()`
    // re-measures against the live text every tick (see the width comment there).
    this.statsPanel.layout(220, 128);

    this.view.addChild(
      this.statsPanel.view,
      this.hpBar.view, this.shieldBar.view, this.weaponText, this.cdBar.view,
      this.infoText, this.floorProgress.view, this.allyText,
      this.toasts.view, this.groundCard.view, this.groundHint,
    );
    // NOTE: `view` itself is NOT added to `layers.ui` here — the caller (Game) mounts
    // it inside its own visibility-toggled `hudView` container, exactly like before
    // extraction; HudView only owns the widgets, not the show/hide root.

    // PvP minimap (design/10 "room progress") — hidden unless state.zoneEnabled
    // (update). Top-right, inset enough to keep the WeChat capsule corner clear
    // (design/10 layout note). A sibling of `view`, not a child — its own visibility
    // is driven independently of the rest of the HUD (zoneEnabled, not phase), so it
    // is mounted directly into `layers.ui`, same as before extraction.
    this.minimap = new Minimap({ w: 140, h: 140 });
    layers.ui.addChild(this.minimap.view);

    this.reposition(screenPx);
  }

  /** Re-anchor the elements whose position depends on viewport size — call on build()
   *  and whenever the caller's own screenSize() changes. */
  reposition(screenPx: { w: number; h: number }): void {
    this.toasts.view.position.set(screenPx.w / 2 - 110, screenPx.h * 0.22);
    this.minimap.view.position.set(screenPx.w - 140 - 20, 60);
    // Beside the weapon HUD row (design/03:125 "beside your active weapon").
    this.groundCard.view.position.set(220, 40);
  }

  update(s: GameState, dt: number, ctx: HudContext): void {
    const p = s.players[ctx.localOwner];

    const hp = p ? Math.max(0, p.hp) : 0;
    const maxHp = p ? p.maxHp : 0;
    this.hpBar.set(hp, maxHp);
    this.hpBar.update(dt);

    // Shield pool (design/07 two-pool) — a separate bar, hidden for a zero-shield body.
    const maxSh = p ? p.maxShield : 0;
    this.shieldBar.view.visible = maxSh > 0;
    if (maxSh > 0) {
      this.shieldBar.set(p ? Math.max(0, p.shield) : 0, maxSh);
      this.shieldBar.update(dt);
    }

    const weapon = p?.weapon;
    this.weaponText.text = weapon
      ? t('hud.weaponLine', { name: weapon.spec.name, rarity: weapon.spec.rarity, kind: weapon.spec.kind, damage: weapon.spec.damage })
      : t('hud.weaponNone');
    // Cooldown sweep (design/10): weapon.cooldownTicks counts DOWN from the spec's fixed
    // cooldown (already whole ticks, sim-facing) to 0=ready — the bar fills as it recovers.
    const maxCdTicks = weapon
      ? Math.max(1, weapon.spec.kind === 'ranged' ? weapon.spec.fireRateTicks : weapon.spec.swingCooldownTicks)
      : 1;
    const readyTicks = weapon ? maxCdTicks - weapon.cooldownTicks : maxCdTicks;
    this.cdBar.set(readyTicks, maxCdTicks);
    this.cdBar.update(dt);

    const buffs = p && p.buffs.length ? t('hud.buffsSuffix', { count: p.buffs.length }) : '';
    if (s.zoneEnabled) {
      // PvP arena (design/15) — a score/timer/team HUD row (design/10) instead of the
      // dungeon floor/room line, which has no meaning here.
      const zone = s.zone;
      const alive = s.players.filter((pl) => pl.alive).length;
      const escalation = zone?.escalation ? t('hud.escalationSuffix', { n: zone.escalation }) : '';
      this.infoText.text = t('hud.pvpLine', {
        skin: ctx.selectedSkin, stage: zone?.stage ?? 0, escalation, alive, total: s.players.length,
        score: ctx.score, buffs,
      });
      this.floorProgress.update(0, -1); // hides — this is the PvP arena's own Minimap's job
    } else {
      // Dungeon progress (ROADMAP 1.3): floor / room within floor, plus the banked bag.
      const floor = s.floorIndex + 1;
      const room = Math.max(1, s.roomIndex + 1);
      const rooms = s.floorStages.length; // total stages this floor (linear or branching)
      const banked = totalBanked(s);
      this.infoText.text = t('hud.pveLine', {
        skin: ctx.selectedSkin, floor, floorCount: EMBER_DUNGEON.floorCount, room, rooms,
        enemies: s.enemies.length, banked, score: ctx.score, buffs,
      });
      // A real PvE minimap (design/10) — a progress TRACK, not a spatial map (see
      // FloorProgress's own doc comment for why PvE's data shape doesn't support the
      // PvP room-graph Minimap's kind of widget). 0 stages (flat EngineConfig.floors
      // mode) hides it, same as the PvP branch above.
      this.floorProgress.update(s.floorStages.length, s.roomIndex);
    }

    // Backing panel width tracks the widest live line (skin name / score digits vary
    // the dungeon and PvP info rows) instead of a fixed guess — a fixed width either
    // clips a long line or wastes space behind a short one every other frame. Uses
    // `estimateMonoWidth` (not `Text.width`/`getBounds()`, both canvas-measurement calls)
    // — see textWidth.ts for why: cheaper every frame, and testable without a live canvas.
    const contentW = Math.max(
      160, // hpBar/shieldBar's own fixed width
      estimateMonoWidth(this.weaponText.text, 14),
      estimateMonoWidth(this.infoText.text, 13),
      this.floorProgress.estimatedWidth(),
    );
    this.statsPanel.layout(Math.max(220, Math.ceil(contentW) + 24), 128);

    // Co-op teammate line (ROADMAP 3.1): the ally seat's health + downed/revive state, so
    // the second player is legible and its bleedout is visible. Single-player omits it.
    if (ctx.showAlly) {
      const ally = s.players.find((_, i) => i !== ctx.localOwner);
      const status = ally
        ? (ally.downed
            ? t('hud.allyDowned', { seconds: Math.ceil(ally.bleedoutTicks / 30) })
            : t('hud.allyHp', { hp: Math.max(0, ally.hp), maxHp: ally.maxHp }))
        : '';
      this.allyText.text = ally ? t('hud.allyLine', { skin: ctx.allySkinId, status }) : '';
    } else {
      this.allyText.text = '';
    }

    // Ground compare card (design/03:125) — floats while standing near an uncollected
    // floor weapon, name/element/rarity only (no stat table; that's the forge's job,
    // and a mid-run comparison needs to read at a glance, not be studied).
    const nearby = p ? nearestWeaponPickup(s.pickups, p.gx, p.gy, GROUND_CARD_RADIUS_FP) : undefined;
    const groundSpec = nearby?.weaponId ? WEAPON_SIM_BY_ID[nearby.weaponId] : undefined;
    if (p?.weapon && groundSpec) {
      this.groundCard.set({
        w: 220,
        leftName: p.weapon.spec.name,
        leftColor: rarityColor(p.weapon.spec),
        rightName: groundSpec.name,
        rightColor: rarityColor(groundSpec),
        rows: [{ label: t('compareCard.type'), left: p.weapon.spec.damageType, right: groundSpec.damageType }],
      });
      this.groundHint.text = t('hud.swapHint');
      this.groundHint.position.set(220, this.groundCard.view.y + this.groundCard.view.height + 4);
      this.groundHint.visible = true;
    } else {
      this.groundCard.hide();
      this.groundHint.visible = false;
    }

    this.toasts.update(dt);

    // PvP room-graph minimap (design/10) — no-op/hidden for PvE, same convention as the
    // engine-side ZoneSystem/EnvironmentSystem (ROADMAP 4.2d).
    if (s.zoneEnabled && s.arenaMap) {
      this.minimap.view.visible = true;
      const players: MinimapPlayer[] = s.players.map((pl, i) => ({
        roomId: pl.roomId,
        alive: pl.alive,
        isLocal: i === ctx.localOwner,
      }));
      this.minimap.update(s.arenaMap, s.zone, players);
    } else {
      this.minimap.view.visible = false;
    }
  }

  /** Push a toast — the only HUD widget consumeEvents reaches into directly (pickup fx). */
  toast(text: string, color: number): void {
    this.toasts.push(text, color);
  }
}
