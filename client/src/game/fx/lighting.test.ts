import { describe, it, expect } from 'vitest';
import { LightRegistry } from './lighting';

describe('LightRegistry', () => {
  it('reports null when nothing is registered', () => {
    const lights = new LightRegistry();
    expect(lights.strongestAt(0, 0)).toBeNull();
  });

  it('addPersistent replaces the same id in place rather than accumulating', () => {
    const lights = new LightRegistry();
    lights.addPersistent('local', { x: 0, y: 0, color: 0xffffff, radius: 100, intensity: 1 });
    lights.addPersistent('local', { x: 50, y: 0, color: 0xffffff, radius: 100, intensity: 1 });
    const hit = lights.strongestAt(50, 0);
    expect(hit).not.toBeNull();
    expect(hit!.intensity).toBeCloseTo(1); // right on top of the (moved) light — no falloff
  });

  it('falls off with distance and returns a normalized direction toward the light', () => {
    const lights = new LightRegistry();
    // Halfway to the light's radius — falloff should sit at ~0.5, not full intensity.
    lights.addPersistent('a', { x: 50, y: 0, color: 0x66e0ff, radius: 100, intensity: 1 });
    const hit = lights.strongestAt(0, 0);
    expect(hit).not.toBeNull();
    expect(hit!.dirX).toBeCloseTo(1);
    expect(hit!.dirY).toBeCloseTo(0);
    expect(hit!.intensity).toBeCloseTo(0.5);
    expect(hit!.color).toBe(0x66e0ff);
  });

  it('picks up nothing past its own radius', () => {
    const lights = new LightRegistry();
    lights.addPersistent('a', { x: 1000, y: 0, color: 0xffffff, radius: 50, intensity: 1 });
    expect(lights.strongestAt(0, 0)).toBeNull();
  });

  it('picks the strongest of several candidates, not just the nearest', () => {
    const lights = new LightRegistry();
    // Near but dim.
    lights.addPersistent('dim', { x: 10, y: 0, color: 0x111111, radius: 100, intensity: 0.05 });
    // Farther but much brighter — should win.
    lights.addPersistent('bright', { x: 80, y: 0, color: 0xffaa00, radius: 100, intensity: 5 });
    const hit = lights.strongestAt(0, 0);
    expect(hit!.color).toBe(0xffaa00);
  });

  it('addTransient fades out over its lifetime and expires after update()', () => {
    const lights = new LightRegistry();
    lights.addTransient({ x: 0, y: 0, color: 0xff0000, radius: 100, intensity: 1 }, 200);
    const full = lights.strongestAt(0, 0)!.intensity;
    lights.update(100); // halfway through its life
    const half = lights.strongestAt(0, 0)!.intensity;
    expect(half).toBeLessThan(full);
    expect(half).toBeGreaterThan(0);
    lights.update(101); // past its lifetime
    expect(lights.strongestAt(0, 0)).toBeNull();
  });

  it('removePersistent drops a light immediately', () => {
    const lights = new LightRegistry();
    lights.addPersistent('a', { x: 0, y: 0, color: 0xffffff, radius: 100, intensity: 1 });
    lights.removePersistent('a');
    expect(lights.strongestAt(0, 0)).toBeNull();
  });

  it('clear() drops both persistent and transient lights', () => {
    const lights = new LightRegistry();
    lights.addPersistent('a', { x: 0, y: 0, color: 0xffffff, radius: 100, intensity: 1 });
    lights.addTransient({ x: 0, y: 0, color: 0xffffff, radius: 100, intensity: 1 }, 200);
    lights.clear();
    expect(lights.strongestAt(0, 0)).toBeNull();
  });
});
