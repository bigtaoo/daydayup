/**
 * Co-op downed / revive (design/05/07, ROADMAP 3.2). A lethal hit sends a player `downed`
 * (frozen, revivable) instead of dead; a teammate revives via a sustained-INTERACT channel,
 * and a run ends only when NO player is up. The engine builds one player today (multi-player
 * wiring is the Phase 3.1 net layer), so the co-op cases synthesise a second PlayerActor —
 * the systems all iterate state.players, so this exercises the real code paths.
 */
import { describe, it, expect } from 'vitest';
import { toFp } from '@dd/engine/math/fixed';
import type { Brad } from '@dd/engine/math/trig';
import { pxToFp, toFpGrid } from '@dd/engine/content/convert';
import { freshStatus } from '@dd/engine/content/damage';
import { BASIC_ENEMY } from '@dd/engine/content/enemies';
import { PLAYER_BASE } from '@dd/engine/content/players';
import { makeWeapon, BLASTER_SIM } from '@dd/engine/content/weapons';
import { createGameState } from '@dd/engine/state/GameState';
import type { GameState } from '@dd/engine/state/GameState';
import { ENEMY_TEAM_ID, type EnemyActor, type PlayerActor, type Projectile } from '@dd/engine/state/entities';
import {
  DOWNED_BLEEDOUT_TICKS, REVIVE_CHANNEL_TICKS, REVIVE_HP, REVIVE_RANGE_GRID,
} from '@dd/engine/config';
import {
  DeathDropsSystem, HitResolveSystem, ReviveSystem, WinConditionSystem,
} from '@dd/engine/systems';
import { createGameEngine } from '@dd/engine/GameEngine';
import { makeCommand } from '@dd/engine/state/input';

const CFG = { seed: 7, worldW: 1600, worldH: 1200, waves: [] as const };
const state = (): GameState => createGameState(CFG);

/** Add a second player at a px position (the engine only spawns one today). */
function addPlayer(s: GameState, xpx: number, ypx: number): PlayerActor {
  const w = makeWeapon(BLASTER_SIM);
  const p: PlayerActor = {
    id: s.nextId(), faction: 'player', teamId: 0, // same team as player 0 — a co-op ally, not a rival
    gx: pxToFp(xpx), gy: pxToFp(ypx), z: toFp(0), vx: toFp(0), vy: toFp(0),
    knockVx: toFp(0), knockVy: toFp(0),
    facing: 0 as Brad, hp: 6, maxHp: 6, shield: 0, maxShield: 0, ticksSinceHit: 0,
    radius: PLAYER_BASE.radius, footprintRadius: PLAYER_BASE.footprintRadius,
    alive: true, weapon: w, weapons: [w], activeSlot: 0, buffs: [],
    firing: false, interacting: false, wasInteracting: false, downed: false, bleedoutTicks: 0, reviveProgressTicks: 0,
    bandages: 0, prevButtons: 0, status: freshStatus(),
  };
  s.players.push(p);
  return p;
}

function addEnemy(s: GameState, xpx: number, ypx: number): EnemyActor {
  const e: EnemyActor = {
    id: s.nextId(), faction: 'enemy', teamId: ENEMY_TEAM_ID,
    gx: pxToFp(xpx), gy: pxToFp(ypx), z: toFp(0), vx: toFp(0), vy: toFp(0),
    knockVx: toFp(0), knockVy: toFp(0),
    facing: 0 as Brad, hp: BASIC_ENEMY.maxHp, maxHp: BASIC_ENEMY.maxHp,
    shield: 0, maxShield: 0, ticksSinceHit: 0,
    radius: BASIC_ENEMY.radius, footprintRadius: BASIC_ENEMY.footprintRadius,
    alive: true, weapon: null, firing: false, status: freshStatus(), enraged: false,
  };
  s.enemies.push(e);
  return e;
}

describe('DeathDropsSystem — a lethal hit sends a player DOWNED, not dead', () => {
  it('hp ≤ 0 → downed (alive stays true), frozen, bleedout armed, one downed event', () => {
    const s = state();
    const p = s.players[0]!;
    p.hp = 0;
    p.vx = toFp(5); // was moving
    new DeathDropsSystem().tick(s);
    expect(p.downed).toBe(true);
    expect(p.alive).toBe(true); // NOT a permanent death yet
    expect(p.bleedoutTicks).toBe(DOWNED_BLEEDOUT_TICKS);
    expect(p.vx).toBe(toFp(0)); // frozen in place
    expect(s.events.filter((e) => e.type === 'downed')).toHaveLength(1);
    // Idempotent: a second tick while still downed doesn't re-arm or re-emit.
    s.events.length = 0;
    new DeathDropsSystem().tick(s);
    expect(s.events.filter((e) => e.type === 'downed')).toHaveLength(0);
  });
});

