# 19 — Server platform: trust seams, entitlements, billing

What the server side becomes once real money is involved. Four of the five pieces this doc
covers already ship (`design/16-accounts.md` login, account storage, matchmaking, the frame-relay
gameserver); the fifth — billing — does not exist, and adding it turns three things that are
currently *tolerable* into things that are *wrong*. This doc is the plan for all four.

Written 2026-09-04 after an audit of the sibling project `funny`'s server (13 services, Mongo +
Redis, a shipped `commercial` service with real Apple/Google/WeChat/Stripe adapters). Its
**topology** is deliberately not adopted; a named set of its **mechanisms** is, each because it
was written by a real incident. Every borrow below says which of funny's assumptions does not
hold here — the standing rule for porting from that project.

## Path convention in this doc

A backticked path carries a file extension **only when the file exists in this repo today**.
Planned modules (`server/src/billsvc/iap`) and sibling-project paths (funny's
`shared/src/internalFetch`) are written **without** one, so `checkDocPaths.mjs` reads them as
prose rather than as claims about this tree. Add the extension when the file lands — §3's two
modules did, on 2026-09-04, and carry `.ts` below.

## The decisions (locked)

- **Three processes, not five and not one.** Control plane (`matchsvc.ts`, 8788), data plane
  (`index.ts`, 8787), and a new **billing plane** (`billsvc`, 8789). Login and account storage
  stay inside the control plane — they are 200-line injected-`DatabaseSync` classes, and
  splitting them buys a network hop and nothing else.
- **Money gets its own process and its own database file.** Not for purity: the control plane is
  restarted and (later) horizontally scaled on a matchmaking cadence, and platform callbacks need
  a stable public entry point, pinned credentials, and an audit boundary that can be read and
  rolled back without the `/find` traffic in the way. funny reached the same conclusion —
  its commercial database is physically isolated from its meta database.
- **Entitlements are server-owned. `meta_state` becomes a cache.** The `/account/meta` route
  accepts a whole client-authored blob today. Once blueprints and characters are sold, that route
  is a free-money hole, and characters are the one meta axis that reaches PvP (`design/14-meta-forging.md`).
- **No wallet, no currency, no gacha.** `design/14-meta-forging.md` locks bounded direct purchase.
  A player buys a SKU and owns it. There is no balance, so there is nothing to double-spend,
  nothing to refund partially, and no channel-tagging problem (see *Not built*).
- **Internal routes get a real key.** Service-to-service calls are authenticated with a
  timing-safe shared-secret header, in a different namespace from both player sessions and the
  match `ticket.ts` HMAC.

---

## 1. The two planes today, and the two defects in them

| | Process | Port | Surface |
|---|---|---|---|
| Control plane | `matchsvc.ts` | 8788 | `/auth/*` (`AuthService.ts`), `/account/meta`, `/find` `/resume` (`Matchmaker.ts`), `/party/*` (`PartyService.ts`), `/rating/*` (`rating.ts`) |
| Data plane | `index.ts` | 8787 | `/ws` frame broadcast (`RoomManager.ts` / `MatchRoom.ts`), checkpoint hash adjudication |

Since 2026-09-04 `matchsvc.ts` is an **assembly shell only** — service construction, the
bot-fill hook, `/health`, the dispatch chain, `main()` — and every surface in that first row is
a group of free `(req, res, url, deps)` handlers under `server/src/routes/`:
`server/src/routes/auth.ts`, `server/src/routes/account.ts`, `server/src/routes/match.ts`,
`server/src/routes/party.ts`, `server/src/routes/rating.ts`, over a shared
`server/src/routes/http.ts` (the CORS block, `send`, `readJson`). It was one 431-line if/else
chain before, against an empty file-length baseline, and §2 and §3 both add routes to it — so
each seam below now names its own file, and the two passes cannot collide in one file.

The only trust seam between them is the signed ticket (`ticket.ts`): matchsvc signs
`{roomId, owner, seed, playerCount, mode, accountId}`, the gameserver trusts nothing else. That
part is correct and is not changed here. Two things around it were not — both **fixed
2026-09-04** (ROADMAP 8.1, `design/roadmap/29-2026-09-04-internal-trust-seam.md`):

