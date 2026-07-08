/**
 * Step 1 — Apply input. Fold each player's confirmed command for this tick into
 * per-tick intent: move vector (fp/tick from moveBrad+moveMag), facing (= aimBrad),
 * firing/block flags, and edge-detected discrete actions (swap weapon, jump).
 *
 * Idle default (design/08 open question, pinned here for Stage B): a player with
 * no command this tick holds idle — zero move, not firing, not blocking — and its
 * prevButtons is left untouched so edge detection stays correct against the next
 * real command. Golden-replay coverage of this default is Stage E.
 *
 * Ports client/src/game/Game.ts updatePlayer() movement + facing + jump + block,
 * and switchWeapon(), from float/radians to fp/brad.
 */
import { FP_SCALE } from '../math/fixed';
import type { Fp } from '../math/fixed';
import { cosFp, sinFp } from '../math/trig';
import type { GameState } from '../state/GameState';
import { Button, type PlayerCommand } from '../state/commands';
import type { PlayerActor } from '../state/entities';
import { PLAYER } from '../content/players';

export class ApplyInputSystem {
  tick(state: GameState, commands: readonly PlayerCommand[]): void {
    // Last command per owner wins if duplicates arrive for one tick.
    const byOwner = new Map<number, PlayerCommand>();
    for (const cmd of commands) {
      if (cmd.type === 'input') byOwner.set(cmd.owner, cmd);
    }

    for (let i = 0; i < state.players.length; i++) {
      const p = state.players[i]!;
      if (!p.alive) {
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
    const speed = PLAYER.speedPerTick;
    p.vx = Math.trunc((cos * speed * cmd.moveMag) / (FP_SCALE * 255)) as Fp;
    p.vy = Math.trunc((sin * speed * cmd.moveMag) / (FP_SCALE * 255)) as Fp;

    p.facing = cmd.aimBrad;

    const held = cmd.buttons;
    const pressed = held & ~p.prevButtons; // rising edges this tick

    const w = p.weapon;
    const isMelee = w?.spec.kind === 'melee';
    if (w) w.blocking = isMelee && (held & Button.BLOCK) !== 0;
    // No firing while actively blocking (matches the demo).
    p.firing = (held & Button.FIRE) !== 0 && !(w?.blocking ?? false);

    if (pressed & Button.SWAP_WEAPON) this.swap(p);
    if (pressed & Button.JUMP && p.z <= 0) p.vz = PLAYER.jumpV;

    p.prevButtons = held;
  }

  private idle(p: PlayerActor): void {
    p.vx = 0 as Fp;
    p.vy = 0 as Fp;
    p.firing = false;
    if (p.weapon) p.weapon.blocking = false;
    // prevButtons deliberately unchanged (idle-hold semantics above).
  }

  // Toggle the active loadout slot. Each slot keeps its own runtime (cooldown /
  // blocking), so switching mid-cooldown does not refresh a weapon. `weapon`
  // mirrors weapons[activeSlot] for the systems that read the active pointer.
  private swap(p: PlayerActor): void {
    if (p.weapons.length < 2) return;
    p.activeSlot = (p.activeSlot + 1) % p.weapons.length;
    p.weapon = p.weapons[p.activeSlot] ?? null;
  }
}
