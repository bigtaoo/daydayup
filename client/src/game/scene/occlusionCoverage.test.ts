/// <reference types="node" />
/**
 * Does the occlusion x-ray actually cover every place the SHIPPED level-1 content can hide the
 * player — and does it stay off everywhere else?
 *
 * **WHY THIS FILE EXISTS.** `occlusion.test.ts` pins the rule and its geometry, and every box in
 * it is one I wrote by hand from the block I had just been looking at. That is the same class of
 * test that shipped green through four rounds of the wall-corner reports and once through
 * `wallGeometry`'s `w > h` guard, which left 1 wall standing where 32 should because level-1's
 * rooms are almost entirely `w <= h`. A hand-written fixture can only confirm the case its author
 * already had in mind; it cannot answer:
 *
 *   - is there anywhere on the real floors that the player can legally stand, is hidden, and the
 *     x-ray does NOT fire? (the bug, generalised — one such spot is one more report)
 *   - does it fire anywhere the player is not covered at all? (the opposite failure: a room that
 *     dissolves while you walk past it)
 *   - do the "a perimeter wall and the south kerb never trigger it" claims hold on real content,
 *     or only on the two rects I built to check them?
 *
 * So: the real floors through the real pipeline (`placeAuthoredFloor` → `buildFloorGeometry` →
 * `wallTier` → `mergeWallRuns` → the occluder boxes `RoomBuilder` derives), then a swept grid of
 * every position the player can legally stand at on all five floors, checked against an
 * **independent oracle** — rectangle overlap between the block's drawn art and the character's
 * drawn body, which is what "hidden" physically means here and which never calls `occludes`.
 * Restating `occludes` as the oracle would make this file a tautology; the whole point is a second
 * derivation that has to agree with the first.
 *
 * Deliberately NOT here: whether the fade LOOKS right. That needs a live frame and a luma sample —
 * the numbers are in design/01-rendering.md's "The occlusion x-ray".
 */
import { describe, it, expect } from 'vitest';
import {
  EMBER_L1_FLOORS,
  EMBER_L1_ROOMS,
  PLAYER_BASE,
  buildFloorGeometry,
  placeAuthoredFloor,
  toFpGrid,
  type RoomPiece,
} from '@dd/engine';
import { fpToPx } from '../coords';
import { wallHeight, wallTier, WALL_HEIGHT, type RectPx, type WallTier } from './wallGeometry';
import { blockCapTop, mergeWallRuns, wallJoins, type WallJoins, type WallRun } from './wallRuns';
import { faceCrownFraction } from './wallTone';
import { pillarArtExtent } from './pillarRender';
import { needsDeepFade, occludes, type Occluder } from './occlusion';

/** The drawn character, in world px. `bodyH`/`halfW` are the shipped rig's own measurements
 *  (`Actor.test.ts` pins them off the real skin); `CLEARANCE` is the engine's. */
const BODY_H = 32;
const HALF_W = 12.96;
const CLEARANCE = fpToPx(PLAYER_BASE.solidRadius);

/** How finely the reachable floor is swept, in world px. 8 px is a quarter of a grid cell and
 *  about a third of the drawn body — fine enough that a blind spot cannot hide between samples,
 *  coarse enough to sweep five floors in well under a second. */
const STEP = 8;

/** Fraction of the drawn body that has to be behind stone before "the character is hidden" is a
 *  fair description. Deliberately well below 1: the report was a body that vanished entirely, but
 *  a character with only their head showing above a wall cap is the same complaint, and the x-ray
 *  has to have fired before it gets that far. */
const HIDDEN_FRACTION = 0.5;

interface Block {
  box: Occluder;
  tier: WallTier | 'pillar';
  /** The block's own footprint, for the "where does a perimeter run fire from" check. */
  rect: RectPx;
}

interface Floor {
  index: number;
  blocks: Block[];
  walls: RectPx[];
  pillars: Array<{ gx: number; gy: number; r: number }>;
  rooms: RectPx[];
}

/**
 * One floor, taken through `RoomBuilder.build`'s own sequence, ending in the occluder boxes it
 * hands the fader. The box derivations here are the SAME expressions RoomBuilder uses (they read
 * `blockCapTop`/`pillarArtExtent`, the shared definitions, rather than restating the arithmetic),
 * because what is under test is the rule's coverage over real geometry — not whether the two
 * copies of a formula match, which `RoomBuilder.test.ts` already checks against the built art.
 */