- **D1 — `/rating/report` was unauthenticated.** It is called by the gameserver and by nothing
  else, but it had no key, no origin check, and open CORS. Any client could POST arbitrary ladder
  placements for any `accountId`. Closed by §3's inbound half. (This bullet and the next read
  "Fixed by §4" when the doc was written; §4 is billing, and the seam that fixes them is §3.)
- **D2 — the outbound report never drains its response body.** `reportSettledMatch` in `index.ts`
  is `fetch(...).catch(() => {})`. funny shipped that exact shape and measured the consequence
  under a concurrent burst: unconsumed undici bodies keep their sockets checked out, the
  keep-alive pool jams, and every request fails with `fetch failed` ~30 s later — so *none* of
  them arrived. Low PvP settlement volume is the only reason it never bit here. Closed by §3's
  outbound half.

Neither defect involved billing, and both were fixed first, as planned.

## 2. Entitlements move server-side — SHIPPED 2026-09-04

Until this landed, `/account/meta` (`server/src/routes/account.ts`) was a blind whole-blob upsert:
`INSERT ... ON CONFLICT DO UPDATE SET
data = excluded.data`, with the only validation being that a `data` key is present. That was the
right call when `MetaState` was a localStorage mirror (`design/16-accounts.md` says so) and
nothing in it was worth money.

The fix is not to validate the blob — that is whack-a-mole. It is to move the two account-level,
purchasable things out of it. `server/src/EntitlementService.ts` owns them, over one table in the
existing account database (`server/src/db.ts`):

```
entitlements(id, account_id, sku, source, order_id, granted_at)
  UNIQUE(account_id, sku)        -- SKUs here are own-or-not, never stacked
  source: 'purchase' | 'grant' | 'event' | 'starter' | 'drop'
```

- `meta_state` keeps what the client legitimately authors: materials, loadout selection,
  in-progress forge state. It stays a whole-blob upsert.
- Blueprint and character **ownership** is read from `entitlements`. On `GET /account/meta` the
  server overwrites the ownership fields in the returned blob from its own table; a client that
  POSTs itself extra ownership is ignored rather than rejected, so no pre-existing guest or
  offline path breaks.
- `forge.ts`'s `acquireBlueprint` / `grantCharacter` are already the grant seam
  `design/14-meta-forging.md` reserved for exactly this. What changes is *who may call them*, not
  their shape.
- A guest (no account) is byte-identical to today: local-only, no server row.

`source` is not decoration. It is what makes the operational work in §7 possible — a daily audit
of non-`purchase` grants, and a support path that can hand-issue one and have it look different
from a paid one afterwards.

### What the build settled that the plan left open

- **SKUs are namespaced rather than split across two tables**: `blueprint:<weaponId>` and
  `character:<skinId>`. One `UNIQUE(account_id, sku)` then covers both, a blueprint id can never
  collide with a skin id, and `WHERE sku LIKE 'character:%'` is the whole query §7's
  hand-correctable-with-SQL requirement needs.
- **`entitlements` DOES take the foreign key `ratings` deliberately refuses**, and the contrast is
  the point. A rating key is any opaque id `ladderReport.ts` hands over, including a guest/bot
  `seat:{roomId}:{seatIdx}` scaffold with no `accounts` row at all. An entitlement is only ever
  minted for a real logged-in account — a guest has no row here — so no legitimate id can fail the
  constraint, and `node:sqlite` enforcing foreign keys by default is then exactly what makes a
  typo'd hand-issue fail loudly instead of becoming an orphan that silently never delivers.
- **Two CHECK constraints**, both because §7 rules out an admin service and the schema therefore
  has to survive being corrected by a human at a `sqlite3` prompt: `source` is constrained to the
  enum §7's daily audit groups by, and a `'purchase'` with no `order_id` is rejected as
  unauditable — §7's reconciliation could never match it to anything.
