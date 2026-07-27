import { describe, it, expect } from 'vitest';
import { computeFloorProgress } from './floorProgressMath';

describe('computeFloorProgress (design/10 PvE progress track)', () => {
  it('a non-dungeon config (stageCount 0) produces no steps — the widget hides', () => {
    expect(computeFloorProgress(0, -1)).toEqual([]);
  });

  it('before the first room loads (roomIndex -1), every stage is upcoming', () => {
    const steps = computeFloorProgress(3, -1);
    expect(steps.map((s) => s.status)).toEqual(['upcoming', 'upcoming', 'upcoming']);
  });

  it('marks stages before roomIndex done, roomIndex itself current, the rest upcoming', () => {
    const steps = computeFloorProgress(4, 2);
    expect(steps.map((s) => s.status)).toEqual(['done', 'done', 'current', 'upcoming']);
  });

  it('the LAST stage is always the capstone, regardless of stage count or progress', () => {
    expect(computeFloorProgress(1, 0).map((s) => s.capstone)).toEqual([true]);
    expect(computeFloorProgress(5, 4).map((s) => s.capstone)).toEqual([false, false, false, false, true]);
  });

  it('at the capstone itself, status is current and capstone is true simultaneously', () => {
    const steps = computeFloorProgress(3, 2);
    expect(steps[2]).toEqual({ index: 2, status: 'current', capstone: true });
  });
});
