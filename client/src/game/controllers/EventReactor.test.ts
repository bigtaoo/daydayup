/**
 * EventReactor (design/08 "events are the only engine→render channel"). Only the
 * toast-text side is asserted here (design/17-i18n.md migrated it to `t()`) — fx/audio
 * are exercised incidentally via real `FxController`/fake `AudioBus` so `consume()`
 * doesn't throw, same "construct real Pixi widgets under plain vitest" convention as
 * HudView.test.ts.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import type { GameEvent } from '@dd/engine';
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
    onWeaponPickup: vi.fn(),
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

  it('an unrecognized weapon id falls back to "New weapon"', () => {
    const { reactor, toast } = newReactor();
    reactor.consume([{ ...PICKUP_BASE, kind: 'weapon', weaponId: 'no-such-weapon' }] as GameEvent[]);
    expect(toast).toHaveBeenCalledWith('New weapon', expect.anything());
  });

  it('a named buff toasts "Buff: {id}"; an unnamed one toasts the generic label', () => {
    const { reactor, toast } = newReactor();
    reactor.consume([{ ...PICKUP_BASE, kind: 'buff', buffId: 'crit_surge' }] as GameEvent[]);
    expect(toast).toHaveBeenCalledWith('Buff: crit_surge', expect.anything());
    toast.mockClear();
    reactor.consume([{ ...PICKUP_BASE, kind: 'buff' }] as GameEvent[]);
    expect(toast).toHaveBeenCalledWith('Buff', expect.anything());
  });

  it('a material pickup toasts "+{qty} {materialId}", defaulting qty to 1 and the id to "material"', () => {
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