- **The client's POST is normalized on WRITE, not merely overwritten on read.** Ownership is
  stripped before the blob is stored, so `meta_state` never holds a client-authored ownership
  claim that would mislead whoever reads that table with SQL.
- **`GET /account/meta` answers `{ data, entitlements }`**, the second being
  `{ sku, source, grantedAt }` per row — never `order_id`, which addresses a row in billsvc's
  private database. One round trip, and therefore no new route and no edit to `matchsvc.ts`'s
  dispatch chain, which §3 was landing in from a parallel worktree at the same time.
- **Nothing under `client/src/game/` had to change, and the Forge neither flickers nor rolls
  back.** The server returns EMPTY ownership for every account that exists today, and
  `client/src/meta/store.ts`'s `migrate()` already unions `STARTER_BLUEPRINTS` + `FREE_CHARACTERS`
  back in on every load — so ownership before and after a login is identical. What *does*
  disappear is ownership the client granted itself, which is the hole this section exists to
  close (see §9). `client/src/net/entitlements.ts` is the client half: the wire read, a defensive
  parse that drops one malformed entry without discarding the ones around it, and the same
  skip-unknown-namespace projection the server uses.

**Named so it is not mistaken for shipped:** nothing yet *calls* `EntitlementService.grant`. The
delivery path is billsvc's (§4) through an internal-key-authed route (§3), and
`EntitlementService.owns` exists and is tested but no PvP character gate consults it yet.

## 3. The internal trust seam — SHIPPED 2026-09-04

**Status: SHIPPED 2026-09-04** (ROADMAP 8.1), and **exactly-once since 2026-09-05**. Both
modules exist; `POST /rating/report` is behind the key, `reportSettledMatch` goes through the
outbound helper, and the settlement report is now idempotent at the receiver. Three things
the plan below did not anticipate are recorded at the end of this section — the third of them
was left open on 2026-09-04 and is closed under "Exactly-once settlement" after it.

Borrowed from funny's `shared/src/internalAuth` and `shared/src/internalFetch`, cut down.

**Inbound** (`server/src/internalAuth.ts`): an `x-internal-key` header compared with
`timingSafeEqual`, plus an advisory `x-internal-caller` for logs. funny's per-caller key registry
(one key per calling service, independently rotatable) is the right end state but is not worth it
at three processes — keep the *shape* (a verifier object built from a registry that currently has
one entry) so adding the registry later is not a rewrite. This is a third namespace, deliberately
distinct from player bearer sessions and from the `ticket.ts` HMAC: internal routes never accept a
player token, and the mismatch is structural rather than a check.

Applies to `/rating/report` (D1, `server/src/routes/rating.ts`) immediately, and to every
`billsvc` route except the platform
webhook, which is authenticated by the platform's own signature instead.

**Outbound** (`server/src/internalFetch.ts`): one helper that every cross-service call goes through,
which cannot forget the three things a bare `fetch` forgets:

1. **always drain or cancel the response body**, even when the real answer arrives elsewhere (D2);
2. **an explicit per-attempt timeout** — undici's `fetch` has no default, so a stuck socket hangs
   for tens of seconds instead of failing fast;
3. **bounded retry only for calls that are idempotent and not self-healing.** A settlement report
   is worth retrying; a periodic heartbeat is not, because the next tick re-sends it. Retry is
   therefore **opt-in**: `retry` absent means exactly one attempt, so a caller who never thought
   about it cannot accidentally get at-least-once delivery.

### What building it changed (2026-09-04)

- **The key comparison hashes both sides before `timingSafeEqual`.** The plan said
  "compared with `timingSafeEqual`", which is what `ticket.ts` already does — behind an
  `a.length !== b.length` guard, because that function *throws* on a length mismatch. That
  guard is right for an HMAC, which is always the same length, and wrong for an
  operator-chosen shared secret: it turns the real key's length into something an attacker can
  measure. Hashing first makes every comparison 32 bytes against 32 bytes, so it neither
  throws nor leaks the length. Without it a wrong-length key is a 500, not a refusal.
