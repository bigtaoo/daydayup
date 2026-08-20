/**
 * `pickPassageStartGrid`'s own gate. The two placement functions that call it are
 * covered in `../dungeon.test.ts`, including the property this module exists for
 * (a drawn `passageGrid` lands on whole grid cells) swept over both paths — but
 * only for the room shapes those tests happen to use, and only for the anchor
 * indices those seeds happen to draw.
 *
 * The claims below are the ones the module's own doc comment makes and nothing
 * else checks: that the snap keeps a full cell of stone at BOTH ends of the band
 * (the perimeter wall's own thickness, so a carved gap is flush with the corner
 * block's inner face and never inside it), across every band length and every
 * anchor index rather than the handful a seed sweep reaches; that the fit
 * threshold is byte-for-byte what it was before the snap; and that the snap did
 * not quietly collapse `DOOR_ANCHOR_COUNT` candidates into fewer distinct
 * positions.
 */
import { describe, it, expect } from 'vitest';
import { Prng } from '../../math/prng';
import { pickPassageStartGrid } from './doorAnchor';
import { DOOR_ANCHOR_COUNT, DOOR_WIDTH_GRID } from './placementConstants';

/** A `Prng` that always hands back a chosen anchor index, so a test can address a
 * specific candidate instead of hunting for a seed that draws it. Clamps into the
 * offered range, since a minimal band offers exactly one candidate. */
class FixedAnchor extends Prng {
  constructor(private readonly idx: number) {
    super(1);
  }
  override nextInt(max: number): number {
    return Math.min(this.idx, max - 1);
  }
}

class CountingPrng extends Prng {
  calls = 0;
  override nextInt(max: number): number {
    this.calls++;
    return super.nextInt(max);
  }
}

const ANCHORS = Array.from({ length: DOOR_ANCHOR_COUNT }, (_, i) => i);

