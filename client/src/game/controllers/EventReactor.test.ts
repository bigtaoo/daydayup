/**
 * EventReactor (design/08 "events are the only engine→render channel"). Only the
 * toast-text side is asserted here (design/17-i18n.md migrated it to `t()`) — fx/audio
 * are exercised incidentally via real `FxController`/fake `AudioBus` so `consume()`
 * doesn't throw, same "construct real Pixi widgets under plain vitest" convention as
 * HudView.test.ts.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { pxToFp, WEAPON_SIM_BY_ID, type GameEvent, type GameState, type MeleeSimSpec } from '@dd/engine';
import { createGameState } from '@dd/engine/state/GameState';
import type { ArenaMap } from '@dd/engine/content/arenas';
import { EventReactor, type EventReactorHost } from './EventReactor';
import type { FxController } from '../fx/FxController';
import { HudView } from '../ui/HudView';
import { Layers } from '../scene/layers';
import type { AudioBus } from '../../platform/types';
import { setLocale, resetLocaleForTests } from '../../i18n';
import { THEME } from '../theme';
import type { SlashArcPose } from '../fx/slashArc';
import { swingSchedule, type SwingShape } from '../../render/rigAttackMotion';

// `FxController`'s real constructor builds WebGL filters (VignetteFilter/
// ChromaticAberrationFilter), which need an actual `document`/GL context this repo's
// plain-node vitest doesn't have (see FxController.ts) — a minimal fake covering only
// the methods EventReactor.consume() actually calls is the same "avoid a real renderer"
// convention every other screen test here already uses for Pixi Text/Container.
function fakeFx(): FxController {
  return {
    flash: vi.fn(),
    muzzleFlare: vi.fn(),
    slashArc: vi.fn(),
    addShake: vi.fn(),
    addHitStop: vi.fn(),
    pulseChromatic: vi.fn(),
    particles: {
      muzzleFlame: vi.fn(), shellCasing: vi.fn(), explosionDebris: vi.fn(), shieldShards: vi.fn(),
    },
  } as unknown as FxController;
}

function fakeAudio(): AudioBus {
  return {
    play: vi.fn(),
    preload: vi.fn(async () => {}),
    setSfxVolume: vi.fn(),
    setMusicVolume: vi.fn(),
    updateMusic: vi.fn(),
    invalidateMusic: vi.fn(),
    resume: vi.fn(),
  };
}

function fakeHost(): EventReactorHost {
  return {
    localOwner: 0,
    activeState: () => null,
    addScore: vi.fn(),
    onRoomEnter: vi.fn(),
    onDoorStateChange: vi.fn(),
    onForceRegroup: vi.fn(),
    onWeaponPickup: vi.fn(),
    actorAt: vi.fn(() => undefined),
  };
}

function newReactor() {
  const hud = new HudView();
  hud.build(new Layers(), { w: 1280, h: 720 });
  const reactor = new EventReactor(fakeFx(), hud, fakeAudio(), fakeHost());
  const toast = vi.spyOn(hud, 'toast');
  return { reactor, toast };
}

const PICKUP_BASE = { type: 'pickup' as const, gx: 0, gy: 0 };

/** The smallest map that makes `createGameState` build an ARENA state (`zoneEnabled`, seats
 *  with `teamId`s) — the `win` cue's whole question is which win model applies, and only a
 *  real state answers that. Same one-room fixture `RunOutcome.test.ts` uses for the screen
 *  side of the same decision. */
const MINI_ARENA: ArenaMap = {
  id: 'mini',
  sizeGrid: { w: 10, h: 10 },
  rooms: [{ id: 'A', rectGrid: { x: 0, y: 0, w: 10, h: 10 }, solids: [] }],
  doors: [],
  spawns: [{ x: 5, y: 5 }],
  eyeCandidates: [{ roomId: 'A' }],
};

afterEach(() => resetLocaleForTests());

describe('EventReactor — pickup toasts', () => {
  it('a heal pickup toasts "+1 HP"', () => {
    const { reactor, toast } = newReactor();
    reactor.consume([{ ...PICKUP_BASE, kind: 'heal' }] as GameEvent[]);
    expect(toast).toHaveBeenCalledWith('+1 HP', expect.anything());
  });

  it('a recognized weapon pickup toasts its translated display name', () => {
    const { reactor, toast } = newReactor();
    reactor.consume([{ ...PICKUP_BASE, kind: 'weapon', weaponId: 'repeater' }] as GameEvent[]);
    expect(toast).toHaveBeenCalledWith('Repeater', expect.anything());
  });

  it('an unrecognized weapon id falls back to "New weapon"', () => {
    const { reactor, toast } = newReactor();
    reactor.consume([{ ...PICKUP_BASE, kind: 'weapon', weaponId: 'no-such-weapon' }] as GameEvent[]);
    expect(toast).toHaveBeenCalledWith('New weapon', expect.anything());
  });

  it('a recognized buff toasts "Buff: {translated name}"', () => {
    const { reactor, toast } = newReactor();
    reactor.consume([{ ...PICKUP_BASE, kind: 'buff', buffId: 'dmg_up' }] as GameEvent[]);
    expect(toast).toHaveBeenCalledWith('Buff: Damage Up', expect.anything());
  });

  it('an uncatalogued buff id falls back to echoing the raw id; an absent one toasts the generic label', () => {
    const { reactor, toast } = newReactor();
    reactor.consume([{ ...PICKUP_BASE, kind: 'buff', buffId: 'crit_surge' }] as GameEvent[]);
    expect(toast).toHaveBeenCalledWith('Buff: crit_surge', expect.anything());
    toast.mockClear();
    reactor.consume([{ ...PICKUP_BASE, kind: 'buff' }] as GameEvent[]);
    expect(toast).toHaveBeenCalledWith('Buff', expect.anything());
  });

  it('a recognized material pickup toasts "+{qty} {translated material name}"', () => {
    const { reactor, toast } = newReactor();
    reactor.consume([{ ...PICKUP_BASE, kind: 'material', materialId: 'mat_fire', qty: 3 }] as GameEvent[]);
    expect(toast).toHaveBeenCalledWith('+3 Fire', expect.anything());
  });

  it('an uncatalogued material id falls back to echoing the raw id; an absent one toasts the generic label', () => {
    const { reactor, toast } = newReactor();
    reactor.consume([{ ...PICKUP_BASE, kind: 'material', materialId: 'fire', qty: 3 }] as GameEvent[]);
    expect(toast).toHaveBeenCalledWith('+3 fire', expect.anything());
    toast.mockClear();
    reactor.consume([{ ...PICKUP_BASE, kind: 'material' }] as GameEvent[]);
    expect(toast).toHaveBeenCalledWith('+1 material', expect.anything());
  });
});