- **An unset key in production yields an EMPTY registry, not the dev key.** `config.ts` gives
  the internal key the same posture it already gives `DDU_TICKET_SECRET` (real env var →
  production; unset → a published dev key plus one loud warning, so the two-process local
  setup works out of the box) with exactly one difference: under `NODE_ENV=production` an
  unset `DDU_INTERNAL_KEY` refuses *every* internal call rather than falling back. A key
  printed in this repository is not a weaker credential than none — it is the same one — and
  the fallback would look configured. This is §5's "fail closed in production" rule, which
  that section states for the billing dev stub, reaching one section earlier than expected.
- **`/rating/report` was at-least-once, and retrying it double-applied a rating.**
  `RatingStore.applyMatch` carried no dedupe key, so a report that was delivered but whose
  response was lost was applied twice on retry — which is why the settlement budget shipped as
  a deliberate 3. **CLOSED 2026-09-05**, with exactly the shape §4 specifies for billing
  delivery: a dedupe key threaded through `ladderReport.ts`, a `UNIQUE` column in `db.ts`, and
  a claim-then-`changes()` check rather than SELECT-then-INSERT. See "Exactly-once settlement"
  below; the budget is now 5, because a retry can no longer multiply a rating.

### Exactly-once settlement — SHIPPED 2026-09-05

`ladderReport.ts` puts a `reportKey` in the report body, `db.ts` gains a `rating_reports`
table whose `report_key` PRIMARY KEY *is* the mechanism, and `RatingStore.applyMatchOnce`
claims that key with `INSERT ... ON CONFLICT DO NOTHING` + `changes()` **inside the same
`BEGIN IMMEDIATE` that writes `ratings`**. Four things the build settled that the sentence
above did not say.

- **The claim and the ratings roll back together, and that direction matters more.** Losing
  the claim and applying anyway is the original defect: a redelivery double-credits. Winning
  the claim and then failing is worse — the key is burned for a match whose deltas were never
  written, so that match's rating is gone permanently and every retry is answered "already
  applied". A double-credit is at least visible in the ladder and reversible. Both directions
  have their own tests, the failing-write one forced by a real SQLite trigger rather than a
  mocked driver, because the point is that the *database* aborts the write the claim is tied to.
- **A lost claim answers 200 with `duplicate: true`, deliberately not 409.** The sender is an
  at-least-once retry ladder, and `internalFetch` counts every non-2xx a failure: a 409 would
  log "ladder report failed" for a match whose rating actually landed, and keep asking. 200 is
  what *ends* at-least-once delivery meeting an idempotent receiver, so the marker goes in the
  body where an operator can still tell the two apart. A thrown apply is a 500 for the mirror
  reason — 500 is the one status that IS retried, and the claim has already rolled back.
- **`roomId` alone would have been a correct key, and is not the one that shipped.** A room
  settles at most once (`MatchRoom.reportResult` latches and destroys) and `matchsvc.ts` mints
  room ids with `randomUUID()`, and the mode does not change this: a PvE/co-op settlement takes
  the same `onSettled` path and is filtered per-REPORT by `reportSettledMatch`'s
  `hashOk`/`placements`/`winner` guard, so whatever gets through still gets through once per
  room. What breaks it is that the room id is not always ours — `index.ts`'s legacy dev
  handshake reads `roomId` off the query string, and the room is gone once it settles, so a
  local `?roomId=dev` can host a second, genuinely different match. So the key is
  `{roomId}:{16 hex of sha256 over the report}`: the prefix is what an operator greps, the
  digest is what keeps two matches apart, and it is stable across the retry ladder because it
  is a pure function of the body.
- **A report with NO `reportKey` is applied the old, non-deduped way, and logged.** The route
  has exactly one legitimate caller, so a keyless report means version skew during a rolling
  deploy. The two options are asymmetric: accept it and risk the bounded double-apply that
  stood until today, or 400 it and lose those matches' ratings for good, since a 4xx is never
  retried. The recoverable failure wins. This is not a hole worth closing — the route is
  key-gated, and anyone who can reach it can already post whatever placements they like.

