# Work log — 2026-09-05: the delivery loop closes, through an outbox

Volume 32. The one thing volume 30 left open. ROADMAP 8.3 shipped the billing plane and
`EntitlementService.grant` had been sitting there since 8.2 with **no caller at all**: a
player could pay, get a `ledger` row, and own nothing. `ledgerOnlyDelivery` was the default,
and [`../19-server-platform.md`](../19-server-platform.md) §4 ended by naming the reason it
still was — not "nobody got to it", but a real question about **where the internal call sits
against the settlement transaction**, marked an open design question. This is that.

Indexed from [`../ROADMAP.md`](../ROADMAP.md) (8.7). Design account in
[`../19-server-platform.md`](../19-server-platform.md) §4, whose "Left open" paragraph is now
a "CLOSED" one that records the answer and its position relative to the transaction boundary.

## The delivery loop closes, through an outbox (2026-09-05, server only, no engine bump)

### The constraint that looked contradictory

`delivery.ts`'s seam is deliberately hostile to the obvious implementation, and its file
header says why: `grant` is **synchronous, `void`, and called from inside
`BEGIN IMMEDIATE`**, so that a throw rolls the order row, the receipt row and the ledger row
back together. That is what makes §4's "one transaction makes the tear impossible" testable
rather than assertable, and it is the whole argument for not copying funny's verify-and-heal
CAS saga.

And §2 puts `entitlements` in the **control plane's** database file. Different file, so no
transaction spans it, so the only way across is HTTP — which `grant` may not do.

Both halves are right, which is why the question was open rather than merely unanswered. The
tempting resolutions are both worse than they look:

- **Make the call from inside the transaction anyway.** It would hold SQLite's write lock
  across a network round trip, serialising every settlement in the process behind the slowest
  control-plane response — and it would *still* not be atomic with the remote write. The cost
  of the tear without the removal of it.
- **Make the call after COMMIT, from `settle`.** Then a process that dies in the gap has
  taken the money with nothing owed and nothing recorded, and no webhook is coming a second
  time. This is the failure the seam's synchronous signature exists to prevent, reintroduced
  one line later.

### The answer: what goes inside is a promise, not the delivery

The call sits strictly outside. What goes inside the transaction is a **durable obligation**
to make it — a fourth table in billsvc's own file:

```
deliveries(id, account_id, sku, grants_json, order_id, receipt_id,
           state, attempts, created_at, delivered_at)
  id = the LEDGER row's own `purchase:<platform>:<txn>`
  state: 'pending' | 'delivered' | 'failed'
```

`outbox.ts`'s `createOutboxDelivery` is one synchronous `INSERT`, on the settlement's own
connection, inside its transaction. §4's single-transaction claim therefore does not weaken —
it gains a fourth member, and after the COMMIT the promise is on disk. `ledgerOnlyDelivery`
stops being the default and stays as the explicit opt-out.

**The row's id is the ledger row's, not a minted one.** The ledger claim on that exact key was
won two statements earlier, so a duplicate `deliveries` row is impossible without a second
idempotency mechanism — and sharing the key makes `ledger LEFT JOIN deliveries USING (id)` the
one query that answers "which money moved without reaching an account", which is the
hand-auditability posture the other three tables were already shaped for. That required one
field on the seam (`EntitlementGrantRequest.ledgerId`): the grant now carries the claim its
caller just won, rather than being trusted to invent an equivalent one.

**The grants are frozen onto the row**, not looked up again at delivery time. A SKU edited
between the payment and a retried delivery must deliver what was paid for.

### At-least-once, and why that is the whole design rather than a compromise

`deliveryPump.ts` drains the table into `POST /internal/entitlements/grant`
(`routes/internalEntitlements.ts`) over 8.1's internal key. It cannot distinguish "the control
plane never saw it" from "the control plane answered and the answer was lost", so it retries,
so delivery is at-least-once.

That is safe **only** because 8.2 had already put `UNIQUE(account_id, sku)` on `entitlements`
and written `grant` as `INSERT ... ON CONFLICT DO NOTHING` + `changes()`. A redelivery grants
nothing twice and still answers 200, so the pump can retire its row off the second answer.
Without that property a coordinator would be unavoidable; with it, a two-phase commit buys
nothing and costs a distributed protocol. The receiving route also inherits 8.2's rule that a
re-grant never overwrites the first row's `source`/`order_id`, so a retry cannot rewrite the
audit record of the payment that caused it.

### Three triggers, because an interval alone is the wrong shape

1. **Opportunistically**, right after a settlement commits, from the webhook — and
   deliberately **not awaited**. The settlement is already durable, and making a platform
   callback wait on the control plane couples a request that must answer fast to a peer that
   may be down. This is the one that delivers a purchase while the player is still looking at
   the payment sheet.
2. **Once at startup** (`main.ts`). This is the only reason the table exists rather than a
   variable: a process that died between the COMMIT and the delivery left rows nothing will
   ever re-trigger, because the platform considers the payment done.
3. **A bounded interval** as the backstop, for a control plane that was down when 1 and 2 ran.

An interval alone would make every purchase wait a tick and would make delivery latency a
function of a tuning constant. A queue process is the infrastructure §8 declines to build.
Opportunistic-plus-backstop is what "no infrastructure the team does not need yet" looks like
when the work is genuinely asynchronous.