describe('WinConditionSystem — a run ends only when NO player is up', () => {
  it('single-player: the sole player going down ends the run (enemies win)', () => {
    const s = state();
    s.players[0]!.downed = true;
    s.players[0]!.alive = true; // downed, not dead
    new WinConditionSystem().tick(s);
    expect(s.winner).toBe('enemies');
    expect(s.phase).toBe('gameover');
  });

  it('co-op: one down, one up → the run continues', () => {
    const s = state();
    addPlayer(s, 500, 400);
    s.players[0]!.downed = true; // player A down
    new WinConditionSystem().tick(s); // player B still up
    expect(s.winner).toBe(null);
  });

  it('co-op: BOTH down at once → team wipe (enemies win)', () => {
    const s = state();
    addPlayer(s, 500, 400);
    s.players[0]!.downed = true;
    s.players[1]!.downed = true;
    new WinConditionSystem().tick(s);
    expect(s.winner).toBe('enemies');
  });
});

describe('ReviveSystem — the revive channel', () => {
  const downedWithReviverInRange = () => {
    const s = state();
    const a = s.players[0]!; // will be downed
    a.downed = true;
    a.bleedoutTicks = DOWNED_BLEEDOUT_TICKS;
    a.gx = pxToFp(400);
    a.gy = pxToFp(400);
    const b = addPlayer(s, 400, 400); // on top of A, well within revive range
    b.interacting = true;
    return { s, a, b };
  };

  it('a teammate holding INTERACT in range completes a revive after REVIVE_CHANNEL_TICKS', () => {
    const { s, a } = downedWithReviverInRange();
    const sys = new ReviveSystem();
    for (let t = 1; t < REVIVE_CHANNEL_TICKS; t++) {
      sys.tick(s);
      expect(a.downed).toBe(true); // not yet
    }
    sys.tick(s); // the completing tick
    expect(a.downed).toBe(false);
    expect(a.alive).toBe(true);
    expect(a.hp).toBe(REVIVE_HP);
    expect(s.events.some((e) => e.type === 'revived' && e.id === a.id)).toBe(true);
  });

  it('bleedout is PAUSED while a valid revive is in progress', () => {
    const { s, a } = downedWithReviverInRange();
    const sys = new ReviveSystem();
    for (let t = 0; t < 10; t++) sys.tick(s);
    expect(a.bleedoutTicks).toBe(DOWNED_BLEEDOUT_TICKS); // untouched — reviver present
    expect(a.reviveProgressTicks).toBe(10);
  });

  it('interruption (reviver stops / walks off) resets channel progress and resumes bleedout', () => {
    const { s, a, b } = downedWithReviverInRange();
    const sys = new ReviveSystem();
    for (let t = 0; t < 20; t++) sys.tick(s);
    expect(a.reviveProgressTicks).toBe(20);
    b.interacting = false; // let go of INTERACT
    sys.tick(s);
    expect(a.reviveProgressTicks).toBe(0); // channel reset
    expect(a.bleedoutTicks).toBe(DOWNED_BLEEDOUT_TICKS - 1); // bleedout resumed
  });

  it('an out-of-range teammate does not revive', () => {
    const { s, a, b } = downedWithReviverInRange();
    b.gx = pxToFp(400 + 32 * (REVIVE_RANGE_GRID + 3)); // several grid units away
    const sys = new ReviveSystem();
    for (let t = 0; t < 30; t++) sys.tick(s);
    expect(a.reviveProgressTicks).toBe(0);
    expect(a.bleedoutTicks).toBe(DOWNED_BLEEDOUT_TICKS - 30); // only bleedout ran
  });

  it('bleedout expiry with no reviver → permanent death', () => {
    const s = state();
    const a = s.players[0]!;
    a.downed = true;
    a.bleedoutTicks = 2; // about to expire
    const sys = new ReviveSystem();
    sys.tick(s);
    expect(a.alive).toBe(true);
    sys.tick(s); // bleedoutTicks → 0
    expect(a.downed).toBe(false);
    expect(a.alive).toBe(false); // dead for good
    expect(s.events.some((e) => e.type === 'death' && e.id === a.id)).toBe(true);
  });
});

