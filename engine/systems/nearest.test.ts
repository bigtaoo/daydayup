/**
 * nearestByPosition (design/08 array-order determinism) — the shared squared-
 * distance search consolidated out of 4 hand-rolled copies (see the module's own
 * doc comment). Exercised transitively via targeting.ts/HitResolveSystem/
 * CommandBuilder today; this is the focused, direct coverage of the generic
 * search itself: reach cutoff, exclude, and both tie-break directions.
 */
import { describe, it, expect } from 'vitest';
import { nearestByPosition } from '@dd/engine/systems/nearest';

interface Point {
  gx: number;
  gy: number;
  id: string;
}

const pt = (id: string, gx: number, gy: number): Point => ({ id, gx, gy });

describe('nearestByPosition — basic search', () => {
  it('returns null for an empty candidate list', () => {
    expect(nearestByPosition(0, 0, [])).toBeNull();
  });

  it('picks the candidate with the smallest squared distance', () => {
    const near = pt('near', 3, 0);
    const far = pt('far', 100, 0);
    expect(nearestByPosition(0, 0, [far, near])).toBe(near);
  });

  it('measures from the given origin, not from (0,0)', () => {
    const a = pt('a', 0, 0);
    const b = pt('b', 100, 100);
    // Origin sits right next to b, far from a.
    expect(nearestByPosition(95, 100, [a, b])).toBe(b);
  });
});

describe('nearestByPosition — exclude', () => {
  it('skips the excluded candidate even if it is the closest', () => {
    const closest = pt('closest', 1, 0);
    const next = pt('next', 5, 0);
    expect(nearestByPosition(0, 0, [closest, next], { exclude: closest })).toBe(next);
  });

  it('returns null when the only candidate is excluded', () => {
    const only = pt('only', 1, 0);
    expect(nearestByPosition(0, 0, [only], { exclude: only })).toBeNull();
  });
});

describe('nearestByPosition — reachSq cutoff', () => {
  it('excludes a candidate strictly beyond reachSq', () => {
    const inReach = pt('inReach', 5, 0); // distSq = 25
    const outOfReach = pt('outOfReach', 20, 0); // distSq = 400
    const result = nearestByPosition(0, 0, [inReach, outOfReach], { reachSq: 100 });
    expect(result).toBe(inReach);
  });

  it('includes a candidate exactly AT the reachSq boundary (inclusive cutoff)', () => {
    const onBoundary = pt('onBoundary', 10, 0); // distSq = 100, reachSq = 100
    expect(nearestByPosition(0, 0, [onBoundary], { reachSq: 100 })).toBe(onBoundary);
  });

  it('returns null when every candidate is out of reach', () => {
    const far = pt('far', 50, 0);
    expect(nearestByPosition(0, 0, [far], { reachSq: 10 })).toBeNull();
  });

  it('defaults to an unlimited reach (Infinity) when omitted', () => {
    const veryFar = pt('veryFar', 1_000_000, 0);
    expect(nearestByPosition(0, 0, [veryFar])).toBe(veryFar);
  });
});

describe('nearestByPosition — tie-break direction', () => {
  it('preferEarlier (default true): the FIRST-found candidate wins an exact tie', () => {
    const first = pt('first', 10, 0);
    const second = pt('second', 0, 10); // exact same squared distance from origin
    expect(nearestByPosition(0, 0, [first, second])).toBe(first);
    expect(nearestByPosition(0, 0, [first, second], { preferEarlier: true })).toBe(first);
  });

  it('preferEarlier: false — the LAST-found candidate wins an exact tie', () => {
    const first = pt('first', 10, 0);
    const second = pt('second', 0, 10);
    expect(nearestByPosition(0, 0, [first, second], { preferEarlier: false })).toBe(second);
  });

  it('a genuinely closer LATER candidate always wins regardless of preferEarlier', () => {
    const farFirst = pt('farFirst', 100, 0);
    const closeSecond = pt('closeSecond', 1, 0);
    expect(nearestByPosition(0, 0, [farFirst, closeSecond], { preferEarlier: true })).toBe(closeSecond);
    expect(nearestByPosition(0, 0, [farFirst, closeSecond], { preferEarlier: false })).toBe(closeSecond);
  });
});

describe('nearestByPosition — iterable input', () => {
  it('accepts any Iterable, not just arrays', () => {
    const a = pt('a', 5, 0);
    const b = pt('b', 1, 0);
    function* gen(): Generator<Point> {
      yield a;
      yield b;
    }
    expect(nearestByPosition(0, 0, gen())).toBe(b);
  });
});
