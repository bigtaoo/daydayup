import { WEAPON_SIM_BY_ID, BLUEPRINT_CATALOG, MATERIAL_DEFS, RUN_BUFFS, type GameEvent, type GameState } from '@dd/engine';
import { THEME, rarityColor } from '../theme';
import { SCORE } from '../score';
import { fpToPx, bradToRad } from '../coords';
import type { FxController } from '../fx/FxController';
import type { HudView } from '../ui/HudView';
import type { AudioBus, AudioCue } from '../../platform/types';
import { t, tName } from '../../i18n';

/** The bits of Game an EventReactor reaction needs to reach back into — score/meta/
 *  room-rebuild are Game-owned state, so this stays a callback interface rather than
 *  EventReactor importing MetaState/Screens/etc. directly (same decoupling FxController
 *  itself relies on: this file never imports Game.ts). */
export interface EventReactorHost {
  readonly localOwner: number;
  activeState(): GameState | null;
  addScore(delta: number): void;
  /** A `room_enter` event landed — rebuild the render-side room geometry. */
  onRoomEnter(s: GameState): void;
  /** A `door_locked`/`door_unlocked` event landed (DoorSystem) — restyle the
   *  affected door fixture(s) in place, no full room rebuild. */
  onDoorStateChange(s: GameState): void;
  /** The LOCAL player was just force-regrouped (DoorSystem, design/05) — an instant
   *  position snap, not organic movement, so the camera must cut to it rather than
   *  interpolate/pan across the floor. */
  onForceRegroup(): void;
  /** A catalogued weapon was picked up — unlock its forge blueprint if not already. */
  onWeaponPickup(weaponId: string): void;
  /** The specific actor view an event's id names — a `hit`'s `target`, or a `bullet_fired`'s
   *  `ownerId` — for a reaction that must land on ONE actor rather than just at a world
   *  position the way `fx.flash()` does. Undefined for a bullet/pickup id, or an actor that's
   *  already gone. Duck-typed (not `Actor`) so this file still never imports scene/ — same
   *  decoupling as the rest of this interface.
   *
   *  The narrow view this reactor needs: where the actor is on screen (world px, so an event's
   *  own position can be turned into a delta from its centre), the hit reaction, the attack
   *  reaction, and where its DRAWN barrel tip is — the muzzle fx has to be anchored there, and
   *  `muzzlePos()` is null for a skin that mounts no weapon module (`Skin.muzzleAnchor`). */
  actorAt(id: number): {
    hitFlash(dx?: number, dy?: number): void;
    onAttack(kind: 'ranged' | 'melee'): void;
    muzzlePos(): { x: number; y: number } | null;
    x: number;
    y: number;
  } | undefined;
}

/**
 * Events are the only engine→render channel (design/08): fx feedback + score + audio.
 * Extracted out of Game.ts 2026-07-28 (that file had accreted too many unrelated jobs) —
 * this is purely the "one big switch over GameEvent" slice, sharing FxController/HudView/
 * AudioBus with the rest of the shell and reaching back into Game only through `host` for
 * the handful of reactions that are genuinely Game-owned state (score/meta/room rebuild).
 */
export class EventReactor {
  constructor(
    private readonly fx: FxController,
    private readonly hud: HudView,
    private readonly audio: AudioBus,
    private readonly host: EventReactorHost,
  ) {}

