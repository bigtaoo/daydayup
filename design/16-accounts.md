# 16 — Accounts

Real username/password login, replacing every "no account system exists" scaffold noted in `05`/`15`/`server/src/rating.ts`/`server/src/PartyService.ts`/`client/src/net/identity.ts`. Shipped 2026-07-29.

## Storage: SQLite (`node:sqlite`), not MongoDB

The project's whole server side is zero-ops (two bare `node:http` processes, in-memory `Map`s, no Express, no DB). Accounts need one real relational fact (a unique username → a login) plus two 1:1 side tables (rating, meta blueprint state) — exactly what SQLite's schema/constraints are for, and MongoDB's schema-flexibility advantage buys nothing here (`MetaState`'s shape is already fixed and versioned via `meta/store.ts`'s `migrate()`). Chosen: Node's **built-in `node:sqlite`** (`DatabaseSync`), not the `better-sqlite3` npm package — this dev box has no C++ build toolchain (no Visual Studio "Desktop development with C++" workload), so `better-sqlite3`'s native `node-gyp rebuild` failed outright; `node:sqlite` needs nothing beyond the Node runtime already required to run this server at all, and is API-equivalent (`.exec()`, `.prepare().run()/.get()/.all()`) for this project's needs. Single file, `DDU_DB_PATH` env override, `:memory:` for tests.

## Server (`matchsvc.ts`, port 8788 — same control-plane process as matchmaking/party/rating)

