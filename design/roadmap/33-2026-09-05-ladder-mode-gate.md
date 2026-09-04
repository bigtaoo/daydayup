# Work log — 2026-09-05: the ladder gate stops asking the players

Volume 32. A follow-up to Phase 8.1's internal trust seam, on the half of it that the key does not
cover: authentication settled *who* may write the ladder, and left *which settlements get written*
decided by data the client supplies.

Indexed from [`../ROADMAP.md`](../ROADMAP.md). Design account in
[`../19-server-platform.md`](../19-server-platform.md) §3, whose "What building it changed"
subsection now carries this as a dated amendment.

## The ladder gate stops asking the players (2026-09-05, server only, no engine bump)

### What was wrong

`server/src/index.ts`'s `reportSettledMatch` decided whether a settled match reaches matchsvc's
ladder with:

```ts
if (!MATCHSVC_URL || !match.hashOk || !match.placements || typeof match.winner !== 'number') return;
```

Three conditions, and only one of them is trusted.

`hashOk` is the room's own work: `MatchRoom.reportResult` compares every seat's end-of-match state
hash and sets it itself. `placements` and `winner` are not. They are `reports[0]`'s values —
relayed verbatim out of the seats' own `result` client messages, with `hashOk` saying only that
every seat sent the *same* hash, never that any of it describes a real match.

So `placements`-is-present was doing double duty. It is a legitimate precondition for
`buildRatingReportBody`, which needs the array to convert placements to ranks. It was also, per the
comment above it, the test for "was this actually a PvP match" — and that is a question the seats
were being allowed to answer about themselves.

The attack is short. Put four clients in a co-op/PvE room, play it out, and have all of them send
the same `stateHash` (they already agree — they ran the same deterministic sim) along with a
fabricated `placements` array and a numeric `winner`. `hashOk` is true, `placements` is present,
`winner` is a number, and matchsvc applies a rating change for a match nobody competed in. The
accounts moved are real: `seatAccounts` comes from the verified ticket, so the seats do not even
have to lie about who they are — only about what they were playing.

That it happens *through* an internal-key-gated route is the part worth naming. Volume 29 closed
the hole where anyone could `curl` the ladder. This one is the gameserver itself, correctly
authenticated, faithfully reporting what its clients told it.

### The room already knew

`MatchRoom` has had the answer since PvP landed. `MatchRoomDeps.mode` is set from the verified
ticket (`resolveSeat` → `RoomManager.join` → the room's constructor), `RoomManager.join` rejects a
joiner who disagrees about it, and `index.ts`'s own reconnect arm was already cross-checking
`existing.modeValue !== mode` to refuse a stale or foreign ticket. Every piece of the trusted
answer was in place; settlement just never consulted it.

It went unconsulted on purpose, and the comment said so — `reportResult`'s doc: "its presence, not
the room's own knowledge of match type, is what selects the `'placement'` reason — MatchRoom stays
generic infrastructure". That reasoning is sound for what it was written about. The `reason` string
in `match_over` is cosmetic, and deriving it from the payload keeps the room from needing to know
what a match type is. The mistake was letting a rule about a display string govern a decision with
ratings attached.

### The fix

`SettledMatch` gains `mode: MatchMode`, populated from `this.mode`, and the guard leads with it:

```ts
if (!MATCHSVC_URL || match.mode !== 'pvp' || !match.hashOk) return;
if (!match.placements || typeof match.winner !== 'number') return;
```

Four decisions inside that:

- **`placements` and `winner` stay in the guard.** They are still necessary —
  `buildRatingReportBody` needs both to be well-formed. What changes is what they are *asked*. They
  are no longer evidence of the match type; they are a shape check on the payload, and the split
  into two statements is there so the file reads that way.
- **`mode` is required, not optional.** `MatchRoom` is the only producer today and always has a
  mode, so nothing needs a default — and an optional field would mean a future producer that omits
  it gets `undefined`, which is not `'pvp'` and so happens to fail closed *by luck*. Required makes
  it a compile error instead. It found the one construction site immediately: the `settled()`
  helper in `index.lifecycle.test.ts`.
- **`MatchRoom` still imports nothing from matchsvc.** The property that made this design worth
  keeping is intact: `mode` was already in `MatchRoomDeps`, so the room reports a fact about itself
  and the entrypoint decides what that fact means. The room does not know there is a ladder.
- **The unstated-mode default stays `'coop'`.** `deps.mode ?? 'coop'` is what every pre-PvP caller
  and test gets, and it has to land on the side that does not report — a room built by a caller who
  never heard of modes must not be able to move ratings. That is now its own test rather than an
  implication of one.

### Tests

Five cases, and the point of each is which mutant it kills.

The `skips: %s` table in `index.lifecycle.test.ts` goes from four arms to five, the new row being a
co-op room. Its companion spells the attack out, because a `mode: 'coop'` row on its own reads like
bookkeeping: every field a seat controls is set to exactly what a genuine PvP settlement looks like
— agreed hash, numeric winner, well-formed `placements`, two logged-in `seatAccounts` — so the only
thing in the payload saying this is not a match is the room's ticket-derived mode. That is the
payload that shipped a rating change before this pass.

`MatchRoom.guards.test.ts` gets the producing half: a co-op room whose seats send a full PvP-shaped
result reports `mode: 'coop'` (and still relays the `placements` verbatim — the room labels where
the data came from, it does not silently drop fields), a pvp room reports `'pvp'`, and an unstated
mode reports `'coop'`. The second exists only as the control for the first: without it a `mode`
hardcoded to `'coop'` passes everything.

Mutation-checked in three directions, since every one of these tests would pass against a guard
that merely *looks* right:

| mutant | result |
| --- | --- |
| drop the `match.mode !== 'pvp'` arm from the guard | 2 failed — both new `index.lifecycle` cases |
| `mode: this.mode` → `mode: 'pvp'` in `onSettled` | 7 failed across both MatchRoom files |
| `mode: this.mode` → `mode: 'coop'` | 1 failed — the pvp control case, and nothing else |

The third is the useful one: exactly one test fails, and it is the one written to be the control.

Four whole-object `toEqual` assertions in `MatchRoom.test.ts` needed `mode: 'coop'` added, which is
the behaviour those assertions were written for — a settlement payload that gains a field silently
is how a consumer ends up reading a stale shape. One of their titles claimed the guest-only
`SettledMatch` was "byte-identical to pre-account behavior"; it no longer is, so the claim is gone
and what that case actually pins — `seatAccounts` absent rather than present-and-empty — is stated
instead.

Server suite 676 → 680 passing, all green; `tsc --noEmit` clean for engine, server and client;
`check:filelength` clean.

### Left alone

- **`match_over`'s `reason` still comes from the payload.** A co-op room whose clients send
  `placements` will show `reason: 'placement'` to those same clients. It is a cosmetic string on a
  message going back to the seats that authored the input, with nothing behind it, and changing it
  would alter client-visible co-op behaviour for no gain. The doc comment now distinguishes the two
  cases rather than stating the payload-derived rule as though it covered both.
- **`/rating/report` is still at-least-once.** Unchanged by this pass and still the next thing to do
  to this seam — see §3's own bullet on the dedupe key.
