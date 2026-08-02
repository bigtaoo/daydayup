import { Graphics } from 'pixi.js';
import type { DamageType, StatusState } from '@dd/engine';
import { THEME, ELEMENT_COLORS } from '../theme';
import { Entity } from './Entity';
import { Skin } from './Skin';

export type Faction = 'player' | 'enemy';
export type WeaponKind = 'ranged' | 'melee';

// How far (× body radius) to lift the sprite so the ground anchor sits at the feet.
// Bigger → more of the body rises above the anchor → more it can overlap a pillar.
const BODY_LIFT_R = 0.7;

// Lingering status auras (design/03/07): a concentric glowing ring per active
// on-hit effect, so a burning / chilled / poisoned actor reads while the DoT lasts —
// not just a one-frame flash on the hit. Lightning has no lingering status (the
// chain is instant), so it deliberately has no aura. Bit index = ring order.
const AURAS: ReadonlyArray<{ bit: number; color: number; active: (s: StatusState) => boolean }> = [
  { bit: 1, color: THEME.colors.statusBurn, active: (s) => s.burnTicks > 0 },
  { bit: 2, color: THEME.colors.statusChill, active: (s) => s.chillTicks > 0 },
  { bit: 4, color: THEME.colors.statusPoison, active: (s) => s.poison.length > 0 },
];

// Actor view (player / enemy). Pure presentation: body skin, a soft shadow, and a
// cosmetic weapon graphic that swaps shape by the engine weapon's kind (Stage D:
// no weapon logic lives here — the engine owns firing, cooldowns, and the loadout).
export class Actor extends Entity {
  private skin: Skin;
  private weaponGfx = new Graphics();
  private statusAura = new Graphics(); // lingering elemental aura, behind the body
  private auraMask = 0; // bitmask of the effects currently drawn (skip redraw if same)
  private auraT = 0; // aura pulse clock (render-only, ms)
  private healthBar: Graphics | null = null; // floating hp bar above the head (both factions)
  private readonly isBoss: boolean;
  private hpRatio = -1; // last-drawn hp fraction (skip redraw if unchanged)
  private weaponKind: WeaponKind | null | undefined = undefined;
  private weaponName: string | undefined = undefined;
  private weaponElement: DamageType | undefined = undefined;
  private radiusPx: number;
  private readonly faction: Faction;

  constructor(faction: Faction, radiusPx: number, tint?: number, boss = false, atlasKey?: string) {
    super();
    this.faction = faction;
    this.radiusPx = radiusPx;
    this.isBoss = boss;
    // The actor container sorts children so the weapon can sit in front of / behind.
    this.sortableChildren = true;

    // Aura sits behind everything (zIndex -1) and glows additively.
    this.statusAura.zIndex = -1;
    this.statusAura.blendMode = 'add';
    this.addChild(this.statusAura);

    const [body, front] =
      faction === 'player'
        ? [THEME.colors.player, THEME.colors.playerFront]
        : [THEME.colors.enemy, 0xffd6d6];
    // An enemy blueprint tint (elemental variant) overrides the default body colour.
    // `atlasKey` is the entity's resolved skin/body-rig name — for players, the
    // SkinDef.atlasKey (design/13's 3-character roster), falling back to the default
    // character's skin if a player entity somehow carries none (forward-compat, like
    // resolveSkin). For enemies, the blueprint's `bodyRig` (design/13 "roster variety
    // beyond the base body") — most variants are still re-tints of the shared
    // critter-core body ("one neutral-grey body, re-tinted per variant"), re-tinted at
    // runtime via `rigTint`; brute/floater instead point at their own distinct rig
    // registry entry while reusing the same tint mechanism. Falls back to the Graphics
    // placeholder like any skin that hasn't (or never will) preload.
    const resolvedTint = tint ?? body;
    this.skin = new Skin(
      resolvedTint,
      front,
      radiusPx,
      faction === 'player' ? (atlasKey ?? 'char_vanguard') : (atlasKey ?? 'critter-core'),
      faction === 'enemy' ? resolvedTint : undefined,
    );
    this.addChild(this.skin.view);

    this.weaponGfx.zIndex = 1;
    this.addChild(this.weaponGfx);
    this.makeShadow(radiusPx * 0.7);

    // Lift the body + weapon so the container origin (gx,gy — where the shadow and
    // the engine's collision footprint sit) lands near the feet rather than the
    // torso. The sprite then rises above the ground point, so via Y-sort it draws
    // over a pillar it stands against (design/01 fake-3D depth).
    const lift = radiusPx * BODY_LIFT_R;
    this.skin.view.y = -lift;
    this.weaponGfx.y = -lift;
    this.statusAura.y = -lift;

    // Every actor carries a floating health bar above its head (design/10 legibility
    // fix, 2026-08-02 for enemies: previously boss-only, so a regular mob's damage
    // state — and a poison/burn melt — was invisible without reading the HUD; extended
    // to the player 2026-08-02 so hp is readable on the map itself, not just the corner
    // HUD). A boss's is drawn bigger/further out (setHealth) so it still reads as the
    // more prominent threat.
    this.healthBar = new Graphics();
    this.healthBar.y = -lift - radiusPx * (boss ? 1.7 : 1.3);
    this.addChild(this.healthBar);
  }

