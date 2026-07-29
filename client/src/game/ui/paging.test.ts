import { describe, it, expect } from 'vitest';
import { pageCount, pageStartForIndex, clampPageStart, wrapIndex } from './paging';

describe('pageCount', () => {
  it('divides evenly when total is an exact multiple of pageSize', () => {
    expect(pageCount(16, 8)).toBe(2);
  });

  it('rounds up a partial last page', () => {
    expect(pageCount(22, 8)).toBe(3); // the actual BLUEPRINT_CATALOG size that found this bug
  });

  it('is always at least 1, even for an empty list', () => {
    expect(pageCount(0, 8)).toBe(1);
  });

  it('a single item is still exactly 1 page', () => {
    expect(pageCount(1, 8)).toBe(1);
  });
});

describe('pageStartForIndex', () => {
  it('floors to the containing page boundary', () => {
    expect(pageStartForIndex(0, 8)).toBe(0);
    expect(pageStartForIndex(7, 8)).toBe(0);
    expect(pageStartForIndex(8, 8)).toBe(8);
    expect(pageStartForIndex(21, 8)).toBe(16);
  });
});

describe('clampPageStart', () => {
  it('advances by a whole page per +1 delta', () => {
    expect(clampPageStart(0, 1, 22, 8)).toBe(8);
    expect(clampPageStart(8, 1, 22, 8)).toBe(16);
  });

  it('does not advance past the last page (a partial final page)', () => {
    expect(clampPageStart(16, 1, 22, 8)).toBe(16); // already on the last page (2/3)
  });

  it('does not retreat before page 0', () => {
    expect(clampPageStart(0, -1, 22, 8)).toBe(0);
  });

  it('a single-page list never moves regardless of direction', () => {
    expect(clampPageStart(0, 1, 5, 8)).toBe(0);
    expect(clampPageStart(0, -1, 5, 8)).toBe(0);
  });
});

describe('wrapIndex', () => {
  it('wraps forward past the end back to 0', () => {
    expect(wrapIndex(21, 1, 22)).toBe(0);
  });

  it('wraps backward past 0 to the last index', () => {
    expect(wrapIndex(0, -1, 22)).toBe(21);
  });

  it('moves normally within bounds', () => {
    expect(wrapIndex(8, -1, 22)).toBe(7);
    expect(wrapIndex(8, 1, 22)).toBe(9);
  });

  it('returns 0 for an empty list instead of dividing by zero', () => {
    expect(wrapIndex(0, 1, 0)).toBe(0);
    expect(wrapIndex(5, -3, 0)).toBe(0);
  });
});
