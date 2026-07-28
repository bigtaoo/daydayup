# DayDayUp

A 2D top-down (3/4 view) free-shooter roguelite, inspired by Soul Knight. The core of the game is a **rich weapon system** — ranged and melee, where melee weapons can block and deflect bullets. Different characters are only skins.

## Structure

| Directory | Contents |
|-----------|----------|
| `design/` | Design and technical decisions (architecture, data models, rationale) |
| `art/` | Art assets and asset conventions |
| `client/` | Game client. Single-engine PixiJS v8. Targets: Web / PC / Android / iOS / WeChat mini-game |
| `server/` | Co-op backend: the frame-broadcast **gameserver** (WebSocket data plane) + the **matchsvc** matchmaking/ticket control plane. See `server/README.md`. |

## Tech stack (summary)

- **Single engine: PixiJS v8** (UI included). No Three.js — the game is 2D top-down; the 3D feel is faked with Y-sorting, height/shadow separation, and a tilted view.
- **Fully open source (MIT)** so any issue can be patched or forked. This is the key trade-off versus closed-editor engines like Cocos Creator.
- **WeChat mini-game is the most constrained target** (no DOM, needs `weapp-adapter`, no WebGPU → WebGL fallback, base-library version must be verified on a real device). See `design/04-wechat.md`.

See [design/](design/) for the full record.

## Getting started

```bash
cd client
npm install
npm run dev        # open http://localhost:5173
```

## Status

- [x] Project structure
- [x] Design docs
- [x] Client vertical slice (tilted view / Y-sort / height & shadow / weapon swap / melee block & deflect) — runs in the browser
- [x] Deterministic engine + full PvE loop (floors → extraction → bank), meta/forge, 3-character roster (Phases 0–2)
- [x] Online co-op (Phase 3): frame-broadcast netcode, downed/revive, matchmaking + signed tickets, local-player prediction — two-tab byte-identical lockstep
- [x] PvP (Phase 4): 8-player solo battle royale, team/hostility model, real 60-room arena map, shrinking zone, placement win condition, anti-cheat checkpoints, matchsvc Elo ladder — see `design/15-pvp-arena.md`
- [x] Art pipeline (Phase 5): `.tao` rig runtime, full 3-character + boss/critter/brute/floater roster art, per-weapon art (9/11 ids), UI widget kit, post-processing/particles — real (non-placeholder) atlas art and WeChat device verification are the remaining work
- [ ] WeChat mini-game adaptation (run in WeChat DevTools, see `design/04-wechat.md`)
