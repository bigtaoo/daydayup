// New 2026-08-19 (volume pass): merge the engine's wall AABBs into the RUNS they visually
// form, before any of them is drawn as a block. Pure geometry, Pixi-free, sibling to
// `wallGeometry.ts` (which decides how tall a wall stands) and `wallRender.ts` (which draws
// one).
//
// WHY. Measured in a live frame: a horizontal luminance scan across what looks like one thick
// north-south wall in `ember_l1_gallery` crosses TWO 32 px segments — 216..268 and 268..320 —
// each with its own lit west edge (luma 43 and 45) and its own dark east band (luma 4-6). The
// cause is content, not rendering: adjacent rooms each author their own perimeter wall, so the
// boundary between two rooms is two parallel walls one against the other (`[184,8,4,27]` and
// `[188,8,4,27]` in grid units, and four more pairs on that floor). Drawing each as an
// independent extruded block puts a bright/dark seam down the middle of a single stone mass,
// so a thick wall reads as two thin slabs standing back to back — one of the reasons the walls
// still looked like a printed ribbon after they were standing.
//
// Render-only: `s.walls` itself is untouched, so collision is unaffected. The engine is right
// to keep two rects (they belong to two different rooms); it is the drawing that has to see
// one mass.
import { wallHeight, type RectPx, type WallTier } from './wallGeometry';
import { FACE_CROWN_FRACTION_MIN } from './wallTone';

/** A wall about to be drawn: its footprint and the tier that sets its height. */
export interface WallRun {
  rect: RectPx;
  tier: WallTier;
}

/** Slack (world px) for "these two edges are the same edge" / "these two rects touch". A wall
 *  is authored on a grid and converted through fixed point, so sub-pixel differences are
 *  conversion noise; anything larger is a real gap that must stay a gap. */
const JOIN_TOLERANCE = 0.75;

const near = (a: number, b: number): boolean => Math.abs(a - b) <= JOIN_TOLERANCE;

/**
 * The union of `a` and `b` if the two form an exact rectangle, else null.
 *
 * Exact means: they share a full edge — identical y and height with x ranges that touch or
 * overlap, or identical x and width with y ranges that touch or overlap. An L, a T or a
 * partial overlap all return null, because their union is not a rectangle and drawing it as
 * one would invent stone where the content has none.
 */
export function joinRects(a: RectPx, b: RectPx): RectPx | null {
  if (near(a.y, b.y) && near(a.h, b.h)) {
    const touch = a.x <= b.x + b.w + JOIN_TOLERANCE && b.x <= a.x + a.w + JOIN_TOLERANCE;
    if (!touch) return null;
    const x = Math.min(a.x, b.x);
    const right = Math.max(a.x + a.w, b.x + b.w);
    return { x, y: Math.min(a.y, b.y), w: right - x, h: Math.max(a.h, b.h) };
  }
  if (near(a.x, b.x) && near(a.w, b.w)) {
    const touch = a.y <= b.y + b.h + JOIN_TOLERANCE && b.y <= a.y + a.h + JOIN_TOLERANCE;
    if (!touch) return null;
    const y = Math.min(a.y, b.y);
    const bottom = Math.max(a.y + a.h, b.y + b.h);
    return { x: Math.min(a.x, b.x), y, w: Math.max(a.w, b.w), h: bottom - y };
  }
  return null;
}

/**
 * Merge every mergeable pair, repeatedly, until nothing more merges.
 *
 * **Only same-tier walls are ever merged**, and that restriction is load-bearing rather than
 * conservatism: a room's own south boundary is a low kerb (`WALL_H_KERB`) precisely so it
 * cannot stand between the camera and the player it frames, while the room on the far side of
 * that same boundary sees a full-height perimeter wall. Those two are stacked adjacent rects
 * of DIFFERENT tiers; merging them would give the pair one height and reintroduce exactly the
 * bug the kerb exists to prevent. Same-tier merging is the only kind that is purely visual.
 *
 * O(n²) per pass over a couple of dozen rects, run once per room build.
 */
