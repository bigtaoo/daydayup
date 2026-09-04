# Work log — 2026-09-04: entitlements move out of the blob

Volume 28, and Phase 8's package **8.2** ([`../19-server-platform.md`](../19-server-platform.md)
§2) — the second of the three server-platform packages built in parallel worktrees on top of
[volume 25](25-2026-09-04-matchsvc-routes.md)'s `routes/*` split, which exists precisely so this
one and 8.1 could be written at the same time without touching the same file.

Indexed from [`../ROADMAP.md`](../ROADMAP.md).

## Entitlements own the purchasable half of MetaState (2026-09-04, server + client, no engine bump)

`POST /account/meta` was a blind whole-blob upsert — `INSERT ... ON CONFLICT DO UPDATE SET data =
excluded.data`, with the only validation being that a `data` key is present. That was the right
call, and `design/16-accounts.md` says so outright: `MetaState` was a localStorage mirror and
nothing in it was worth money.

It stops being the right call the moment blueprints and characters are sold. A logged-in `curl`
with nothing but a valid session could hand itself the entire paid roster — and characters are the
one meta axis that reaches PvP (`design/14-meta-forging.md`), so the hole is not only economic.

### The fix is not to validate the blob

That is whack-a-mole, and the blob is exactly the wrong place to fight: every field in it is
legitimately client-authored except two. So the two move out.

```
entitlements(id, account_id, sku, source, order_id, granted_at)
  UNIQUE(account_id, sku)
  CHECK (source IN ('purchase','grant','event','starter','drop'))
  CHECK (source <> 'purchase' OR order_id IS NOT NULL)
```

`meta_state` keeps materials, loadout, in-progress forge state — everything the client is
*supposed* to author — and stays a whole-blob upsert. `GET /account/meta` overwrites the two
ownership fields in the returned blob from this table; `POST` **strips** them before storing.

Ignored, not rejected, and that distinction is the whole reason nothing broke: an older client, a
guest promoting its local save, and an offline replay all POST the full `MetaState`, and every one
of them has to keep succeeding. Stripping on *write* rather than only overwriting on *read* is the
smaller decision with the larger payoff — `meta_state` then never holds a client-authored
ownership claim at all, so whoever reads that table with SQL later cannot be misled by one.

### Three things the schema decides that the plan had left open

**SKUs are namespaced, not split across two tables.** `blueprint:<weaponId>` and
`character:<skinId>`. One `UNIQUE(account_id, sku)` covers both, a blueprint id can never collide
with a skin id, and `WHERE sku LIKE 'character:%'` is the entire query design/19 §7's
"hand-correctable with SQL, because there is no admin service" requirement needs. That §7 audit —
count the non-`purchase` grants per account per day — is one `GROUP BY`, and the test suite runs it
as SQL rather than asserting that it could be written.

**This table takes the foreign key `ratings` deliberately refuses, and the contrast is the point.**
`db.ts` already carried a comment explaining why `ratings.account_id` has no FK: a rating key is
any opaque id `ladderReport.ts` hands over, including a guest/bot `seat:{roomId}:{seatIdx}`
scaffold that has no `accounts` row and never will. The obvious move was to copy that reasoning
across. It does not transfer: an entitlement is only ever minted for a real logged-in account, and
a guest has **no row here at all** — which is also what makes "a guest is byte-identical to today"
true. So there is no legitimate id that could fail the constraint, and `node:sqlite` enforcing
foreign keys by default becomes an asset rather than the hazard it was for `ratings`: a
hand-issued row for a typo'd account id fails loudly at the prompt instead of becoming an orphan
that silently never delivers.

**A `'purchase'` with no `order_id` is refused by a CHECK.** A paid entitlement with nothing behind
it is unauditable, and §7's reconciliation — the check that covers the platform↔local tear
`BEGIN IMMEDIATE` cannot close — could never match it to anything.

`grant()` is `INSERT ... ON CONFLICT DO NOTHING` followed by reading `changes`, never
SELECT-then-INSERT, because platform callbacks are at-least-once by contract and the UNIQUE
constraint has to be the idempotency key. A re-grant is a no-op rather than an update: the *first*
grant's `source` and `order_id` are the audit record, and letting a later call overwrite them would
let a free hand-issue erase the paid order that preceded it.