function buildFloor(index: number): Floor {
  const map = EMBER_L1_FLOORS[index]!;
  const { placed, doors } = placeAuthoredFloor(map, EMBER_L1_ROOMS as readonly RoomPiece[]);
  const geo = buildFloorGeometry(placed, doors);
  const rooms: RectPx[] = placed.map((r) => ({
    x: fpToPx(toFpGrid(r.offsetXGrid)),
    y: fpToPx(toFpGrid(r.offsetYGrid)),
    w: fpToPx(toFpGrid(r.piece.sizeGrid.w)),
    h: fpToPx(toFpGrid(r.piece.sizeGrid.h)),
  }));
  const walls: RectPx[] = geo.walls.map((w) => ({
    x: fpToPx(w.x), y: fpToPx(w.y), w: fpToPx(w.w), h: fpToPx(w.h),
  }));
  const runs: WallRun[] = mergeWallRuns(walls.map((rect) => ({ rect, tier: wallTier(rect, rooms) })));
  const joins: WallJoins[] = wallJoins(runs, faceCrownFraction('fire')); // level 1 is ember

  const blocks: Block[] = runs.map((run, i) => {
    const height = wallHeight(run.tier);
    const sortY = run.rect.y + run.rect.h;
    return {
      tier: run.tier,
      rect: run.rect,
      box: {
        left: run.rect.x,
        right: run.rect.x + run.rect.w,
        top: sortY + blockCapTop(run.rect, height, joins[i]),
        sortY,
        foldY: sortY - height,
      },
    };
  });

  const pillars = geo.obstacles.map((o) => ({ gx: fpToPx(o.gx), gy: fpToPx(o.gy), r: fpToPx(o.radius) }));
  for (const p of pillars) {
    const art = pillarArtExtent(p.r * 2 + 16, WALL_HEIGHT); // RoomBuilder's own bodyW/height
    blocks.push({
      tier: 'pillar',
      rect: { x: p.gx - p.r, y: p.gy - p.r, w: p.r * 2, h: p.r * 2 },
      box: { left: p.gx - art.halfW, right: p.gx + art.halfW, top: p.gy + art.top, sortY: p.gy, foldY: p.gy },
    });
  }
  return { index, blocks, walls, pillars, rooms };
}

const FLOORS: Floor[] = Object.keys(EMBER_L1_FLOORS).map(Number).map(buildFloor);

/** Can the player's body stand centred here? Their solid circle is treated as its bounding square
 *  against a wall AABB, which is what the engine's own AABB resolution does, and as a real circle
 *  against a round pillar. Conservative on purpose: anything this accepts is somewhere the player
 *  can genuinely be, which is what makes a blind spot found here a real one. */
function standable(f: Floor, gx: number, gy: number): boolean {
  for (const w of f.walls) {
    if (gx + CLEARANCE > w.x && gx - CLEARANCE < w.x + w.w && gy + CLEARANCE > w.y && gy - CLEARANCE < w.y + w.h) {
      return false;
    }
  }
  for (const p of f.pillars) {
    const reach = p.r + CLEARANCE;
    if ((gx - p.gx) ** 2 + (gy - p.gy) ** 2 < reach ** 2) return false;
  }
  return f.rooms.some((r) => gx > r.x && gx < r.x + r.w && gy > r.y && gy < r.y + r.h);
}

/**
 * THE ORACLE. What fraction of the drawn body is behind stone at this position — computed from
 * rectangle overlap between the two things that are actually drawn, with no reference to
 * `occludes`.
 *
 * A body is drawn upward from its ground point, so it occupies `[gy - BODY_H, gy]`; a block's art
 * occupies `[box.top, box.sortY]` and only counts if it sorts in FRONT (`sortY > gy`), because
 * that is the whole of what per-object Y-sorting decides. Overlap is summed per row rather than
 * per block so two blocks covering the same rows (an L corner) cannot count twice.
 *
 * The idle hover (`Actor.HOVER`, ~6-9 px of render-only lift) is deliberately ignored: it moves
 * the body UP, away from the near edge of the art, so leaving it out slightly overstates how
 * covered the character is. Overstating is the safe direction for a test whose job is to find
 * places the x-ray should have fired and did not.
 */
function coveredFraction(f: Floor, gx: number, gy: number): number {
  const bodyTop = gy - BODY_H;
  const rows = new Set<number>();
  for (const b of f.blocks) {
    if (b.box.sortY <= gy) continue; // sorts behind the character — cannot cover them
    if (gx + HALF_W <= b.box.left || gx - HALF_W >= b.box.right) continue;
    const from = Math.max(bodyTop, b.box.top);
    const to = Math.min(gy, b.box.sortY);
    for (let y = Math.ceil(from); y < to; y++) rows.add(y);
  }
  return rows.size / BODY_H;
}

