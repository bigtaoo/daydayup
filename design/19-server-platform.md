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
Planned modules (`server/src/internalAuth`) and sibling-project paths (funny's
`shared/src/internalFetch`) are written **without** one, so `checkDocPaths.mjs` reads them as
prose rather than as claims about this tree. Add the extension when the file lands.

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
part is correct and is not changed here. Two things around it are not:

- **D1 — `/rating/report` is unauthenticated.** It is called by the gameserver and by nothing
  else, but it has no key, no origin check, and open CORS. Any client can POST arbitrary ladder
  placements for any `accountId`. Fixed by §4.
- **D2 — the outbound report never drains its response body.** `reportSettledMatch` in `index.ts`
  is `fetch(...).catch(() => {})`. funny shipped that exact shape and measured the consequence
  under a concurrent burst: unconsumed undici bodies keep their sockets checked out, the
  keep-alive pool jams, and every request fails with `fetch failed` ~30 s later — so *none* of
  them arrived. Low PvP settlement volume is the only reason this has not bitten. Fixed by §4.

Neither defect involves billing. Both should be fixed first.

## 2. Entitlements move server-side

Today `/account/meta` (`server/src/routes/account.ts`) is a blind whole-blob upsert:
`INSERT ... ON CONFLICT DO UPDATE SET
data = excluded.data`, with the only validation being that a `data` key is present. That was the
right call when `MetaState` was a localStorage mirror (`design/16-accounts.md` says so) and
nothing in it was worth money.

The fix is not to validate the blob — that is whack-a-mole. It is to move the two account-level,
purchasable things out of it:

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

`source` is not decoration. It is what makes the operational work in §8 possible — a daily audit
of non-`purchase` grants, and a support path that can hand-issue one and have it look different
from a paid one afterwards.

## 3. The internal trust seam

Borrowed from funny's `shared/src/internalAuth` and `shared/src/internalFetch`, cut down.

**Inbound** (`server/src/internalAuth`): an `x-internal-key` header compared with
`timingSafeEqual`, plus an advisory `x-internal-caller` for logs. funny's per-caller key registry
(one key per calling service, independently rotatable) is the right end state but is not worth it
at three processes — keep the *shape* (a verifier object built from a registry that currently has
one entry) so adding the registry later is not a rewrite. This is a third namespace, deliberately
distinct from player bearer sessions and from the `ticket.ts` HMAC: internal routes never accept a
player token, and the mismatch is structural rather than a check.

Applies to `/rating/report` (D1, `server/src/routes/rating.ts`) immediately, and to every
`billsvc` route except the platform
webhook, which is authenticated by the platform's own signature instead.

**Outbound** (`server/src/internalFetch`): one helper that every cross-service call goes through,
which cannot forget the three things a bare `fetch` forgets:

1. **always drain or cancel the response body**, even when the real answer arrives elsewhere (D2);
2. **an explicit per-attempt timeout** — undici's `fetch` has no default, so a stuck socket hangs
   for tens of seconds instead of failing fast;
3. **bounded retry only for calls that are idempotent and not self-healing.** A settlement report
   is worth retrying; a periodic heartbeat is not, because the next tick re-sends it.

## 4. Billing: the data model

Three tables in `billsvc`'s **own** SQLite file (`DDU_BILLING_DB_PATH`), never the account DB:

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
between the **platform** and the local transaction. That is what §8's reconciliation covers.

## 5. IAP adapters and the dev stub

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
- Refund handling is specified only to the extent of "the ledger is append-only and a reversal is
  a new row". What a revoked character does to a ladder history is unanswered.
- SQLite stays the answer until there are two control-plane processes. That, not revenue, is the
  signal to revisit.
