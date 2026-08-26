/**
 * The mechanical half of arena authoring: turning a hand-drawn SLOT GRID into room rects,
 * and turning a hand-authored door list into perimeter walls with openings carved for it.
 *
 * Nothing here decides anything. The column widths, the row heights, which slots hold a
 * room, and which adjacent pairs get a door are all authored by hand in `launchArena.ts` —
 * this file only does the arithmetic that would otherwise be 60 hand-typed rects and ~150
 * hand-typed wall runs, which is exactly the kind of thing a person gets wrong once and
 * then cannot find. `design/15`'s "the editor is the authority on room layout, doors,
 * monster placement, loot markers and hazard traits" is satisfied by the LAYOUT being
 * authored; the wall-run arithmetic under it is the same derivation the editor's own door
 * tool performs (`carveDoorGaps`, the PvE side).
 *
 * Two properties this file guarantees, both load-bearing for `arenaGeometryMetrics`:
 *
 * - **Rooms are flush.** A slot grid's columns/rows are laid end to end, so two adjacent
 *   rooms share a boundary line and their perimeter walls sit back to back (two cells of
 *   stone). There is no inter-room gap for an actor to slip through, which is what made the
 *   previous map's door graph decorative.
 * - **A door is a hole in BOTH walls.** An opening is carved from each of the two rooms'
 *   perimeters, and the `passageGrid` spans both wall columns — so the one place the graph
 *   says you can cross is the one place you physically can.
 */
import type { AabbGrid } from '../../content/rooms';

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** A slot's position in the authored grid. */
export interface Slot {
  col: number;
  row: number;
}

export type Side = 'north' | 'south' | 'west' | 'east';

/** An opening in one room's perimeter, in ROOM-RELATIVE coordinates along that side. */
export interface Opening {
  side: Side;
  /** First cell of the gap along the side's own axis (x for north/south, y for west/east). */
  from: number;
  /** Number of cells the gap spans. */
  span: number;
}

/**
 * Absolute rect for every slot, laid out flush from `origin`. Returned as a row-major
 * lookup so the authoring table can index it the same way it is written down: `[row][col]`.
 */
export function slotRects(
  origin: { x: number; y: number },
  colWidths: readonly number[],
  rowHeights: readonly number[],
): Rect[][] {
  const xs: number[] = [origin.x];
  for (const w of colWidths) xs.push(xs[xs.length - 1]! + w);
  const ys: number[] = [origin.y];
  for (const h of rowHeights) ys.push(ys[ys.length - 1]! + h);

  return rowHeights.map((h, row) => colWidths.map((w, col) => ({ x: xs[col]!, y: ys[row]!, w, h })));
}

/** Total extent of a slot grid, including the margin `origin` leaves on the near sides. */
export function gridExtent(
  origin: { x: number; y: number },
  colWidths: readonly number[],
  rowHeights: readonly number[],
  margin: number,
): { w: number; h: number } {
  const sum = (ns: readonly number[]) => ns.reduce((a, b) => a + b, 0);
  return { w: origin.x + sum(colWidths) + margin, h: origin.y + sum(rowHeights) + margin };
}

/** Which side of `a` faces `b`, or null when they are not flush neighbours. */
export function facingSide(a: Rect, b: Rect): Side | null {
  const yOverlap = Math.max(a.y, b.y) < Math.min(a.y + a.h, b.y + b.h);
  const xOverlap = Math.max(a.x, b.x) < Math.min(a.x + a.w, b.x + b.w);
  if (yOverlap && a.x + a.w === b.x) return 'east';
  if (yOverlap && b.x + b.w === a.x) return 'west';
  if (xOverlap && a.y + a.h === b.y) return 'south';
  if (xOverlap && b.y + b.h === a.y) return 'north';
  return null;
}

/** The overlapping span two flush neighbours share, in absolute coordinates. */
function sharedSpan(a: Rect, b: Rect, side: Side): { lo: number; hi: number } {
  if (side === 'east' || side === 'west') {
    return { lo: Math.max(a.y, b.y), hi: Math.min(a.y + a.h, b.y + b.h) };
  }
  return { lo: Math.max(a.x, b.x), hi: Math.min(a.x + a.w, b.x + b.w) };
}

