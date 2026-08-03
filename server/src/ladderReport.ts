/**
 * Pure placement → rank conversion for the ladder-rating report (design/15, ROADMAP
 * 4.6) — split out of index.ts so it's unit-testable without touching node:http/fetch.
 * index.ts intentionally stays thin and untested-directly (its own doc comment: "the
 * ONLY file that touches ws... hands everything to the pure RoomManager/MatchRoom
 * lifecycle, which the tests drive with fakes") — this module is that same principle
 * applied to the 4.6 wiring.
 */
import { teamIdForOwner } from './config';

export interface RatingReportBody {
  accountIds: string[];
  places: number[];
  /** Squad membership per entry (index-aligned with `accountIds`/`places`), fed to
   * `rating.ts`'s `computeRatingDeltas` so squadmates share one team rank/rating
   * instead of being scored off their individually-adjacent `places` — see that
   * file's doc comment. Derived the same way every seat's squad already is
   * (`teamIdForOwner`), so a solo/FFA match (squad size 1) degenerates to one
   * singleton team per seat, byte-identical to the pre-squad behavior. */
  teamIds: number[];
}

/**
 * Convert `GameState.placements` (seat indices in ELIMINATION order — worst place
 * first, see `GameState.ts`'s doc comment) into a 1-based place per seat index, then
 * into the `{accountIds, places, teamIds}` triple matchsvc's `/rating/report` expects
 * (index-aligned across all three). `placements[j]` (0-indexed) is place `N - j`,
 * where `N` = `playerCount` — the FIRST-eliminated seat is the WORST place.
 *
 * `playerCount` (the true total seat count) is a REQUIRED param, not derived from
 * `placements.length + 1` — that inference is only correct for a solo/FFA match.
 * `WinConditionSystem.tickPlacement` (engine) only ever pushes LOSING squads' seats
 * into `placements`; the winning squad's OTHER members (everyone but the single
 * `winner` seat `state.winner` names) never appear in `placements` OR `winner`, so a
 * squad win with a real playerCount would silently drop them from the ladder report
 * entirely without this param. With it, every seat sharing the winner's `teamId`
 * (`teamIdForOwner`, same formula the engine used to assign teams) is filled in as
 * tied for 1st — the "full squad-tied ranking" design/15 flagged as a follow-up.
 * A solo/FFA match (squad size 1) has the winner's team be just the winner seat
 * itself, reproducing the exact pre-squad single-winner behavior.
 *
 * `accountId` falls back to a SCAFFOLD (`seat:{roomId}:{seatIdx}`) for any seat with no
 * real account behind it — a guest, a bot, or (pre design/16-accounts.md) every seat,
 * since this project had no account/auth layer anywhere before that. `seatAccounts`
 * (optional last param) is `MatchRoom`'s per-seat real accountId map, threaded from the
 * signed ticket a logged-in player redeemed; omitting it (every pre-account caller)
 * reproduces the exact old scaffold-only behavior.
 */
export function buildRatingReportBody(
  roomId: string,
  winner: number,
  placements: readonly number[],
  playerCount: number,
  seatAccounts?: Readonly<Record<number, string>>,
): RatingReportBody {
  const n = playerCount;
  const winnerTeam = teamIdForOwner(winner, n);

  const bySeat = new Map<number, number>();
  for (let seatIdx = 0; seatIdx < n; seatIdx++) {
    if (teamIdForOwner(seatIdx, n) === winnerTeam) bySeat.set(seatIdx, 1); // whole winning squad, tied for 1st
  }
  placements.forEach((seatIdx, j) => bySeat.set(seatIdx, n - j));

  const accountIds: string[] = [];
  const places: number[] = [];
  const teamIds: number[] = [];
  for (const [seatIdx, place] of bySeat) {
    accountIds.push(seatAccounts?.[seatIdx] ?? `seat:${roomId}:${seatIdx}`);
    places.push(place);
    teamIds.push(teamIdForOwner(seatIdx, n));
  }
  return { accountIds, places, teamIds };
}
