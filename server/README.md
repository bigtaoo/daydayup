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

| File | Role | `ws`? | Tested |
|------|------|-------|--------|
| `src/MatchRoom.ts`   | One match's lifecycle: fill seats → start → relay → settle. Wraps `FrameBroadcast`. | no | ✅ `test/MatchRoom.test.ts` |
| `src/RoomManager.ts` | `roomId → MatchRoom`; routes `ClientMsg`; first joiner defines the match. | no | ✅ |
| `src/index.ts`       | WebSocket bootstrap — the ONLY file that imports `ws`; wraps sockets as `RoomConnection`s and provides the real-timer `Scheduler`. | yes | typecheck only |

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

```bash
cd server
npm install
npm test           # MatchRoom / RoomManager lifecycle
npm run typecheck  # incl. the ws entrypoint
npm run dev        # ws://0.0.0.0:8787/ws  (PORT/HOST env override)
```

Launch handshake (MVP): `ws://host:8787/ws?roomId=..&owner=..&seed=..&count=..`. A real
deployment fronts this with a matchmaking/ticket service that signs the params (funny's
`matchsvc`); that control plane — and where the relay ultimately lives (raw WS vs a
room/relay service) — is design/06's remaining open question, out of scope for the net
layer itself.

## Not in scope (by design)

Anti-cheat beyond the post-match `runHeadless` re-judge (design/06: full state is
client-held; casual-first PvP accepts maphack at launch), accounts/persistence, and PvP
settlement/ELO (Phase 4). Co-op is cooperative and latency-tolerant, so it is playable on
the confirmed stream + catch-up alone; **local prediction** (rendering your own input ahead
of the confirmed frame) is a client-side render-loop concern layered on top — see the
client net module.
