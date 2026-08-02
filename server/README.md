# Server — co-op frame-broadcast gameserver

The **net layer** for online co-op (design/06, ROADMAP 3.1). A server-driven
frame-broadcast lockstep data plane (the 王者荣耀 / funny `gameserver` pattern): the
server owns the clock and broadcasts one frame packet per pulse, **never waiting for a
client** — a lagging player falls behind the broadcast and catches up alone.

It is deliberately thin. The determinism-critical relay logic lives in **`@dd/engine`**
(`net/FrameBroadcast.ts`) and is consumed identically by client and server — the design/06
anti-drift rule ("one definition, same bytes on both sides"). This package only adds the
**I/O orchestration** around it: seat assignment, the metronome, sockets.

## Layout

This package hosts **both planes** (design/06), each with its own entrypoint but a shared
pure core + the shared ticket module:

**Data plane** — the WebSocket frame relay (ROADMAP 3.1):

| File | Role | `ws`? | Tested |
|------|------|-------|--------|
| `src/MatchRoom.ts`   | One match's lifecycle: fill seats → start → relay → settle. Wraps `FrameBroadcast`. | no | ✅ `test/MatchRoom.test.ts` |
| `src/RoomManager.ts` | `roomId → MatchRoom`; routes `ClientMsg`; first joiner defines the match. | no | ✅ |
| `src/index.ts`       | WebSocket bootstrap — the ONLY file that imports `ws`; wraps sockets as `RoomConnection`s, provides the real-timer `Scheduler`, and **verifies the `/ws?ticket=` handshake**. | yes | typecheck only |

**Control plane** — matchmaking + tickets (ROADMAP 3.3):

| File | Role | I/O? | Tested |
|------|------|------|--------|
| `src/ticket.ts`      | Stateless HMAC-SHA256 sign/verify over `{roomId,owner,seed,playerCount,exp}`. Shared by both planes. | no | ✅ `test/ticket.test.ts` |
| `src/Matchmaker.ts`  | Pure queue: `enqueue`→group-when-full→signed tickets, `poll`. Injected clock/seed/roomId/signer. | no | ✅ `test/Matchmaker.test.ts` |
| `src/matchsvc.ts`    | HTTP bootstrap — the ONLY control-plane file that imports `node:http`; wires the real clock/seed/signer around `Matchmaker`. | yes | typecheck only |
| `src/config.ts`      | The one place that reads `DDU_TICKET_SECRET` (env), so both planes agree on the secret. | env | — |

`MatchRoom`/`RoomManager` take an injected `Scheduler` (the metronome clock) and
`RoomConnection`s (per-seat senders), so the whole lifecycle is unit-tested with a fake
clock and fake sockets — no network, no timers. The relay *content* (command ordering,
the monotonic watermark, the reconnect log) is proven in `@dd/engine`'s
`framebroadcast.test.ts`, including a **loopback test** that runs
`FrameBroadcast → NetInputSource → engine` and asserts it reproduces a plain replay
byte-for-byte.

## Protocol

Shared wire types live in `@dd/engine/net/protocol.ts` (`ClientMsg` / `ServerMsg`).
Messages are newline-free JSON — `PlayerCommand` is already compact plain data (integer
brad/mag/buttons), so JSON is fine for the co-op MVP; a WeChat/production build would swap
a binary codec in behind the same seam. The server **never interprets** a command's
meaning; it only buckets commands by frame and broadcasts them, stamping each with the
sender's authoritative seat (`owner`) so a client can only ever move its own player.

- `match_start` — sent when the room fills; carries `seed`, `playerCount`, and this
  client's `localOwner`. The client builds `EngineConfig.players` of length `playerCount`.
- `frame_batch` — one broadcast pulse: the confirmed `toFrame` watermark + any non-empty
  frames since the last pulse. `NetInputSource` folds it into the engine's confirmed stream.
- `conn_resync` — reconnect catch-up: the frame log past the client's `lastFrame`.
- `match_over` — the settled outcome (also re-judged client-side via `runHeadless`).

Tick rates: **sim 30 Hz**, **net 10 Hz** (one batch / 100 ms covering 3 sim frames) —
the funny defaults; both `FrameBroadcast` and `NetInputSource` take these as options so
the pairing stays in lock-step. (design/06 leaves 30 vs 20 Hz open, to decide after WeChat
CPU measurement.)

## Run

One package of a root npm workspace — `npm install` once at the repo root covers it.

```bash
npm run dev:server    # data plane: ws://0.0.0.0:8787/ws  (PORT/HOST env override)
npm run dev:matchsvc  # control plane: http://0.0.0.0:8788  (MATCH_PORT env override)
```

Or from inside `server/`: `npm test` (ticket / Matchmaker / MatchRoom / RoomManager),
`npm run typecheck` (incl. both entrypoints), `npm run dev`, `npm run matchsvc`.

**Handshake (ROADMAP 3.3):** the client calls the control plane to matchmake —
`POST /find {playerCount}` then poll `GET /find/:queueId` — and receives a **signed
ticket**. It then opens the data-plane socket with it: `ws://host:8787/ws?ticket=<token>`.
The gameserver verifies the ticket and derives the trusted `{roomId, owner, seed,
playerCount}` from it, so a client can no longer claim another seat or a different seed.

**Ticket secret:** set `DDU_TICKET_SECRET` to the SAME value on both processes for any real
deployment — then a valid ticket is mandatory (invalid/absent → close `4401`). Unset, both
default to a shared insecure DEV secret (with a warning) and the gameserver *also* still
accepts the legacy raw-param handshake (`/ws?roomId=..&owner=..&seed=..&count=..`) for local
manual testing. Set `DDU_GAMESERVER_URL` on matchsvc so its issued tickets carry the right
`wsUrl` (default `ws://localhost:8787/ws`). Where the two services physically deploy is an
ops call; the architecture split (design/06) is settled.

## Not in scope (by design)

Anti-cheat beyond the post-match `runHeadless` re-judge (design/06: full state is
client-held; casual-first PvP accepts maphack at launch), and PvP settlement/ELO (Phase 4).
The matchmaking here is deliberately minimal — a first-come queue keyed by seat count, no
**accounts/auth** (a ticket identifies a seat, not a user) and no **skill matching/MMR**.
Co-op is cooperative and latency-tolerant, so it is playable on the confirmed stream +
catch-up alone; **local prediction** (rendering your own movement/aim ahead of the confirmed
frame) shipped as a client-side render-layer concern on top (`client/src/game/controllers/LocalPredictor.ts`)
and never touches this data plane — the server stays the pure confirmed-frame relay.
