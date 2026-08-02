/**
 * Step 1 — Apply input. Fold each player's confirmed command for this tick into
 * per-tick intent: move vector (fp/tick from moveBrad+moveMag), facing (= aimBrad),
 * the firing flag, and the edge-detected weapon-swap action.
 *
 * Idle default (design/08 open question, pinned here for Stage B): a player with
 * no command this tick holds idle — zero move, not firing — and its prevButtons is
 * left untouched so edge detection stays correct against the next real command.
 * Golden-replay coverage of this default is Stage E.
 *
 * Ports client/src/game/Game.ts updatePlayer() movement + facing, and
 * switchWeapon(), from float/radians to fp/brad. (Block is not a state — it is the
 * melee swing arc, see DeflectSystem; jump was removed.)
 */
import { FP_SCALE } from '../math/fixed';
import type { Fp } from '../math/fixed';
import { cosFp, sinFp } from '../math/trig';
import type { GameState } from '../state/GameState';
import { Button, type PlayerCommand } from '../state/commands';
import type { PlayerActor } from '../state/entities';
import { PLAYER_BASE } from '../content/players';

export class ApplyInputSystem {
  tick(state: GameState, commands: readonly PlayerCommand[]): void {
    // Last command per owner wins if duplicates arrive for one tick.
    const byOwner = new Map<number, PlayerCommand>();
    for (const cmd of commands) {
      if (cmd.type === 'input') byOwner.set(cmd.owner, cmd);
    }

    for (let i = 0; i < state.players.length; i++) {
      const p = state.players[i]!;
      // A dead OR downed player can't act (design/05/07): a downed player is frozen in
      // place and cannot move, fire, swap, or revive — only a teammate can act on it.
      if (!p.alive || p.downed) {
        this.idle(p);
        continue;
      }
      const cmd = byOwner.get(i);
      if (cmd) this.apply(p, cmd);
      else this.idle(p);
    }
  }

  private apply(p: PlayerActor, cmd: PlayerCommand): void {
    // Move: (dir/1000) × speedPerTick × (mag/255), single truncation → deterministic.
    const cos = cosFp(cmd.moveBrad);
    const sin = sinFp(cmd.moveBrad);
    const speed = PLAYER_BASE.speedPerTick;
    p.vx = Math.trunc((cos * speed * cmd.moveMag) / (FP_SCALE * 255)) as Fp;
    p.vy = Math.trunc((sin * speed * cmd.moveMag) / (FP_SCALE * 255)) as Fp;

    p.facing = cmd.aimBrad;

    const held = cmd.buttons;
    const pressed = held & ~p.prevButtons; // rising edges this tick

    // Firing drives BOTH ranged shots and melee swings; a melee swing is also what
    // parries bullets (DeflectSystem) — there is no separate block input.
    p.firing = (held & Button.FIRE) !== 0;
    // This tick's INTERACT hold state (design/05/08) — read by PickupSystem/ReviveSystem.
    p.interacting = (held & Button.INTERACT) !== 0;
    // Portal-popup choice (design/05, ROADMAP 1.4 follow-up) — ExtractionSystem reads
    // these directly; already a one-tick pulse (CommandBuilder latches then clears),
    // same convention as SWAP_WEAPON below, so no edge detection needed here.
    p.confirmExtract = (held & Button.CONFIRM_EXTRACT) !== 0;
    p.confirmDescend = (held & Button.CONFIRM_DESCEND) !== 0;

    if (pressed & Button.SWAP_WEAPON) this.swap(p);

    p.prevButtons = held;
  }

  private idle(p: PlayerActor): void {
    p.vx = 0 as Fp;
    p.vy = 0 as Fp;
    p.firing = false;
    p.interacting = false;
    p.confirmExtract = false;
    p.confirmDescend = false;
    // prevButtons deliberately unchanged (idle-hold semantics above).
  }

  // Toggle the active loadout slot. Each slot keeps its own runtime (cooldown), so
  // switching mid-cooldown does not refresh a weapon. `weapon` mirrors
  // weapons[activeSlot] for the systems that read the active pointer.
  private swap(p: PlayerActor): void {
    if (p.weapons.length < 2) return;
    p.activeSlot = (p.activeSlot + 1) % p.weapons.length;
    p.weapon = p.weapons[p.activeSlot] ?? null;
  }
}