### The failure policy is where the branches are, and the two directions are opposite

- **4xx → terminal.** The control plane refused on purpose: an unknown account, a malformed
  body, a rejected key. Repeating it verbatim cannot change the answer. The row goes `failed`
  and is logged as an **error** naming the account, the SKU and the order, because money moved
  and nothing was granted and only a human can resolve that.
- **5xx, timeout, refused connection → still owed, forever.** No dead-letter, no attempt
  budget: abandoning the row loses a purchase that was paid for, while a peer that comes back
  heals every stuck row on the next sweep. `attempts` is the operator's signal, not a budget.

Getting that inverted is how an outbox either loses purchases or hammers a dead service, so it
is asserted three ways rather than commented. It is also why the receiving route's status
codes are load-bearing rather than cosmetic: an unknown account is checked with a `SELECT`
and answered **404**, while a failed *write* is answered **500** — telling those apart by
parsing a driver's error string is exactly what the rest of this plane refuses to do, and
flattening the second into a 4xx would discard a recoverable purchase.

Two smaller decisions worth recording. The route **refuses an empty grant list** rather than
treating it as a successful no-op: a 200 would let the pump retire the row and erase the only
evidence that a player paid for nothing. And an **unknown grant kind is refused, not skipped** —
skipping delivers a partial purchase and reports success, which is the shape that silently
loses half of a two-item SKU the day one exists.

### `config.ts` grew a truthful name rather than a convenient lie

billsvc needs a key for its outbound call. The registry today holds exactly one secret, filed
under `gameserver` because that was the first hop to need one, and `internalKeyFor('billsvc')`
correctly answers `undefined`. Asking for `internalKeyFor(INTERNAL_CALLER_GAMESERVER)` would
have worked and would have put a false caller name in the one place an audit line reads one, so
`sharedInternalKey()` names the fact instead: *today there is one key and all three processes
present it*. When the registry grows a key per caller, that function becomes
`internalKeyFor(INTERNAL_CALLER_BILLSVC)` and nothing else moves.

### Tests

**+73 cases — 63 in four new files, 10 added to three existing ones.** The server suite reads
**793** at this commit: 675 before Phase 8's 2026-09-05 passes, +45 from volume 31 (which landed
first, so it is already in the parent) and +73 here. Stated against the commit rather than against
`D:/daydayup`, which had two other sessions' uncommitted engine and client work in it all day and
so was never a tree that existed as a commit — the same correction volume 31 had to make. The split
across files is deliberate:
`billsvc.outbox.test.ts` drives the durable half through the **real `BillingService`** rather
than inserting rows, because the seam's entire claim is about what happens inside the
transaction; `billsvc.deliveryPump.test.ts` is almost all failure policy;
`routes.internalEntitlements.test.ts` runs against a real matchsvc on an ephemeral port,
because which status code a refusal carries only exists at that layer; and
`billsvc.deliveryLoop.test.ts` stands **two real processes on two ephemeral ports over two
separate SQLite files** and drives a dev-stub purchase from webhook to `GET /account/meta`.

Four properties only that last file can show: that the two database files really are separate
and the entitlement really does cross; that billsvc's outbound key (derived by
`sharedInternalKey`) is accepted by matchsvc's inbound verifier (derived by `internalKeys`) —
a mismatch is invisible in either half alone; that the billsvc SKU `bp.cannon` becomes the
entitlement sku `blueprint:cannon`, two namespaces meeting here and nowhere else; and that a
settlement whose delivery **could not** be made is still a settlement, with the money recorded
and the obligation completed by a later sweep.

The restart case is written twice on purpose, once per layer, because it is the only reason the
table exists and `:memory:` cannot show it: a real file, one connection writes the pending row
and closes, a second finds the obligation still owed.

The startup sweep needed a test that pins `start()` rather than one that merely calls
`pumpOnce()`. Pointing the pump at a port nothing listens on makes the *attempt* observable —
`attempts` climbing to 1 with the row still `pending` is evidence only `start()` could have
produced. Verified by deleting the `pump.start()` line: the test fails.

**A 12-mutant battery, 12 killed, both controls surviving.** The mutants were the decisions
rather than the syntax: invert the 4xx/5xx split, make nothing terminal, drop the attempt
count, remove the `AND state = 'pending'` guard from both `mark*` writes, turn the outbox
insert from a claim into a plain INSERT, make an unknown account retryable, accept an empty
grant list, silently skip `character` grants, flatten a failed write into a 400, revert the
process default to ledger-only, and remove the opportunistic sweep. The two controls (a batch-
size tuning constant and a log wording nothing matches) both survived, which is what says the
battery was real.

100% lines **and** branches on every new file; server-wide 99.53% lines / 97.24% branches — measured with `server/` on disk byte-identical to this commit, which `git status` confirmed before the run.

### Still open

Nothing in this loop. The tear between the **platform** and the local transaction was never
§4's to close and is unchanged — that is §7's reconciliation, which is still 8.5. The four real
IAP adapters still stop at unverified because no merchant credential exists anywhere in this
project (§9), so the only chain that can be driven end to end today is the dev stub's — which
is exactly what §5 says the stub is for.