## 4. Billing: the data model — SHIPPED 2026-09-04

**Status: SHIPPED 2026-09-04** (ROADMAP 8.3). `server/src/billingDb.ts` owns the file and
`server/src/billsvc/BillingService.ts` the five rules; the process is `server/src/billsvc/main.ts`
on 8789 and its routes are `server/src/billsvc/server.ts`. Two amendments the plan below did not
anticipate, and one thing left open, are recorded at the end of this section.

Three tables in `billsvc`'s **own** SQLite file (`DDU_BILLING_DB_PATH`), never the account DB —
and never `db.ts`'s `openDb` either, because a shared opener is how a later refactor quietly
re-merges two files this decision separated on purpose:

```
orders(id, account_id, sku, platform, amount_cents, currency,
       state, platform_txn_id UNIQUE, created_at, settled_at)
receipts(id, account_id, platform, product, raw, verified_at)      -- id = `${platform}:${receipt}`
ledger(id, account_id, sku, order_id, receipt_id, kind, ts)        -- append-only, never updated
```

Five rules, each answering a specific failure funny actually hit:

- **`platform_txn_id`'s UNIQUE constraint is the idempotency key.** Platform callbacks are
  at-least-once by contract. Delivery is `INSERT ... ON CONFLICT DO NOTHING` followed by reading
  `changes()`, never SELECT-then-INSERT.
- **Delivery is triggered by the callback, never by the client.** The client's `POST /order/create`
  returns platform payment parameters and nothing else; `GET /order/:id` lets it poll. Whatever it
  claims about success is not an input.
- **Price comes from a server-side SKU table.** An `amount` in the request body is discarded.
- **A replayed receipt belonging to a different account is rejected, not replayed.** funny's
  comment is the whole argument: otherwise the response mirrors another account's state to the
  requester.
- **A receipt records which product it resolved to.** Without it, a receipt for one SKU can later
  be replayed to claim a different one.

**The one place funny's design is deliberately not copied.** funny's recharge path needs a
verify-and-heal saga with CAS claim fields (`healedAt`, `healClaimedAt`) because its receipt row
and its wallet increment are separate Mongo documents with no transaction around them: a crash
between the two loses the purchase silently, and two concurrent healers both observing "no ledger
entry" both re-grant. Here, `orders` + `entitlements` + `ledger` are three tables in one SQLite
file, so a single `BEGIN IMMEDIATE` makes the tear impossible and the CAS machinery unnecessary.

What survives the translation is the *reasoning*, pointed at the tear that does still exist —
between the **platform** and the local transaction. That is what §7's reconciliation covers.

**AMENDMENT 1 (2026-09-04): the named idempotency key is not sufficient on its own.**
`platform_txn_id`'s UNIQUE constraint is the right key and the claim-then-`changes()` shape above
is the right mechanism, but `txnId` arrives in the **callback body**, which nothing authenticates.
One dev-stub receipt posted at three different orders with three invented transaction ids wins
three claims and delivers three times. So `settle` claims **twice** inside the one transaction —
the receipt row's primary key first, then the ledger row's `purchase:<platform>:<txn>` id — and
prefers `verified.platformTxnId` over the body's whenever an adapter supplies one, because the
receipt is verified and the body is not. Losing the first claim is an at-least-once redelivery;
losing the second after winning the first means one platform transaction presented under two
receipts, which is refused rather than resolved silently either way.

**AMENDMENT 2 (2026-09-04): rule 4 belongs INSIDE the transaction.** It first shipped as a
`SELECT account_id FROM receipts` before `BEGIN IMMEDIATE`, which is correct today — but only
because there happens to be no `await` between that read and the claim. Written that way the
guarantee is a property of the current code rather than of the lock, so the ownership question is
now answered from the **lost claim**, under the write lock the transaction already holds.

