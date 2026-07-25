# Netcode & determinism

How DayDayUp goes online. This is the single source of truth for the simulation-core / netcode split. It mirrors the proven architecture of the sibling project **funny** (`C:\Users\TaoWang\Documents\funny`, Notebook Wars) — a shipping TS+PixiJS deterministic-lockstep game on the same platforms (Web / WeChat) — and records where DayDayUp must diverge because it is a **real-time twin-stick shooter**, not a turn-based game.

## The decision (locked)

- **Model:** server-driven frame-broadcast lockstep (帧转发服务器, the 王者荣耀 pattern) + **client-side prediction of the local player only**.
- **Not** peer-to-peer lockstep, and **not** full peer rollback (GGPO-style).
- **Simulation runs on a shared deterministic engine** consumed identically by client (prediction/render) and server (authority/replay), reusing funny's `@nw/engine` blueprint.

### Why this and not the alternatives

| Model | Verdict for DayDayUp |
|-------|----------------------|
| Peer lockstep (wait for slowest) | ✗ Packet loss freezes the whole match; unacceptable for action. |
| **Server frame-broadcast lockstep** | ✓ Server is the clock, **never waits for a client**; a lagging player falls behind and catches up alone. Scales to 5v5+ (王者荣耀 proves it), so 3v3/4v4 is comfortable. |
| Full peer rollback | ✗ Built for 2-player fighting games. In a bullet-hell with 6–8 players, re-simulating N frames × many entities blows the frame budget on low-end phones / WeChat. |
| Server-authoritative + state sync | Best anti-cheat & scaling, but heaviest to build and wastes the deterministic-engine investment. Kept as a **later escalation path** if competitive PvP demands it. |

Match scope driving this: **PvP is 3v3 / 4v4, positioned casual-first.** Casual tolerance means the inherent maphack weakness of client-held full state is acceptable for launch (mitigation below).

## Two layers, kept strictly separate

```
┌─────────────────────────────────────────────────┐
│  @dd/engine  — deterministic simulation core     │  ← no Pixi, no DOM, headless-runnable
│  fixed-point math · injected PRNG · fixed tick    │
│  InputSource · systems · GameState (plain data)   │
└─────────────────────────────────────────────────┘
        ▲ reads state, interpolates      ▲ drives authority, replays
┌───────────────────┐          ┌──────────────────────────┐
│  client render     │          │  server (frame broadcast, │
│  (Pixi, this repo) │          │   headless authority)      │
└───────────────────┘          └──────────────────────────┘
```

The engine is the **only** code that decides game outcomes. The render layer and the server both sit *outside* it and only touch its public surface. This is funny's SLG_DESIGN §16.7 lesson: they had two hand-mirrored copies of the logic (client + server) that inevitably drifted and desynced, and had to extract `@nw/engine` to kill it. **We build it extracted from day one.**

## The deterministic core (`@dd/engine`)

Package layout mirrors funny's `server/engine/`; client references it via webpack alias + `tsconfig` paths, server via npm-workspace dependency. Same bytes on both sides.

### Fixed-point arithmetic — mandatory

Floating point is **not** bit-identical across JS engines (WeChat runs JavaScriptCore on iOS, V8 on Android; browsers differ). Any divergence → desync. So the logic layer never touches native floats.

Adopt funny's `math/fixed.ts` almost verbatim:

- `FP_SCALE = 1000`, one grid unit = 1000 fp integer units.
- A **branded `Fp` type** so TypeScript rejects assigning a raw `number` to an fp field at compile time.
- Helpers `toFp / fp / addFp / subFp / mulFp / scaleFp / negFp`; `fromFp` is **render-layer only**.
- **Integer `isqrt`** (bit-by-bit) for distances — never `Math.sqrt`.

### Deterministic trig — the twin-stick-specific hazard

funny's units advance along grid columns, so it barely needs trig. **DayDayUp fires bullets at arbitrary angles**, so `Math.atan2 / cos / sin` are everywhere in the current demo (`Game.ts` facing, bullet velocity, block-arc test). These are float and platform-divergent — they must leave the logic layer:

- **Quantize aim on input.** A `PlayerCommand` carries the aim as an **integer angle** (e.g. `0..65535` binary-radians, "brad"), not a float. This makes the input itself deterministic and compact on the wire.
- **Fixed-point trig tables.** `cos_fp(brad) / sin_fp(brad)` via a precomputed integer lookup table (+ interpolation in fp). Bullet velocity, facing, and block-arc all derive from these.
- Angle math (differences, arcs) done in the integer brad space, not radians.

> This is the single biggest new determinism surface vs funny. Design the fp-trig + brad-angle module early; the whole weapon/ballistics system depends on it.

### Deterministic RNG