describe('EventReactor — pickup toasts, i18n (design/17-i18n.md)', () => {
  it('translate every toast template under zh', () => {
    setLocale('zh');
    const { reactor, toast } = newReactor();
    reactor.consume([{ ...PICKUP_BASE, kind: 'heal' }] as GameEvent[]);
    expect(toast).toHaveBeenCalledWith('+1 生命', expect.anything());
    toast.mockClear();
    reactor.consume([{ ...PICKUP_BASE, kind: 'buff' }] as GameEvent[]);
    expect(toast).toHaveBeenCalledWith('增益', expect.anything());
    toast.mockClear();
    reactor.consume([{ ...PICKUP_BASE, kind: 'material' }] as GameEvent[]);
    expect(toast).toHaveBeenCalledWith('+1 材料', expect.anything());
  });

  it('translates a recognized weapon/buff/material name, not just the generic templates', () => {
    setLocale('zh');
    const { reactor, toast } = newReactor();
    reactor.consume([{ ...PICKUP_BASE, kind: 'weapon', weaponId: 'repeater' }] as GameEvent[]);
    expect(toast).toHaveBeenCalledWith('连发枪', expect.anything());
    toast.mockClear();
    reactor.consume([{ ...PICKUP_BASE, kind: 'buff', buffId: 'dmg_up' }] as GameEvent[]);
    expect(toast).toHaveBeenCalledWith('增益：伤害提升', expect.anything());
    toast.mockClear();
    reactor.consume([{ ...PICKUP_BASE, kind: 'material', materialId: 'mat_fire', qty: 3 }] as GameEvent[]);
    expect(toast).toHaveBeenCalledWith('+3 火', expect.anything());
  });
});

describe('EventReactor — score reactions unaffected by the toast migration', () => {
  it('an enemy death still scores a kill', () => {
    const hud = new HudView();
    hud.build(new Layers(), { w: 1280, h: 720 });
    const host = fakeHost();
    const reactor = new EventReactor(fakeFx(), hud, fakeAudio(), host);
    reactor.consume([{ type: 'death', faction: 'enemy', gx: 0, gy: 0 } as GameEvent]);
    expect(host.addScore).toHaveBeenCalled();
  });
});

describe('EventReactor — hit-flash outline (design/01 fidelity roadmap milestone 5)', () => {
  it('flashes the specific actor named by a hit event\'s `target` id', () => {
    const hud = new HudView();
    hud.build(new Layers(), { w: 1280, h: 720 });
    const onHurt = vi.fn();
    const host = fakeHost();
    (host.actorAt as ReturnType<typeof vi.fn>).mockReturnValue({ onHurt });
    const reactor = new EventReactor(fakeFx(), hud, fakeAudio(), host);
    reactor.consume([{ type: 'hit', target: 7, faction: 'player', gx: 0, gy: 0, damage: 1, damageType: 'physical' } as GameEvent]);
    expect(host.actorAt).toHaveBeenCalledWith(7);
    expect(onHurt).toHaveBeenCalled();
  });

  // 2026-08-26. `shield_break` grew a second fx call: the shell's own fragments
  // (`ParticleSystem.shieldShards`). Worth a test of its own because the POSITION is the part
  // that can be wrong invisibly — `shield_break` carries the target actor's centre (`combat.ts`
  // pushes `target.gx/gy`) while the neighbouring `hit` case carries the impact point, and a
  // ring of shards thrown from the wrong one of those still reads as "the shield broke".
  describe('shield_break spawns the shell fragments', () => {
    const breakAt = (gx: number, gy: number) => {
      const hud = new HudView();
      hud.build(new Layers(), { w: 1280, h: 720 });
      const fx = fakeFx();
      new EventReactor(fx, hud, fakeAudio(), fakeHost()).consume([
        { type: 'shield_break', id: 7, gx, gy } as GameEvent,
      ]);
      return fx.particles.shieldShards as unknown as ReturnType<typeof vi.fn>;
    };

    it('throws the ring from the event position, in screen px', () => {
      const shards = breakAt(pxToFp(300), pxToFp(200));
      expect(shards).toHaveBeenCalledTimes(1);
      const [x, y] = shards.mock.calls[0] as [number, number, number];
      expect(x).toBeCloseTo(300, 6);
      expect(y).toBeCloseTo(200, 6);
    });

    it('follows the actor rather than sitting at the origin', () => {
      // The failure this catches: a burst hard-coded to (0,0), or to the camera centre, which
      // looks plausible in any single screenshot of a fight near the middle of the room.
      const [x, y] = breakAt(pxToFp(-140), pxToFp(96)).mock.calls[0] as [number, number, number];
      expect(x).toBeCloseTo(-140, 6);
      expect(y).toBeCloseTo(96, 6);
    });

    it('does not fire on any other event that reaches the same switch', () => {
      const hud = new HudView();
      hud.build(new Layers(), { w: 1280, h: 720 });
      const fx = fakeFx();
      new EventReactor(fx, hud, fakeAudio(), fakeHost()).consume([
        { type: 'hit', target: 7, faction: 'player', gx: 0, gy: 0, damage: 1, damageType: 'physical' },
        { type: 'deflect', gx: 0, gy: 0 },
        { type: 'clash', gx: 0, gy: 0 },
      ] as GameEvent[]);
      expect(fx.particles.shieldShards).not.toHaveBeenCalled();
    });
  });

  // 2026-08-26. The shield shell dents where the hit LANDED (`EnergyShieldFilter.hit`), which
  // makes the delta this passes a load-bearing value rather than a decoration. It is also
  // completely invisible when wrong: a sign flip dents the far side, and "the shield deformed"
  // still reads as correct on screen. Nothing else in the suite covers this — the mutation
  // battery for the rewrite only mutates the shader and the tile, never this file.
  describe('hands the shell the direction the hit came from', () => {
    const fire = (target: { onHurt: ReturnType<typeof vi.fn>; x: number; y: number }, gx: number, gy: number) => {
      const hud = new HudView();
      hud.build(new Layers(), { w: 1280, h: 720 });
      const host = fakeHost();
      (host.actorAt as ReturnType<typeof vi.fn>).mockReturnValue(target);
      new EventReactor(fakeFx(), hud, fakeAudio(), host).consume([
        { type: 'hit', target: 7, faction: 'player', gx, gy, damage: 1, damageType: 'physical' } as GameEvent,
      ]);
      return target.onHurt.mock.calls[0] as [number, number];
    };
    // The actor is deliberately NOT at the origin: with it at (0,0) an implementation that
    // forwarded the impact's absolute position instead of the delta would produce the same
    // vector, and this whole describe would pass against it.
    const AT = { x: 300, y: 200 };

    it('points from the actor toward the impact, not the other way', () => {
      const t = { onHurt: vi.fn(), ...AT };
      // Impact one grid to the RIGHT of the actor: 300px is 9.375 grid, +1 grid = 332px.
      const [dx, dy] = fire(t, pxToFp(332), pxToFp(200));
      expect(dx).toBeGreaterThan(0);
      expect(Math.abs(dy)).toBeLessThan(1e-6);
    });

    it('flips with the impact side', () => {
      const right = fire({ onHurt: vi.fn(), ...AT }, pxToFp(332), pxToFp(200));
      const left = fire({ onHurt: vi.fn(), ...AT }, pxToFp(268), pxToFp(200));
      expect(Math.sign(right[0])).toBe(1);
      expect(Math.sign(left[0])).toBe(-1);
      expect(right[0]).toBeCloseTo(-left[0], 6); // symmetric about the actor
    });

    it('is a DELTA from the actor, not the impact position', () => {
      const t = { onHurt: vi.fn(), ...AT };
      const [dx, dy] = fire(t, pxToFp(332), pxToFp(232));
      expect(dx).toBeCloseTo(32, 6);
      expect(dy).toBeCloseTo(32, 6);
    });

    it('uses screen-down y, so a hit from below dents the bottom of the shell', () => {
      const t = { onHurt: vi.fn(), ...AT };
      const [, dy] = fire(t, pxToFp(300), pxToFp(264));
      expect(dy).toBeGreaterThan(0); // +y is DOWN on screen; the shader's dent axis assumes it
    });
  });

  it('is a no-op when the target id has no live view (already gone)', () => {
    const hud = new HudView();
    hud.build(new Layers(), { w: 1280, h: 720 });
    const reactor = new EventReactor(fakeFx(), hud, fakeAudio(), fakeHost());
    expect(() =>
      reactor.consume([{ type: 'hit', target: 99, faction: 'enemy', gx: 0, gy: 0, damage: 1, damageType: 'physical' } as GameEvent]),
    ).not.toThrow();
  });
});

