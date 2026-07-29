/**
 * Pure pagination/browse-cursor math shared by any fixed-page-size row list
 * (`Forge.ts`'s Loadout blueprint rows today). Extracted out of `Forge.ts` so it's
 * unit-testable without constructing any Pixi object (this repo's own convention —
 * see `compareCard.ts`/`pickupProximity.ts`: pure logic lives in its own module,
 * tested directly; the Pixi class just calls it).
 *
 * Found via a real bug: `BLUEPRINT_CATALOG` has more entries than the old digit-key
 * shortcuts (1-9) ever reached, and the first cut of real `Button` rows let the list
 * spill past the fixed bottom action bar before this paging was added.
 */

/** How many pages a list of `total` items needs at `pageSize` per page (min 1, even
 * for an empty list — there's always at least a "page 1 of 1" to show). */
export function pageCount(total: number, pageSize: number): number {
  return Math.max(1, Math.ceil(total / pageSize));
}

/** The page-start index (a multiple of `pageSize`) containing `index`. */
export function pageStartForIndex(index: number, pageSize: number): number {
  return Math.floor(index / pageSize) * pageSize;
}

/** Move `pageStart` by `deltaPages` whole pages, clamped to [0, last page's start]. */
export function clampPageStart(pageStart: number, deltaPages: number, total: number, pageSize: number): number {
  const maxStart = (pageCount(total, pageSize) - 1) * pageSize;
  return Math.max(0, Math.min(maxStart, pageStart + deltaPages * pageSize));
}

/** Wrap a browse-cursor index by `delta`, looping at both ends of `[0, len)`. Returns
 * 0 for an empty list (delta is meaningless with nothing to select). */
export function wrapIndex(index: number, delta: number, len: number): number {
  if (len === 0) return 0;
  return ((index + delta) % len + len) % len;
}
