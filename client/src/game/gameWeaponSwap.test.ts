/**
 * Weapon swapping, end to end through `Game` — from the live report
 * *"角色可以同时持有一把近战武器和一把枪，并且在ui上我标注的位置可以进行切换。我记得之前
 * 实现过一次"* (ENGINE_VERSION 45).
 *
 * Every PIECE of this verb had unit coverage and was individually green while the verb was
 * unusable in the shipped game: `resolveLoadout` (engine/content/players.test.ts) decides
 * the two slots, `HudView.test.ts` proves the chip shows and fires `onSwapWeapon`,
 * `CommandBuilder.test.ts` proves `requestSwap()` latches SWAP_WEAPON for exactly one
 * build, and `ApplyInputSystem` proves the bit advances `activeSlot`. What no test owned
 * was the WIRING BETWEEN them — the two lines in Game.ts that hand the HUD's tap and the
 * keyboard's key to the same builder — plus the loadout the run is built with in the first
 * place. That combination is exactly how this shipped broken: nothing was red.
 *
 * So this file asserts the only observable that matters to a player: after the tap, the
 * weapon the SIM considers active is a different one, of the other kind. Same failure class
 * `gameQuality.test.ts` was written for ("an entire interaction system that rendered
 * perfectly and was connected to nothing" — design/04 item 12).
 */
import { describe, it, expect } from 'vitest';
import { Container, type Ticker } from 'pixi.js';
import { installFakeTextCanvas } from './screens/fakeTextCanvas';
import { Game } from './Game';
import { PLAYER_BASE } from '@dd/engine/content/players';
import type { GameState } from '@dd/engine';

installFakeTextCanvas();

const NO_TOUCH = {
  active: false, stickRadius: 0, move: null,
  fire: { cx: 0, cy: 0, r: 0, pressed: false },
  weapon1: { cx: 0, cy: 0, r: 0 }, weapon2: { cx: 0, cy: 0, r: 0 },
  interact: { cx: 0, cy: 0, r: 0, pressed: false },
};

/** Game's frame loop is registered through `ticker.add`; a fake ticker that only swallows
 *  the callback would make every assertion below vacuous (no frame, no command, no tick),
 *  so this one CAPTURES it and `frames()` drives it by hand — the same hand-driven-ticker
 *  technique the perf tooling uses for a tab that will not stay foregrounded. */
function newGame() {
  const frameCbs: Array<(t: Ticker) => void> = [];
  const app = {
    stage: new Container(),
    renderer: { screen: { width: 1280, height: 720 }, resolution: 1, resize: () => {} },
    ticker: { add: (cb: (t: Ticker) => void) => frameCbs.push(cb), remove: () => {} },
    canvas: {},
  } as unknown as ConstructorParameters<typeof Game>[0];

  const input = {
    onSwitchWeapon: null as ((slot: number) => void) | null,
    attach: () => {},
    read: () => ({ moveX: 0, moveY: 0, firing: false, interacting: false }),
    getTouchVisual: () => NO_TOUCH,
    setControlMirror: () => {},
  };
  const game = new Game(app, input as never,
    { play: () => {}, setSfxVolume: () => {}, setMusicVolume: () => {}, resume: () => {} } as never);
  game.start();

  const inner = game as unknown as {
    run: { phase: string; engine: { state: GameState } | null; replayStop: number | null };
    hud: { weaponSlotChip: { onTap: (() => void) | null; view: { visible: boolean } } };
    nav: { showForge(): void };
    runs: { beginRun(): void };
  };
  let ms = 0;
  const frames = (n: number) => {
    for (let i = 0; i < n; i++) { ms += 16.7; for (const cb of frameCbs) cb({ deltaMS: 16.7, lastTime: ms } as Ticker); }
  };
  return { game, inner, input, frames, frameCount: () => frameCbs.length };
}

/** The active weapon as the SIM sees it — `weapons[activeSlot]`, not a HUD label. */
function active(inner: { run: { engine: { state: GameState } | null } }) {
  const p = inner.run.engine!.state.players[0]!;
  return { slot: p.activeSlot, name: p.weapon!.spec.name, kind: p.weapon!.spec.kind };
}

function startedRun() {
  const h = newGame();
  expect(h.frameCount()).toBeGreaterThan(0); // the loop really is captured
  h.inner.nav.showForge();
  h.inner.runs.beginRun();
  h.frames(4);
  return h;
}

describe('Game — the weapon swap verb, HUD tap to sim', () => {
  it('an ordinary run spawns holding a gun with a melee weapon in the idle slot', () => {
    const { inner } = startedRun();
    const p = inner.run.engine!.state.players[0]!;
    expect(p.weapons).toHaveLength(PLAYER_BASE.weaponSlots);
    expect(active(inner).kind).toBe('ranged');
    expect(p.weapons.map((w) => w.spec.kind)).toContain('melee');
    expect(inner.hud.weaponSlotChip.view.visible).toBe(true);
  });

  it('tapping the HUD idle-slot chip makes the MELEE weapon active in the sim', () => {
    const { inner, frames } = startedRun();
    const before = active(inner);

    inner.hud.weaponSlotChip.onTap!();  // the tile the report circled
    frames(4);

    const after = active(inner);
    expect(after.slot).not.toBe(before.slot);
    expect(after.kind).toBe('melee');
    expect(after.name).not.toBe(before.name);
  });

  it('the keyboard/touch path reaches the same latch — and swapping is a toggle, not a one-way trip', () => {
    const { inner, input, frames } = startedRun();
    const spawn = active(inner);

    input.onSwitchWeapon!(2);
    frames(4);
    expect(active(inner).kind).toBe('melee');

    input.onSwitchWeapon!(1);
    frames(4);
    expect(active(inner)).toEqual(spawn);
  });

  it('one tap is one swap — the latch clears, so holding a run for many frames does not keep flipping', () => {
    const { inner, frames } = startedRun();
    inner.hud.weaponSlotChip.onTap!();
    frames(30);
    expect(active(inner).kind).toBe('melee'); // not flipped back and forth by later frames
  });

  it('the chip stays available after a swap, now pointing at the weapon just put away', () => {
    const { inner, frames } = startedRun();
    const before = active(inner);
    inner.hud.weaponSlotChip.onTap!();
    frames(4);
    expect(inner.hud.weaponSlotChip.view.visible).toBe(true);
    const p = inner.run.engine!.state.players[0]!;
    expect(p.weapons[(p.activeSlot + 1) % p.weapons.length]!.spec.name).toBe(before.name);
  });
});