/**
 * THE SECOND ORACLE, and the one that decides whether the fix is good enough: how much of the
 * drawn body is STILL behind opaque stone once the x-ray has done its work.
 *
 * A firing block only fades its cap, so what stays opaque is everything from its cap/face fold
 * down (`foldY..sortY`); a block that does not fire stays opaque over its whole art. A pillar
 * fades whole, so a firing pillar leaves nothing. Same per-row union as `coveredFraction`, so two
 * blocks over the same rows cannot double-count.
 */
function hiddenAfterFraction(f: Floor, gx: number, gy: number, fired: readonly Block[]): number {
  const focus = { x: gx, y: gy, halfW: HALF_W, bodyH: BODY_H };
  const bodyTop = gy - BODY_H;
  const rows = new Set<number>();
  for (const b of f.blocks) {
    if (b.box.sortY <= gy) continue;
    if (gx + HALF_W <= b.box.left || gx - HALF_W >= b.box.right) continue;
    // A block that is not firing stays opaque over all of its art; one that is firing keeps
    // everything from its fold down, unless it also took the deep pass, which leaves nothing.
    let opaqueTop = b.box.top;
    if (fired.includes(b)) opaqueTop = needsDeepFade(b.box, focus) ? b.box.sortY : b.box.foldY;
    const from = Math.max(bodyTop, opaqueTop);
    const to = Math.min(gy, b.box.sortY);
    for (let y = Math.ceil(from); y < to; y++) rows.add(y);
  }
  return rows.size / BODY_H;
}

/** Every standable sample on this floor, with what the oracle and the rule each say about it. */
function sweep(f: Floor): Array<{ gx: number; gy: number; covered: number; fired: Block[]; hiddenAfter: number }> {
  const out: Array<{ gx: number; gy: number; covered: number; fired: Block[]; hiddenAfter: number }> = [];
  const minX = Math.min(...f.rooms.map((r) => r.x));
  const maxX = Math.max(...f.rooms.map((r) => r.x + r.w));
  const minY = Math.min(...f.rooms.map((r) => r.y));
  const maxY = Math.max(...f.rooms.map((r) => r.y + r.h));
  const focus = { x: 0, y: 0, halfW: HALF_W, bodyH: BODY_H };
  for (let gy = minY; gy <= maxY; gy += STEP) {
    for (let gx = minX; gx <= maxX; gx += STEP) {
      if (!standable(f, gx, gy)) continue;
      focus.x = gx;
      focus.y = gy;
      const fired = f.blocks.filter((b) => occludes(b.box, focus));
      out.push({
        gx,
        gy,
        covered: coveredFraction(f, gx, gy),
        fired,
        hiddenAfter: hiddenAfterFraction(f, gx, gy, fired),
      });
    }
  }
  return out;
}

const SWEPT = FLOORS.map((f) => ({ floor: f, samples: sweep(f) }));