export function mergeWallRuns(runs: readonly WallRun[]): WallRun[] {
  const out = runs.map((r) => ({ rect: { ...r.rect }, tier: r.tier }));
  let merged = true;
  while (merged) {
    merged = false;
    for (let i = 0; i < out.length && !merged; i++) {
      for (let j = i + 1; j < out.length; j++) {
        const a = out[i]!;
        const b = out[j]!;
        if (a.tier !== b.tier) continue;
        const union = joinRects(a.rect, b.rect);
        if (!union) continue;
        a.rect = union;
        out.splice(j, 1);
        merged = true;
        break;
      }
    }
  }
  return out;
}

/**
 * Where a block's north/south edge is NOT a real edge: local-x intervals along it at which
 * another mass of at least the same height carries straight on, so the two tops are one
 * continuous surface.
 *
 * New 2026-08-19, second report on the same wall (*"竖着的墙，直接盖在了横着的墙上面"* — the
 * vertical wall looks pasted on top of the horizontal one). `mergeWallRuns` above can only merge
 * pairs whose union is a RECTANGLE, so an L or T corner is always two separate blocks — and each
 * of them was drawing its full set of *"this is where I end"* cues at the join:
 *
 *   - the north-south run stroked a lit coping and a dark silhouette along its cap's north edge,
 *     which is buried inside the corner and cannot catch any light;
 *   - the east-west wall ran its cap depth gradient (0 → `CAP_GRADIENT_MAX`) across its whole
 *     32 px cap *including* the part the corner continues through, so the two tops met at a
 *     measured 66 → 79 luma step with a highlight line drawn on it.
 *
 * Together those read exactly as reported: a brighter rectangle laid over the brick. The
 * geometry was never wrong (for those x the mass really is solid from the far wall's north edge
 * to the near run's south edge, so one continuous top ribbon is correct) — what was wrong is
 * that both blocks announced an edge in the middle of it.
 *
 * Height matters, hence `wallHeight`: a taller neighbour buries the edge, an equal one continues
 * it, but a SHORTER one (a kerb against a perimeter wall) leaves a genuine step that must keep
 * its coping and its gradient.
 *
 * **TUCK — the third report on the same wall, and the one that changed the rule rather than a
 * number** (*"中间的墙体处理的很好，但是上面那段就不对了。我觉得应该是中间的墙要看起来到横着的墙的
 * 底部，然后相交的部分进行立体化处理"*). Removing the false edges made the corner seamless and it
 * still read wrong, because *seamless* was never the ask: a run whose own art intrudes a wall
 * height north of its footprint climbs up the far wall's brick face and interrupts it, and that
 * face is the one surface in the frame the eye is using as the room's back wall.
 *
 * Physically the run's stone IS nearer than that face — the previous pass's arithmetic was right —
 * so this is a deliberate stylisation: a DEEP run (`rect.h > its own height`, i.e. one you see
 * mostly the top of) whose north edge is fully buried **tucks under** the wall to its north.
 *
 * **How far it may reach north is the whole question, and it took two more rounds to land.** Not
 * the full wall height (that is the overlap being complained about). Not zero either — clipping the
 * run at the wall's FOOT was tried, shipped a render, and was rejected: *"感觉还是不对，我觉得应该
 * 要覆盖到我标记的区域"*, with a rectangle drawn over the brick above the run. Measuring that
 * rectangle against the frame put its top edge at world y −10, and the far wall's CROWN course ends
 * at −14.6 — the run should cover the wall's brick and stop just under its crown.
 *
 * That is `tuckLiftPx`, and it has a clean reading: the crown is the longest unbroken horizontal
 * line in the room and the one the eye identifies the back wall by, so it is the one thing that must
 * survive. Everything below it is brick the run is entitled to stand in front of. Visually the run
 * ends up reading as slightly shorter than the wall it meets, which is what an abutting wall under a
 * coping course looks like — and the swatch's own dark mortar line lands exactly on the junction, so
 * the joint comes out looking authored.
 *
 * `rect.h > height` is what keeps this from breaking the OTHER case that shares this geometry: two
 * parallel east-west walls stacked north-south (32 px deep, 104 tall) are one mass whose top is
 * drawn by the northern one's cap, so the southern one's art *must* keep reaching north of its
 * footprint or there would be a hole. Only a run deeper than it is tall has a cap left to clip.
 */
