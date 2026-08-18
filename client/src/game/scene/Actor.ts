import { Filter, Graphics, Rectangle } from 'pixi.js';
import type { DamageType, StatusState } from '@dd/engine';
import { THEME, ELEMENT_COLORS } from '../theme';
import { EnergyShieldFilter, OutlineFilter, DissolveFilter, HeatHazeFilter, NormalLitFilter } from '../fx/filters';
import type { LightHit } from '../fx/lighting';
import { Entity, SHADOW_SQUASH } from './Entity';
import { Skin } from './Skin';

export type Faction = 'player' | 'enemy';
export type WeaponKind = 'ranged' | 'melee';

// How far (× body radius) to lift the sprite so the ground anchor sits at the feet.
// Bigger → more of the body rises above the anchor → more it can overlap a pillar.
// Applies to the Graphics PLACEHOLDER only: a real rig already encodes its own hover
// height in its body bone's length (orb-core's `shell` is 46 authoring-px of "floats
// this far above the ground point", design/12/13's "it floats, there is no walk cycle"),
// and RigSkin draws that bone's art on its tip — lifting it a second time here would
// double-count and leave the body visibly detached from its own shadow.
const BODY_LIFT_R = 0.7;

/**
 * Idle hover, in world px of render-only height (`Entity.visualZ`), per body archetype
 * (2026-08-18 depth pass, user report *"希望能再强化一下立体效果"*).
 *
 * design/13's hero and its floating enemy forms do not walk — "it floats, there is no walk
 * cycle" — and their rigs' `idle` clips already bob the ART (orb-core's shell/eye/belly all
 * translate -6 authoring px, `public/skins/orb-core/animation.json`). What that clip
 * *cannot* do is move the SHADOW, because a clip only knows about bones: the body rose and
 * its shadow stayed exactly as wide and as dark as when it was on the floor, which reads as
 * a sprite sliding up and down a flat backdrop rather than a body leaving the ground. This
 * lifts the whole entity instead, so `Entity.applyTransform` shrinks, fades and slides the
 * shadow with it. The two stack deliberately: the clip animates the body's own parts, this
 * animates the body's height.
 *
 * `base` is a constant lift (a floater rests off the floor), `amp` the swing around it —
 * both kept small, since the camera zooms ~4x in a room and these are world px. A grounded
 * archetype (critter-core, brute-core) gets no entry and never leaves the floor.
 */
const HOVER: Readonly<Record<string, { base: number; amp: number; periodMs: number }>> = {
  char_vanguard: { base: 3.5, amp: 2.5, periodMs: 2400 },
  char_skirmisher: { base: 3.5, amp: 2.5, periodMs: 2100 },
  char_juggernaut: { base: 3, amp: 2, periodMs: 2900 },
  'floater-core': { base: 5, amp: 3, periodMs: 2000 },
  'boss-core': { base: 4.5, amp: 3.5, periodMs: 3200 },
};

/** Spreads hover phase across actors so a room full of floaters doesn't pulse in lockstep.
 *  Render-only and deliberately construction-ORDER dependent, not state-derived — nothing
 *  in the sim can see it (design/08 "render only reads"). */