/**
 * One door between two flush rooms: the passage rect (absolute, spanning BOTH rooms' wall
 * columns) plus the opening each room must carve. `bias` shifts the opening off centre in
 * cells — an authored knob, so a district's doors are not all in a dead-straight line.
 */
export function doorBetween(
  a: Rect,
  b: Rect,
  width: number,
  bias = 0,
): { passageGrid: AabbGrid; openingA: Opening; openingB: Opening } | null {
  const side = facingSide(a, b);
  if (side === null) return null;
  const { lo, hi } = sharedSpan(a, b, side);

  // Keep the opening off the corners: a gap flush with a corner would leave a wall run of
  // length zero on that side and open a diagonal line of sight the author never drew.
  const usableLo = lo + 1;
  const usableHi = hi - 1;
  const clampedWidth = Math.max(1, Math.min(width, usableHi - usableLo));
  const centre = Math.floor((usableLo + usableHi - clampedWidth) / 2) + bias;
  const start = Math.max(usableLo, Math.min(centre, usableHi - clampedWidth));

  const opening = (rect: Rect, s: Side): Opening => ({
    side: s,
    from: start - (s === 'north' || s === 'south' ? rect.x : rect.y),
    span: clampedWidth,
  });
  const opposite: Record<Side, Side> = { north: 'south', south: 'north', west: 'east', east: 'west' };

  if (side === 'east' || side === 'west') {
    const x = side === 'east' ? a.x + a.w - 1 : b.x + b.w - 1;
    return {
      passageGrid: { x, y: start, w: 2, h: clampedWidth },
      openingA: opening(a, side),
      openingB: opening(b, opposite[side]),
    };
  }
  const y = side === 'south' ? a.y + a.h - 1 : b.y + b.h - 1;
  return {
    passageGrid: { x: start, y, w: clampedWidth, h: 2 },
    openingA: opening(a, side),
    openingB: opening(b, opposite[side]),
  };
}

/** Split one wall run of `length` cells into the segments left by `gaps`. */
function segments(length: number, gaps: readonly Opening[]): { from: number; span: number }[] {
  const sorted = [...gaps].sort((p, q) => p.from - q.from);
  const out: { from: number; span: number }[] = [];
  let cursor = 0;
  for (const gap of sorted) {
    const from = Math.max(cursor, gap.from);
    if (from > cursor) out.push({ from: cursor, span: from - cursor });
    cursor = Math.max(cursor, gap.from + gap.span);
  }
  if (cursor < length) out.push({ from: cursor, span: length - cursor });
  return out;
}

/**
 * A room's 1-cell perimeter ring as room-relative solids, with `openings` carved out.
 * North/south runs own the full width; west/east runs cover only the rows between them, so
 * no two solids overlap at a corner (an overlap would double-count in every cover metric).
 */
export function perimeterSolids(rect: Rect, openings: readonly Opening[]): AabbGrid[] {
  const bySide = (side: Side) => openings.filter((o) => o.side === side);
  const solids: AabbGrid[] = [];

  for (const seg of segments(rect.w, bySide('north'))) {
    solids.push({ x: seg.from, y: 0, w: seg.span, h: 1 });
  }
  for (const seg of segments(rect.w, bySide('south'))) {
    solids.push({ x: seg.from, y: rect.h - 1, w: seg.span, h: 1 });
  }
  // Trim the vertical runs to the interior rows, then re-split so a west/east opening that
  // reaches a corner row still lands correctly.
  for (const [side, x] of [
    ['west', 0],
    ['east', rect.w - 1],
  ] as const) {
    for (const seg of segments(rect.h, bySide(side))) {
      const from = Math.max(seg.from, 1);
      const to = Math.min(seg.from + seg.span, rect.h - 1);
      if (to > from) solids.push({ x, y: from, w: 1, h: to - from });
    }
  }
  return solids;
}