export interface WallJoins {
  /** Intervals `[x0, x1]` in the block's own local x, along its north edge, at which a mass of at
   *  least its height continues: no coping and no silhouette belong there. */
  north: ReadonlyArray<readonly [number, number]>;
  /** South-edge intervals whose cap/face fold is BURIED because the neighbour's cap continues
   *  through it — mask the fold and the cap's depth gradient out of them. */
  south: ReadonlyArray<readonly [number, number]>;
  /** True when this block tucks under the wall to its north. Whole-width only, deep runs only. */
  tuckNorth: boolean;
  /** How far north of its own footprint edge a tucked block's art may still reach, in world px:
   *  the far wall's height less its crown course. 0 when not tucking. */
  tuckLiftPx: number;
  /** South-edge intervals where a deep run tucks under THIS block. Its fold there is real (the run
   *  stops short of it), so instead of masking, its CROWN gets the contact crease. */
  tuckedSouth: ReadonlyArray<readonly [number, number]>;
  /** The crown fraction these joins were computed with (`faceCrownFraction` of the room's element).
   *  Carried so the crease that follows from a join is sized by the SAME number that placed it —
   *  the swatches disagree per element, so a second lookup downstream could disagree too. */
  crownFraction: number;
  /** True when a door passage (design/05: an always-present fixture, never a bare gap) sits
   *  directly north of this run — see `bordersDoorNorth`. Unlike `tuckNorth` this is never
   *  computed BY `wallJoins` itself (doors are not walls, so this file stays door-blind); the
   *  caller that knows about `s.dungeonDoors` (`RoomBuilder`) sets it after the fact. Read only
   *  by `blockCapTop`, and only on a run deep enough to have a cap left once clipped — see there. */
  doorClip: boolean;
  /** True when this block has NO cap at all: its art stops at the top of its own face, with no
   *  stone lying over it. Like `doorClip` it is never computed by `wallJoins` (which only knows
   *  about walls); the caller sets it, and the only one that does today is
   *  `RoomBuilder.buildDoors`, for a door standing taller than the wall it is cut into — see
   *  `doorFlankHeight`. Read by `blockCapTop`, which is the single place every cap-shaped cue
   *  (`wallRender.addCapLayers`, the cap depth gradient, the cap edge bevel, the coping in
   *  `addBlockEdge`) derives its extent from — so one flag drops the whole cap coherently rather
   *  than five call sites agreeing by hand. */
  capless: boolean;
}

/** No joins at all — the default for callers that have no neighbour set (tests, flat modes). */
export const NO_JOINS: WallJoins = {
  north: [], south: [], tuckNorth: false, tuckLiftPx: 0, tuckedSouth: [],
  crownFraction: FACE_CROWN_FRACTION_MIN, doorClip: false, capless: false,
};

/** Merge touching/overlapping intervals so a masked stroke never restarts mid-join. */
function coalesce(spans: Array<readonly [number, number]>): Array<readonly [number, number]> {
  const sorted = [...spans].sort((a, b) => a[0] - b[0]);
  const out: Array<readonly [number, number]> = [];
  for (const [a, b] of sorted) {
    const last = out[out.length - 1];
    if (last && a <= last[1] + JOIN_TOLERANCE) out[out.length - 1] = [last[0], Math.max(last[1], b)];
    else out.push([a, b]);
  }
  return out;
}

/** The north-edge intervals of `run` that a mass of at least its own height continues through. */
function northJoinsOf(run: WallRun, runs: readonly WallRun[]): Array<readonly [number, number]> {
  const r = run.rect;
  const mine = wallHeight(run.tier);
  const spans: Array<readonly [number, number]> = [];
  for (const other of runs) {
    if (other === run || wallHeight(other.tier) < mine) continue;
    const o = other.rect;
    if (!near(o.y + o.h, r.y)) continue;
    const x0 = Math.max(r.x, o.x);
    const x1 = Math.min(r.x + r.w, o.x + o.w);
    if (x1 - x0 > JOIN_TOLERANCE) spans.push([x0 - r.x, x1 - r.x]);
  }
  return coalesce(spans);
}

