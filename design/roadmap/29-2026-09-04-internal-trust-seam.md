# Work log — 2026-09-04: the internal trust seam

Volume 29. The first code of Phase 8, and deliberately the half of it that has nothing to do with
money: two defects that stood on 2026-09-04, independent of billing, both named in
[`../19-server-platform.md`](../19-server-platform.md) §1 as D1 and D2 and both marked "should be
fixed first".

Indexed from [`../ROADMAP.md`](../ROADMAP.md). Design account in
[`../19-server-platform.md`](../19-server-platform.md) §3, which now carries a
"What building it changed" subsection for the three things the plan did not anticipate.

## The internal trust seam (2026-09-04, server, no engine bump)

### D1 — anyone could write the ladder

`POST /rating/report` had **no authentication of any kind**: no key, no origin check, open CORS.
It is called by the gameserver and by nothing else, and it is the one endpoint in this project
that can move any account's ladder rating. One `curl` was enough to hand yourself first place and
demote a real player, for any `accountId`, permanently — `RatingStore` persists to SQLite, so
nothing expires the damage.

The fix is `server/src/internalAuth.ts`: an `x-internal-key` header checked against a per-caller
registry, plus an advisory `x-internal-caller` that exists **only** for the audit line.

Four things about it are worth stating, because each is a way this check could have been written
that looks correct and is not.

- **The comparison hashes both sides before `timingSafeEqual`.** `ticket.ts` compares an HMAC
  behind an `a.length !== b.length` early return, because `timingSafeEqual` throws on a length
  mismatch. That is right for an HMAC — always the same length — and wrong for an
  operator-chosen secret, where the guard turns the real key's length into something an attacker
  can measure a byte at a time. Hashing first makes every comparison 32 bytes against 32 bytes:
  no throw, no length leak. Without it, a wrong-length key is a 500 out of a request handler
  rather than a refusal, which is why four different-length keys are their own test case.
- **`x-internal-caller` is never used to select which key to compare against.** If it were, an
  unauthenticated attacker would be choosing their own examiner, and a forgeable header would be
  load-bearing. The authoritative caller identity is the registry entry whose *key* matched; the
  header is recorded beside it and sanitized (control characters stripped, truncated) before it
  reaches a log line, because it is otherwise a log-injection vector into the audit trail it is
  about to appear in.
- **The registry loop has no early `break`.** With one entry that is free; with several it is
  what stops the time taken from saying which caller's key was presented.
- **The third-namespace rule is structural, not a check.** Nothing in `internalAuth.ts` reads
  `authorization`, so there is no code path that could consult the session store — a player token
  presented as `x-internal-key` is refused as `unknown-key`, exactly like noise. Proved with a
  *real* registration: the same token `/auth/me` accepts gets 401 on `/rating/report`, in either
  header. And `routes/http.ts`'s `access-control-allow-headers` does not list `x-internal-key`,
  so a cross-origin page cannot attach one past its own preflight — the open CORS block cannot be
  turned into a way in. Pinned as a test rather than left as a coincidence.

`GET /rating/:accountId` is deliberately **not** gated: a public read of a visible rank that
writes nothing.

### D2 — the outbound report never drained its body

`reportSettledMatch` in `index.ts` was `fetch(...).catch(() => {})`. The response body was never
consumed. funny shipped that exact line and **measured** the consequence under a concurrent
burst: an unconsumed undici body keeps its socket checked out, the keep-alive pool runs dry, and
every request then fails with `fetch failed` about 30 s later. The failure mode is not "some
reports were slow" — it is that *none* of them arrived, silently, because the call was
fire-and-forget in the first place. Low PvP settlement volume is the only reason it never bit
here.

`server/src/internalFetch.ts` makes the three things a bare `fetch` forgets impossible to forget:

1. **The body is always drained or cancelled** — before any status branch, so a 4xx and a 5xx are
   released exactly like a 200, and on *every* attempt of a retry ladder rather than only the
   last. Draining after the loop instead of inside it looks correct and leaves attempts 1..n-1
   checked out, which is the burst case exactly; that is its own test.
2. **Each attempt carries an explicit timeout.** undici's `fetch` has no default, so a stuck
   socket hangs for tens of seconds instead of failing fast — one wedged peer becomes a backlog.
   The timer is cleared in a `finally`, because a pending `setTimeout` keeps the event loop alive
   and `main()`'s `SIGTERM` shutdown then waits for it.
3. **Bounded retry is opt-in.** `retry` absent means exactly one attempt, so a caller who never
   thought about idempotency cannot accidentally get at-least-once. A 5xx, a timeout and a
   network error retry; every 4xx does not, because repeating a refusal verbatim cannot change
   the answer (429 is not special-cased — these callers are our own processes and nothing here
   rate-limits them).

It never throws and never rejects, so the settlement path stays fire-and-forget with no unhandled
rejection to take the gameserver down mid-match. What it no longer does is fail *silently*: a
report that exhausts its budget is logged with the room, the attempt count and the failure kind.

### The one thing left open

`/rating/report` is **at-least-once, not exactly-once**. `RatingStore.applyMatch` has no dedupe
key, so a report that was delivered but whose response was lost gets applied twice on retry. The
settlement budget is a deliberate 3 rather than 10 for that reason, and the trade is written at
the call site. Closing it wants the same shape design/19 §4 already specifies for billing
delivery — a dedupe key (`roomId` is already threaded through `ladderReport.ts`), a `UNIQUE`
column in `db.ts`, and a `changes()` check instead of SELECT-then-INSERT. That touches
`rating.ts` and `db.ts`, and is the next thing to do to this seam.

## Numbers

- `server/src/internalAuth.ts` (144 lines) and `server/src/internalFetch.ts` (187) are new;
  `config.ts`, `index.ts` and `routes/rating.ts` changed. No file near the 500-line convention.
- 88 new cases (82 across four new test files, 6 added to `index.lifecycle.test.ts`); the server
  suite goes 311 → 399.
- Server coverage **99.41% lines / 96.15% branches** (99.32 / 95.44 before). The four
  files this pass owns are 100% on both.
- `npm run check`, `npm run coverage` and `npm run check:logic` all green.

## Two test-craft notes worth keeping

- **`vi.spyOn` on an already-spied method hands back the existing mock.** Several new cases spy
  `console.warn`, and `index.lifecycle.test.ts`'s `afterEach` did not restore mocks — so a later
  case was reading every earlier case's calls, and a "warns exactly once" assertion was counting
  the whole file. It failed loudly here only because three cases in a row asserted a count.
- **A wall-clock assertion is not how you prove a real timer ran.** The first version of the
  "uses the shipped backoff, not an injected one" case asserted `Date.now() - started >= 1` after
  a 1 ms sleep. `Date.now()` has ~15 ms granularity on Windows, so it reads 0 often enough to go
  red — and proves nothing when it passes. It is fake-timer driven now:
  `advanceTimersByTimeAsync` past the backoff, then assert the second attempt happened.