describe('EventReactor — door lock/unlock (design/05 "Room & door model" DoorSystem)', () => {
  it('door_locked restyles the door fixture(s) via onDoorStateChange, given the active state', () => {
    const hud = new HudView();
    hud.build(new Layers(), { w: 1280, h: 720 });
    const host = fakeHost();
    // `players: []` rather than `{}`: `activeState()` is typed `GameState | null`, so a state
    // with no seat array is a shape the game never produces and the cast was hiding that.
    const state = { players: [] } as unknown as GameState;
    host.activeState = () => state;
    const reactor = new EventReactor(fakeFx(), hud, fakeAudio(), host);
    reactor.consume([{ type: 'door_locked', roomId: 'r1' } as GameEvent]);
    expect(host.onDoorStateChange).toHaveBeenCalledWith(state);
  });

  it('door_unlocked does the same', () => {
    const hud = new HudView();
    hud.build(new Layers(), { w: 1280, h: 720 });
    const host = fakeHost();
    const state = { players: [] } as unknown as GameState;
    host.activeState = () => state;
    const reactor = new EventReactor(fakeFx(), hud, fakeAudio(), host);
    reactor.consume([{ type: 'door_unlocked', roomId: 'r1' } as GameEvent]);
    expect(host.onDoorStateChange).toHaveBeenCalledWith(state);
  });

  it('is a no-op when there is no active state', () => {
    const hud = new HudView();
    hud.build(new Layers(), { w: 1280, h: 720 });
    const host = fakeHost(); // activeState() => null by default
    const reactor = new EventReactor(fakeFx(), hud, fakeAudio(), host);
    reactor.consume([{ type: 'door_locked', roomId: 'r1' } as GameEvent]);
    expect(host.onDoorStateChange).not.toHaveBeenCalled();
  });
});

describe('EventReactor — force_regroup (design/05 DoorSystem)', () => {
  function stateWithLocalPlayer(id: number): GameState {
    return { players: [{ id, gx: 0, gy: 0 }] } as unknown as GameState;
  }

  it('snaps the camera when the local player is among the regrouped ids', () => {
    const hud = new HudView();
    hud.build(new Layers(), { w: 1280, h: 720 });
    const host = fakeHost();
    host.activeState = () => stateWithLocalPlayer(7);
    const reactor = new EventReactor(fakeFx(), hud, fakeAudio(), host);
    reactor.consume([{ type: 'force_regroup', roomId: 'r1', playerIds: [7] } as GameEvent]);
    expect(host.onForceRegroup).toHaveBeenCalled();
  });

  it('is a no-op when the local player is not among the regrouped ids', () => {
    const hud = new HudView();
    hud.build(new Layers(), { w: 1280, h: 720 });
    const host = fakeHost();
    host.activeState = () => stateWithLocalPlayer(7);
    const reactor = new EventReactor(fakeFx(), hud, fakeAudio(), host);
    reactor.consume([{ type: 'force_regroup', roomId: 'r1', playerIds: [3, 9] } as GameEvent]);
    expect(host.onForceRegroup).not.toHaveBeenCalled();
  });

  it('is a no-op when there is no active state', () => {
    const hud = new HudView();
    hud.build(new Layers(), { w: 1280, h: 720 });
    const host = fakeHost(); // activeState() => null by default
    const reactor = new EventReactor(fakeFx(), hud, fakeAudio(), host);
    expect(() =>
      reactor.consume([{ type: 'force_regroup', roomId: 'r1', playerIds: [7] } as GameEvent]),
    ).not.toThrow();
    expect(host.onForceRegroup).not.toHaveBeenCalled();
  });
});

/**
 * The character-reaction cues (design/11, 2026-09-02). Three of the four are gated on the
 * LOCAL seat, and that gate is the whole design: `impact` already reports that a hit landed
 * somewhere, `death.enemy` that something died. What had no sound at all was the answer to
 * "was that me" — so a `hurt` or a `death.player` that fired for every actor would not be a
 * louder version of this feature, it would be the absence of it.
 */