  // Swap the cosmetic weapon shape to match the engine's active weapon kind. A real
  // rig mounts its own weapon sprite on the socket (design/03/12/13's universal
  // mount); the Graphics placeholder is only drawn when no rig is loaded, so the
  // two never render on top of each other. Enemies are the exception: critter-core
  // (design/13) is deliberately socket-less (one bone, no arms yet), so its rig can
  // never mount a weapon sprite — enemies always keep the Graphics placeholder,
  // regardless of `hasRig`. `damageType` re-tints the mounted weapon sprite to its
  // element hue (`ELEMENT_COLORS`, same law as a bullet's own colour) — physical
  // stays the weapon's neutral authored colour, matching `Bullet.color`'s own
  // `ELEMENT_COLORS[type] ?? fallback` convention.
  setWeaponKind(kind: WeaponKind | null, damageType?: DamageType, name?: string): void {
    if (kind === this.weaponKind && damageType === this.weaponElement && name === this.weaponName) return;
    this.weaponKind = kind;
    this.weaponElement = damageType;
    this.weaponName = name;
    this.skin.setWeaponKind(kind, name);
    this.skin.setWeaponTint(damageType !== undefined ? (ELEMENT_COLORS[damageType] ?? 0xffffff) : 0xffffff);
    const rigCanMountWeapon = this.skin.hasRig && this.faction === 'player';
    this.drawWeapon(rigCanMountWeapon ? null : kind);
  }

  // Update the boss health bar from the engine actor's hp (no-op for non-bosses).
  // Colour ramps green → amber → red as it drains; redraws only when the fraction
  // changes, so a boss sitting at full hp costs nothing per tick.
  setHealth(hp: number, maxHp: number): void {
    if (!this.healthBar || maxHp <= 0) return;
    const ratio = Math.max(0, Math.min(1, hp / maxHp));
    if (ratio === this.hpRatio) return;
    this.hpRatio = ratio;

    const w = this.radiusPx * (this.isBoss ? 2.2 : 1.7);
    const h = this.isBoss ? 6 : 4;
    const g = this.healthBar;
    g.clear();
    g.roundRect(-w / 2, -h / 2, w, h, 2).fill({ color: 0x1a1d26, alpha: 0.85 });
    if (ratio > 0) {
      const color = ratio > 0.5 ? 0x66bb6a : ratio > 0.25 ? 0xffca28 : 0xef5350;
      g.roundRect(-w / 2, -h / 2, w * ratio, h, 2).fill({ color });
    }
    g.roundRect(-w / 2, -h / 2, w, h, 2).stroke({ color: 0x0c0e14, width: 1, alpha: 0.9 });
  }

  // Mirror the engine actor's lingering status (design/03/07). Draws one glowing
  // ring per active effect; redraws only when the active set changes (the pulse is
  // an alpha animation in interpolate, so a steady burn doesn't rebuild geometry).
  setStatus(status: StatusState): void {
    let mask = 0;
    for (const a of AURAS) if (a.active(status)) mask |= a.bit;
    if (mask === this.auraMask) return;
    this.auraMask = mask;

    const g = this.statusAura;
    g.clear();
    if (mask === 0) return;
    const r = this.radiusPx;
    let ring = 0;
    for (const a of AURAS) {
      if (!(mask & a.bit)) continue;
      const rad = r * (1.15 + ring * 0.22);
      g.circle(0, 0, rad).stroke({ color: a.color, width: 3, alpha: 0.55 });
      ring++;
    }
  }

  private drawWeapon(kind: WeaponKind | null): void {
    const g = this.weaponGfx;
    g.clear();
    const r = this.radiusPx;
    if (kind === 'ranged') {
      g.rect(r * 0.5, -2.5, r * 0.8, 5).fill({ color: THEME.colors.gun }); // barrel
    } else if (kind === 'melee') {
      g.moveTo(r * 0.3, 0)
        .lineTo(r * 1.5, 0)
        .stroke({ color: THEME.colors.sword, width: 3 }); // blade
    }
  }

  override interpolate(alpha: number, frameDt: number): void {
    super.interpolate(alpha, frameDt);
    // Cheap idle/move clip pick straight from Entity's own interpolation buffers —
    // attack/hurt/death need real GameState signals Actor doesn't receive yet.
    const moving = Math.hypot(this.curX - this.prevX, this.curY - this.prevY) > 0.01;
    // Upper/lower body split: the body (legs/torso) faces movement (`bodyFacingRad`,
    // == facingRad for anything that doesn't move independently of its aim, like an
    // enemy), while the weapon always points at the aim/shot direction (`facingRad`).
    this.skin.setFacing(this.bodyFacingRad, this.facingRad, frameDt, moving ? 'move' : 'idle');
    this.weaponGfx.rotation = this.facingRad;
    // Gentle breathing pulse so an active aura reads as a live effect, not an outline.
    if (this.auraMask !== 0) {
      this.auraT += frameDt;
      this.statusAura.alpha = 0.75 + 0.25 * Math.sin(this.auraT * 0.008);
    }
  }
}
