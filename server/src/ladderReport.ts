/**
 * Pure placement → rank conversion for the ladder-rating report (design/15, ROADMAP
 * 4.6) — split out of index.ts so it's unit-testable without touching node:http/fetch.
 * index.ts intentionally stays thin and untested-directly (its own doc comment: "the
 * ONLY file that touches ws... hands everything to the pure RoomManager/MatchRoom
 * lifecycle, which the tests drive with fakes") — this module is that same principle
 * applied to the 4.6 wiring.
 */
export interface RatingReportBody {
  accountIds: string[];
  places: number[];
}

/**
 * Convert `GameState.placements` (seat indices in ELIMINATION order — worst place
 * first, the winner implicitly 1st and absent from the array, see GameState.ts's doc
 * comment) into a 1-based place per seat index, then into the `{accountIds, places}`
 * pairs matchsvc's `/rating/report` expects (index-aligned, same seat order both
 * arrays). `placements[j]` (0-indexed) is place `N - j`, where `N` = total seat count
 * (`placements.length + 1`) — the FIRST-eliminated seat is the WORST place (N), the
 * last-eliminated is place 2.
 *
 * `accountId` is a SCAFFOLD (`seat:{roomId}:{seatIdx}`), not a real account system —
 * this project has no account/auth layer anywhere yet (matchmaking seats are bare
 * numeric `owner` indices, design/06). Swapping in real account ids later is a
 * caller-side change only, not a rating-math or protocol change.
 */
export function buildRatingReportBody(roomId: string, winner: number, placements: readonly number[]): RatingReportBody {
  const n = placements.length + 1;
  const bySeat = new Map<number, number>([[winner, 1]]);
  placements.forEach((seatIdx, j) => bySeat.set(seatIdx, n - j));

  const accountIds: string[] = [];
  const places: number[] = [];
  for (const [seatIdx, place] of bySeat) {
    accountIds.push(`seat:${roomId}:${seatIdx}`);
    places.push(place);
  }
  return { accountIds, places };
}