describe('EventReactor — the cues that are about YOU (design/11)', () => {
  const LOCAL = 11;
  const OTHER = 12;

  function reactorFor(seatId: number | null) {
    const hud = new HudView();
    hud.build(new Layers(), { w: 1280, h: 720 });
    const audio = fakeAudio();
    const fx = fakeFx();
    const host = fakeHost();
    if (seatId !== null) {
      host.activeState = () =>
        ({ players: [{ id: seatId, gx: 0, gy: 0 }] }) as unknown as GameState;
    }
    return { reactor: new EventReactor(fx, hud, audio, host), audio, fx, host };
  }

  const hitOn = (target: number) => ({
    type: 'hit', target, faction: 'enemy', gx: 0, gy: 0, damage: 1, damageType: 'physical',
  }) as GameEvent;

  it('a hit on the local seat plays hurt AND impact — the pair IS the signal', () => {
    // Not either/or: `impact` places the hit in the world and `hurt` says whose body it was.
    // A version that replaced one with the other would lose half of what the frame knows.
    const { reactor, audio } = reactorFor(LOCAL);
    reactor.consume([hitOn(LOCAL)]);
    expect(cuesOf(audio).sort()).toEqual(['hurt', 'impact']);
  });

  it('a hit on anybody else plays impact alone', () => {
    const { reactor, audio } = reactorFor(LOCAL);
    reactor.consume([hitOn(OTHER)]);
    expect(cuesOf(audio)).toEqual(['impact']);
  });

  it('coalesces a burst of hits on the local seat into one hurt carrying the count', () => {
    const { reactor, audio } = reactorFor(LOCAL);
    reactor.consume([hitOn(LOCAL), hitOn(LOCAL), hitOn(OTHER)]);
    expect(audio.play).toHaveBeenCalledWith('hurt', 2);
    expect(audio.play).toHaveBeenCalledWith('impact', 3);
  });

  it('plays nothing seat-specific when there is no seat yet', () => {
    // A menu frame draining a stale queue: `activeState()` is null, so there is no local id.
    // The failure this pins is treating "no local actor" as actor 0, which would hand the
    // hurt cue to whichever entity happened to be first.
    const { reactor, audio } = reactorFor(null);
    reactor.consume([
      hitOn(0),
      { type: 'death', id: 0, faction: 'player', gx: 0, gy: 0 } as GameEvent,
    ]);
    expect(cuesOf(audio)).toEqual(['impact']);
  });

  it("the local seat's death plays death.player; another player's plays nothing", () => {
    const a = reactorFor(LOCAL);
    a.reactor.consume([{ type: 'death', id: LOCAL, faction: 'player', gx: 0, gy: 0 } as GameEvent]);
    expect(cuesOf(a.audio)).toEqual(['death.player']);

    const b = reactorFor(LOCAL);
    b.reactor.consume([{ type: 'death', id: OTHER, faction: 'player', gx: 0, gy: 0 } as GameEvent]);
    expect(b.audio.play).not.toHaveBeenCalled();
  });

  it('an enemy death still plays death.enemy, and never the run-ending fall', () => {
    const { reactor, audio, host } = reactorFor(LOCAL);
    reactor.consume([{ type: 'death', id: 99, faction: 'enemy', gx: 0, gy: 0 } as GameEvent]);
    expect(cuesOf(audio)).toEqual(['death.enemy']);
    expect(host.addScore).toHaveBeenCalled(); // the kill-score branch is untouched
  });

  it('being downed plays hurt, and coalesces with the hit that caused it', () => {
    // Going down is damage, so it takes the damage cue rather than a lifecycle one — a downed
    // player in co-op can be revived, and the run-ending fall would be a lie. In the frame
    // where both land, that is ONE louder hurt, which is what the moment should be.
    const { reactor, audio } = reactorFor(LOCAL);
    reactor.consume([
      hitOn(LOCAL),
      { type: 'downed', id: LOCAL, gx: 0, gy: 0 } as GameEvent,
    ]);
    expect(audio.play).toHaveBeenCalledWith('hurt', 2);
  });

  it('a teammate going down is SEEN but not heard', () => {
    // The split is deliberate: the fx stays ungated because a teammate collapsing is worth
    // looking at, while the cue is the local seat's own damage channel.
    const { reactor, audio, fx } = reactorFor(LOCAL);
    reactor.consume([{ type: 'downed', id: OTHER, gx: 0, gy: 0 } as GameEvent]);
    expect(audio.play).not.toHaveBeenCalled();
    expect(fx.addShake).toHaveBeenCalled();
    expect(fx.addHitStop).toHaveBeenCalled();
  });

  // ---- `win` is about whose run ended well (2026-09-02) ------------------------------
  //
  // The bug these pin was live and reproduced, not theoretical: `case 'win'` played the
  // jingle for ANY `win` event, and the event fires when anyone wins. With `?arenaDemo=1`,
  // downing the local seat and letting it bleed out produced `death.player:1` then `win:1`
  // in one frame with `phase === 'defeat'` — the victory sting over a defeat screen.
  //
  // Fixtures use the engine's REAL `createGameState` rather than the cast object literal the
  // cases above share, because the whole question turns on two fields those literals do not
  // have: `zoneEnabled` (which win model applies) and per-seat `teamId` (which squad won).
  // A cast fixture would pass while spelling either of them wrong.

  /** A finished arena match. `teams[i]` is seat i's squad; the local seat is seat 0
   *  (`fakeHost().localOwner`), and seat i's entity id is i + 1 (`GameState.nextId`). */
  function arenaReactor(teams: readonly number[]) {
    const hud = new HudView();
    hud.build(new Layers(), { w: 1280, h: 720 });
    const audio = fakeAudio();
    const host = fakeHost();
    const s = createGameState({
      seed: 1, worldW: 0, worldH: 0, waves: [], arena: MINI_ARENA,
      players: teams.map((teamId) => ({ teamId })),
    });
    host.activeState = () => s;
    return { reactor: new EventReactor(fakeFx(), hud, audio, host), audio, state: s };
  }

  const winBy = (winner: number | 'enemies' | null) => ({ type: 'win', winner }) as GameEvent;

  it('plays the jingle when the local seat itself is the named winner', () => {
    const { reactor, audio } = arenaReactor([0, 1]);
    reactor.consume([winBy(0)]);
    expect(cuesOf(audio)).toEqual(['win']);
  });

  it('a RIVAL winning plays the run-ending fall, never the jingle', () => {
    // The reported bug, at its smallest: someone won, and it was not us.
    const { reactor, audio } = arenaReactor([0, 1]);
    reactor.consume([winBy(1)]);
    expect(cuesOf(audio)).toEqual(['death.player']);
  });

  it("a squad-mate named as winner is still YOUR win — team membership, not seat identity", () => {
    // `WinConditionSystem.tickPlacement` names the winning squad's LOWEST seat, so a seat-
    // equality check hands most of a winning squad the defeat sound. That exact mistake was a
    // real bug on the screen side (fixed 2026-08-04); sharing `localSeatWon` is what stops the
    // audio side from having to make it again independently.
    const { reactor, audio } = arenaReactor([0, 1, 1, 0]);
    reactor.consume([winBy(3)]); // seat 3 shares the local seat's squad (team 0)
    expect(cuesOf(audio)).toEqual(['win']);
  });

  it('a rival SQUAD winning plays the fall even though a seat of ours outlived a seat of theirs', () => {
    const { reactor, audio } = arenaReactor([0, 1, 1, 0]);
    reactor.consume([winBy(1)]);
    expect(cuesOf(audio)).toEqual(['death.player']);
  });

  it('the local seat dying and the match ending in the same frame is ONE louder fall, not two sounds', () => {
    // The literal reproduced frame: `death.player` from the bleedout plus a rival's `win`.
    // Coalescing is what makes that one voice at higher gain — the same call design/11 makes
    // for `downed` plus the `hit` that caused it. Two separate cues here would be the bug's
    // twin: a second sound narrating the moment the first one already announced.
    const { reactor, audio, state } = arenaReactor([0, 1]);
    reactor.consume([
      { type: 'death', id: state.players[0]!.id, faction: 'player', gx: 0, gy: 0 } as GameEvent,
      winBy(1),
    ]);
    expect(audio.play).toHaveBeenCalledTimes(1);
    expect(audio.play).toHaveBeenCalledWith('death.player', 2);
  });

  it('a PvE run ends well for the whole party, not just for the seat the sim names', () => {
    // `WinConditionSystem`/`ExtractionSystem` both hardcode `winner: 0` (*"single-player:
    // player id 0"*), so in co-op the arena rule — is that seat mine? — would silence the
    // jingle for every seat but the first. PvE has no per-seat answer at all.
    const { reactor, audio } = reactorFor(LOCAL); // no `zoneEnabled` → the PvE model
    reactor.consume([winBy(0)]);
    expect(cuesOf(audio)).toEqual(['win']);
  });

  it("a PvE wipe ('enemies' won) plays the fall", () => {
    // The single-player defeat, and the one case where this cue says something no other cue
    // in the frame does: the seat is `downed`, not dead, so `hurt` is all that fired and
    // nothing yet said the fall was final.
    const { reactor, audio } = reactorFor(LOCAL);
    reactor.consume([
      { type: 'downed', id: LOCAL, gx: 0, gy: 0 } as GameEvent,
      winBy('enemies'),
    ]);
    expect(cuesOf(audio).sort()).toEqual(['death.player', 'hurt']);
  });

  it('reads the winner the EVENT announced, not the one the state happens to hold', () => {
    // The state is only consulted for the seats' teams; WHO won comes off the event. The two
    // agree in the real game (every producer sets `state.winner` and pushes the event in one
    // tick), which is exactly why the difference is invisible unless a test forces it apart —
    // so here the state carries the OPPOSITE winner from the event, and the event has to win.
    // Reading `s.winner` instead compiles, and with the two never disagreeing anywhere else in
    // this file it would stay green.
    const a = arenaReactor([0, 1]);
    a.state.winner = 1;            // the state says a rival took it
    a.reactor.consume([winBy(0)]);  // the event says we did
    expect(cuesOf(a.audio)).toEqual(['win']);

    const b = arenaReactor([0, 1]);
    b.state.winner = 0;            // ...and the mirror image
    b.reactor.consume([winBy(1)]);
    expect(cuesOf(b.audio)).toEqual(['death.player']);
  });

  it('plays NEITHER cue when there is no state to ask', () => {
    // A menu frame draining a stale queue. Guessing either way is worse than silence: the
    // jingle would be the original bug, and the fall would invent a defeat.
    const { reactor, audio } = reactorFor(null);
    reactor.consume([winBy(0), winBy('enemies')]);
    expect(audio.play).not.toHaveBeenCalled();
  });
});

