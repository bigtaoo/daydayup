// Render-side input → PlayerCommand. Reads the platform InputSource each sim tick
// and assembles the engine's frozen twin-stick command. The float→brad/mag
// quantization is the engine's input-edge seam (quantizeMove / quantizeAim,
// design/06/08) — this file only handles the render-specific bits: screen→world
// aim, idle-stick hold, and latching the discrete weapon-swap press into a
// one-tick button pulse so the engine's rising-edge detection sees a clean press.
//
// Because the quantization lives in @dd/engine, the golden-replay tests build
// commands through the exact same grid this producer uses.
import { Button, makeCommand, pxToFp, quantizeAim, quantizeMove, type Brad, type GameState, type PlayerCommand } from '@dd/engine';
import { nearestByPosition } from '@dd/engine/systems/nearest';
import type { InputSource } from '../platform/types';

/** Auto-aim settings consulted live each tick (Settings screen, default on). */
export interface AutoAimOptions {
  enabled: boolean;
  /** Current viewport size in px — the aim range is "roughly one screen" (half the
   * viewport's diagonal), so a target anywhere on screen is reachable. */
  screenPx: { w: number; h: number };
}

export class CommandBuilder {
  private lastAim = 0 as Brad; // idle stick keeps the last facing (no snap-to-zero)
  private swapLatch = false;

  constructor(private readonly input: InputSource) {}

  /** Discrete-action latch, set from Game's onSwitchWeapon routing. */
  requestSwap(): void {
    this.swapLatch = true;
  }

  /**
   * Build this tick's command. `playerPx` is the engine player's world-px position
   * and `cam` the world-layer offset, so a screen-space mouse point maps to a world
   * aim direction. `state` + `autoAim` let auto-aim (when enabled) override the raw
   * mouse/stick aim with the direction to the nearest in-range living enemy — this
   * MUST happen here, before quantization, since the engine only ever sees the
   * already-quantized `aimBrad` (design/06 input edge) and fires along it verbatim.
   */
  build(
    tick: number,
    owner: number,
    playerPx: { x: number; y: number },
    cam: { x: number; y: number },
    state: GameState,
    autoAim: AutoAimOptions,
  ): PlayerCommand {
    const inp = this.input.read();

    // Move: raw vector → direction brad + 0..255 magnitude (engine input edge).
    const { moveBrad, moveMag } = quantizeMove(inp.moveX, inp.moveY);

    // Aim: when auto-aim is on it fully replaces manual aim — nearest in-range
    // enemy, or (nothing in range) hold the current facing, same fallback the
    // AllyController bot uses. Manual aim only runs when auto-aim is off: 'point'
    // (mouse) → world-space angle to the cursor, 'dir' (stick) → the stick
    // direction, with an idle stick holding the last aim instead of resetting.
    let aim = this.lastAim;
    if (autoAim.enabled) {
      aim = nearestEnemyAim(state, owner, autoAim.screenPx) ?? this.lastAim;
    } else if (inp.aim.mode === 'point') {
      const wx = inp.aim.x - cam.x;
      const wy = inp.aim.y - cam.y;
      aim = quantizeAim(wx - playerPx.x, wy - playerPx.y);
    } else if (inp.aim.dx !== 0 || inp.aim.dy !== 0) {
      aim = quantizeAim(inp.aim.dx, inp.aim.dy);
    }
    this.lastAim = aim;

    let buttons = 0;
    if (inp.firing) buttons |= Button.FIRE;
    if (inp.interacting) buttons |= Button.INTERACT; // extraction hold/tap (ROADMAP 1.4)
    if (this.swapLatch) {
      buttons |= Button.SWAP_WEAPON;
      this.swapLatch = false;
    }

    return makeCommand({ owner, tick, moveBrad, moveMag, aimBrad: aim, buttons });
  }
}

/**
 * Nearest living enemy within ~one screen of the local player, quantized to an aim
 * brad — or null if none is in range (caller falls back to holding facing). Squared
 * fp distance, same pattern as AllyController's targeting; the range itself is
 * screen-size-derived so it is inherently render-side, never fed back into the sim.
 */
function nearestEnemyAim(state: GameState, owner: number, screenPx: { w: number; h: number }): Brad | null {
  const me = state.players[owner];
  if (!me) return null;
  const rangeFp = pxToFp(Math.hypot(screenPx.w, screenPx.h) / 2);
  const aliveEnemies = (function* () { for (const e of state.enemies) if (e.alive) yield e; })();
  // preferEarlier:false — this call site's original `d <= best` kept the LAST
  // candidate found on an exact tie, unlike every other nearest-search in the
  // engine; preserved deliberately rather than normalized away (see nearest.ts).
  const target = nearestByPosition(me.gx, me.gy, aliveEnemies, { reachSq: rangeFp * rangeFp, preferEarlier: false });
  return target ? quantizeAim(target.gx - me.gx, target.gy - me.gy) : null;
}