/** Whether `run` tucks under the wall(s) north of it: a run deeper than it is tall, buried along
 *  its whole width. Both conditions are load-bearing — see `WallJoins`. */
function tucks(run: WallRun, north: ReadonlyArray<readonly [number, number]>): boolean {
  const { w, h } = run.rect;
  if (h <= wallHeight(run.tier)) return false;
  const first = north[0];
  return north.length === 1 && first![0] <= JOIN_TOLERANCE && first![1] >= w - JOIN_TOLERANCE;
}

/** How far a tucked `run` may still reach north of its own footprint edge: the SHORTEST northern
 *  neighbour's height less that neighbour's crown course, since the crown that has to stay unbroken
 *  is the neighbour's own. Every candidate is at least as tall as `run` (see `northJoinsOf`). */
function tuckLift(run: WallRun, runs: readonly WallRun[], crownFraction: number): number {
  const r = run.rect;
  let lift = Infinity;
  for (const other of runs) {
    if (other === run || wallHeight(other.tier) < wallHeight(run.tier)) continue;
    const o = other.rect;
    if (!near(o.y + o.h, r.y)) continue;
    if (Math.min(r.x + r.w, o.x + o.w) - Math.max(r.x, o.x) <= JOIN_TOLERANCE) continue;
    lift = Math.min(lift, wallHeight(other.tier) * (1 - crownFraction));
  }
  return Number.isFinite(lift) ? lift : 0;
}

/** `runs[i]`'s joins against every other run, as a parallel array. Two passes, because whether a
 *  block masks its own fold or creases its own face depends on whether the run SOUTH of it tucks.
 *  O(n²) over a couple of dozen rects, once per room build. */
export function wallJoins(
  runs: readonly WallRun[],
  crownFraction: number = FACE_CROWN_FRACTION_MIN,
): WallJoins[] {
  const north = runs.map((run) => northJoinsOf(run, runs));
  const tuckNorth = runs.map((run, i) => tucks(run, north[i]!));
  const lift = runs.map((run, i) => (tuckNorth[i] ? tuckLift(run, runs, crownFraction) : 0));
  return runs.map((run, i) => {
    const r = run.rect;
    const mine = wallHeight(run.tier);
    const south: Array<readonly [number, number]> = [];
    const tuckedSouth: Array<readonly [number, number]> = [];
    for (const [j, other] of runs.entries()) {
      if (other === run || wallHeight(other.tier) < mine) continue;
      const o = other.rect;
      if (!near(o.y, r.y + r.h)) continue;
      const x0 = Math.max(r.x, o.x);
      const x1 = Math.min(r.x + r.w, o.x + o.w);
      if (x1 - x0 <= JOIN_TOLERANCE) continue;
      // A neighbour that tucks stops at MY south edge, so my fold there is real: crease it
      // instead of masking it.
      (tuckNorth[j] ? tuckedSouth : south).push([x0 - r.x, x1 - r.x]);
    }
    return {
      north: north[i]!,
      south: coalesce(south),
      tuckNorth: tuckNorth[i]!,
      tuckLiftPx: lift[i]!,
      tuckedSouth: coalesce(tuckedSouth),
      crownFraction,
      doorClip: false,
      capless: false,
    };
  });
}

/**
 * Whether a door passage sits directly north of `rect` — the door's south edge meets `rect`'s
 * north edge with at least some x-overlap (design/01 "door passage between two rooms" case: a
 * long north-south run's cap "spills one wall height past its own footprint onto ground [...]
 * standing there they are half swallowed by its cap" — a door fixture standing on that same
 * ground gets swallowed the same way, permanently rather than only while a character stands
 * there, since a door has no x-ray to fade the block back). Unlike `tucks()`, this does NOT
 * require whole-width coverage: a door is a discrete fixture, not another wall course whose
 * crown must stay one continuous line, so any overlap is a real overlap worth clipping for.
 */