/**
 * `spawn` — the one cue with no engine event behind it. `Scene` counts the actor views it
 * built this frame and `GameLoop` hands that count here, so these cases are about the
 * arithmetic at this end; `Scene.test.ts` owns whether the count itself is right.
 */
describe('EventReactor — the spawn count (design/11)', () => {
  function reactorWithAudio() {
    const hud = new HudView();
    hud.build(new Layers(), { w: 1280, h: 720 });
    const audio = fakeAudio();
    return { reactor: new EventReactor(fakeFx(), hud, audio, fakeHost()), audio };
  }

  it('plays one spawn cue carrying how many actors materialised', () => {
    // A room's wave arrives all at once: nine bodies must be one voice at higher gain, the
    // same rule design/11 states for ten hits in a frame.
    const { reactor, audio } = reactorWithAudio();
    reactor.consume([], 9);
    expect(audio.play).toHaveBeenCalledTimes(1);
    expect(audio.play).toHaveBeenCalledWith('spawn', 9);
  });

  it('plays nothing on a frame that built no views', () => {
    // The common case by far — every frame between waves. A cue at count 0 would be a voice
    // per frame, which is the mistake a truthy check would not catch.
    const { reactor, audio } = reactorWithAudio();
    reactor.consume([{ type: 'clash', gx: 0, gy: 0 } as GameEvent], 0);
    expect(cuesOf(audio)).toEqual(['clash']);
  });

  it('defaults to no spawns when the caller passes nothing', () => {
    // Every other case in this file calls `consume(events)` with one argument; the default is
    // what keeps that honest rather than silently meaning "one spawn".
    const { reactor, audio } = reactorWithAudio();
    reactor.consume([{ type: 'clash', gx: 0, gy: 0 } as GameEvent]);
    expect(cuesOf(audio)).toEqual(['clash']);
  });

  it('rides in the same coalescing map as the events, not around it', () => {
    const { reactor, audio } = reactorWithAudio();
    reactor.consume([{ type: 'bullet_fired', gx: 0, gy: 0, facing: 0 } as GameEvent], 2);
    expect(audio.play).toHaveBeenCalledTimes(2);
    expect(audio.play).toHaveBeenCalledWith('spawn', 2);
    expect(audio.play).toHaveBeenCalledWith('muzzle', 1);
  });
});