  consume(events: readonly GameEvent[]): void {
    // Coalesce audio cues within the frame: a bullet-hell frame can emit dozens of
    // identical events, so we collect the distinct cues here and play each ONCE after
    // the loop (design/11 "coalesce identical cues in the same frame"). fx/score still
    // react per-event below — only sound is deduped.
    //
    // The COUNT is kept, not just the fact: design/11 asks for ten hits in one frame to
    // become one impact "at higher gain, not ten", and the mixer needs the number to do it.
    const cues = new Map<AudioCue, number>();
    const cue = (id: AudioCue): void => {
      cues.set(id, (cues.get(id) ?? 0) + 1);
    };
    for (const e of events) {
      switch (e.type) {
        case 'bullet_fired': {
          // Anchored on the SHOOTER, not on the event's own position (2026-08-30, user report
          // *"角色射击时，没有射击动画，枪口也没有射击特效"*). `gx/gy` is the sim's muzzle —
          // `muzzleOffset` along the aim ray on the GROUND plane — which is not where the rig
          // draws the gun, so every muzzle fx used to burst near the character's middle and read
          // as "no muzzle effect at all". `Actor.muzzlePos()` is the drawn barrel tip, i.e. the
          // exact point `Scene` already spawns the bullet view from, so shot, flare and sparks
          // now all leave the same place. It is null for a skin with no mounted module (the
          // boss, the Graphics placeholder, the frames before the weapon texture preloads) —
          // those keep the old sim position plus the same 12 px lift `flash()`/`trailDot()` use.
          const shooter = this.host.actorAt(e.ownerId);
          shooter?.onAttack('ranged'); // clip + recoil — render-only, see Actor.onAttack
          const drawn = shooter?.muzzlePos() ?? null;
          const fx = drawn ? drawn.x : fpToPx(e.gx);
          const fy = drawn ? drawn.y : fpToPx(e.gy) - 12;
          const facingRad = bradToRad(e.facing);
          this.fx.muzzleFlare(fx, fy, facingRad, THEME.colors.muzzle);
          this.fx.particles.muzzleFlame(fx, fy, facingRad, THEME.colors.muzzle);
          this.fx.particles.shellCasing(fx, fy, facingRad);
          cue('muzzle');
          break;
        }
        case 'melee_swing':
          // The melee half of the SAME reaction the ranged branch above opens with, and the
          // reason `melee_swing` exists at all (ENGINE_VERSION 52): a swing is announced whether
          // or not it connects, so the blade animates over empty air too. No fx of its own —
          // `deflect` already flashes a parry and `hit` a connection, and a swing that reads
          // only as a flash of light is the thing this replaces.
          this.host.actorAt(e.ownerId)?.onAttack('melee');
          break;
        case 'hit':
          this.fx.flash(fpToPx(e.gx), fpToPx(e.gy),
            e.faction === 'enemy' ? THEME.colors.enemy : THEME.colors.swordGlow, 16);
          // A silhouette flash on the SPECIFIC actor hit (design/01 milestone 5,
          // `OutlineFilter`) — independent of the position-anchored burst above, which
          // reads as "impact happened here" rather than "this one took it".
          // Handed the impact point as a delta from the target's own centre, so the shield
          // shell dents where the hit landed rather than in a fixed direction
          // (`EnergyShieldFilter.hit`, 2026-08-26). The event already carries the position the
          // burst above is anchored to; nothing new had to reach the client for this.
          {
            const target = this.host.actorAt(e.target);
            target?.hitFlash(fpToPx(e.gx) - target.x, fpToPx(e.gy) - target.y);
          }
          if (e.faction === 'enemy') {
            // The (any) player took the hit — a small punch of feedback.
            this.fx.addShake(0.18);
            this.fx.pulseChromatic(0.006);
          }
          cue('impact');
          break;
        case 'shield_break':
          // A shattered shield — a bright cyan burst (design/07 two-pool break).
          this.fx.flash(fpToPx(e.gx), fpToPx(e.gy), THEME.colors.shield, 28);
          // ...plus the shell's own fragments (2026-08-26). The event's position IS the target
          // actor's centre (`combat.ts` pushes `target.gx/gy`), which is what the ring has to be
          // thrown from — unlike `hit`, whose position is the impact point. The shell's surface
          // animates itself over the same 200 ms in `EnergyShieldFilter.shatter`, driven off the
          // pool reaching 0 rather than off this event, so the two need no handshake.
          this.fx.particles.shieldShards(fpToPx(e.gx), fpToPx(e.gy), THEME.colors.shield);
          this.fx.addShake(0.4);
          this.fx.addHitStop(50);
          this.fx.pulseChromatic(0.014);
          cue('shield.break');
          break;
        case 'deflect':
          this.fx.flash(fpToPx(e.gx), fpToPx(e.gy), THEME.colors.deflect, 20);
          this.fx.addShake(0.22);
          this.fx.pulseChromatic(0.008);
          cue('deflect');
          break;
        case 'status': {
          // Elemental fx — a coloured flash by effect (design/03/07).
          const c =
            e.effect === 'burn' ? THEME.colors.statusBurn
            : e.effect === 'chill' ? THEME.colors.statusChill
            : e.effect === 'shock' ? THEME.colors.statusShock
            : THEME.colors.statusPoison;
          this.fx.flash(fpToPx(e.gx), fpToPx(e.gy), c, 12);
          cue(`status.${e.effect}` as AudioCue);
          break;
        }
        case 'clash':
          this.fx.flash(fpToPx(e.gx), fpToPx(e.gy), THEME.colors.clash, 14);
          cue('clash');
          break;
        case 'enrage':
          // A boss crossed its enrage threshold (design/09 traits) — a hard red pulse,
          // distinct from a normal hit flash, so it reads as a real escalation moment.
          this.fx.flash(fpToPx(e.gx), fpToPx(e.gy), THEME.colors.enemy, 40);
          this.fx.addShake(0.35);
          this.fx.pulseChromatic(0.012);
          cue('shield.break'); // reuse the existing sting; no dedicated cue authored yet
          break;
        case 'death':
          if (e.faction === 'enemy') {
            this.host.addScore(SCORE.kill);
            this.fx.particles.explosionDebris(fpToPx(e.gx), fpToPx(e.gy) - 12, THEME.colors.enemy);
            this.fx.addShake(0.15);
            cue('death');
          }
          break;
        case 'pickup':
          switch (e.kind) {
            case 'heal':
              this.fx.flash(fpToPx(e.gx), fpToPx(e.gy), THEME.colors.pickupHeal, 20);
              cue('pickup.heal');
              this.hud.toast(t('toast.heal'), THEME.colors.pickupHeal);
              break;
            case 'weapon': {
              // Flash in the dropped weapon's rarity colour (design/14) — the tier
              // reads at a glance. Falls back to the generic amber if unresolved.
              const spec = e.weaponId ? WEAPON_SIM_BY_ID[e.weaponId] : undefined;
              const c = spec ? rarityColor(spec) : THEME.colors.pickupWeapon;
              this.fx.flash(fpToPx(e.gx), fpToPx(e.gy), c, 24);
              cue('pickup.weapon');
              this.hud.toast(spec ? tName(spec.nameKey) : t('toast.newWeapon'), c);
              // Finding a catalogued weapon permanently unlocks its forge blueprint
              // (design/14 "2–3 common blueprints drop from runs") — first-pass: any
              // catalogued pickup grants it. Meta is separate from the sim, so this
              // mid-run write can't affect determinism.
              if (e.weaponId && BLUEPRINT_CATALOG[e.weaponId]) this.host.onWeaponPickup(e.weaponId);
              break;
            }
            case 'buff':
              this.fx.flash(fpToPx(e.gx), fpToPx(e.gy), THEME.colors.pickupBuff, 22);
              cue('pickup.buff');
              {
                const buff = e.buffId ? RUN_BUFFS[e.buffId] : undefined;
                // Falls back to the raw id only if `buffId` names something outside the
                // catalogue (shouldn't happen for a real drop) — same defensive shape as
                // the material/weapon lookups below.
                const label = buff ? tName(buff.nameKey) : e.buffId;
                this.hud.toast(label ? t('toast.buffNamed', { id: label }) : t('toast.buffGeneric'), THEME.colors.pickupBuff);
              }
              break;
            default: { // material
              this.host.addScore(SCORE.material);
              this.fx.flash(fpToPx(e.gx), fpToPx(e.gy), THEME.colors.pickupMaterial, 16);
              cue('pickup.material');
              const mat = e.materialId ? MATERIAL_DEFS[e.materialId] : undefined;
              // Translated fallback only triggers when `materialId` itself is absent —
              // an id present but uncatalogued falls back to the raw id, same shape as
              // the buff toast above.
              const materialName = mat ? tName(mat.nameKey) : e.materialId ?? t('toast.materialFallback');
              this.hud.toast(t('toast.materialQty', { qty: e.qty ?? 1, material: materialName }), THEME.colors.pickupMaterial);
            }
          }
          break;
        case 'wave_clear':
          this.host.addScore(SCORE.waveClear);
          cue('wave-clear');
          break;
        case 'room_enter': {
          // A new dungeon room went live (ROADMAP 1.3) — mirror its geometry: ground,
          // AABB walls, pillars, and the resized world bounds (design/08 render-only).
          const s = this.host.activeState();
          if (s) this.host.onRoomEnter(s);
          break;
        }
        case 'door_locked':
        case 'door_unlocked': {
          // A room's doors flipped lock state as a unit (design/05, DoorSystem) — the
          // engine already rewrote state.walls; just restyle the door fixture(s), no
          // full room rebuild.
          const s = this.host.activeState();
          if (s) this.host.onDoorStateChange(s);
          break;
        }
        case 'force_regroup': {
          // Every OTHER online, non-downed player was just teleported onto the
          // fighting room's entrance (design/05, DoorSystem) — react only if the
          // LOCAL player was one of them (playerIds are entity ids, not seats/owners,
          // same lookup the 'hit' case above uses for `actorAt`).
          const s = this.host.activeState();
          const p = s?.players[this.host.localOwner];
          if (p && e.playerIds.includes(p.id)) {
            this.host.onForceRegroup();
            this.fx.flash(fpToPx(p.gx), fpToPx(p.gy), THEME.colors.extractGlow, 24);
          }
          break;
        }
        case 'descend': {
          // Banked the floor's materials and dropped deeper — a green pulse at the player.
          const p = this.host.activeState()?.players[this.host.localOwner];
          if (p) this.fx.flash(fpToPx(p.gx), fpToPx(p.gy), THEME.colors.extractGlow, 30);
          this.host.addScore(SCORE.waveClear);
          cue('wave-clear');
          break;
        }
        case 'downed':
          // A player was incapacitated (co-op downed/revive, ROADMAP 3.2) — a red pulse.
          // In the single-player demo this is the moment the run is lost.
          this.fx.flash(fpToPx(e.gx), fpToPx(e.gy), THEME.colors.clash, 28);
          this.fx.addShake(0.55);
          this.fx.addHitStop(80);
          this.fx.pulseChromatic(0.02);
          cue('death');
          break;
        case 'revived':
          // A teammate channelled the player back up — a green pulse (co-op only).
          this.fx.flash(fpToPx(e.gx), fpToPx(e.gy), THEME.colors.extractGlow, 28);
          cue('pickup.heal');
          break;
        case 'win':
          cue('win');
          break;
        // 'win' score bonus is handled by the outcome check (win()).
      }
    }
    for (const [id, count] of cues) this.audio.play(id, count);
  }
}