describe('occlusion coverage — the shipped level-1 floors, swept', () => {
  it('is actually looking at all five floors, and at a real amount of floor', () => {
    // The guard every test of this class needs: a pipeline change that silently produced empty
    // floors would make every assertion below vacuously true.
    expect(FLOORS).toHaveLength(5);
    for (const { floor, samples } of SWEPT) {
      expect(floor.blocks.length, `floor ${floor.index} blocks`).toBeGreaterThan(10);
      expect(samples.length, `floor ${floor.index} standable samples`).toBeGreaterThan(2000);
    }
  });

  it('the content really does contain places the player is hidden — this is not a hypothetical', () => {
    // If this ever goes to zero, the level content changed (or a wall tier shrank) and the x-ray
    // has become dead code rather than a fix. That is a thing to notice, not to silently keep.
    for (const { floor, samples } of SWEPT) {
      const hidden = samples.filter((s) => s.covered >= HIDDEN_FRACTION);
      expect(hidden.length, `floor ${floor.index} hidden spots`).toBeGreaterThan(0);
    }
    const fully = SWEPT.flatMap((s) => s.samples).filter((s) => s.covered >= 1);
    expect(fully.length).toBeGreaterThan(0); // the reported case: nothing of the body left
  });

  it('EVERY hidden spot on every floor fires the x-ray — no blind spot survives', () => {
    // The bug, generalised. One position that reaches this list is one more screenshot.
    const missed = SWEPT.flatMap(({ floor, samples }) =>
      samples
        .filter((s) => s.covered >= HIDDEN_FRACTION && s.fired.length === 0)
        .map((s) => `floor ${floor.index} at (${s.gx}, ${s.gy}) covered ${(s.covered * 100) | 0}%`),
    );
    expect(missed).toEqual([]);
  });

  it('never fires where the character is not covered at all', () => {
    // The opposite failure: blocks going translucent as the player walks past them, which reads
    // as the room dissolving. `MIN_COVER_FRACTION` is what holds this line.
    const spurious = SWEPT.flatMap(({ floor, samples }) =>
      samples
        .filter((s) => s.covered === 0 && s.fired.length > 0)
        .map((s) => `floor ${floor.index} at (${s.gx}, ${s.gy})`),
    );
    expect(spurious).toEqual([]);
  });

  it('every block it fires for is one that is really covering the character', () => {
    // Per-block rather than per-position: a rule that fired for the right POSITION but named a
    // neighbouring block would fade the wrong stone and leave the player hidden anyway.
    for (const { floor, samples } of SWEPT) {
      for (const s of samples) {
        for (const b of s.fired) {
          expect(b.box.sortY, `floor ${floor.index} at (${s.gx}, ${s.gy})`).toBeGreaterThan(s.gy);
          expect(b.box.top).toBeLessThan(s.gy);
          expect(s.gx + HALF_W).toBeGreaterThan(b.box.left);
          expect(s.gx - HALF_W).toBeLessThan(b.box.right);
        }
      }
    }
  });

  it('a KERB never fires, on any floor, from anywhere the player can stand', () => {
    // The claim `MIN_COVER_FRACTION` exists for. A 22 px south lip reaches 6 px above the feet of
    // a player standing flush against it, so fading the whole southern edge of every room would
    // be a bigger artifact than the few px it fixes. Checked against real authored content rather
    // than the one kerb rect I wrote by hand in `occlusion.test.ts`.
    const kerbs = SWEPT.flatMap(({ floor, samples }) =>
      samples
        .filter((s) => s.fired.some((b) => b.tier === 'kerb'))
        .map((s) => `floor ${floor.index} at (${s.gx}, ${s.gy})`),
    );
    expect(kerbs).toEqual([]);
    // ...and there really are kerbs in the content, so that emptiness means something.
    expect(FLOORS.some((f) => f.blocks.some((b) => b.tier === 'kerb'))).toBe(true);
  });

  it('a PERIMETER run fires only from BEYOND its own end — never from inside the room it bounds', () => {
    // This one corrected a claim I had already written into design/01: "a perimeter wall never
    // triggers it, its blind band is on the far side of itself." True of a room's north wall, and
    // false in general — the sweep found 1,574 samples where one does fire (4,626 before the tier
    // fix of 2026-08-20; see `wallGeometry.wallTier`), all of them on the same shape: a long
    // north-south run whose NORTH END is open floor (a door passage between two rooms), where the
    // run's art spills one wall height past its own footprint onto ground the player walks over
    // once that door unlocks. Firing there is right — the player standing in that passage is half
    // swallowed by the run's cap. What has to stay true is the geometry: a perimeter run can only
    // ever fire from north of its own footprint, never from the room floor it borders, which is
    // what stops a room's own boundary fading while you walk along it.
    const hits = SWEPT.flatMap(({ floor, samples }) =>
      samples.flatMap((s) =>
        s.fired.filter((b) => b.tier === 'perimeter').map((b) => ({ floor: floor.index, s, b })),
      ),
    );
    expect(hits.length).toBeGreaterThan(0);
    const insideFootprint = hits
      .filter((h) => h.s.gy >= h.b.rect.y)
      .map((h) => `floor ${h.floor} at (${h.s.gx}, ${h.s.gy})`);
    expect(insideFootprint).toEqual([]);
    // Every one of them is at most one wall thickness wide (measured: 32 or 64 px) — a
    // north-south run, or a door-carved fragment of one. The room-width east-west runs that used
    // to appear here were the stacked-room boundaries `wallTier` now kerbs, and their blind band
    // was inside the room ABOVE them; a north wall with no room above it has its blind band off
    // the floor entirely, which is the case my original claim was actually about.
  });

  it('fades at most a couple of blocks at once, so a room never dissolves', () => {
    // An L corner is two blocks and the player can stand behind both; three would mean the rule
    // is reaching past the character.
    const worst = Math.max(...SWEPT.flatMap(({ samples }) => samples.map((s) => s.fired.length)));
    expect(worst).toBeGreaterThan(0);
    expect(worst).toBeLessThanOrEqual(2);
  });

  it('fires strictly inside the band the art covers, on real geometry', () => {
    // Both edges of the trigger region, swept rather than asserted at one hand-picked y: walking
    // north out of a block's shadow must stop the x-ray at the row its art tops out, and walking
    // south past its own ground line must stop it there.
    for (const { floor, samples } of SWEPT) {
      for (const s of samples) {
        for (const b of s.fired) {
          const covered = Math.min(s.gy, b.box.sortY) - Math.max(s.gy - BODY_H, b.box.top);
          expect(covered, `floor ${floor.index} at (${s.gx}, ${s.gy})`).toBeGreaterThan(0);
        }
      }
    }
  });
});

