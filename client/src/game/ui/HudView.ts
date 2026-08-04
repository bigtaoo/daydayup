import { Container, Graphics } from 'pixi.js';
import { THEME } from '../theme';
import type { Layers } from '../scene/layers';
import { Panel, ToastQueue } from './widgets';
import { nearbyWeaponPickups } from './pickupProximity';
import { WeaponPickupPrompt } from './WeaponPickupPrompt';
import { Minimap, type MinimapPlayer } from './Minimap';
import { FloorProgress } from './FloorProgress';
import { PlayerCard, AllyRow } from './PlayerCard';
import { WeaponCard } from './WeaponCard';
import { StatChip } from './StatChip';
import { DownedBanner } from './DownedBanner';
import type { HudIconId } from './hudIcons';
import { SIM, type GameState } from '@dd/engine';
import { t, type TranslationKey } from '../../i18n';
import { totalFloorCount } from '../match/floorCount';

// Weapon-pickup panel proximity ring (design/03) — wider than PickupSystem's own tight
// collect radius (SIM.pickupRadius) so the panel has a beat to show before it's even
// clickable. Same constant PickupSystem's weapon-kind branch itself gates collection
// on (SIM.lootRevealRadius) — sharing it means "if the panel shows it, you can click
// it," and also the constant used to resolve an arena crate, so a resolved weapon
// pickup is always already known by the time the panel would want to show it.
const WEAPON_PROMPT_RADIUS_FP = SIM.lootRevealRadius;

/** The bits of Game's own state updateHud needs that aren't already on GameState. */
export interface HudContext {
  localOwner: number;
  score: number;
  selectedSkin: string;
  /** Co-op teammate line (ROADMAP 3.1) — shown for a local bot ally or the arenaDemo harness. */
  showAlly: boolean;
  allySkinId: string;
}

type ChipKey = 'floor' | 'room' | 'enemies' | 'banked' | 'score' | 'buffs' | 'stage' | 'alive';

// Each chip's glyph + tint. Tints are pulled from what the stat refers to ON SCREEN, not
// picked for variety: the foe count takes the enemy faction red, banked materials take
// the material-pickup yellow, buffs take the buff-pickup violet, the PvP zone stage takes
// the same amber the Minimap telegraphs a closing room with. A player who has learned a
// colour in the world reads the chip for free.
const CHIP_DEFS: Record<ChipKey, { icon: HudIconId; color: number; label: TranslationKey }> = {
  floor: { icon: 'floor', color: 0xf6ad55, label: 'hud.chips.floor' },
  room: { icon: 'room', color: 0x90cdf4, label: 'hud.chips.room' },
  enemies: { icon: 'enemies', color: THEME.colors.enemy, label: 'hud.chips.enemies' },
  banked: { icon: 'banked', color: THEME.colors.pickupMaterial, label: 'hud.chips.banked' },
  score: { icon: 'score', color: 0xffd27f, label: 'hud.chips.score' },
  buffs: { icon: 'buffs', color: THEME.colors.pickupBuff, label: 'hud.chips.buffs' },
  stage: { icon: 'stage', color: 0xf6ad55, label: 'hud.chips.stage' },
  alive: { icon: 'alive', color: 0x68d391, label: 'hud.chips.alive' },
};

// Which chips a mode shows, in row order. `buffs` is in both and drops out of the row
// whenever the run has none — an always-zero chip is noise.
const PVE_CHIPS: readonly ChipKey[] = ['floor', 'room', 'enemies', 'banked', 'score', 'buffs'];
const PVP_CHIPS: readonly ChipKey[] = ['stage', 'alive', 'score', 'buffs'];

const PAD = 12; // panel inset, all four sides
const GAP = 8; // vertical gap between HUD sections
const CHIP_GAP = 6;