funny's `math/prng.ts`: an LCG (`Math.imul`-based, uint32), `Math.random()` banned in logic. Reused as-is. **Injected instances** (each subsystem/roomgen holds its own seeded `Prng`), never a global — so drop tables, bullet-spread jitter, and dungeon generation are all reproducible from `seed + input stream`.

### Fixed tick + the loop

- Logic tick **30 Hz** (match funny's `TICK_RATE`); render runs at display rate (60 fps) and **interpolates** between the last two sim states.
- Loop is the accumulator pattern from funny's `engine/loop.ts`, including its **catch-up multiplier** (backlog >1 s/10 s/30 s → 2×/3×/5×) and `MAX_CATCHUP_TICKS` spiral guard. This is *exactly* the "lagging client falls behind the broadcast and speeds up to resync" behavior we need — already written.

### Banned in the logic layer (enforced)

`Math.random()` · `Date.now()` / `new Date()` · native float in stored state · `Math.sqrt/sin/cos/atan2` · iteration over `Set`/`Map`/`Object.keys` in a way that leaks insertion/hash order into state · variable `dt`. All arithmetic goes through fp helpers; all randomness through injected `Prng`; all angles through brad + fp-trig tables.

## Netcode model in detail

### Server as frame broadcaster

- The server owns a fixed-rate clock. Every tick it **broadcasts one frame packet** to all clients in the match: the set of player commands it has received for that frame, or an **empty frame (frame number only)** if none arrived.
- The server **does not wait** for any client. Late-arriving input is folded into a later frame (or dropped past a deadline). One player's bad network never stalls anyone else.
- Clients advance their sim strictly by the confirmed frame stream. A client behind the broadcast uses the catch-up multiplier to resync.

### Unified input pipeline (funny's `InputSource`)

The engine pulls the confirmed command set per tick from an abstract `InputSource`, agnostic to origin — so single-player, online, and replay share **one** logic path:

| Impl | Used for | Command source |
|------|----------|----------------|
| `LocalInputSource` | single-player PvE / practice | self-forward, 0 delay |
| `NetInputSource` | online PvE/PvP | server `frame_batch`; `take(frame)` returns `null` until confirmed |
| `ReplayInputSource` | replay / headless re-judge | recorded frames |

### Client-side prediction (the twin-stick feel fix)

Frame-broadcast alone leaves **local input delay ≈ one RTT** (your press must reach the server, get framed, and broadcast back). Fine for turn-based, mushy for a shooter. Fix:

- The client **predicts its own actor immediately** — local movement, aim, and firing apply the instant the input is read, running the shared engine ahead of the confirmed frame with the local input filled in.
- When the authoritative frame arrives, the client **reconciles**: if the confirmed input matches what it predicted (the common case, since it's your own input), nothing visible happens; on mismatch it rolls its *own* actor back to the confirmed state and replays.
- **Scope is the local player only.** Other players and enemies are shown from confirmed frames (with short interpolation). This is "rollback scoped to your own input" — an order of magnitude cheaper than peer rollback, and enough for casual 3v3/4v4.
- Remote bullets/enemies may pop slightly on correction; acceptable at this positioning.

### PvE vs PvP

- **PvP (3v3/4v4):** the full model above.
- **PvE (co-op boss):** same transport, but cooperative and latency-tolerant. Can start as `LocalInputSource` single-player (validate feel first), then the same `NetInputSource` broadcast for co-op. Enemy/boss AI runs *inside* the deterministic engine off injected PRNG (like funny's `AISystem` / `WaveDirector`), so it stays identical on every client.

## Anti-cheat posture

Frame-broadcast lockstep means **every client holds full match state** → maphack/wallhack is inherently possible. Given casual-first PvP:

1. **Launch:** accept it. No ranked integrity promised.
2. **Backstop:** `runHeadless` (funny's headless driver) can **re-simulate a finished match from `seed + recorded input`** server-side and compare the reported outcome — post-match validation / ban tooling, no realtime cost. (funny uses this exact path for authoritative siege, ADR-007.)
3. **Escalation (only if competitive PvP is ever added):** move to server-authoritative state sync with fog-of-war culling. The deterministic engine is reusable there too — the engine investment is never wasted.

## Persistent vs in-run state

Follow funny's split (ADR-002): **in-run resources/drops are engine state, wiped each match; persistent progression is server-authoritative meta**, loaded into the engine as initial config at match start. In DayDayUp's concrete form (`05`/`14`) the persistent side is **materials** (banked out of a run) plus the **account-level blueprint and character unlocks** they (or purchase) buy; the brought-in loadout weapon is *crafted* from an unlocked blueprint + materials at match start but, like every weapon, is itself wiped at run end (`05` "weapons are ephemeral; materials are the only carry-out"). The architecture is unchanged — meta in as initial config, in-run state out each match. Rewards are recomputed server-side, never trusted from the client (funny ADR-006). The fairness split (`14`): crafted weapons are compile-time barred from PvP, only character choice reaches it — so persistent meta never becomes a PvP power ladder, keeping casual-first intact under a bounded, no-gacha monetization model.

## Numbers live in one place

All balance/config numbers live in the engine (funny's ADR-001: `config.ts` inside `@nw/engine`, client reads via alias). Prose docs only snapshot them with a date. Prevents the "same number, four different values across four docs" drift funny hit.

## Migrating the current demo

The vertical slice (`client/src/game/`) is float + variable-`dt` + logic-fused-into-Pixi (`Actor`/`Enemy`/`Bullet` **are** `Container`s; state lives in display objects; `sync()` copies to Pixi x/y). Refactor in phases — do not bolt netcode on before the split:

1. **Split state from view.** Introduce plain-data sim entities (no Pixi) inside `@dd/engine`; the render layer owns Pixi objects that *read* sim state each frame. `sync()` becomes the render layer's job. Existing `01-rendering` tricks (Y-sort, height/shadow, per-weapon z) stay in the render layer unchanged — they read `gx/gy/z` off sim state.
2. **Fixed timestep.** Replace `ticker.deltaTime` variable stepping with the 30 Hz accumulator loop; render interpolates.
3. **Fixed-point + brad-angle + fp-trig.** Convert movement, facing, ballistics, collision, block-arc from float to fp; move `atan2/cos/sin` into the fp-trig module; quantize aim input to brad.
4. **Injected PRNG.** Replace any `Math.random` (enemy spawns, spread) with seeded `Prng`.
5. **`InputSource` seam.** Route input through `LocalInputSource` → validate single-player still plays identically (golden-replay check: same seed + same input → identical end state). ✅ shipped (Stage E).
6. **Server broadcast + `NetInputSource` + local prediction.** Only now add the online layer. ✅ **shipped (ROADMAP 3.1), minus prediction.** The engine gained multi-seat construction (`EngineConfig.players`) — the actual second player, additive/byte-identical for single-player. `@dd/engine/net` holds the shared wire protocol, `NetInputSource` (confirmed frame-stream + jitter cushion + catch-up), and `FrameBroadcast` (the pure server relay). The `server/` package is the WebSocket shell around `FrameBroadcast` (`MatchRoom`/`RoomManager`, injected clock + sockets, unit-tested with fakes); the client `CoopSession` drives the engine off the confirmed stream. Loopback tests prove `FrameBroadcast → NetInputSource → engine` and the full client↔server `CoopSession` loop reproduce a plain replay byte-for-byte. **Local-player prediction/reconcile is deferred** — co-op PvE is latency-tolerant (below) and plays on the confirmed-stream + catch-up path alone; prediction is a render-loop latency-hiding layer, and its reconciliation smoothing (snap vs lerp) is an open question to tune against real mobile RTT, so it lands with the live N-player render. **The matchmaking control plane in front of this shipped too (ROADMAP 3.3):** `matchsvc` (HTTP) pools players and issues signed HMAC tickets, the gameserver verifies `/ws?ticket=` and derives the trusted seat/seed from it, and the client `?online=1` path (matchmaking → ticket → `CoopSession`) is browser-verified two-tab (two independent clients matchmade into one room, byte-identical lockstep). See the resolved open question below.

Steps 1–5 are the determinism foundation and are worth doing regardless of when multiplayer ships.

## Open questions

- Logic tick rate: 30 Hz (match funny) vs 20 Hz (cheaper on low-end/WeChat, coarser aim). Decide after measuring WeChat CPU under a full bullet-hell.
- Brad resolution (angle quantization granularity) and fp-trig table size vs accuracy.
- Prediction reconciliation smoothing for remote entities (snap vs lerp) — tune against real mobile RTT.
- ~~Server transport / where the frame-broadcast server lives.~~ **RESOLVED (ROADMAP 3.3):** a two-service split like funny — a **control plane** (`matchsvc`, HTTP) that pools players and issues **signed HMAC tickets**, and a **data plane** (`gameserver`, the raw-WebSocket frame relay, ROADMAP 3.1). The client calls matchsvc to matchmake, then redeems its ticket on the gameserver socket (`/ws?ticket=`); the gameserver verifies the ticket and derives the trusted `{roomId, owner, seed, playerCount}` from it instead of raw params (closing the seat/seed spoof hole). Ticket = stateless `b64url(payload).b64url(hmac-sha256)` over a shared secret (`DDU_TICKET_SECRET`); no shared store. A real secret makes tickets mandatory; unset falls back to the dev raw-param handshake. Where the two services physically deploy (host/Docker) is a separate ops call, not an architecture question.
- Match size ceiling and per-frame input packet budget for WeChat.
```
