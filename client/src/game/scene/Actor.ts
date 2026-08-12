import { Filter, Graphics, Rectangle } from 'pixi.js';
import type { DamageType, StatusState } from '@dd/engine';
import { THEME, ELEMENT_COLORS } from '../theme';
import { EnergyShieldFilter, OutlineFilter, DissolveFilter, HeatHazeFilter, NormalLitFilter } from '../fx/filters';
import type { LightHit } from '../fx/lighting';
import { Entity } from './Entity';
import { Skin } from './Skin';

export type Faction = 'player' | 'enemy';
export type WeaponKind = 'ranged' | 'melee';

// How far (× body radius) to lift the sprite so the ground anchor sits at the feet.
// Bigger → more of the body rises above the anchor → more it can overlap a pillar.
const BODY_LIFT_R = 0.7;

const HIT_FLASH_MS = 160; // outline "you were just hit" flash duration (Actor.hitFlash)
const DISSOLVE_MS = 700; // death-dissolve shader duration (Actor.startDissolve)

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
  private localRing: Graphics | null = null; // "this one is you" ground marker (setLocal)
  private isLocal = false;
  private readonly isBoss: boolean;
  private hpRatio = -1; // last-drawn hp fraction (skip redraw if unchanged)
  // Dynamic lighting (design/01 fidelity roadmap milestone 2) — unlike every filter
  // below, this one is never conditionally active: every actor is always lit, so it's
  // built eagerly instead of lazily, and always first in applySkinFilters()'s list.
  private readonly litFilter = new NormalLitFilter();
  private shieldFilter: EnergyShieldFilter | null = null; // lazily built — most actors never carry a shield pool
  private shieldActive = false;
  private shieldRatio = -1; // last-applied shield fraction (skip redundant work if unchanged)
  private outlineFilter: OutlineFilter | null = null; // lazily built — most actors never get hit while on screen
  private outlineMs = 0; // remaining ms of the current hit flash, 0 = inactive
  private dissolveFilter: DissolveFilter | null = null;
  private dissolveMs = -1; // -1 = not dissolving; counts up from 0 once startDissolve fires
  private heatHazeFilter: HeatHazeFilter | null = null; // lazily built — most actors never burn
  private heatHazeActive = false;
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
    // Pin the filter render area to a fixed square, X-centered on the skin's local
    // origin (0,0) — the placeholder's facing-direction "front" wedge (Skin.ts) and a
    // real rig's mounted weapon sprite both extend the auto-computed bounds out to one
    // side only (whichever way the actor is currently facing/aiming), which drags
    // EVERY skin-level filter's UV-space "center" along with it. Most filters
    // (OutlineFilter, NormalLitFilter, HeatHazeFilter) sample the real alpha edge so
    // they're visually tolerant of that drift, but EnergyShieldFilter's rim-glow is a
    // hardcoded UV-distance-from-0.5 circle (see filters.ts) — it needs the render
    // area itself to stay centered and symmetric, or the glow renders lopsided toward
    // whichever side the bounds happen to extend that frame. 3x radius comfortably
    // covers body + any mounted weapon reach in every facing/aim direction.
    //
    // Y is measured, not assumed 0: a rig's decorative bones hang off the body bone's
    // TIP, not its center (design/12/13's FK convention — orb-core's eye/belly/weapon
    // sockets all sit ~1 body-length above the shell's own origin, see orbCoreRig.ts),
    // so the assembled silhouette is consistently top-heavy relative to (0,0) — found
    // 2026-08-12 from a user report that the shield glow sat low, hugging the ground
    // instead of the character (`critter-core`'s single-bone enemies have no such
    // offset and were never visibly wrong). Unlike the X asymmetry above, this one does
    // NOT depend on facing/aim (only the weapon socket's own rotation does, an X-axis
    // effect already handled by pinning X), so measuring it once, here, at a neutral
    // rest pose is safe — it won't drift during play the way a per-frame bounds read
    // would. `setFacing` lays the rig out at rest (or is a harmless no-op default for
    // the Graphics placeholder) so `getLocalBounds` reports real numbers.
    this.skin.setFacing(0, 0, 0, 'idle');
    const restBounds = this.skin.view.getLocalBounds();
    const filterCenterY = restBounds.y + restBounds.height / 2;
    const filterHalfExtent = radiusPx * 3;
    this.skin.view.filterArea = new Rectangle(
      -filterHalfExtent,
      filterCenterY - filterHalfExtent,
      filterHalfExtent * 2,
      filterHalfExtent * 2,
    );

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

    // litFilter is always on (unlike the four conditionally-active shaders below, whose
    // own setters call applySkinFilters on their own activation edge) — an actor that
    // never takes a status/shield/hit/death would otherwise never get it attached at all.
    this.applySkinFilters();
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

  /**
   * Mark this actor as the seat THIS client is driving (`Scene` resolves which one).
   *
   * Every actor got a floating health bar in the 2026-08-02 legibility pass, which had
   * an unintended cost: the player's own bar became indistinguishable from a mob's, so
   * "which one of these is me" stopped being answerable at a glance — the user's own
   * report, pointing at their character and asking what it was. Two cues fix it without
   * touching the sim: a teal ground ring at the feet (the player faction's own hue,
   * THEME.colors.player — the one colour no enemy tint ever takes), and a health bar
   * outlined in that same teal instead of the default near-black.
   */
  setLocal(local: boolean): void {
    if (local === this.isLocal) return;
    this.isLocal = local;
    if (local && !this.localRing) {
      this.localRing = new Graphics();
      this.localRing.zIndex = -2; // behind the status aura (-1) and the body
      this.addChild(this.localRing);
    }
    if (this.localRing) {
      // Squashed to the same 0.5 ratio Entity.makeShadow uses, so it reads as lying on
      // the ground plane rather than as a halo standing up around the body.
      const r = this.radiusPx * 1.2;
      this.localRing.clear();
      if (local) {
        this.localRing
          .ellipse(0, 0, r, r * 0.5)
          .stroke({ color: THEME.colors.player, width: 2, alpha: 0.9 })
          .ellipse(0, 0, r * 0.7, r * 0.35)
          .stroke({ color: THEME.colors.player, width: 1, alpha: 0.3 });
      }
    }
    this.hpRatio = -1; // force setHealth to redraw the bar in its new outline style
  }

  // Update the floating health bar from the engine actor's hp. Colour ramps green →
  // amber → red as it drains; redraws only when the fraction changes, so an actor
  // sitting at full hp costs nothing per tick.
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
    g.roundRect(-w / 2, -h / 2, w, h, 2).stroke(
      this.isLocal
        ? { color: THEME.colors.player, width: 1.5, alpha: 1 }
        : { color: 0x0c0e14, width: 1, alpha: 0.9 },
    );
  }

  // Mirror the engine actor's lingering status (design/03/07). Draws one glowing
  // ring per active effect; redraws only when the active set changes (the pulse is
  // an alpha animation in interpolate, so a steady burn doesn't rebuild geometry).
  setStatus(status: StatusState): void {
    let mask = 0;
    for (const a of AURAS) if (a.active(status)) mask |= a.bit;
    if (mask === this.auraMask) return;
    const prevMask = this.auraMask;
    this.auraMask = mask;

    const g = this.statusAura;
    g.clear();
    if (mask !== 0) {
      const r = this.radiusPx;
      let ring = 0;
      for (const a of AURAS) {
        if (!(mask & a.bit)) continue;
        const rad = r * (1.15 + ring * 0.22);
        g.circle(0, 0, rad).stroke({ color: a.color, width: 3, alpha: 0.55 });
        ring++;
      }
    }

    // Heat-haze distortion (design/01 fidelity roadmap milestone 5, `HeatHazeFilter`) —
    // the silhouette itself shimmers while burning, on top of the ring above. Burn is
    // bit 1 (AURAS[0]); only reacts on an actual burn on/off edge, not every aura change
    // (a chill/poison toggle alongside an ongoing burn shouldn't rebuild this filter).
    const wasBurning = (prevMask & 1) !== 0;
    const isBurning = (mask & 1) !== 0;
    if (isBurning !== wasBurning) {
      if (isBurning && !this.heatHazeFilter) this.heatHazeFilter = new HeatHazeFilter();
      this.heatHazeActive = isBurning;
      this.applySkinFilters();
    }
  }

  // Mirror the engine actor's two-pool shield (design/02/05/07) as a shimmering rim-glow
  // (design/01 fidelity roadmap milestone 5, `EnergyShieldFilter`). maxShield <= 0 is the
  // common case (most enemies, the 0-shield starter) and stays a cheap no-op — the filter
  // is only ever built for an actor that actually carries a shield pool. Ratio 0 (broken,
  // still has a maxShield) removes it — the `shield_break` event's own flash already
  // covers that instant, so there's nothing left for the glow to do.
  setShield(shield: number, maxShield: number): void {
    if (maxShield <= 0) {
      this.shieldRatio = -1;
      this.setShieldActive(false);
      return;
    }
    const ratio = Math.max(0, Math.min(1, shield / maxShield));
    if (ratio === this.shieldRatio) return;
    this.shieldRatio = ratio;
    if (ratio <= 0) {
      this.setShieldActive(false);
      return;
    }
    if (!this.shieldFilter) this.shieldFilter = new EnergyShieldFilter(THEME.colors.shield);
    this.shieldFilter.intensity = ratio;
    this.setShieldActive(true);
  }

  /** Apply this frame's strongest nearby point light (design/01 milestone 2) — called
   *  once per render frame by Scene.applyLighting, `null` when nothing is close enough
   *  to matter (the filter's fixed key light still shades in that case). */
  setLighting(hit: LightHit | null): void {
    if (hit) this.litFilter.setPoint(hit.dirX, hit.dirY, hit.color, hit.intensity);
    else this.litFilter.clearPoint();
  }

  private setShieldActive(active: boolean): void {
    if (active === this.shieldActive) return;
    this.shieldActive = active;
    this.applySkinFilters();
  }

  // Brief "you were just hit" silhouette flash (design/01 milestone 5, `OutlineFilter`)
  // — real alpha-edge detection, unlike the shield's UV-distance approximation, so it
  // reads correctly against any body shape. Fired from EventReactor's 'hit' case for
  // BOTH factions (whichever actor the event names as `target`), independent of the
  // existing position-anchored `fx.flash()` burst — that one reads as "impact happened
  // here", this one reads as "THIS actor took it".
  hitFlash(): void {
    if (!this.outlineFilter) this.outlineFilter = new OutlineFilter(0xffffff);
    this.outlineFilter.alpha = 1;
    this.outlineMs = HIT_FLASH_MS;
    this.applySkinFilters();
  }

  // Kick off the death-dissolve shader (design/01 milestone 5, `DissolveFilter`) — called
  // once by Scene when this actor's id drops out of the engine's alive list, instead of
  // destroying the view that same tick. Hides everything except the dissolving body
  // itself (weapon/aura/hp-bar/local-ring are all meaningless on a dead actor and would
  // otherwise float oddly over a half-dissolved silhouette).
  startDissolve(): void {
    if (this.dissolveMs >= 0) return; // already dissolving — defensive, shouldn't double-fire
    this.dissolveFilter = new DissolveFilter();
    this.dissolveMs = 0;
    this.weaponGfx.visible = false;
    this.statusAura.visible = false;
    if (this.healthBar) this.healthBar.visible = false;
    if (this.localRing) this.localRing.visible = false;
    this.applySkinFilters();
  }

  /** True once the death-dissolve has fully played out — Scene destroys the view then. */
  get isDissolved(): boolean {
    return this.dissolveMs >= DISSOLVE_MS;
  }

  // Recompute `skin.view.filters` from `litFilter` (always on) plus whichever of the
  // four conditionally-active skin-level shaders are currently live. Order is
  // lit-then-warp-then-glow-then-highlight-then-dissolve: lighting establishes the base
  // shaded colour every later overlay then distorts/adds onto/highlights, the UV wobble
  // should distort what the glow/outline draw (not the other way around), a hit flash
  // should still read on top of an active shield glow, and a dying actor's dissolve
  // should be the last word regardless of what else was active the instant it died.
  private applySkinFilters(): void {
    const list: Filter[] = [this.litFilter];
    if (this.heatHazeActive && this.heatHazeFilter) list.push(this.heatHazeFilter);
    if (this.shieldActive && this.shieldFilter) list.push(this.shieldFilter);
    if (this.outlineMs > 0 && this.outlineFilter) list.push(this.outlineFilter);
    if (this.dissolveMs >= 0 && this.dissolveFilter) list.push(this.dissolveFilter);
    this.skin.view.filters = list.length ? list : null;
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
    // attack/hurt/death need real GameState signals Actor doesn't receive yet. A caller
    // that collapses prev onto cur mid-motion (`Scene.positionLocal`'s predicted-pose
    // snap) sets `movingOverride` explicitly since the buffer delta alone would always
    // read as stationary in that case.
    const moving = this.movingOverride ?? Math.hypot(this.curX - this.prevX, this.curY - this.prevY) > 0.01;
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
    if (this.shieldActive && this.shieldFilter) this.shieldFilter.tick(frameDt);
    if (this.heatHazeActive && this.heatHazeFilter) this.heatHazeFilter.tick(frameDt);
    if (this.outlineMs > 0) {
      this.outlineMs = Math.max(0, this.outlineMs - frameDt);
      this.outlineFilter!.alpha = this.outlineMs / HIT_FLASH_MS;
      if (this.outlineMs === 0) this.applySkinFilters();
    }
    if (this.dissolveMs >= 0 && this.dissolveMs < DISSOLVE_MS) {
      this.dissolveMs = Math.min(DISSOLVE_MS, this.dissolveMs + frameDt);
      this.dissolveFilter!.progress = this.dissolveMs / DISSOLVE_MS;
    }
  }
}