/**
 * In-match HUD (design/10 widget kit), extracted out of Game.ts 2026-07-28 and rebuilt
 * as real UI 2026-08-02. It previously composed a couple of bars with two monospace
 * strings — a weapon line and one long "Floor 1/3 Room 1/2 Enemies 1 Banked 0 Score 0"
 * run-on — which read as a debug print rather than a HUD (the user's own complaint).
 * Every one of those values is now a widget: a `PlayerCard` (portrait + name + the two
 * defensive pools), a `WeaponCard` (real weapon art + rarity + element + damage +
 * cooldown), and a row of icon-led `StatChip`s, over one backing `Panel` that sizes
 * itself to whichever section is widest.
 *
 * `view` is the visibility root Game's own phase transitions toggle; HudView owns the
 * widgets, not the show/hide root. `settingsBtn` deliberately stays on Game: it's shown
 * in the FORGE phase too, so it isn't really part of "the HUD."
 */
export class HudView {
  readonly view = new Container();
  // Sub-widgets are public so tests (and any future caller) can assert against a named
  // widget rather than indexing into `view.children` by position, which is what the
  // previous version of this file forced on HudView.test.ts.
  readonly playerCard = new PlayerCard();
  readonly weaponCard = new WeaponCard();
  readonly allyRow = new AllyRow();
  readonly downedBanner = new DownedBanner();
  readonly chips = new Map<ChipKey, StatChip>();
  readonly floorProgress = new FloorProgress();
  // Ground weapon-pickup panel (design/03, ENGINE_VERSION 32) — lists every nearby
  // floor weapon (icon + name); tapping one is the collect action itself. Replaces the
  // old single-nearest "ground compare card" + tap-INTERACT gesture.
  readonly weaponPickupPrompt = new WeaponPickupPrompt();

  private statsPanel!: Panel;
  private readonly dividers = new Graphics();
  private toasts!: ToastQueue;
  private minimap!: Minimap;
  private panelW = 0;
  private panelH = 0;

  build(layers: Layers, screenPx: { w: number; h: number }): void {
    this.statsPanel = new Panel({ radius: 10, color: 0x0b0e14, alpha: 0.66, borderColor: 0x4c566a, borderAlpha: 0.55 });
    this.toasts = new ToastQueue({ w: 220 });

    this.statsPanel.view.position.set(4, 4);
    this.playerCard.view.position.set(PAD, 10);
    this.weaponCard.view.position.set(PAD, 10 + PlayerCard.HEIGHT + GAP);

    for (const [key, def] of Object.entries(CHIP_DEFS) as Array<[ChipKey, (typeof CHIP_DEFS)[ChipKey]]>) {
      this.chips.set(key, new StatChip(def.icon, def.color));
    }

    this.view.addChild(
      this.statsPanel.view,
      this.dividers,
      this.playerCard.view,
      this.weaponCard.view,
      ...[...this.chips.values()].map((c) => c.view),
      this.floorProgress.view,
      this.allyRow.view,
      this.toasts.view,
      this.weaponPickupPrompt.view,
      this.downedBanner.view,
    );
    // NOTE: `view` itself is NOT added to `layers.ui` here — the caller (Game) mounts
    // it inside its own visibility-toggled `hudView` container.

    // PvP minimap (design/10 "room progress") — hidden unless state.zoneEnabled
    // (update). Top-right, inset enough to keep the WeChat capsule corner clear
    // (design/10 layout note). A sibling of `view`, not a child — its own visibility
    // is driven independently of the rest of the HUD (zoneEnabled, not phase), so it
    // is mounted directly into `layers.ui`.
    this.minimap = new Minimap({ w: 140, h: 140 });
    layers.ui.addChild(this.minimap.view);

    this.reposition(screenPx);
  }

  /** Re-anchor the elements whose position depends on viewport size — call on build()
   *  and whenever the caller's own screenSize() changes. */
  reposition(screenPx: { w: number; h: number }): void {
    this.toasts.view.position.set(screenPx.w / 2 - 110, screenPx.h * 0.22);
    this.minimap.view.position.set(screenPx.w - 140 - 20, 60);
    this.downedBanner.reposition(screenPx);
  }