**What the single-transaction claim actually rests on, and how it is checked.** The grant is called
from *inside* the transaction (`server/src/billsvc/delivery.ts`), and that is what makes the
decision above testable rather than assertable: a throwing grant rolls the order row, the receipt
row and the ledger row back together, the platform's next retry finds an open order, and the
connection stays usable. If the order row survived a failed grant, funny's saga would be necessary
here after all and this section would be wrong.

**Left open: nothing writes §2's `entitlements` table yet.** `ledgerOnlyDelivery` is the default,
under which the append-only ledger row *is* the delivery record — correct behaviour rather than a
stub, and replayable into `entitlements` later precisely because the ledger is append-only. Note
the tension this section glosses: §2 puts `entitlements` in the **control plane's** database file,
so "three tables in one SQLite file" does not hold across it and one `BEGIN IMMEDIATE` cannot span
it. Closing the loop is an internal call, and where it sits against that transaction boundary is an
open design question — not an oversight, and not something the ledger-only default hides.

## 5. IAP adapters and the dev stub — SHIPPED 2026-09-04

**Status: SHIPPED 2026-09-04** (ROADMAP 8.4), under `server/src/billsvc/iap/` with the second
fail-closed check in `server/src/billsvc/startupGuard.ts`. The four real adapters stop at
unverified, exactly as §9 says they must.

Shape borrowed from funny's `commercial/src/iap/`, which is a per-platform set of independent
functions behind one factory — CLAUDE.md's preferred split form, and it survived four platforms:

```
verifyReceipt(platform, receipt) -> { ok, product?, amountCents? }
```

One file per platform under `server/src/billsvc/iap/`, plus `devStub`. A factory reads credentials
from the environment and closes over a dispatch; a platform with no configured credentials returns
failure rather than throwing.

Two properties are non-negotiable, both taken verbatim from funny:

- **The dev stub is the reason the whole chain is testable with no merchant account.** Receipts
  prefixed `product:<sku>` resolve locally, so orders, idempotency, delivery and reconciliation
  can all be driven end to end before any real credential exists. It is a long-lived asset, not
  scaffolding.
- **Fail closed in production, twice.** With `NODE_ENV=production` the stub is disabled outright —
  it can be neither switched on by a mis-set env var nor fallen back to because credentials are
  missing; missing credentials mean verification fails and nothing is granted. The process also
  refuses to start with the dev flag set. One of those checks is the design; two is the design
  surviving a deploy.

**Where funny's assumption inverts.** funny sells a currency, so its verify result is
coins-first with a non-coin product as a secondary branch. Here there is no currency, so that
secondary branch is the *only* branch and the coin fields do not exist. The port is a
simplification, not a translation.

**As shipped, three notes.** The two fail-closed checks deliberately **share no code**:
`server/src/billsvc/iap/factory.ts` reads `NODE_ENV` before it reads `DDU_BILLING_DEV_STUB`, and
`server/src/billsvc/startupGuard.ts` carries its own copy of that three-line predicate. Importing one into the other is the obvious
tidy-up and it would make both defences one defence with two call sites, which is the failure
"twice over" exists to survive — so each has a test asserting its own copy. The stub resolves a
`product:` receipt on **any** platform while enabled, which is what makes `/webhook/apple` drivable
end to end with no Apple account; when it is off the same receipt falls through to the real adapter
and fails there, which is the correct answer and not a fallback in the other direction. And the
four real adapters each have exactly two outcomes, both failures and neither throwing (a missing
credential, and a round trip that is not implemented) — a platform that cannot be verified must not
report `ok`, and one unconfigured platform must not be able to 500 the shared webhook route for the
others.

## 6. Topology: `GameRegistry`, deferred but shaped now

The gameserver's rooms are in-process `Map`s driven by in-process intervals (`RoomManager.ts`), so
today there can be exactly one. That is fine — a frame-broadcast room is inherently a stateful
shard — but it is currently an accident rather than a decision, and the cheap moment to shape it
is before anything depends on `/find`'s response format.

