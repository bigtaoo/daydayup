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
 * `accountId` falls back to a SCAFFOLD (`seat:{roomId}:{seatIdx}`) for any seat with no
 * real account behind it — a guest, a bot, or (pre design/16-accounts.md) every seat,
 * since this project had no account/auth layer anywhere before that. `seatAccounts`
 * (optional 4th param) is `MatchRoom`'s per-seat real accountId map, threaded from the
 * signed ticket a logged-in player redeemed; omitting it (every pre-account caller)
 * reproduces the exact old scaffold-only behavior.
 */
export function buildRatingReportBody(
  roomId: string,
  winner: number,
  placements: readonly number[],
  seatAccounts?: Readonly<Record<number, string>>,
): RatingReportBody {
  const n = placements.length + 1;
  const bySeat = new Map<number, number>([[winner, 1]]);
  placements.forEach((seatIdx, j) => bySeat.set(seatIdx, n - j));

  const accountIds: string[] = [];
  const places: number[] = [];
  for (const [seatIdx, place] of bySeat) {
    accountIds.push(seatAccounts?.[seatIdx] ?? `seat:${roomId}:${seatIdx}`);
    places.push(place);
  }
  return { accountIds, places };
}