export function bordersDoorNorth(rect: RectPx, doorRects: readonly RectPx[]): boolean {
  for (const d of doorRects) {
    if (!near(d.y + d.h, rect.y)) continue;
    const x0 = Math.max(rect.x, d.x);
    const x1 = Math.min(rect.x + rect.w, d.x + d.w);
    if (x1 - x0 > JOIN_TOLERANCE) return true;
  }
  return false;
}

/** The parts of `0..width` that `spans` does NOT cover — where an edge cue still belongs. */
export function unjoinedSpans(
  width: number,
  spans: ReadonlyArray<readonly [number, number]>,
): Array<readonly [number, number]> {
  const out: Array<readonly [number, number]> = [];
  let cursor = 0;
  for (const [a, b] of spans) {
    if (a - cursor > JOIN_TOLERANCE) out.push([cursor, Math.min(a, width)]);
    cursor = Math.max(cursor, b);
  }
  if (width - cursor > JOIN_TOLERANCE) out.push([cursor, width]);
  return out;
}

/**
 * Local y of the top (north) edge of a block's cap — the highest row its art paints, and so both
 * where every cap layer starts and how far north of its own footprint the block reaches (which is
 * what `RoomBuilder` hands the occlusion x-ray as `Occluder.top`). Lives here rather than in
 * `wallRender` because the clip it applies is a JOIN property — the whole rule is about what the
 * neighbouring mass is holding — and because three call sites read it, which is two more than the
 * inlined copies it replaced.
 *
 * A tucked run reaches only `tuckLiftPx` north of its own footprint edge (local `-r.h`) instead of
 * a full wall height, which leaves the wall it runs into holding its crown course. `tuckNorth` is
 * only ever set when `r.h > height`, which is exactly the condition under which that clip still
 * leaves a cap — see `WallJoins`. `Math.min` is belt-and-braces: the cap can never cross its fold.
 *
 * `doorClip` (`bordersDoorNorth`) clips the same way but to ZERO lift — a door has no crown of
 * its own to leave standing, so nothing may spill past its threshold at all — PROVIDED `height`
 * here is already `effectiveWallHeight`'s result, not the tier's raw height. See that function:
 * a `doorClip`ped run's CAP alone is not always the whole spill, and `Math.min(-height, ...)`
 * below only ever protects this function's own output from crossing its own fold — it has no way
 * to know whether `height` itself is already too tall for `r.h` to justify.
 *
 * `capless` short-circuits both of those: the block has no top surface to place at all, so its cap
 * collapses onto its own fold and every cue derived from `-height - capTop` sizes itself to zero.
 * Only doors set it — see `WallJoins.capless` and `doorFlankHeight`.
 */
export function blockCapTop(r: RectPx, height: number, joins: WallJoins = NO_JOINS): number {
  // `capless` first and unconditionally: the block has no top surface at all, so its cap starts
  // and ends on its own fold. Every cap cue sizes itself off `-height - capTop`, which is then 0.
  if (joins.capless) return -height;
  const base = joins.tuckNorth ? Math.min(-height, -r.h - joins.tuckLiftPx) : -height - r.h;
  return joins.doorClip ? Math.min(-height, Math.max(base, -r.h)) : base;
}