/** Which cues a fake bus was asked for, in call order. */
const cuesOf = (audio: ReturnType<typeof fakeAudio>): string[] =>
  (audio.play as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[0] as string);

describe('EventReactor — audio cue coalescing (design/11)', () => {
  function reactorWithAudio() {
    const hud = new HudView();
    hud.build(new Layers(), { w: 1280, h: 720 });
    const audio = fakeAudio();
    return { reactor: new EventReactor(fakeFx(), hud, audio, fakeHost()), audio };
  }

  const hit = (gx = 0) => ({
    type: 'hit', target: 7, faction: 'player', gx, gy: 0, damage: 1, damageType: 'physical',
  }) as GameEvent;

  it('plays a repeated cue ONCE, carrying how many events collapsed into it', () => {
    // design/11: ten hits in a frame are one impact at higher gain, not ten impacts. The
    // COUNT is what lets the mixer do the gain half — dropping it (a plain Set) is the
    // version this test exists to catch.
    const { reactor, audio } = reactorWithAudio();
    reactor.consume([hit(0), hit(1), hit(2)]);
    expect(audio.play).toHaveBeenCalledTimes(1);
    expect(audio.play).toHaveBeenCalledWith('impact', 3);
  });

  it('counts each cue separately, and plays each one once', () => {
    const { reactor, audio } = reactorWithAudio();
    reactor.consume([
      hit(0),
      hit(1),
      { type: 'bullet_fired', gx: 0, gy: 0, facing: 0 } as GameEvent,
      { type: 'clash', gx: 0, gy: 0 } as GameEvent,
    ]);
    expect(audio.play).toHaveBeenCalledWith('impact', 2);
    expect(audio.play).toHaveBeenCalledWith('muzzle', 1);
    expect(audio.play).toHaveBeenCalledWith('clash', 1);
    expect(audio.play).toHaveBeenCalledTimes(3);
  });

  it('starts a fresh count each frame', () => {
    const { reactor, audio } = reactorWithAudio();
    reactor.consume([hit(0), hit(1)]);
    reactor.consume([hit(0)]);
    expect(audio.play).toHaveBeenNthCalledWith(1, 'impact', 2);
    expect(audio.play).toHaveBeenNthCalledWith(2, 'impact', 1);
  });
});

/**
 * `bullet_fired` (2026-08-30, user report *"角色射击时，没有射击动画，枪口也没有射击特效"*).
 *
 * The old handler burst at the event's OWN position — the sim's muzzle, a flat `muzzleOffset`
 * along the aim ray on the GROUND plane — lifted by a hardcoded 12 px. That lands near the
 * character's middle, not at the gun the rig draws, which is why a muzzle effect that had
 * existed since 2026-07-26 read as absent. These pin the two things that changed: the fx are
 * anchored on the SHOOTER's drawn barrel tip, and the shot is reported back to that actor so
 * it can recoil.
 */
