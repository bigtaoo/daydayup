# Work log — 2026-09-04: matchsvc's dispatch chain gets five files

Volume 25, and the first of the Phase 8 server-platform packages
([`../19-server-platform.md`](../19-server-platform.md)) — the only one of them that ships no
feature at all. It exists so that 8.1 and 8.2 can be built at the same time without editing the
same file.

Indexed from [`../ROADMAP.md`](../ROADMAP.md).

## The dispatch chain gets five files (2026-09-04, server only, no engine bump)

`server/src/matchsvc.ts` was 431 lines, and `server/scripts/file-length-baseline.json` is empty
**on purpose** — the entry in it is a `_readme` saying so, precisely so that any file crossing 500
lines fails outright rather than being grandfathered. Phase 8's 8.1 (the internal-key trust seam
in front of `/rating/report`) and 8.2 (entitlements out of the `/account/meta` blob) both add
routes to that file. Two of them arriving at 431 lines is how a baseline stops being a gate.

The second reason is the one that actually set the schedule: 8.1 and 8.2 are being built in
parallel worktrees. Before this pass they would both have been editing the same 431-line if/else
chain; after it, one owns `routes/rating.ts` and the other owns `routes/account.ts`.

### Form 1, and it is not a close call

CLAUDE.md's split order puts *independent function modules* first, composition second, an
inheritance chain last. `matchsvc.ts` is the textbook case for the first: a linear `if/else` over
handlers that share **no** private state — every one of them reads the request, calls exactly one
injected service, and writes a response. There was nothing to compose and nothing to inherit.

Five groups by surface, each a set of free `(req, res, url, deps)` functions with its own narrow
`*RouteDeps` interface:

| File | Surface | Deps it names |
|---|---|---|
| `../../server/src/routes/auth.ts` | `/auth/register` `login` `logout` `me` `change-password`, plus `requireAuth` | `auth` |
| `../../server/src/routes/account.ts` | `GET`/`POST /account/meta` — 8.2's seam | `auth`, `db` |
| `../../server/src/routes/match.ts` | `POST /find`, `GET /find/:id`, `POST /resume` | `matchmaker`, `withUrl`, `secret` |
| `../../server/src/routes/party.ts` | the five `/party/*` routes, plus the join-code generator | `parties` |
| `../../server/src/routes/rating.ts` | `POST /rating/report` — 8.1's seam — and `GET /rating/:id` | `ratings` |
| `../../server/src/routes/http.ts` | the CORS block, `send`, `readJson`, the `RouteHandler` shape | — |

`matchsvc.ts` keeps only what an assembly shell should: the service construction, the PvP
bot-fill hook, `/health`, the dispatch chain, and `main()`. **431 → 213 lines**, no new file over
100.

### The one place the plan had to bend: `send` cannot stay in the shell

The obvious reading is that `CORS`/`send`/`readJson` stay in `matchsvc.ts`, since they are shared
and belong to nobody. They cannot. A handler in `routes/` importing `send` back from
`matchsvc.ts` is exactly the sibling→shell import CLAUDE.md forbids — `matchsvc → routes/auth →
matchsvc` is a cycle, and ESM tolerating it (hoisted function declarations) does not make it
allowed. The alternative, injecting `send` and `readJson` through each group's `deps`, makes every
handler runtime-dependent on a static helper for no gain.

So they sit in `routes/http.ts`, one layer **below** the handlers, importing no service and no
route. The rule the split leaves behind: a shared primitive goes underneath the siblings, never
in the shell they assemble.

That file is also where `access-control-allow-headers: content-type, authorization` now lives.
Dropping `authorization` from it is design/16-accounts.md's browser-preflight-only bug — invisible
to node's `fetch`, to `curl`, and to every unit test, surfacing client-side as a bare "Failed to
fetch" with no server log. It carried a comment saying so before this pass and still does; what
is new is that `routes.test.ts` asserts it on the constant **and** on a real response, so moving
the constant again cannot quietly drop it.

### The one mechanic that genuinely changed

Everything else is a verbatim move. The exception is the three `/:param` routes. The shell used to
capture the parameter (`url.pathname.match(/^\/find\/([^/]+)$/)`) and the handler body read the
capture out of the closure. Now each group **exports its pattern** (`FIND_POLL_PATH`,
`PARTY_LOOKUP_PATH`, `RATING_LOOKUP_PATH`), the shell matches on it to dispatch, and the handler
re-matches it to extract — so no positional capture crosses the boundary and the handler shape
stays uniform for 8.1/8.2 to copy.