describe('occlusion coverage — how much of the character is left buried afterwards', () => {
  const ALL = SWEPT.flatMap(({ floor, samples }) => samples.map((s) => ({ f: floor.index, ...s })));

  it('no reachable spot on any floor leaves the character MORE than half hidden', () => {
    // The acceptance criterion, and the one this pass is actually judged on. The first version of
    // the fix faded a block's cap only, which is measurably the better look — and this sweep is
    // what found the 0.15% of floor where it achieved nothing at all, because the whole body sat
    // below the cap/face fold and what was covering it was the front FACE. `needsDeepFade` is the
    // second pass that closes those; without it, 88 samples here stay 100% hidden.
    const worst = ALL.filter((s) => s.hiddenAfter > 0.5)
      .slice(0, 8)
      .map((s) => `floor ${s.f} at (${s.gx}, ${s.gy}) still ${(s.hiddenAfter * 100) | 0}% hidden`);
    expect(worst).toEqual([]);
  });

  it('and the head is always the part you keep', () => {
    // Which half survives is not a detail: a body is drawn upward from its ground point, so what
    // the block covers is always the BOTTOM of it. Reading "standing behind a wall" off a pair of
    // shoulders is normal for this view; losing the head and keeping the feet would not be.
    const headless = ALL.filter((s) => s.hiddenAfter > 0 && s.hiddenAfter >= s.covered)
      .filter((s) => s.covered >= 1) // fully covered before, so any residual is not "the top half"
      .map((s) => `floor ${s.f} at (${s.gx}, ${s.gy})`);
    expect(headless).toEqual([]);
  });

  it('the deep pass is RARE — it is a fallback, not the normal path', () => {
    // If this ever became common, the fade would be reading as "walls dissolve near me" rather
    // than as an occasional rescue, and the cap-only look this pass measured would be lost.
    const deep = ALL.filter((s) =>
      s.fired.some((b) => needsDeepFade(b.box, { x: s.gx, y: s.gy, halfW: HALF_W, bodyH: BODY_H })),
    );
    expect(deep.length).toBeGreaterThan(0); // it is reachable content, not dead code
    expect(deep.length / ALL.length).toBeLessThan(0.02); // measured 0.2%, down from 1.2%: the
    // stacked-room boundaries that used to need it are kerbs now (`wallGeometry.wallTier`).
  });
});

describe('occlusion coverage — where the blind spots actually are', () => {
  it('reports the measured extent, as the record of what this pass is worth', () => {
    // The number this whole pass is judged by, kept in the suite rather than only in a commit
    // message: across 97,803 standable samples on the five shipped floors, 5.4% leave the player
    // at least half hidden and 3.3% leave them COMPLETELY invisible before the x-ray. Those were
    // 8.5% and 5.5% until the tier fix of 2026-08-20 — a third of the blind floor was one wall
    // standing at the wrong height, not something the x-ray had to exist for (see
    // `wallGeometry.wallTier`). Bounded loosely on both sides — zero would mean the content no
    // longer has the problem (and the x-ray has become dead weight), a large fraction would mean
    // the sweep is wrong rather than the level.
    const all = SWEPT.flatMap(({ samples }) => samples);
    const half = all.filter((s) => s.covered >= HIDDEN_FRACTION).length / all.length;
    const full = all.filter((s) => s.covered >= 1).length / all.length;
    expect(half).toBeGreaterThan(0.02);
    expect(half).toBeLessThan(0.2);
    expect(full).toBeGreaterThan(0.01);
    // ...and after the x-ray, the character always keeps more than half of themselves (measured
    // worst case 43.8% hidden, at a room boundary).
    expect(Math.max(...all.map((s) => s.hiddenAfter))).toBeLessThan(HIDDEN_FRACTION);
  });
});