describe('EventReactor — a shot leaves the shooter, not the event position', () => {
  const SHOT = { type: 'bullet_fired', ownerId: 7, gx: pxToFp(100), gy: pxToFp(200), facing: 0 } as GameEvent;

  function shooter(muzzle: { x: number; y: number } | null) {
    return {
      onHurt: vi.fn(), onAttack: vi.fn(), muzzlePos: vi.fn(() => muzzle), x: 100, y: 200,
    };
  }

  function reactorWith(actor: ReturnType<typeof shooter> | undefined) {
    const fx = fakeFx();
    const host = { ...fakeHost(), actorAt: vi.fn(() => actor) };
    const hud = new HudView();
    hud.build(new Layers(), { w: 1280, h: 720 });
    return { fx, host, actor, reactor: new EventReactor(fx, hud, fakeAudio(), host) };
  }

  it('tells the shooter it fired, so the rig can recoil', () => {
    const actor = shooter({ x: 140, y: 150 });
    const { reactor, host } = reactorWith(actor);
    reactor.consume([SHOT]);
    expect(host.actorAt).toHaveBeenCalledWith(7);
    expect(actor.onAttack).toHaveBeenCalledWith('ranged');
    expect(actor.onAttack).toHaveBeenCalledTimes(1);
  });

  /**
   * The melee half (ENGINE_VERSION 52). Before `melee_swing` existed the render layer was never
   * told a swing happened at all: `deflect` fires only when a swing catches a bullet and `hit`
   * only when it connects, so swinging at empty air reached the view as nothing.
   */
  it('tells the swinger it swung, off the melee event, with the melee kind', () => {
    const SWING = { type: 'melee_swing', ownerId: 7, gx: pxToFp(100), gy: pxToFp(200), facing: 0 } as GameEvent;
    const actor = shooter(null);
    const { reactor, host } = reactorWith(actor);
    reactor.consume([SWING]);
    expect(host.actorAt).toHaveBeenCalledWith(7);
    expect(actor.onAttack).toHaveBeenCalledWith('melee', undefined);
  });

  it('a swing draws no muzzle fx and costs no cue — a blade has no muzzle', () => {
    // The reason this is its own case and not folded into the one above: the two events carry
    // IDENTICAL fields, so the easy mistake is to route the swing through the ranged branch and
    // get a muzzle flare, flame, shell casing and a gunshot cue out of a sword.
    const SWING = { type: 'melee_swing', ownerId: 7, gx: pxToFp(100), gy: pxToFp(200), facing: 0 } as GameEvent;
    const { reactor, fx } = reactorWith(shooter({ x: 140, y: 150 }));
    reactor.consume([SWING]);
    expect(fx.muzzleFlare).not.toHaveBeenCalled();
    expect(fx.particles.muzzleFlame).not.toHaveBeenCalled();
    expect(fx.particles.shellCasing).not.toHaveBeenCalled();
  });

  it('survives a swinger whose view is already gone', () => {
    const SWING = { type: 'melee_swing', ownerId: 7, gx: pxToFp(0), gy: pxToFp(0), facing: 0 } as GameEvent;
    const { reactor } = reactorWith(undefined);
    expect(() => reactor.consume([SWING])).not.toThrow();
  });

  it('a swing plays its OWN cue, never the gunshot', () => {
    // This case used to assert the opposite — that a swing made no sound at all — and said in
    // its own comment that authoring a swing cue is what would change it. That happened
    // 2026-09-02. What it is pinning is unchanged and is the part that matters: `melee_swing`
    // and `bullet_fired` carry identical fields, so routing a swing through the ranged branch
    // would hand a sword the `muzzle` cue and nothing would look wrong.
    const SWING = { type: 'melee_swing', ownerId: 7, gx: pxToFp(0), gy: pxToFp(0), facing: 0 } as GameEvent;
    const audio = fakeAudio();
    const hud = new HudView();
    hud.build(new Layers(), { w: 1280, h: 720 });
    const host = { ...fakeHost(), actorAt: vi.fn(() => shooter({ x: 1, y: 2 })) };
    new EventReactor(fakeFx(), hud, audio, host).consume([SWING]);
    expect(audio.play).toHaveBeenCalledWith('swing', 1);
    expect(audio.play).toHaveBeenCalledTimes(1);
  });

  it('lands on the swinger the event names, not on whoever swung last', () => {
    // `actorAt(e.ownerId)` — the same resolution the ranged branch does. In a PvP arena eight
    // players can swing on one tick, and a dropped `ownerId` would animate one of them eight times.
    const a = shooter(null), b = shooter(null);
    const byId = new Map([[7, a], [9, b]]);
    const host = { ...fakeHost(), actorAt: vi.fn((id: number) => byId.get(id)) };
    const hud = new HudView();
    hud.build(new Layers(), { w: 1280, h: 720 });
    new EventReactor(fakeFx(), hud, fakeAudio(), host).consume([
      { type: 'melee_swing', ownerId: 9, gx: pxToFp(0), gy: pxToFp(0), facing: 0 } as GameEvent,
    ]);
    // `undefined` is the second argument: `fakeHost().activeState()` is null, so no weapon can
    // be resolved and the rig falls back to `DEFAULT_SWING`. The weapon-carrying path has its
    // own block at the bottom of this file.
    expect(b.onAttack).toHaveBeenCalledWith('melee', undefined);
    expect(a.onAttack).not.toHaveBeenCalled();
  });

  it('anchors flare, sparks and casing on the DRAWN barrel tip — all three at the same point', () => {
    const actor = shooter({ x: 140, y: 150 });
    const { reactor, fx } = reactorWith(actor);
    reactor.consume([SHOT]);
    expect(fx.muzzleFlare).toHaveBeenCalledWith(140, 150, 0, expect.any(Number));
    expect(fx.particles.muzzleFlame).toHaveBeenCalledWith(140, 150, 0, expect.any(Number));
    expect(fx.particles.shellCasing).toHaveBeenCalledWith(140, 150, 0);
  });

  it('points the flare along the shot, not along a fixed direction', () => {
    const actor = shooter({ x: 0, y: 0 });
    const { reactor, fx } = reactorWith(actor);
    reactor.consume([{ ...SHOT, facing: 16384 } as GameEvent]); // a quarter turn in brad
    const angle = (fx.muzzleFlare as unknown as ReturnType<typeof vi.fn>).mock.calls[0]![2];
    expect(angle).toBeCloseTo(Math.PI / 2, 6);
  });

  // A skin that mounts no module at all (design/13's boss), one still on the Graphics
  // placeholder, and the frames before a weapon texture finishes preloading all report null.
  // Those must keep the pre-2026-08-30 behaviour rather than bursting at the origin.
  it('falls back to the sim position (lifted 12 px) when the skin mounts no weapon', () => {
    const { reactor, fx } = reactorWith(shooter(null));
    reactor.consume([SHOT]);
    expect(fx.muzzleFlare).toHaveBeenCalledWith(100, 200 - 12, 0, expect.any(Number));
    expect(fx.particles.shellCasing).toHaveBeenCalledWith(100, 200 - 12, 0);
  });

  it('still fires the fx when the shooter’s view is already gone', () => {
    const { reactor, fx } = reactorWith(undefined);
    expect(() => reactor.consume([SHOT])).not.toThrow();
    expect(fx.muzzleFlare).toHaveBeenCalledWith(100, 200 - 12, 0, expect.any(Number));
  });
});

/**
 * A shotgun volley — `SCATTERGUN_SIM` emits one `bullet_fired` PER PELLET in a single frame,
 * all from one actor (`engine/systems/ballistics.test.ts` pins that end). Worth its own test
 * because it is the only shape where the three reactions this handler runs disagree about
 * counting: the recoil must fire per pellet (each one restarts the same envelope, which is what
 * a fast weapon should look like), the fx must be per pellet, and the AUDIO must coalesce to
 * one cue carrying the count — design/11's "ten hits in one frame are one impact at higher
 * gain, not ten impacts".
 */
describe('EventReactor — a multi-pellet volley in one frame', () => {
  it('recoils and flares per pellet, but plays exactly one muzzle cue carrying the count', () => {
    const actor = { onHurt: vi.fn(), onAttack: vi.fn(), muzzlePos: vi.fn(() => ({ x: 12, y: 34 })), x: 0, y: 0 };
    const fx = fakeFx();
    const audio = fakeAudio();
    const hud = new HudView();
    hud.build(new Layers(), { w: 1280, h: 720 });
    const reactor = new EventReactor(fx, hud, audio, { ...fakeHost(), actorAt: vi.fn(() => actor) });

    const volley = [0, 1, 2, 3, 4].map((i) => ({
      type: 'bullet_fired', ownerId: 3, gx: pxToFp(0), gy: pxToFp(0), facing: 1000 * i,
    }) as GameEvent);
    reactor.consume(volley);

    expect(actor.onAttack).toHaveBeenCalledTimes(5);
    expect(fx.muzzleFlare).toHaveBeenCalledTimes(5);
    expect(audio.play).toHaveBeenCalledTimes(1);
    expect(audio.play).toHaveBeenCalledWith('muzzle', 5);
  });
});

/**
 * The melee sector arc's WIRING (2026-09-02). `fx/slashArc.test.ts` owns the geometry; what is
 * asserted here is the translation, which is the half that can silently be wrong: the event
 * carries no weapon, so this reactor resolves the swinger's spec out of `GameState` and converts
 * brad→rad, fp→px and ticks→ms on the way to the fx. Every one of those conversions is a place a
 * plausible-looking arc can end up at the wrong size.
 */