### The client change is one optional argument, and the interesting part is why

The brief asked that the Forge not flicker or roll back across a login. It does not, and the
reason is that the property was already structural — it just had to be recognized rather than
built. `meta/store.ts`'s `migrate()` unions `STARTER_BLUEPRINTS` and `FREE_CHARACTERS` back in on
every load, and the server returns **empty** ownership arrays for every account that exists today.
So ownership before and after a login is identical, and nothing under `client/src/game/` needed to
change at all. That is asserted directly rather than inferred.

What *does* disappear is ownership the client granted itself — which is the hole. See "what this
leaves open" below.

`pullAccountMeta` gained an optional third argument, `local`, used **only** on the
brand-new-account branch where `data` is `null`. There the server has no blob to be authoritative
over yet, so applying entitlements additively on top of local state is the correct reading, and it
means a purchase made before this account's first save lands on the first login instead of the
second. Omitting the argument is byte-for-byte the pre-8.2 behaviour, which is why
`OnlineMatch.ts` compiles untouched.

`client/src/net/entitlements.ts` is the new client half: the wire read, a defensive parse, and the
same skip-unknown-namespace projection the server uses. The parse distrusts the response the way
`migrate()` distrusts a localStorage save, for the same reason — this payload now decides what the
player owns, and what reaches it is a server that may be older or newer than the build plus
whatever a proxy substitutes on a bad day. A malformed entry is dropped **on its own**; the test
for that puts the bad entry both before and after the good one, because a parser that bailed on
the first bad entry would still pass a test that only put it last.

### One round trip, and no edit to the dispatch chain

`GET /account/meta` returns `{ data, entitlements }` rather than gaining a sibling
`/account/entitlements` route. Two reasons, one of them scheduling: a new route needs a line in
`matchsvc.ts`'s dispatch chain, and 8.1 was landing in that same file from a parallel worktree.
The only edit this pass makes there is a single doc-comment line in the route map. The other
reason is that a client asking "what do I own" always also wants "and what is my meta state", so
the second call would have been pure latency.

`order_id` is deliberately not on the wire. It addresses a row in billsvc's private database and
the client has no use for it.

### Verification

`npm run check`, `npm run coverage` and `npm run check:logic` all green. **100% lines and 100%
branches** on all four changed or new source files — `EntitlementService.ts`, `routes/account.ts`,
`net/entitlements.ts`, `meta/accountSync.ts`.

The branch column is the one that had to be earned, and the tests that earn it are the refusals and
the absent-field fallbacks: the FK refusal and both CHECK refusals asserted against their real
error text rather than a bare `toThrow()`, the redelivered grant returning `false` without
touching the first row's `source`, the non-object blobs (`"a string"`, `null`, `[1,2]`) a pre-8.2
server accepted and stored and which can therefore still be sitting in a real database, the
pre-8.2 server that answers with no `entitlements` field at all, and the global-`fetch` arm every
other test in the file injects past. Server suite 311 → 374; client +40.

### What this leaves open, named rather than implied

- **Nothing calls `grant()` yet.** Delivery is billsvc's job (design/19 §4) through an
  internal-key-authed route (§3). `EntitlementService.owns()` exists and is tested, but no PvP
  character gate consults it — that is `routes/match.ts` validating a `skinId` at `/find`, and it
  is what actually closes design/14's "the one meta axis that reaches PvP".
- **`ForgeActions.acquireBlueprint`'s `demo: free grant` scaffold** (ROADMAP 2.4) is now a grant
  that survives until the next login and then quietly vanishes. It should be gated on `getSession()`
  or routed through a real purchase. Left alone deliberately — which of the two is a product
  decision, and the file belongs to the Forge, not to this seam.
- **`OnlineMatch.syncMetaWithSession`** should pass `d.run.meta` as `pullAccountMeta`'s third
  argument to get a first-login delivery. One line, fully backward compatible.
- **`net/auth.ts`'s `fetchAccountMeta`** now has no production caller; `fetchAccountState` reads
  the same route and keeps the field it discarded.