  update(s: GameState, dt: number, ctx: HudContext): void {
    const p = s.players[ctx.localOwner];

    this.playerCard.set(ctx.selectedSkin, p?.hp ?? 0, p?.maxHp ?? 0, p?.shield ?? 0, p?.maxShield ?? 0);
    this.playerCard.update(dt);

    // Cooldown sweep (design/10): weapon.cooldownTicks counts DOWN from the spec's fixed
    // cooldown (already whole ticks, sim-facing) to 0=ready — the bar fills as it recovers.
    const weapon = p?.weapon;
    const maxCdTicks = weapon
      ? Math.max(1, weapon.spec.kind === 'ranged' ? weapon.spec.fireRateTicks : weapon.spec.swingCooldownTicks)
      : 1;
    this.weaponCard.set(weapon?.spec ?? null, weapon ? maxCdTicks - weapon.cooldownTicks : maxCdTicks, maxCdTicks);
    this.weaponCard.update(dt);

    const buffCount = p?.buffs.length ?? 0;
    if (s.zoneEnabled) {
      // PvP arena (design/15) — zone stage / survivors / score, instead of the dungeon
      // floor-and-room chips, which have no meaning here.
      const zone = s.zone;
      const stage = zone?.stage ?? 0;
      this.chips.get('stage')!.set(t('hud.chips.stage'), zone?.escalation ? `${stage}+${zone.escalation}` : `${stage}`);
      this.chips.get('alive')!.set(t('hud.chips.alive'), `${s.players.filter((pl) => pl.alive).length}/${s.players.length}`);
      this.floorProgress.update(0, -1); // hides — this is the PvP arena's own Minimap's job
    } else {
      // Dungeon progress (ROADMAP 1.3): floor / room within floor, plus the banked bag.
      const rooms = s.floorStages.length; // total stages this floor (linear or branching)
      this.chips.get('floor')!.set(t('hud.chips.floor'), `${s.floorIndex + 1}/${totalFloorCount(s)}`);
      this.chips.get('room')!.set(t('hud.chips.room'), `${Math.max(1, s.roomIndex + 1)}/${rooms}`);
      this.chips.get('enemies')!.set(t('hud.chips.enemies'), `${s.enemies.length}`);
      this.chips.get('banked')!.set(t('hud.chips.banked'), `${totalBanked(s)}`);
      // A real PvE minimap (design/10) — a progress TRACK, not a spatial map (see
      // FloorProgress's own doc comment for why PvE's data shape doesn't support the
      // PvP room-graph Minimap's kind of widget). 0 stages (flat EngineConfig.floors
      // mode) hides it, same as the PvP branch above.
      this.floorProgress.update(rooms, s.roomIndex);
    }
    this.chips.get('score')!.set(t('hud.chips.score'), `${ctx.score}`);
    this.chips.get('buffs')!.set(t('hud.chips.buffs'), `${buffCount}`);

    // Co-op teammate (ROADMAP 3.1): the ally seat's health + downed/bleedout state, so
    // the second player is legible. Single-player omits the row entirely.
    const ally = ctx.showAlly ? s.players.find((_, i) => i !== ctx.localOwner) : undefined;
    this.allyRow.view.visible = ally !== undefined;
    if (ally) {
      this.allyRow.set(ctx.allySkinId, ally.hp, ally.maxHp, ally.downed, Math.ceil(ally.bleedoutTicks / 30), ally.reviveProgressTicks);
      this.allyRow.update(dt);
    }

    // Local seat's own downed/revive state (design/10 open question, ROADMAP 3.2) —
    // previously invisible: a downed player saw only a frozen world, nothing explaining
    // why or how long until either a revive completes or bleedout ends the run.
    this.downedBanner.set(p?.downed ?? false, p?.bleedoutTicks ?? 0, p?.reviveProgressTicks ?? 0);
    this.downedBanner.update(dt);

    this.layout(s.zoneEnabled ? PVP_CHIPS : PVE_CHIPS, buffCount > 0, ally !== undefined);
    this.updateWeaponPickupPrompt(s, p);
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

  /** Pack the chip row, stack whatever sections are live, and size the backing panel to
   *  the widest of them. Sizing is `estimateMonoWidth`-derived throughout (never
   *  `Text.width`/`getBounds()`, both canvas-measurement calls) — see textWidth.ts for
   *  why: cheaper every frame, and testable without a live canvas. */
  private layout(order: readonly ChipKey[], showBuffs: boolean, showAlly: boolean): void {
    let chipX = PAD;
    for (const [key, chip] of this.chips) {
      const active = order.includes(key) && (key !== 'buffs' || showBuffs);
      chip.view.visible = active;
      if (!active) continue;
      chip.view.position.set(chipX, 0); // y set below, once the row's own y is known
      chipX += chip.width + CHIP_GAP;
    }
    const chipsW = chipX - PAD - CHIP_GAP;

    let y = 10 + PlayerCard.HEIGHT + GAP + WeaponCard.HEIGHT + GAP;
    const chipRowY = y;
    for (const chip of this.chips.values()) if (chip.view.visible) chip.view.position.y = chipRowY;
    y += StatChip.HEIGHT;

    if (this.floorProgress.view.visible) {
      this.floorProgress.view.position.set(PAD, y + 6);
      y += 6 + 12;
    }
    if (showAlly) {
      this.allyRow.view.position.set(PAD, y + 8);
      y += 8 + AllyRow.HEIGHT;
    }

    const w =
      Math.ceil(
        Math.max(
          this.playerCard.estimatedWidth(),
          this.weaponCard.estimatedWidth(),
          chipsW,
          this.floorProgress.view.visible ? this.floorProgress.estimatedWidth() : 0,
          showAlly ? this.allyRow.estimatedWidth() : 0,
        ),
      ) + PAD;
    const h = y + 10;
    if (w !== this.panelW || h !== this.panelH) {
      this.panelW = w;
      this.panelH = h;
      this.statsPanel.layout(w, h);
      this.redrawDividers(w);
      // The weapon-pickup panel floats immediately right of the HUD (design/03) — it
      // has to track the panel's live width, or a long localized weapon name slides
      // the panel out from under it.
      this.weaponPickupPrompt.view.position.set(w + 12, 40);
    }
  }

  private redrawDividers(w: number): void {
    // Hairlines between the three fixed sections (who you are / what you hold / how the
    // run is going). Cheap grouping cue — without them the card reads as one dense block.
    const line = (y: number) => {
      this.dividers.moveTo(PAD, y).lineTo(w - PAD + 4, y);
    };
    this.dividers.clear();
    line(10 + PlayerCard.HEIGHT + GAP / 2);
    line(10 + PlayerCard.HEIGHT + GAP + WeaponCard.HEIGHT + GAP / 2);
    this.dividers.stroke({ color: 0x4c566a, alpha: 0.35, width: 1 });
  }

  // Weapon-pickup panel (design/03) — lists every nearby floor weapon while standing
  // near one or more; the click itself is the collect action (WeaponPickupPrompt.onPick,
  // wired to CommandBuilder.requestPickup by Game.ts).
  private updateWeaponPickupPrompt(s: GameState, p: GameState['players'][number] | undefined): void {
    const nearby = p ? nearbyWeaponPickups(s.pickups, p.gx, p.gy, WEAPON_PROMPT_RADIUS_FP) : [];
    this.weaponPickupPrompt.update(nearby);
  }
}

function totalBanked(s: GameState): number {
  let n = 0;
  for (const v of Object.values(s.bankedMaterials)) n += v ?? 0;
  return n;
}