describe('EventReactor — the melee swing carries the weapon that swung', () => {
  const SABER = WEAPON_SIM_BY_ID.saber as MeleeSimSpec;
  const HAMMER = WEAPON_SIM_BY_ID.hammer as MeleeSimSpec;
  const SPEAR = WEAPON_SIM_BY_ID.spear as MeleeSimSpec;

  /** A state holding one player at `id` with `spec` equipped — the narrow slice `meleeSwinger`
   *  reads (`players[].id/radius/weapon.spec`), faked rather than driven through a real engine
   *  because what is under test is the translation, not the sim. */
  function stateWith(id: number, spec: MeleeSimSpec | undefined): GameState {
    return {
      players: [{ id, radius: pxToFp(16), weapon: spec ? { spec } : null }],
    } as unknown as GameState;
  }

  function swingWith(spec: MeleeSimSpec | undefined, facing = 0) {
    const fx = fakeFx();
    const actor = { onHurt: vi.fn(), onAttack: vi.fn(), muzzlePos: vi.fn(() => null), x: 100, y: 200 };
    const host = {
      ...fakeHost(),
      activeState: () => stateWith(7, spec),
      actorAt: vi.fn(() => actor),
    };
    const hud = new HudView();
    hud.build(new Layers(), { w: 1280, h: 720 });
    new EventReactor(fx, hud, fakeAudio(), host).consume([
      { type: 'melee_swing', ownerId: 7, gx: pxToFp(80), gy: pxToFp(120), facing } as GameEvent,
    ]);
    const pose = (fx.slashArc as unknown as { mock: { calls: [SlashArcPose][] } }).mock.calls[0]?.[0];
    return { fx, actor, pose };
  }

  it('draws the arc at the weapon own sector and reach, not at a constant', () => {
    const { pose } = swingWith(SABER);
    // 162° authored → 81° each side, and 1.44 grid → 46 px. Both restated from
    // `weaponSpecs/starter.ts` rather than recomputed from the spec, so a spec change has to be
    // acknowledged here instead of the assertion following it silently.
    expect(pose!.arcHalfRad).toBeCloseTo((81 * Math.PI) / 180, 3);
    expect(pose!.outerPx).toBeCloseTo(46, 0);
    expect(pose!.innerPx).toBeCloseTo(16, 6); // the actor's own radius — the arc's inner edge
  });

  it('gives the hammer a wider arc and the spear a longer reach — the specs, not the animation', () => {
    // The two extremes of the roster, and the concrete statement of what this pass fixed: they
    // used to be drawn identically.
    const hammer = swingWith(HAMMER).pose!;
    const spear = swingWith(SPEAR).pose!;
    expect(hammer.arcHalfRad).toBeGreaterThan(spear.arcHalfRad * 3);
    expect(spear.outerPx).toBeGreaterThan(hammer.outerPx);
  });

  it('anchors the arc on the SIM swing origin, lifted to blade height', () => {
    // Not on the drawn body (which `muzzleFlare` uses): `meleeArc` measures `range` from the
    // actor's own gx/gy, and this fx exists to agree with the hit test.
    const { pose } = swingWith(SABER);
    expect(pose!.x).toBeCloseTo(80, 6);
    expect(pose!.y).toBeCloseTo(120 - 12, 6);
  });

  it('sweeps with the mirrored body when the swing points left', () => {
    expect(swingWith(SABER, 0).pose!.flipX).toBe(1);
    // Half a turn in brad — `facingFromAngle` reads the cosine's sign, so this is the mirror case.
    expect(swingWith(SABER, 32768).pose!.flipX).toBe(-1);
  });

  it('tints the arc by element, and falls back to the blade glow for physical', () => {
    expect(swingWith(SABER).pose!.color).toBe(THEME.colors.swordGlow); // the saber is physical
    expect(swingWith(WEAPON_SIM_BY_ID.emberblade as MeleeSimSpec).pose!.color)
      .toBe(THEME.colors.statusBurn);
  });

  it('schedules the arc inside the strike window of that weapon own envelope', () => {
    const { pose } = swingWith(SABER);
    // The saber's ACTIVE hit window (4 ticks), not its 11-tick recovery — ENGINE_VERSION 53.
    const schedule = swingSchedule({ arcDeg: 162, windowMs: (4 * 1000) / 30 });
    expect(pose!.delayMs).toBeCloseTo(schedule.strikeStartMs, 6);
    expect(pose!.sweepMs).toBeCloseTo(schedule.strikeEndMs - schedule.strikeStartMs, 6);
    // The whole fx has to be gone before the next swing of a held trigger starts one.
    expect(pose!.delayMs + pose!.sweepMs + pose!.fadeMs).toBeLessThan((11 * 1000) / 30);
  });

  it('hands the rig the same weapon shape it hands the arc', () => {
    // One spec, two consumers. If these ever disagreed the blade and the light on the ground
    // would sweep different arcs at different speeds, and each on its own would look fine.
    const { actor } = swingWith(HAMMER);
    const shape = (actor.onAttack as unknown as { mock: { calls: [string, SwingShape][] } })
      .mock.calls[0]![1]!;
    expect(shape.arcDeg).toBeCloseTo(220, 0);
    // The hammer's 6-tick window, not its 20-tick recovery (ENGINE_VERSION 53). Both consumers
    // read the same field off the same spec, so this is what keeps them in step.
    expect(shape.windowMs).toBeCloseTo((6 * 1000) / 30, 0);
  });

  it('animates but draws no sector for a swinger whose weapon cannot be resolved', () => {
    // The normal case for an enemy: `meleeArc` only runs over `state.players`, and no enemy in
    // the roster carries a melee weapon. The clip and the cue must still fire — a swing that
    // animates nothing is worse than one drawn at a default size.
    const { fx, actor } = swingWith(undefined);
    expect(actor.onAttack).toHaveBeenCalledWith('melee', undefined);
    expect(fx.slashArc).not.toHaveBeenCalled();
  });

  it('draws no sector on a menu frame draining a stale swing', () => {
    // `activeState()` is null between runs, and the same queue is drained there.
    const fx = fakeFx();
    const hud = new HudView();
    hud.build(new Layers(), { w: 1280, h: 720 });
    new EventReactor(fx, hud, fakeAudio(), fakeHost()).consume([
      { type: 'melee_swing', ownerId: 7, gx: pxToFp(0), gy: pxToFp(0), facing: 0 } as GameEvent,
    ]);
    expect(fx.slashArc).not.toHaveBeenCalled();
  });
});