funny's answer, adopted: a registry inside matchsvc where each gameserver **registers** its public
WS URL and capacity at startup, **heartbeats** its load, and is dropped after 30 s of silence;
`/find` picks the least-loaded healthy instance and returns its URL **in the response, not in the
ticket** — the ticket stays purely a seat authorization and never learns the topology. Two details
from funny that are the actual content:

- **A single-instance deployment does not register at all**; a configured static address seeds one
  entry. So this can land now as the static branch only, with the register/heartbeat routes unbuilt.
- **Registration retries indefinitely with capped backoff, but gives up immediately on a 4xx**, and
  heartbeats deliberately do *not* re-register. A heartbeat that silently re-registered would mask
  a failed startup registration; a registration that gave up on a network blip would leave the
  instance permanently invisible.

This supersedes the "put a gameserver id inside the ticket" sketch that preceded this doc.

## 7. Operations

None of this is optional once money moves; all of it is small if the schema anticipates it.

- **Log every webhook event, not just the successful one.** Keyed `${txnId}:${eventType}` so
  at-least-once redelivery upserts. funny's reason: failed and cancelled transactions are
  otherwise dropped silently by the handler, and "why did my payment not go through" then has no
  evidence behind it at all.
- **Reconciliation, daily.** Pull the platform's recent order list, compare against local
  `orders`. This is the check that covers the platform↔local tear §4 leaves open, and it is the
  reason the ledger is append-only.
- **A daily anomaly audit that files rather than acts.** Count non-`purchase` entitlement grants
  per account per day; anything over a threshold goes to a review list. funny's two audits
  (`coinAnomalyAudit`, `anticheatAudit`) share one principle worth stating here because it is the
  same one `design/15-pvp-arena.md`'s checkpoint quorum already follows: **with no evidence, skip
  — never convict.** No automatic revocation.
- **No admin service.** funny has a whole one. Here the requirement is weaker but real: the schema
  must be queryable and hand-correctable by a human with SQL, which is what `source` on an
  entitlement and an append-only ledger buy. Revisit when the first refund arrives.

## 8. Deliberately not built (all of these exist in funny)

| Not adopted | Why not here |
|---|---|
| Gateway separated from gameserver | funny's gateway carries presence, social and world traffic. This project's WS carries frames and nothing else. |
| Mongo, Redis, protobuf codegen, generated OpenAPI routes | Three processes, one client, and `@dd/engine`'s `ClientMsg`/`ServerMsg` is already the shared contract. |
| Wallet, currency, gacha, pity, subscription cards | `design/14-meta-forging.md` locks bounded direct purchase with no gacha. Importing the code would import the economy. |
| Channel-tagged balances | funny needs them because coins bought on the web may not be spent inside an iOS build (Apple's anti-circumvention terms). Selling SKUs rather than currency removes the problem — **and re-creates it the day a currency is introduced.** |
| Loki / Alloy / Grafana | The standing rule for porting observability from funny: its monitors exist to feed a sink this project does not have, so a literal port computes correct numbers and drops them. The logger *shape* — console line plus one JSON object per line, file sink only when a log dir is configured — is worth taking. |
| Social, auction, world, bot services | Other games. `BotClient.ts` already covers what is needed here. |

## 9. Open questions

- No WeChat or Apple merchant credentials exist anywhere in this project, so §5's real adapters
  cannot be verified past the dev stub. Which platform is first is a product decision.
- Whether `entitlements` should also absorb the **materials** half of `MetaState` (it is farmable,
  not purchasable, so it is only worth it if duplication-by-blob-replay turns out to matter).
- `ForgeActions.acquireBlueprint`'s `demo: free grant` scaffold (`design/14-meta-forging.md`,
  ROADMAP 2.4) is now a grant that survives until the next login and then vanishes, because the
  server answers `/account/meta` with its own table. It has to become a real purchase, or be
  hidden while a session is live. Left alone by §2's pass on purpose: which of the two is a
  product decision, not a server one.
- Refund handling is specified only to the extent of "the ledger is append-only and a reversal is
  a new row". What a revoked character does to a ladder history is unanswered.
- SQLite stays the answer until there are two control-plane processes. That, not revenue, is the
  signal to revisit.
