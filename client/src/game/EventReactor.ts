import { WEAPON_SIM_BY_ID, BLUEPRINT_CATALOG, type GameEvent, type GameState } from '@dd/engine';
import { CONFIG, rarityColor } from './config';
import { fpToPx, bradToRad } from './coords';
import type { FxController } from './FxController';
import type { HudView } from './HudView';
import type { AudioBus, AudioCue } from '../platform/types';

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
  /** A catalogued weapon was picked up — unlock its forge blueprint if not already. */
  onWeaponPickup(weaponId: string): void;
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
    const cues = new Set<AudioCue>();
    for (const e of events) {
      switch (e.type) {
        case 'bullet_fired': {
          const fx = fpToPx(e.gx);
          const fy = fpToPx(e.gy);
          this.fx.flash(fx, fy, CONFIG.colors.muzzle, 12);
          const facingRad = bradToRad(e.facing);
          this.fx.particles.muzzleFlame(fx, fy - 12, facingRad, CONFIG.colors.muzzle);
          this.fx.particles.shellCasing(fx, fy - 12, facingRad);
          cues.add('muzzle');
          break;
        }
        case 'hit':
          this.fx.flash(fpToPx(e.gx), fpToPx(e.gy),
            e.faction === 'enemy' ? CONFIG.colors.enemy : CONFIG.colors.swordGlow, 16);
          if (e.faction === 'enemy') {
            // The (any) player took the hit — a small punch of feedback.
            this.fx.addShake(0.18);
            this.fx.pulseChromatic(0.006);
          }
          cues.add('impact');
          break;
        case 'shield_break':
          // A shattered shield — a bright cyan burst (design/07 two-pool break).
          this.fx.flash(fpToPx(e.gx), fpToPx(e.gy), CONFIG.colors.shield, 28);
          this.fx.addShake(0.4);
          this.fx.addHitStop(50);
          this.fx.pulseChromatic(0.014);
          cues.add('shield.break');
          break;
        case 'deflect':
          this.fx.flash(fpToPx(e.gx), fpToPx(e.gy), CONFIG.colors.deflect, 20);
          this.fx.addShake(0.22);
          this.fx.pulseChromatic(0.008);
          cues.add('deflect');
          break;
        case 'status': {
          // Elemental fx — a coloured flash by effect (design/03/07).
          const c =
            e.effect === 'burn' ? CONFIG.colors.statusBurn
            : e.effect === 'chill' ? CONFIG.colors.statusChill
            : e.effect === 'shock' ? CONFIG.colors.statusShock
            : CONFIG.colors.statusPoison;
          this.fx.flash(fpToPx(e.gx), fpToPx(e.gy), c, 12);
          cues.add(`status.${e.effect}` as AudioCue);
          break;
        }
        case 'clash':
          this.fx.flash(fpToPx(e.gx), fpToPx(e.gy), CONFIG.colors.clash, 14);
          cues.add('clash');
          break;
        case 'enrage':
          // A boss crossed its enrage threshold (design/09 traits) — a hard red pulse,
          // distinct from a normal hit flash, so it reads as a real escalation moment.
          this.fx.flash(fpToPx(e.gx), fpToPx(e.gy), CONFIG.colors.enemy, 40);
          this.fx.addShake(0.35);
          this.fx.pulseChromatic(0.012);
          cues.add('shield.break'); // reuse the existing sting; no dedicated cue authored yet
          break;
        case 'death':
          if (e.faction === 'enemy') {
            this.host.addScore(CONFIG.score.kill);
            this.fx.particles.explosionDebris(fpToPx(e.gx), fpToPx(e.gy) - 12, CONFIG.colors.enemy);
            this.fx.addShake(0.15);
            cues.add('death');
          }
          break;
        case 'pickup':
          switch (e.kind) {
            case 'heal':
              this.fx.flash(fpToPx(e.gx), fpToPx(e.gy), CONFIG.colors.pickupHeal, 20);
              cues.add('pickup.heal');
              this.hud.toast('+1 HP', CONFIG.colors.pickupHeal);
              break;
            case 'weapon': {
              // Flash in the dropped weapon's rarity colour (design/14) — the tier
              // reads at a glance. Falls back to the generic amber if unresolved.
              const spec = e.weaponId ? WEAPON_SIM_BY_ID[e.weaponId] : undefined;
              const c = spec ? rarityColor(spec) : CONFIG.colors.pickupWeapon;
              this.fx.flash(fpToPx(e.gx), fpToPx(e.gy), c, 24);
              cues.add('pickup.weapon');
              this.hud.toast(spec ? spec.name : 'New weapon', c);
              // Finding a catalogued weapon permanently unlocks its forge blueprint
              // (design/14 "2–3 common blueprints drop from runs") — first-pass: any
              // catalogued pickup grants it. Meta is separate from the sim, so this
              // mid-run write can't affect determinism.
              if (e.weaponId && BLUEPRINT_CATALOG[e.weaponId]) this.host.onWeaponPickup(e.weaponId);
              break;
            }
            case 'buff':
              this.fx.flash(fpToPx(e.gx), fpToPx(e.gy), CONFIG.colors.pickupBuff, 22);
              cues.add('pickup.buff');
              this.hud.toast(e.buffId ? `Buff: ${e.buffId}` : 'Buff', CONFIG.colors.pickupBuff);
              break;
            default: // material
              this.host.addScore(CONFIG.score.material);
              this.fx.flash(fpToPx(e.gx), fpToPx(e.gy), CONFIG.colors.pickupMaterial, 16);
              cues.add('pickup.material');
              this.hud.toast(`+${e.qty ?? 1} ${e.materialId ?? 'material'}`, CONFIG.colors.pickupMaterial);
          }
          break;
        case 'wave_clear':
          this.host.addScore(CONFIG.score.waveClear);
          cues.add('wave-clear');
          break;
        case 'room_enter': {
          // A new dungeon room went live (ROADMAP 1.3) — mirror its geometry: ground,
          // AABB walls, pillars, and the resized world bounds (design/08 render-only).
          const s = this.host.activeState();
          if (s) this.host.onRoomEnter(s);
          break;
        }
        case 'descend': {
          // Banked the floor's materials and dropped deeper — a green pulse at the player.
          const p = this.host.activeState()?.players[this.host.localOwner];
          if (p) this.fx.flash(fpToPx(p.gx), fpToPx(p.gy), CONFIG.colors.extractGlow, 30);
          this.host.addScore(CONFIG.score.waveClear);
          cues.add('wave-clear');
          break;
        }
        case 'downed':
          // A player was incapacitated (co-op downed/revive, ROADMAP 3.2) — a red pulse.
          // In the single-player demo this is the moment the run is lost.
          this.fx.flash(fpToPx(e.gx), fpToPx(e.gy), CONFIG.colors.clash, 28);
          this.fx.addShake(0.55);
          this.fx.addHitStop(80);
          this.fx.pulseChromatic(0.02);
          cues.add('death');
          break;
        case 'revived':
          // A teammate channelled the player back up — a green pulse (co-op only).
          this.fx.flash(fpToPx(e.gx), fpToPx(e.gy), CONFIG.colors.extractGlow, 28);
          cues.add('pickup.heal');
          break;
        case 'win':
          cues.add('win');
          break;
        // 'win' score bonus is handled by the outcome check (win()).
      }
    }
    for (const cue of cues) this.audio.play(cue);
  }
}