That is a real behavioural surface: a handler reading the wrong group, or forgetting
`decodeURIComponent`, still answers `200` with plausible JSON. Hence three tests that assert
which decoded string reached the service, one of them on a `seat:{roomId}:{seatIdx}` guest rating
key, whose colons arrive percent-encoded.

The exported patterns also document an ordering constraint that used to be implicit in the chain:
`RATING_LOOKUP_PATH` matches `/rating/report` and `PARTY_LOOKUP_PATH` matches `/party/create`, so
the `POST` routes have to be checked first. Two tests state that out loud.

### What the 26 new tests are for

`server/test/routes.test.ts`. Not a re-test of the routes — the two real-HTTP suites
(`matchsvc.http.test.ts`, `matchsvc.queue.http.test.ts`) already drive every handler through a
real `node:http` server on an ephemeral port, and they are the reason this split could be called
behaviour-preserving at all: **all 285 pre-existing server tests passed with not one character
changed.** A test that had to be edited would have been the finding.

What the new file covers is the set of paths a real request cannot easily produce, all of which
were uncovered *before* the split too:

- `readJson`'s three non-happy exits. The interesting one is the 4 KB cap: the assertion is that a
  first chunk which is already a complete valid body still parses **after** a 5000-byte tail
  arrives, which is the only case that distinguishes "drop the overflow tail" from "reject the
  request" — every other oversized-body test answers `{}` under both.
- `requireAuth`'s two refusals, asserting the session store is *never consulted* rather than just
  that `null` came back, plus that it passes the token and not the whole header value.
- `POST /auth/logout` with a non-string token — the fallback arm of that handler's only `if`. A
  logout must never 4xx: the client whose token is already garbage is the one trying hardest to
  log out.
- `randomCode`'s alphabet. The comment has always said no `0/O/1/I` because a player reads the
  code to a friend; nothing pinned it. 500 draws, and the assertion that all 32 glyphs appear —
  a generator stuck on a subset shows up as a shortfall.

Four mutants, one each: drop `decodeURIComponent`, drop `authorization` from CORS, turn the
tail-drop into an abort, shrink the code alphabet. All four killed.

### Numbers

| | before | after |
|---|---|---|
| `matchsvc.ts` | 431 lines | 213 |
| largest server source file in the split | — | 94 (`routes/match.ts`) |
| server tests | 285 | 311 |
| server coverage (lines / branches) | 99.32% / 95.44% | 99.34% / 95.61% |
| files in the server coverage scope | 14 | 20 |

`createMatchsvcServer` and `MatchsvcServerOptions` keep their exact signatures; `index.ts` and
both HTTP suites import them unchanged. `matchsvc.ts`'s only uncovered lines are still `main()`
and the run-directly guard, exactly as before.

## Side finding: `#!` + CRLF is what breaks a fresh worktree's gates

Unrelated to the split, but it cost two earlier passes and is now settled, so it is written down
here rather than lost again.

A newly created worktree on this machine (`core.autocrlf=true`) fails `npm run check` in two
places that have nothing to do with the change under test: `tools/png-pipeline`'s
`alphaClamp.test.mjs` / `lumaCurve.test.mjs`, and — the part nobody had noticed — **four
`build/*.test.mjs` files in the root test leg**, which is the last thing `check` runs, after
~7000 green tests. All of them die as a bare `SyntaxError: Invalid or unexpected token` with no
stack, on files git reports as unmodified.

The rule is: **a file whose first two bytes are `#!` and whose line endings are CRLF dies in
vitest's transform**, and the poison is in the *imported module*, not in the test. That is what
made the earlier measurements look contradictory and produced a "no per-file theory survives"
verdict: `alphaClamp.mjs` and `lumaCurve.mjs` both open `#!/usr/bin/env node`, so their tests
fail; `pngCodec.mjs` opens `/*`, so `pngCodec.test.mjs` passes even when CRLF itself; and
`lumaCurve.test.mjs` being byte-identical in both checkouts never mattered, because the broken
file was never the test. Seven `build/*.mjs` are shebanged, which is the second cluster.

It is fixable in about ten files — rewrite `\r\n` → `\n` in every source file starting with `#!` —
after which `check` and `coverage` both go green. Git then reports those files as ` M` (it wants
CRLF back), so they are working-tree-only noise and must never be staged.

What **not** to do: `git config core.autocrlf input` to prevent it. A `git config` run from inside
a linked worktree writes to the **shared** `.git/config`, silently reconfiguring `D:/daydayup` for
whatever other session is working there.