/**
 * The wall height actually used to draw a block — ordinarily just the tier's own `height`, with
 * one exception measured in 2026-08-20 (`doorSpillCoverage.test.ts`, 12 real cases across the
 * five shipped floors, not the hypothetical edge case an earlier version of `blockCapTop`'s own
 * comment assumed it was):
 *
 * A block's FACE is drawn at a fixed `height` regardless of its own footprint depth `r.h`
 * (`wallRender.buildWallBlock`) — that mismatch is exactly what lets a wall "stand" at all, since
 * every wall's footprint (its collision thickness) is far shallower than the height it's drawn
 * at. But it means that whenever `r.h < height`, the FACE ALONE already reaches `height - r.h` px
 * north of the block's own footprint edge, with no cap involved — `blockCapTop`'s `doorClip`
 * clamp only ever touches the CAP, so clipping it to zero (as it correctly does) left the face's
 * own reach untouched and still spilling onto the door. Measured: a 32 px-deep PERIMETER stub
 * beside a door span 72 px of pure face over it with the cap-only clip already in place.
 *
 * The fix is to shrink the HEIGHT itself, not add a second clip: capping `height` to `r.h` for a
 * `doorClip`ped run makes both the face (drawn at this returned height) and the cap
 * (`blockCapTop`, fed this same returned height) stop exactly at the block's own footprint edge —
 * `blockCapTop`'s own `doorClip` branch always resolves to exactly `-r.h` once `height <= r.h`,
 * so the two functions agree by construction rather than by coincidence. A genuinely DEEP run
 * (`r.h > height`, the case this whole feature first shipped for) is a no-op here — `Math.min`
 * returns the tier height unchanged, exactly as before. `RoomBuilder` is the only caller, and
 * feeds this SAME returned value to `buildWallBlock`, `drawWallShadow`, and the occluder's
 * `foldY`/`top`, so nothing downstream can disagree about how tall this block actually stood.
 */
export function effectiveWallHeight(r: RectPx, height: number, joins: WallJoins = NO_JOINS): number {
  return joins.doorClip ? Math.min(height, r.h) : height;
}
/**
 * How tall the wall a door is CUT INTO stands, in world px — the SHORTEST of the runs abutting the
 * passage along the gap — or `null` when nothing abuts it at all (a mode with no wall model, or a
 * hand-built fixture in a test).
 *
 * This is the descendant of the deleted `doorFlankTier`, and it is deliberately NOT a height for
 * the door: `wallGeometry.DOOR_H` is, one number for every door in the game, and that stays. What
 * the flank still decides is whether the door has a CAP — whether there is any stone lying over
 * its lintel — because a cap only means anything as the continuation of the neighbouring wall's
 * own crown (`wallRender.addCapLayers`: "its stone above the lintel has to be the same continuous
 * quarry as the runs either side of it"). Where the door out-tops those runs there is no such
 * quarry to continue, and drawing one anyway hangs a slab of wall in mid-air above the doorway —
 * which is exactly what shipping `DOOR_H` did to the 11 kerb doorways (2026-09-03, live report
 * with a screenshot circling the slab: *"我希望门的位置只有门"*).
 *
 * SHORTEST rather than tallest for the same reason the old tier rule took the shortest: a passage
 * between two rooms is flanked by several runs, and a cap that lands on one flank's crown while
 * floating over the other is still a floating slab. Both sides have to reach it.
 */
export function doorFlankHeight(door: RectPx, runs: readonly WallRun[]): number | null {
  let best: number | null = null;
  for (const run of runs) {
    if (!abutsAlongGap(door, run.rect)) continue;
    const h = wallHeight(run.tier);
    if (best === null || h < best) best = h;
  }
  return best;
}

/**
 * Does this doorway draw NO cap — i.e. does it stand taller than the stone it is cut into?
 * `WallJoins.capless`' production rule, here rather than in `RoomBuilder` so the sweep over the
 * shipped floors (`doorStandCoverage.test.ts`) asks the same question the renderer asks.
 */
export function doorCapless(door: RectPx, runs: readonly WallRun[], height: number): boolean {
  const flank = doorFlankHeight(door, runs);
  return flank !== null && flank < height;
}

/** Does `r` sit against `door` along the gap — touching on one axis, genuinely overlapping on the
 *  other? A shared corner is not a flank (the overlap test is `> JOIN_TOLERANCE`, not `>= 0`), so
 *  a wall that merely clips the doorway's corner diagonally never gets a vote on its height. */
function abutsAlongGap(door: RectPx, r: RectPx): boolean {
  const overlapX = Math.min(door.x + door.w, r.x + r.w) - Math.max(door.x, r.x);
  const overlapY = Math.min(door.y + door.h, r.y + r.h) - Math.max(door.y, r.y);
  if (overlapY > JOIN_TOLERANCE && (near(r.x + r.w, door.x) || near(r.x, door.x + door.w))) return true;
  return overlapX > JOIN_TOLERANCE && (near(r.y + r.h, door.y) || near(r.y, door.y + door.h));
}