- `server/src/db.ts` — schema: `accounts(id, username UNIQUE, password_hash, provider, provider_id, created_at)`, `sessions(token, account_id, expires_at)`, `ratings(account_id, rating)` (unused today — `rating.ts`'s in-memory `RatingStore` is untouched; reserved for a future persistence pass), `meta_state(account_id, data)`.
- `server/src/AuthService.ts` — pure class over an injected `DatabaseSync`, same DI shape as `Matchmaker`/`PartyService`. Passwords: `crypto.scryptSync` + a random 16-byte salt (`salt:hash` hex), `timingSafeEqual` to verify — no bcrypt/argon2 dependency. Sessions: opaque `crypto.randomBytes(32)` bearer tokens stored server-side (revocable via `DELETE`, not JWT — no new dependency, mirrors `ticket.ts`'s own HMAC-over-JWT choice), 30-day TTL.
- Routes (all in `matchsvc.ts`, same linear-`if` dispatch as every other route there): `POST /auth/register`, `POST /auth/login`, `POST /auth/logout`, `GET /auth/me` (Bearer), `POST /auth/change-password`, `GET/POST /account/meta` (Bearer) — the Forge `MetaState` JSON blob.
- `accounts.provider`/`provider_id` (default `'local'`/`NULL`) are unused today but reserved for third-party login (WeChat openid, etc.) per the user's request — adding a provider later is a new `provider != 'local'` row + a new `/auth/oauth/:provider` route, not a schema migration.

## Client

- `client/src/net/session.ts` — `{accountId, username, token}` in `localStorage['daydayup.session.v1']`, same storage-port/cache convention as `net/identity.ts`'s `IdentityStore`.
- `client/src/net/auth.ts` — thin `fetch` wrapper over the routes above, same injected-fetch DI convention as `net/party.ts`/`net/matchmaking.ts`.
- `client/src/net/identity.ts`'s `getPlayerId()` now prefers the logged-in `accountId` over the local guest UUID — the single seam every downstream caller (party, matchmaking, ladder rating) already read through, so nothing else needed to change to pick up a real identity once logged in.
- `client/src/game/LoginScreen.ts` — login/register/logout/change-password UI, same `Panel`/`Button`/`TextInputOverlay` pattern as `PartyScreen.ts` (`TextInputOverlay` gained a `password?: boolean` masking option). Reached from a new MainMenu "LOGIN"/"Hi, {username}" button. **Never required to play** — BACK without an account is the unchanged guest path.

## What's bound to an account (vs. what isn't, yet)

- **Login/session itself** — done, the core of this doc.
- **PvP ladder rating** — a logged-in client's real `accountId` rides in the signed match ticket (`TicketPayload.accountId`) from `POST /find` through `Matchmaker` → the gameserver's `Seat`/`RoomConnection` → `MatchRoom.reportResult`'s new `SettledMatch.seatAccounts` (seat → accountId) → `ladderReport.buildRatingReportBody`'s new optional 4th param. A seat missing from `seatAccounts` (guest, bot) still gets the pre-existing `seat:{roomId}:{seatIdx}` scaffold — fully backward compatible, every pre-account test/caller unaffected. `ratings` still lives in the in-memory `RatingStore` (not yet the `ratings` SQLite table) — persisting it is a deliberate follow-up, not done here.
- **Forge blueprints/materials/loadout** (`MetaState`) — `client/src/meta/accountSync.ts`'s `createAccountSyncMetaStore` wraps the existing localStorage `MetaStore`: every `save()` best-effort mirrors to `/account/meta` once logged in (fire-and-forget, same shape as the server's own `reportSettledMatch`); `pullAccountMeta()` runs once right after login/register to pull the account's server-side state (or push the current local state up, for a brand-new account). A guest's behavior is byte-identical to before this doc.

## A real bug only live verification caught

`vitest`/curl both passed throughout, but the first live click-through (claude-in-chrome, real Chrome) hit `Failed to fetch` on every bearer-token call. Cause: `matchsvc.ts`'s CORS constant only declared `access-control-allow-headers: content-type` — fine for every pre-existing route (none sent custom headers), but `/auth/me` and `/account/meta` send `Authorization`, which a real browser's CORS preflight rejects unless the server explicitly allows it. Node's own `fetch`/`undici` and `curl` don't enforce browser CORS preflight rules, so neither the test suite nor a server-side curl check could ever have caught this — only an actual browser exercising the actual request could. Fixed by adding `authorization` to `access-control-allow-headers`; re-verified live (register → unlock a blueprint → log out → clear local state → log back in with a changed password → blueprint state pulled back from the server) end to end, including a direct SQLite row check.

## Test coverage (added after the initial ship, on request)

- **Local username blacklist** (`server/src/usernameFilter.ts`) — reserved system names (`admin`/`root`/`system`/`moderator`/…) + a small first-pass profanity list, case-insensitive substring match. No external content-moderation API is wired in (this project has no WeChat appid/secret anywhere) — swapping in a real one later is a one-function change to `isBlockedUsername`.
- **`matchsvc.ts` was refactored for testability**: `createMatchsvcServer(opts)` builds the HTTP server WITHOUT starting it; `main()` (the real CLI entrypoint) is now guarded behind an ESM `import.meta.url === process.argv[1]` check, so importing the module for tests no longer has the side effect of binding the real port. `server/test/matchsvc.http.test.ts` is the first direct HTTP-layer test this file has ever had: a real server on an ephemeral port, real `fetch` calls through the full `/auth/*`/`/account/*` surface, AND a real CORS preflight (`OPTIONS` with `Access-Control-Request-Headers`) asserting `authorization` is allowed — a regression test for the exact bug above, which no prior test category in this repo (pure-logic unit tests, curl) could catch.
- **`AuthService` edge cases**: boundary-length inputs, unicode/emoji rejection, SQL-injection-style username/password strings (proven inert — parameterized queries + charset validation), concurrent same-username registration (only one wins). Also fixed a real correctness gap found while writing these: username uniqueness and login lookup were case-SENSITIVE (`'Alice'`/`'alice'` were two different accounts) — now `COLLATE NOCASE` on both queries.
- **`LoginScreen` re-entrancy**: `doLogin`/`doRegister`/`doChangePassword`/`doLogout` now guard against a second call landing while the first is still in flight (matches `PartyScreen`'s `doCreate`/`doJoin` convention, which `LoginScreen` had missed) — tested with a controllable deferred promise per action.
- Totals after this pass: **134 server tests** (was 100) + **568 client tests** (was 564), both `tsc --noEmit` clean.

## Explicitly not built

- Real third-party OAuth (WeChat/Google) — the `provider`/`provider_id` columns and routing seam are reserved, not implemented.
- Persisting `ratings`/`sessions` cleanup jobs, rate-limiting login attempts, email/password-reset flows — none of this exists; `register`/`login`/`changePassword` are the whole surface.
- Squad-aware or account-aware anything beyond what's listed above (e.g. friends lists, cross-device sync verification) — out of scope.
