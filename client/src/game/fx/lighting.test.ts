import { describe, it, expect } from 'vitest';
import { LightRegistry, makeLightBuffer, type ActiveLight } from './lighting';

/** Snapshot into a fresh buffer of `size` slots, returning only the written entries. */
function snap(lights: LightRegistry, size = 8): ActiveLight[] {
  const buf = makeLightBuffer(size);
  return buf.slice(0, lights.snapshot(buf));
}

describe('LightRegistry', () => {
  it('reports nothing when nothing is registered', () => {
    expect(snap(new LightRegistry())).toEqual([]);
  });

  it('addPersistent replaces the same id in place rather than accumulating', () => {
    const lights = new LightRegistry();
    lights.addPersistent('local', { x: 0, y: 0, color: 0xffffff, radius: 100, intensity: 1 });
    lights.addPersistent('local', { x: 50, y: 0, color: 0xffffff, radius: 100, intensity: 1 });
    const out = snap(lights);
    expect(out).toHaveLength(1);
    expect(out[0]!.x).toBe(50);
  });

  it('hands the shader position and radius untouched — falloff is now per-texel, not per-actor', () => {
    // The old `strongestAt(x, y)` collapsed a light to one direction and one already-faded
    // intensity AT AN ACTOR'S CENTRE. The pass shading the whole layer has each texel's own
    // world position, so distance falloff belongs there and this layer must not pre-apply it.
    const lights = new LightRegistry();
    lights.addPersistent('a', { x: 50, y: -20, color: 0x66e0ff, radius: 100, intensity: 1 });
    expect(snap(lights)[0]).toEqual({ x: 50, y: -20, color: 0x66e0ff, radius: 100, intensity: 1 });
  });

  it('keeps a light whose radius does not reach the player — the shader decides what it touches', () => {
    // Under `strongestAt` a far light returned null and simply vanished. Now it is still a
    // real light in the world; whether any given texel sees it is a per-texel question.
    const lights = new LightRegistry();
    lights.addPersistent('a', { x: 100_000, y: 0, color: 0xffffff, radius: 50, intensity: 1 });
    expect(snap(lights)).toHaveLength(1);
  });

  it('drops a light with no radius or no intensity, which could never contribute', () => {
    const lights = new LightRegistry();
    lights.addPersistent('noRadius', { x: 0, y: 0, color: 0xffffff, radius: 0, intensity: 1 });
    lights.addPersistent('noPower', { x: 0, y: 0, color: 0xffffff, radius: 100, intensity: 0 });
    expect(snap(lights)).toEqual([]);
  });

  it('addTransient fades over its lifetime and expires after update()', () => {
    const lights = new LightRegistry();
    lights.addTransient({ x: 0, y: 0, color: 0xff0000, radius: 100, intensity: 1 }, 200);
    expect(snap(lights)[0]!.intensity).toBeCloseTo(1);
    lights.update(100); // halfway through its life
    expect(snap(lights)[0]!.intensity).toBeCloseTo(0.5);
    lights.update(101); // past its lifetime
    expect(snap(lights)).toEqual([]);
  });

  it('removePersistent drops a light immediately', () => {
    const lights = new LightRegistry();
    lights.addPersistent('a', { x: 0, y: 0, color: 0xffffff, radius: 100, intensity: 1 });
    lights.removePersistent('a');
    expect(snap(lights)).toEqual([]);
  });

  it('clear() drops both persistent and transient lights', () => {
    const lights = new LightRegistry();
    lights.addPersistent('a', { x: 0, y: 0, color: 0xffffff, radius: 100, intensity: 1 });
    lights.addTransient({ x: 0, y: 0, color: 0xffffff, radius: 100, intensity: 1 }, 200);
    lights.clear();
    expect(snap(lights)).toEqual([]);
  });
});

describe('LightRegistry.snapshot', () => {
  it('orders strongest first', () => {
    const lights = new LightRegistry();
    lights.addPersistent('dim', { x: 0, y: 0, color: 0x111111, radius: 100, intensity: 0.2 });
    lights.addPersistent('bright', { x: 0, y: 0, color: 0xffaa00, radius: 100, intensity: 2 });
    lights.addPersistent('mid', { x: 0, y: 0, color: 0x00ff00, radius: 100, intensity: 1 });
    expect(snap(lights).map((l) => l.color)).toEqual([0xffaa00, 0x00ff00, 0x111111]);
  });

  it('keeps the strongest when there are more lights than slots', () => {
    // The shader has a fixed slot count and a busy fight registers one transient per impact,
    // so this cap is reachable in real play. Dropping the WEAKEST is the point — an
    // almost-expired impact flash is what should lose.
    const lights = new LightRegistry();
    for (let i = 1; i <= 6; i++) {
      lights.addPersistent(`l${i}`, { x: i, y: 0, color: 0xffffff, radius: 100, intensity: i / 10 });
    }
    const out = snap(lights, 3);
    expect(out).toHaveLength(3);
    expect(out.map((l) => l.intensity)).toEqual([0.6, 0.5, 0.4]);
  });

  it('ranks a faded transient below a steady light of the same registered intensity', () => {
    // The fade has to be folded in BEFORE the ranking, or a dying flash outranks the
    // player's own glow purely because its authored number is larger.
    const lights = new LightRegistry();
    lights.addPersistent('glow', { x: 0, y: 0, color: 0x00ff00, radius: 100, intensity: 0.5 });
    lights.addTransient({ x: 0, y: 0, color: 0xff0000, radius: 100, intensity: 1 }, 100);
    lights.update(80); // 20% of its life left -> effective 0.2
    expect(snap(lights).map((l) => l.color)).toEqual([0x00ff00, 0xff0000]);
  });

  it('reuses the caller buffer without allocating, and leaves stale slots past the count', () => {
    // It runs every render frame; a fresh array per frame is exactly the churn the whole
    // move away from per-actor filters was about.
    const lights = new LightRegistry();
    lights.addPersistent('a', { x: 7, y: 8, color: 0x123456, radius: 30, intensity: 0.9 });
    lights.addPersistent('b', { x: 1, y: 2, color: 0x654321, radius: 40, intensity: 0.1 });
    const buf = makeLightBuffer(4);
    const slots = [...buf];
    expect(lights.snapshot(buf)).toBe(2);
    // Same objects, written in place.
    expect(buf.every((s, i) => s === slots[i])).toBe(true);
    lights.removePersistent('b');
    expect(lights.snapshot(buf)).toBe(1);
    // Slot 1 still holds last frame's data — the COUNT is what bounds the read, and the
    // filter's `setLights` honours it. A test that only checked slot 0 would not catch a
    // consumer that ignored the count.
    expect(buf[1]!.color).toBe(0x654321);
  });

  it('handles a zero-length buffer without throwing', () => {
    const lights = new LightRegistry();
    lights.addPersistent('a', { x: 0, y: 0, color: 0xffffff, radius: 100, intensity: 1 });
    expect(lights.snapshot([])).toBe(0);
  });
});
