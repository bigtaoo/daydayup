/**
 * EventReactor (design/08 "events are the only engine→render channel"). Only the
 * toast-text side is asserted here (design/17-i18n.md migrated it to `t()`) — fx/audio
 * are exercised incidentally via real `FxController`/fake `AudioBus` so `consume()`
 * doesn't throw, same "construct real Pixi widgets under plain vitest" convention as
 * HudView.test.ts.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { pxToFp, type GameEvent, type GameState } from '@dd/engine';
import { EventReactor, type EventReactorHost } from './EventReactor';
import type { FxController } from '../fx/FxController';
import { HudView } from '../ui/HudView';
import { Layers } from '../scene/layers';
import type { AudioBus } from '../../platform/types';
import { setLocale, resetLocaleForTests } from '../../i18n';

// `FxController`'s real constructor builds WebGL filters (VignetteFilter/
// ChromaticAberrationFilter), which need an actual `document`/GL context this repo's
// plain-node vitest doesn't have (see FxController.ts) — a minimal fake covering only
// the methods EventReactor.consume() actually calls is the same "avoid a real renderer"
// convention every other screen test here already uses for Pixi Text/Container.
function fakeFx(): FxController {
  return {
    flash: vi.fn(),
    addShake: vi.fn(),
    addHitStop: vi.fn(),
    pulseChromatic: vi.fn(),
    particles: { muzzleFlame: vi.fn(), shellCasing: vi.fn(), explosionDebris: vi.fn() },
  } as unknown as FxController;
}

function fakeAudio(): AudioBus {
  return { play: vi.fn(), setSfxVolume: vi.fn(), setMusicVolume: vi.fn(), resume: vi.fn() };
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
    const hitFlash = vi.fn();
    const host = fakeHost();
    (host.actorAt as ReturnType<typeof vi.fn>).mockReturnValue({ hitFlash });
    const reactor = new EventReactor(fakeFx(), hud, fakeAudio(), host);
    reactor.consume([{ type: 'hit', target: 7, faction: 'player', gx: 0, gy: 0, damage: 1, damageType: 'physical' } as GameEvent]);
    expect(host.actorAt).toHaveBeenCalledWith(7);
    expect(hitFlash).toHaveBeenCalled();
  });

  // 2026-08-26. The shield shell dents where the hit LANDED (`EnergyShieldFilter.hit`), which
  // makes the delta this passes a load-bearing value rather than a decoration. It is also
  // completely invisible when wrong: a sign flip dents the far side, and "the shield deformed"
  // still reads as correct on screen. Nothing else in the suite covers this — the mutation
  // battery for the rewrite only mutates the shader and the tile, never this file.
  describe('hands the shell the direction the hit came from', () => {
    const fire = (target: { hitFlash: ReturnType<typeof vi.fn>; x: number; y: number }, gx: number, gy: number) => {
      const hud = new HudView();
      hud.build(new Layers(), { w: 1280, h: 720 });
      const host = fakeHost();
      (host.actorAt as ReturnType<typeof vi.fn>).mockReturnValue(target);
      new EventReactor(fakeFx(), hud, fakeAudio(), host).consume([
        { type: 'hit', target: 7, faction: 'player', gx, gy, damage: 1, damageType: 'physical' } as GameEvent,
      ]);
      return target.hitFlash.mock.calls[0] as [number, number];
    };
    // The actor is deliberately NOT at the origin: with it at (0,0) an implementation that
    // forwarded the impact's absolute position instead of the delta would produce the same
    // vector, and this whole describe would pass against it.
    const AT = { x: 300, y: 200 };

    it('points from the actor toward the impact, not the other way', () => {
      const t = { hitFlash: vi.fn(), ...AT };
      // Impact one grid to the RIGHT of the actor: 300px is 9.375 grid, +1 grid = 332px.
      const [dx, dy] = fire(t, pxToFp(332), pxToFp(200));
      expect(dx).toBeGreaterThan(0);
      expect(Math.abs(dy)).toBeLessThan(1e-6);
    });

    it('flips with the impact side', () => {
      const right = fire({ hitFlash: vi.fn(), ...AT }, pxToFp(332), pxToFp(200));
      const left = fire({ hitFlash: vi.fn(), ...AT }, pxToFp(268), pxToFp(200));
      expect(Math.sign(right[0])).toBe(1);
      expect(Math.sign(left[0])).toBe(-1);
      expect(right[0]).toBeCloseTo(-left[0], 6); // symmetric about the actor
    });

    it('is a DELTA from the actor, not the impact position', () => {
      const t = { hitFlash: vi.fn(), ...AT };
      const [dx, dy] = fire(t, pxToFp(332), pxToFp(232));
      expect(dx).toBeCloseTo(32, 6);
      expect(dy).toBeCloseTo(32, 6);
    });

    it('uses screen-down y, so a hit from below dents the bottom of the shell', () => {
      const t = { hitFlash: vi.fn(), ...AT };
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
    const state = {} as GameState;
    host.activeState = () => state;
    const reactor = new EventReactor(fakeFx(), hud, fakeAudio(), host);
    reactor.consume([{ type: 'door_locked', roomId: 'r1' } as GameEvent]);
    expect(host.onDoorStateChange).toHaveBeenCalledWith(state);
  });

  it('door_unlocked does the same', () => {
    const hud = new HudView();
    hud.build(new Layers(), { w: 1280, h: 720 });
    const host = fakeHost();
    const state = {} as GameState;
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