let hoverPhaseSeq = 0;

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
  // Idle hover (see HOVER above) — null for a grounded archetype, in which case `visualZ`
  // is never written and this actor behaves exactly as it did before the depth pass.
  private readonly hover: { base: number; amp: number; periodMs: number } | null;
  private hoverT: number;

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
    const rigName = faction === 'player' ? (atlasKey ?? 'char_vanguard') : (atlasKey ?? 'critter-core');
    this.hover = HOVER[rigName] ?? null;
    this.hoverT = this.hover ? (hoverPhaseSeq++ * 0.37) * this.hover.periodMs : 0;
    if (this.hover) this.visualZ = this.hover.base;
    this.skin = new Skin(
      resolvedTint,
      front,
      radiusPx,
      rigName,
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
    // over a pillar it stands against (design/01 fake-3D depth). A rig skin needs no
    // lift of its own — its body bone already stands the art off the ground point (see
    // BODY_LIFT_R) — so for those the lift is 0 and the body's real on-screen centre is
    // the measured one, which is also what the aura/health bar anchor to below (they
    // wrap the BODY, not the ground point).
    const lift = this.skin.hasRig ? 0 : radiusPx * BODY_LIFT_R;
    const bodyCenterY = -lift + (this.skin.hasRig ? filterCenterY : 0);
    this.skin.view.y = -lift;
    this.weaponGfx.y = -lift;
    this.statusAura.y = bodyCenterY;

    // Every actor carries a floating health bar above its head (design/10 legibility
    // fix, 2026-08-02 for enemies: previously boss-only, so a regular mob's damage
    // state — and a poison/burn melt — was invisible without reading the HUD; extended
    // to the player 2026-08-02 so hp is readable on the map itself, not just the corner
    // HUD). A boss's is drawn bigger/further out (setHealth) so it still reads as the
    // more prominent threat.
    this.healthBar = new Graphics();
    this.healthBar.y = bodyCenterY - radiusPx * (boss ? 1.7 : 1.3);
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
   * report, pointing at their character and asking what it was. Fixed with two cues: a
   * teal ground ring at the feet, and a health bar outlined in that same teal instead of
   * the default near-black.
   *
   * The ring half was dropped again 2026-08-14 (same user, two more screenshot rounds
   * later): first report was the ring reading as "only half a shield" (it shared the
   * body's own y=0 ground origin, so its top half sat behind the lifted body sprite and
   * got painted over — fixed same day by moving it to a zIndex in FRONT of the body so
   * the full ellipse always shows), second report was that the now-always-visible ring
   * and the (correctly, separately fixed) `EnergyShieldFilter` rim-glow are both cyan
   * and both wrap the character, so a live shield and "this is you" became
   * indistinguishable at a glance — the exact ambiguity this marker exists to prevent,
   * just moved from "ring vs body" to "ring vs shield". Asked the user how to resolve
   * it; chosen fix: drop the ground ring entirely and rely on the health-bar teal
   * outline alone (setHealth below) — it never occupies the same on-screen space as the
   * shield glow, so the two can never be confused, at the cost of a slightly less
   * prominent marker than a full-body ring gave.
   */
  setLocal(local: boolean): void {
    if (local === this.isLocal) return;
    this.isLocal = local;
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
        // An ellipse, not a circle (2026-08-18 depth pass): an aura wraps the body in a
        // TILTED view, so it foreshortens vertically exactly like the ground shadow and the
        // shield ring. A true circle is the single loudest "this is a flat decal" cue a
        // round overlay can give, which is what the shield's own report was about.
        g.ellipse(0, 0, rad, rad * SHADOW_SQUASH).stroke({ color: a.color, width: 3, alpha: 0.55 });
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
  // itself (weapon/aura/hp-bar are all meaningless on a dead actor and would otherwise
  // float oddly over a half-dissolved silhouette).
  startDissolve(): void {
    if (this.dissolveMs >= 0) return; // already dissolving — defensive, shouldn't double-fire
    this.dissolveFilter = new DissolveFilter();
    this.dissolveMs = 0;
    this.weaponGfx.visible = false;
    this.statusAura.visible = false;
    if (this.healthBar) this.healthBar.visible = false;
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

  /**
   * The mounted weapon's business end in the same space `Entity.x/y` live in — i.e.
   * ready to hand straight to another Entity's `place()`. See `RigSkin.muzzleLocal` for
   * why this exists (bullets visibly leaving mid-gun instead of the muzzle) and what it
   * is used for; null whenever this actor has no rig-mounted module, which is every
   * enemy. Reads the pose `interpolate` last laid out, so call it after that (which is
   * where `Scene` sits in the frame anyway).
   */
  muzzlePos(): { x: number; y: number } | null {
    const local = this.skin.muzzleAnchor();
    if (!local) return null;
    // `skin.view.y` is the placeholder-only body lift (0 for a rig, see the constructor),
    // included rather than assumed so this stays correct if that ever changes.
    return { x: this.x + local.x, y: this.y + this.skin.view.y + local.y };
  }

  override interpolate(alpha: number, frameDt: number): void {
    // Written BEFORE super, which is what consumes `visualZ` (Entity.applyTransform).
    if (this.hover) {
      this.hoverT += frameDt;
      this.visualZ = this.hover.base + this.hover.amp * Math.sin((this.hoverT / this.hover.periodMs) * Math.PI * 2);
    }
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
