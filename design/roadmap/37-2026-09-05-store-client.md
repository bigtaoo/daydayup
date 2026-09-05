# Work log — 2026-09-05: the client buys through the billing plane

Volume 37. ROADMAP 8.8 — the client half of design/19 §4/§9's own open item, closed the same day
Phase 8's operational half (volume 35) and its topology piece (volume 34) landed.

Indexed from [`../ROADMAP.md`](../ROADMAP.md). Design account in
[`../19-server-platform.md`](../19-server-platform.md) §4/§9.

## The client buys through the billing plane (2026-09-05, client only, no engine bump)

### What was there

`ForgeActions.acquireBlueprint` (ROADMAP 2.4's monetization scaffolding) handed the player the
first purchasable blueprint for **free**, the moment the ACQUIRE button — or its `[B]` keyboard
shortcut — was pressed. That was always a scaffold, not a store: `design/19-server-platform.md`
§9 named the grant it produced as one that "survives until the next login and then vanishes",
because §2's server-side entitlements pass made `/account/meta` answer from its own table, and a
grant the client made to itself is invisible to it.

### What shipped

Four new client files, none of them touching `server/**`, `design/19`, or `ROADMAP.md` directly
during the pass — the wire protocol was pinned by the task rather than invented here, since the
matchsvc-side proxy for it is explicitly a later package:

- **`net/billing.ts`** — an injected-`fetch` wrapper over `GET /store/skus`, `POST /store/order`,
  `GET /store/order/:id`, shaped like `net/auth.ts`/`net/entitlements.ts`. Every response is parsed
  defensively: a SKU with no price is **dropped, not defaulted** (there is no fallback number here
  that is not a price the client invented), and `payment.configured` **fails closed** — anything
  that is not the literal boolean `true` means "this platform cannot take a payment", matching
  `server/src/billsvc/paymentParams.ts`'s own posture.
- **`platform/storePlatform.ts`** — the App-Store-3.1.1 gate. A web checkout inside an iOS build
  breaks Apple's anti-steering rule, and the WeChat mini-game has no merchant credentials to sell
  through either, so `detectStorePlatform()` returns `null` for both and the caller renders **no
  store entry at all**, not a disabled one. The `wx` check runs first and unconditionally, because
  the mini-game runtime injects DOM-shaped compat shims for libraries that probe for them
  (`game/match/gameQueryParams.ts` records the same trap with its always-empty `location.search`),
  so "has a document" alone would answer `true` there. `?store=dev` opts a web session into the
  server's dev stub — the one platform whose payment block is ever `configured: true`, and the only
  way to walk create → pay → webhook → delivered with nothing configured at all.
- **`controllers/StorePurchase.ts`** — the flow: list → order → poll → re-read ownership. Every
  dependency is injected, `sleep` included, so all eight outcomes (busy, not-logged-in,
  no-platform, not-configured, order-failed, payment-failed, timed-out, delivered) run with no
  network, no clock and no page. Two arms worth naming: `payment.configured === false` is reported
  as its own outcome and polls nothing, because the order is booked but nobody can pay for it and
  design/19's own reasoning is that a plausible-looking but unsigned payment block is a worse
  failure than an honest refusal; and a delivered purchase whose ownership re-read failed still
  reports **success** (`refreshed: false`), because the money moved and the entitlement exists —
  reusing `OnlineMatch.syncMetaWithSession`'s swallow-the-error shape here would have made that
  arm unreachable and told a paying player their purchase failed when it had not.
- **`screens/StoreScreen.ts`** — the screen. Every outcome code maps through an exhaustive
  `Record<..., TranslationKey>`, so a new code the flow can produce is a compile error here rather
  than silently falling through to generic copy. Rows render the server's `amountCents`/`currency`
  verbatim; nothing here derives, totals or discounts a price. A SKU already owned refuses locally
  before an order is booked — the one mistake on this screen that costs real money, since the
  server would happily take it for a second copy of something that grants nothing new.

### Where it plugs in

`Forge`'s ACQUIRE button and its `[B]` shortcut became STORE, opening a new `'store'` `Phase` —
a full phase rather than an overlay, because every forge key is guarded on
`phase === 'forge'` (`ForgeInput`), so a separate phase silences `[X] CLEAR LOADOUT` and the rest
of the table for free while a purchase is in flight, which an overlay would not. `gameAssembly.ts`
resolves the platform gate exactly once, at construction, and pushes it onto the Forge as a
`storeEnabled` flag; no screen decides for itself whether it may sell. `ForgeActions.acquireBlueprint`
is **deleted**, not deprecated — a guard test (`ForgeActions.test.ts`, "grants nothing for free")
drives every remaining forge verb and asserts none of them can widen what the account owns, so a
regression that reintroduced a free grant through some other path would still be caught.

### What is still open

The three routes the client calls do not exist on matchsvc — `net/billing.ts` is hardwired to a
protocol billsvc alone answers, on its own process and port, with no proxy in front of it yet.
Wiring `GET /store/skus` / `POST /store/order` / `GET /store/order/:id` through matchsvc, over
§3's internal trust seam, is the next package and the thing that makes this screen reach a real
account rather than `ERR_CONNECTION_REFUSED`. `design/19-server-platform.md` §9 is corrected to
say so.

### Tests

107 new client tests across four new test files, plus targeted updates to eleven existing ones
(`Forge.test.ts`, `ForgeActions.test.ts`, `ForgeInput.test.ts`, `ScreenFlow.test.ts`,
`ScreenNav.test.ts`, `gameWiring.test.ts`, `gameUiSound.test.ts`, `musicDirector.test.ts`,
`pureLayerBoundary.test.ts`, `viewportFit.test.ts`, `buttonCueConventions.test.ts`) whose fixtures
named the deleted `acquireBtn`/`onAcquire`/`acquireBlueprint` or needed a new `'store'` phase/screen
threaded through. Client suite 4933 → 5040 (241 files); `tsc --noEmit`, `check:filelength`,
`check:docpaths` and the 90/90 coverage gate all clean — `StorePurchase.ts` and `StoreScreen.ts`
land at 100%/95%+ lines/branches respectively, and `StorePurchase.ts` was added to
`pureLayerBoundary.ts`'s `PURE_FILES`: every dependency it has is injected, so the whole
create → poll → deliver chain — including its timed-out and delivered-but-unrefreshed arms — is
exercised with no network, no clock and no browser behind it.

Browser-verified against the real dev server: the STORE button renders only where
`storeEnabled` is true, `[B]` and the button both open the screen, and a guest reading it sees
"Log in first. Purchases belong to your account, not to this device." rather than a silent
no-op or a network error. One thing only the browser caught: `store.back`'s copy carried a `←`
glyph on top of the button's own `setIcon(icon_back)` arrow, rendering as "← ← FORGE" — fixed by
dropping the glyph from the string, matching `LoginScreen`'s bare-word back button.

### Left alone

- **The matchsvc-side `/store/*` proxy.** Named above — explicitly out of scope for this pass.
- **`meta/forge.ts`'s `acquireBlueprint`/`grantCharacter` exports.** Untouched. Only the
  `ForgeActions` controller wrapper that turned a button press into a free grant was deleted; the
  underlying transaction functions remain the reserved grant seam design/14/19 already describe,
  for whatever calls them once entitlement delivery reaches this side of the wire.
- **A character SKU.** `net/billing.ts`'s `SkuGrant` already carries `'character'` alongside
  `'blueprint'`, and `StoreScreen`'s owned-check and name lookup both handle it — but
  `server/src/billsvc/skus.ts` sells none yet, and which of the three launch characters is paid is
  still a product decision design/14 leaves to the store, not to this pass.
