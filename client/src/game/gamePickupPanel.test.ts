/**
 * The weapon-pickup panel, end to end through `Game` — from the live report
 * *"附近有可以拾取的武器时，不要阻断了玩家攻击"* (2026-09-02, client only).
 *
 * Same failure class, and the same reason for existing, as `gameWeaponSwap.test.ts`: every
 * PIECE of this had coverage while the shipped game was wrong. `WeaponPickupPrompt.test.ts`
 * proves the panel reports a press that lands on it, `CommandBuilder.test.ts` proves the
 * latch swallows exactly that press, `GameLoop.test.ts` proves the loop no longer gates fire
 * on the panel being open — and none of them can see the two lines in `Game.ts` that connect
 * the panel's callbacks to the builder. That gap is not hypothetical here: the pickup panel
 * shipped in 2026-08-03 with `onPick` connected to nothing at all, so no click could collect
 * anything for a whole day, with nothing red (ROADMAP, 2026-08-04).
 *
 * So both cases below assert what a player would see: whether a shot came out of the gun,
 * and whether the weapon left the floor.
 */
import { describe, it, expect } from 'vitest';
import { Container, type Ticker } from 'pixi.js';
import { installFakeTextCanvas } from './screens/fakeTextCanvas';
import { Game } from './Game';
import type { GameState, PickupItem } from '@dd/engine';

installFakeTextCanvas();

const NO_TOUCH = {
  active: false, stickRadius: 0, move: null,
  fire: { cx: 0, cy: 0, r: 0, pressed: false },
  weapon1: { cx: 0, cy: 0, r: 0 }, weapon2: { cx: 0, cy: 0, r: 0 },
  interact: { cx: 0, cy: 0, r: 0, pressed: false },
};

/** A press, as Pixi delivers it to the panel: capture phase (`Button` stops the bubble),
 *  which is the phase `WeaponPickupPrompt` registers in. The payload is ignored by the
 *  handler, so a cast is enough — same convention as `widgets.test.ts`'s tap emits. */
const pressPanel = (view: { emit: (event: string) => void }) => view.emit('pointerdowncapture');
const tap = (view: { emit: (event: string) => void }) => view.emit('pointertap');

interface Prompt {
  view: { emit: (event: string) => void };
  rows: Array<{ view: { emit: (event: string) => void } }>;
  isOpen: boolean;
}

function newGame() {
  const frameCbs: Array<(t: Ticker) => void> = [];
  const app = {
    stage: new Container(),
    renderer: { screen: { width: 1280, height: 720 }, resolution: 1, resize: () => {} },
    ticker: { add: (cb: (t: Ticker) => void) => frameCbs.push(cb), remove: () => {} },
    canvas: {},
  } as unknown as ConstructorParameters<typeof Game>[0];

  // Mutable, unlike the sibling files' fixed literal: holding the fire button IS the
  // subject here, so the case has to be able to press and release it.
  const state = { moveX: 0, moveY: 0, firing: false, interacting: false };
  const input = {
    onSwitchWeapon: null as ((slot: number) => void) | null,
    attach: () => {},
    read: () => state,
    getTouchVisual: () => NO_TOUCH,
    setControlMirror: () => {},
  };
  const game = new Game(app, input as never,
    { play: () => {}, setSfxVolume: () => {}, setMusicVolume: () => {}, resume: () => {} } as never);
  game.start();

  const inner = game as unknown as {
    run: { engine: { state: GameState } | null };
    hud: { weaponPickupPrompt: Prompt };
    nav: { showForge(): void };
    runs: { beginRun(): void };
  };
  let ms = 0;
  const frames = (n: number) => {
    for (let i = 0; i < n; i++) { ms += 16.7; for (const cb of frameCbs) cb({ deltaMS: 16.7, lastTime: ms } as Ticker); }
  };
  return { inner, input: state, frames };
}

/** A run, standing on a floor weapon, with the panel up. */
function runWithLootUnderfoot() {
  const h = newGame();
  h.inner.nav.showForge();
  h.inner.runs.beginRun();
  h.frames(4); // the spawn position is only real once tick 1's SpawnSystem has run

  const s = h.inner.run.engine!.state;
  const p = s.players[0]!;
  const item: PickupItem = {
    id: s.nextId(), kind: 'weapon', gx: p.gx, gy: p.gy,
    spawnTick: 0, alive: true, weaponId: 'blaster',
  };
  s.pickups.push(item);
  h.frames(2); // HudView sees it and opens the panel

  expect(h.inner.hud.weaponPickupPrompt.isOpen).toBe(true);
  expect(p.weapon!.spec.kind).toBe('ranged'); // the shots below have to come from somewhere
  return { ...h, state: s, item };
}

describe('Game — the weapon-pickup panel and the attack button', () => {
  it('a player standing in loot can still shoot: the open panel takes nothing on its own', () => {
    // The report itself. Until 2026-09-02 `GameLoop` OR'd this panel's `isOpen` into
    // `suppressFire`, so holding fire next to any floor weapon produced nothing at all —
    // and since every kill drops one, that is most of a fight.
    const h = runWithLootUnderfoot();

    h.input.firing = true;
    h.frames(12);

    expect(h.state.projectiles.length).toBeGreaterThan(0);
    expect(h.state.pickups).toContain(h.item); // and it did not collect anything either
  });

  it('the click that collects a weapon does not also fire a shot', () => {
    // The reason the suppression exists at all: `WebInput` sets `firing` from a raw
    // `mousedown` that no Pixi hit test can consume, so the press carrying a row click
    // would otherwise reach the sim as FIRE on the same tick.
    const h = runWithLootUnderfoot();
    const prompt = h.inner.hud.weaponPickupPrompt;

    pressPanel(prompt.view);   // pointerdown — the browser dispatches this before mousedown
    h.input.firing = true;     // ...and then the raw mousedown WebInput actually listens to
    h.frames(12);
    expect(h.state.projectiles.length).toBe(0);

    tap(prompt.rows[0]!.view); // the completed click on the row
    h.input.firing = false;    // released
    h.frames(4);

    expect(h.state.pickups).not.toContain(h.item); // collected, so the click DID reach the sim
    expect(h.state.projectiles.length).toBe(0);    // and still no shot came out of it
  });
});