describe('pickPassageStartGrid (ENGINE_VERSION 44)', () => {
  /**
   * 6 must fail and 7 must fit, hardcoded on purpose — NOT recomputed from
   * `DOOR_EDGE_MARGIN_GRID`, which would make this test agree with any value the
   * constant is later changed to and catch nothing. These two facts are what
   * forced the margin to stay at 1.5 through the grid-snap fix: an integer margin
   * of 1 lets a 6-cell band fit a door (it must not), and 2 stops an 8-cell band
   * offering more than one anchor (`../dungeon.test.ts` pins that it must, for
   * `HALL`/`NARROW`). Snapping the OUTPUT is what avoids that trade, so the
   * threshold has to be provably untouched by it.
   */
  it('returns null exactly when the shared band is too short — the same threshold as before the snap', () => {
    for (const idx of ANCHORS) {
      for (const tooShort of [0, 1, 5, 6]) {
        expect(pickPassageStartGrid(0, tooShort, new FixedAnchor(idx)), `band of ${tooShort}`).toBeNull();
      }
      for (const fits of [7, 8, 15, 20]) {
        expect(pickPassageStartGrid(0, fits, new FixedAnchor(idx)), `band of ${fits}`).not.toBeNull();
      }
    }
  });

  it('costs exactly one roomgenPrng draw when a door fits, and none at all when it does not', () => {
    const fits = new CountingPrng(1);
    expect(pickPassageStartGrid(0, 20, fits)).not.toBeNull();
    expect(fits.calls).toBe(1);

    const tooShort = new CountingPrng(1);
    expect(pickPassageStartGrid(0, 6, tooShort)).toBeNull();
    expect(tooShort.calls).toBe(0); // the fail-loud path must not advance the stream
  });

  /**
   * The sweep. Every band length a door can fit in, every anchor index, several
   * non-zero band origins (so nothing passes by accident on `lo === 0`), against
   * the two properties that actually matter downstream: the result is a whole grid
   * cell, and a full cell of wall survives at each end.
   *
   * The depth half is why: `carveDoorGaps` cuts exactly what the passage rect
   * says, so a fractional start leaves the wall run past the gap fractionally
   * deep. Four runs in shipped level-1 content stood 16 px deep that way, under a
   * 104 px-tall perimeter — a cap band on a third of the depth every wall tone was
   * measured on (`design/01-rendering.md`).
   */
  it('every anchor it can draw is a whole grid cell, inside the band, clear of both corner blocks', () => {
    const offenders: string[] = [];
    for (const lo of [0, 1, 7, 20, 33]) {
      for (let len = 7; len <= 48; len++) {
        const hi = lo + len;
        for (const idx of ANCHORS) {
          const start = pickPassageStartGrid(lo, hi, new FixedAnchor(idx));
          const at = `band ${lo}..${hi} anchor #${idx}`;
          if (start === null) {
            offenders.push(`${at}: null, but a ${len}-cell band fits a door`);
            continue;
          }
          if (!Number.isInteger(start)) offenders.push(`${at}: start ${start} is off-grid`);
          const nearClear = start - lo;
          const farClear = hi - (start + DOOR_WIDTH_GRID);
          if (nearClear < 1) offenders.push(`${at}: only ${nearClear} cells clear of the near corner`);
          if (farClear < 1) offenders.push(`${at}: only ${farClear} cells clear of the far corner`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it('still offers DOOR_ANCHOR_COUNT distinct positions once the band is wide enough — the snap did not collapse the candidate set', () => {
    const starts = new Set(ANCHORS.map((idx) => pickPassageStartGrid(0, 30, new FixedAnchor(idx))));
    expect(starts.size).toBe(DOOR_ANCHOR_COUNT);
  });

  /**
   * The candidate set has to REACH both ends of the band, not just be five distinct
   * positions somewhere inside it. Without this, a wrong step divisor (`span /
   * DOOR_ANCHOR_COUNT` instead of `span / (DOOR_ANCHOR_COUNT - 1)`) still yields
   * five whole-cell positions with legal clearance — every other test here passes —
   * while quietly clustering every door toward the near corner.
   */
  it('reaches both ends of the band, not just five distinct positions somewhere inside it', () => {
    for (const len of [7, 12, 20, 31, 48]) {
      const first = pickPassageStartGrid(0, len, new FixedAnchor(0))!;
      const last = pickPassageStartGrid(0, len, new FixedAnchor(DOOR_ANCHOR_COUNT - 1))!;
      // Snapping can spend at most half a cell of the 1.5-cell margin at each end,
      // so the extreme anchors sit within 2 cells of the band's own extremes.
      expect(first, `band of ${len}: first anchor`).toBeLessThanOrEqual(2);
      expect(len - (last + DOOR_WIDTH_GRID), `band of ${len}: last anchor`).toBeLessThanOrEqual(2);
    }
  });

  it('collapses to a single candidate on a minimal band, and still costs its one draw', () => {
    const starts = new Set(ANCHORS.map((idx) => pickPassageStartGrid(0, 7, new FixedAnchor(idx))));
    expect(starts.size).toBe(1);
    const prng = new CountingPrng(1);
    pickPassageStartGrid(0, 7, prng);
    expect(prng.calls).toBe(1);
  });

  it('never walks backwards as the anchor index rises', () => {
    for (let len = 7; len <= 48; len++) {
      const starts = ANCHORS.map((idx) => pickPassageStartGrid(0, len, new FixedAnchor(idx))!);
      for (let i = 1; i < starts.length; i++) {
        expect(starts[i]!, `band of ${len}, #${i} vs #${i - 1}`).toBeGreaterThanOrEqual(starts[i - 1]!);
      }
    }
  });

  it('is a pure function of the band and the draw — no hidden state between calls', () => {
    for (const seed of [1, 42, 999999999]) {
      const first = pickPassageStartGrid(4, 27, new Prng(seed));
      const second = pickPassageStartGrid(4, 27, new Prng(seed));
      expect(second).toBe(first);
    }
  });
});