describe('ReviveSystem — PvP squad + bandage gating (design/05/15)', () => {
  /** A zoneEnabled (PvP) state needs a real arena — `createGameState` only sets
   * `zoneEnabled` when `EngineConfig.arena` is provided. */
  const MINI_ARENA = {
    id: 'mini', sizeGrid: { w: 10, h: 10 },
    rooms: [{ id: 'A', rectGrid: { x: 0, y: 0, w: 10, h: 10 }, solids: [] }],
    doors: [], spawns: [{ x: 5, y: 5 }], eyeCandidates: [{ roomId: 'A' }],
  };

  function pvpDownedWithReviverInRange(sameTeam: boolean, reviverBandages: number) {
    const s = createGameState({ ...CFG, arena: MINI_ARENA, players: [{ teamId: 0 }] });
    expect(s.zoneEnabled).toBe(true);
    const a = s.players[0]!;
    a.downed = true;
    a.bleedoutTicks = DOWNED_BLEEDOUT_TICKS;
    a.gx = pxToFp(400);
    a.gy = pxToFp(400);
    const b = addPlayer(s, 400, 400); // on top of A, well within revive range
    b.teamId = sameTeam ? 0 : 1;
    b.bandages = reviverBandages;
    b.interacting = true;
    return { s, a, b };
  }

  it('a same-squad reviver WITH a bandage completes the revive and spends exactly one bandage', () => {
    const { s, a, b } = pvpDownedWithReviverInRange(true, 1);
    const sys = new ReviveSystem();
    for (let t = 0; t < REVIVE_CHANNEL_TICKS; t++) sys.tick(s);
    expect(a.downed).toBe(false);
    expect(b.bandages).toBe(0); // spent
  });

  it('a same-squad reviver with NO bandage cannot even start the channel', () => {
    const { s, a, b } = pvpDownedWithReviverInRange(true, 0);
    const sys = new ReviveSystem();
    sys.tick(s);
    expect(a.reviveProgressTicks).toBe(0); // never advances
    expect(a.bleedoutTicks).toBe(DOWNED_BLEEDOUT_TICKS - 1); // bleedout runs as if no reviver at all
    expect(b.bandages).toBe(0); // nothing spent on a non-starting attempt
  });

  it('a RIVAL squad member never revives, even carrying a bandage', () => {
    const { s, a, b } = pvpDownedWithReviverInRange(false, 1);
    const sys = new ReviveSystem();
    for (let t = 0; t < 10; t++) sys.tick(s);
    expect(a.reviveProgressTicks).toBe(0);
    expect(a.bleedoutTicks).toBe(DOWNED_BLEEDOUT_TICKS - 10);
    expect(b.bandages).toBe(1); // the rival's bandage is untouched
  });

  it('an INTERRUPTED PvP revive does not spend the bandage', () => {
    const { s, a, b } = pvpDownedWithReviverInRange(true, 1);
    const sys = new ReviveSystem();
    for (let t = 0; t < REVIVE_CHANNEL_TICKS - 1; t++) sys.tick(s); // one short of completion
    expect(a.downed).toBe(true);
    b.interacting = false; // interrupt right before completion
    sys.tick(s);
    expect(a.reviveProgressTicks).toBe(0);
    expect(b.bandages).toBe(1); // untouched — only a COMPLETED revive spends it
  });

  it('PvE (no zoneEnabled) is completely unaffected by the bandage requirement, even at 0 bandages', () => {
    const s = state(); // plain PvE state — no arena, zoneEnabled false
    expect(s.zoneEnabled).toBe(false);
    const a = s.players[0]!;
    a.downed = true;
    a.bleedoutTicks = DOWNED_BLEEDOUT_TICKS;
    a.gx = pxToFp(400);
    a.gy = pxToFp(400);
    const b = addPlayer(s, 400, 400);
    b.interacting = true;
    expect(b.bandages).toBe(0); // default — PvE never grants any
    const sys = new ReviveSystem();
    for (let t = 0; t < REVIVE_CHANNEL_TICKS; t++) sys.tick(s);
    expect(a.downed).toBe(false); // still completes for free, exactly as before
  });
});

describe('downed players are invulnerable (design/07, 3.2)', () => {
  it('an enemy bullet passes through a downed player without dealing damage', () => {
    const s = state();
    const p = s.players[0]!;
    p.gx = pxToFp(400);
    p.gy = pxToFp(400);
    p.downed = true;
    p.hp = 0;
    const b: Projectile = {
      id: s.nextId(), faction: 'enemy', teamId: ENEMY_TEAM_ID, gx: pxToFp(400), gy: pxToFp(400), z: toFp(0),
      vx: toFp(0), vy: toFp(0), radius: toFpGrid(0.2), damage: 3, damageType: 'physical',
      lifeTicks: 10, alive: true,
    };
    s.projectiles.push(b);
    new HitResolveSystem().tick(s);
    expect(p.hp).toBe(0); // unchanged — no overkill, no re-death
    expect(b.alive).toBe(true); // bullet not consumed by a downed body
  });
});

describe('Integration — single-player downed→wipe through the real engine step()', () => {
  it('a player reduced to 0 HP downs and the run ends the same/next tick with enemies winning', () => {
    const eng = createGameEngine({ seed: 2, worldW: 800, worldH: 600, playerStart: [400, 300], waves: [] });
    const p = eng.state.players[0]!;
    p.hp = 1;
    p.shield = 0; // drop the default skin's shield so a single chip hit is lethal
    // An enemy offset along +x fires back west through the (stationary) player.
    const e = addEnemy(eng.state, 470, 300);
    e.weapon = makeWeapon(BLASTER_SIM);
    for (let t = 1; t <= 200 && eng.state.phase !== 'gameover'; t++) {
      eng.step([makeCommand({ owner: 0, tick: t, moveBrad: 0 as Brad, moveMag: 0, aimBrad: 0 as Brad, buttons: 0 })]);
    }
    expect(eng.state.phase).toBe('gameover');
    expect(eng.state.winner).toBe('enemies');
    expect(eng.state.players[0]!.downed).toBe(true); // single-player: down = run over, never revived
  });
});
