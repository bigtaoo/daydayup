# DayDayUp

A 2D top-down (3/4 view) free-shooter roguelite, inspired by Soul Knight. The core of the game is a **rich weapon system** — ranged and melee, where melee weapons can block and deflect bullets. Different characters are only skins.

## Structure

An npm workspace. Every package is consumed as TypeScript **source** — there is no
build step between them, so a shared type can never go stale against a built artifact.

| Directory | Contents |
|-----------|----------|
| `design/` | Design and technical decisions (architecture, data models, rationale) |
| `art/` | Art assets and asset conventions |
| `engine/` | `@dd/engine` — the deterministic simulation core (`design/06`, `design/08`). Renderer- and host-free: it compiles without the DOM lib and may not import any other package. Consumed by client, server and both tools. See `engine/README.md`. |
| `client/` | Game client. Single-engine PixiJS v8. Targets: Web / PC / Android / iOS / WeChat mini-game. See `client/README.md`. |
| `server/` | Co-op backend: the frame-broadcast **gameserver** (WebSocket data plane) + the **matchsvc** matchmaking/ticket control plane. See `server/README.md`. |
| `tools/` | Authoring tools, none of them shipped to players. `animator` — the `.tao` rig/clip editor (`design/12`); its `projects/*.editortao` files are the authoring source for every rig in the game. `map-editor` — arena/room authoring, the authority on the `ArenaMap` layout the engine only consumes (`design/15`). `png-pipeline` — a dependency-free pure-Node PNG codec (`pngCodec.mjs`) plus the `compress.mjs` trim/downsample/re-encode step every asset in `client/public/` went through. `desktop-shell` — an Electron app hosting `animator` and `map-editor` as switchable pages in one window, with a native file I/O bridge (`window.nwDesktop.fs`) so Save/Load use real OS dialogs instead of the browser File System Access API. |
| `world/` | Authored world data the tools produce and the engine consumes — today `arenas/arena_prototype_60.json`, the validated 60-room PvP map wired into `ARENA_CATALOG` |

`tsconfig.base.json` and `build/ddAlias.mjs` are the type-side and bundler-side halves
of one `@dd/*` path map — kept as a single file each so they cannot drift apart.

## Tech stack (summary)

- **Single engine: PixiJS v8** (UI included). No Three.js — the game is 2D top-down; the 3D feel is faked with Y-sorting, height/shadow separation, and a tilted view.
- **Fully open source (MIT)** so any issue can be patched or forked. This is the key trade-off versus closed-editor engines like Cocos Creator.
- **WeChat mini-game is the most constrained target** (no DOM, needs `weapp-adapter`, no WebGPU → WebGL fallback, base-library version must be verified on a real device). See `design/04-wechat.md`.

See [design/](design/) for the full record.

## Getting started

Install once at the repo root — it is a workspace, so this covers every package.

```bash
npm install
```

```bash
npm run dev        # client dev server, http://localhost:5173
```

| Command | What it does |
|---------|--------------|
| `npm run check` | Typecheck **and** test every package — the one command to run before committing |
| `npm test` | Test every package |
| `npm run typecheck` | `tsc --noEmit` in every package |
| `npm run dev:server` / `npm run dev:matchsvc` | Co-op gameserver / matchmaking service |
| `npm run dev:animator` / `npm run dev:map-editor` | The two authoring tools |
| `npm run dev:desktop-shell` | The Electron shell hosting both authoring tools (run the two `dev:` commands above first, in separate terminals) |
| `npm run test:pvp-sim` | The offline PvP balance harness (`client/sim/`, kept out of the default test glob — ~6s) |

## Deployment

The client is live at **https://b.gamestao.com** — static assets (`client/dist`) served
by a Cloudflare Worker (`daydayup-client`, `wrangler/client.jsonc`), same Cloudflare
account as the `funny` project's `gamestao.com` zone.

`.github/workflows/client-deploy.yml` auto-deploys on every push to `main` that touches
`client/**` or `engine/**` (the client build reads the engine as source via the vite
alias), or via manual `workflow_dispatch`. Gated behind repo variable
`CLIENT_DEPLOY_ENABLED` and repo secrets `CLOUDFLARE_API_TOKEN` /
`CLOUDFLARE_ACCOUNT_ID`.

Manual deploy (fallback, or first-time setup):

```bash
npm run build -w client
npx wrangler deploy -c wrangler/client.jsonc
```

The two authoring tools have the same setup — `wrangler/animator.jsonc` /
`wrangler/map-editor.jsonc` + `.github/workflows/animator-deploy.yml` /
`map-editor-deploy.yml`, gated behind `ANIMATOR_DEPLOY_ENABLED` /
`MAP_EDITOR_DEPLOY_ENABLED` — but those repo variables are **not yet set**, so neither
workflow deploys until that's turned on. Once live they'd serve at
`dd-animator.gamestao.com` / `dd-map.gamestao.com`, which is what the desktop shell's
`tools/desktop-shell/src/tools.ts` `prodUrl` fields point to for a packaged install.

## Status

- [x] Project structure
- [x] Design docs
- [x] Client vertical slice (tilted view / Y-sort / height & shadow / weapon swap / melee block & deflect) — runs in the browser
- [x] Deterministic engine + full PvE loop (floors → extraction → bank), meta/forge, 3-character roster (Phases 0–2)
- [x] Online co-op (Phase 3): frame-broadcast netcode, downed/revive, matchmaking + signed tickets, local-player prediction — two-tab byte-identical lockstep
- [x] PvP (Phase 4): 8-player solo-or-squad battle royale, team/hostility model, real 60-room arena map, shrinking zone, placement win condition, anti-cheat checkpoints, matchsvc Elo ladder — see `design/15-pvp-arena.md`
- [x] PvP squads (design/05/15 follow-up): pre-formed party invite codes, squad-chunked matchmaking/teamId, gated bandage revive, party lobby UI
- [x] Art pipeline (Phase 5): `.tao` rig runtime, full 3-character + boss/critter/brute/floater roster art, a distinct sprite for every ranged/melee weapon id, per-element biome floor/wall art, hub background + button icons + the Forger NPC, UI widget kit, post-processing/particles, all five fidelity-roadmap shaders — dynamic per-pixel lighting (shader-derived fake normal, no normal-map asset needed), energy shield, hit-flash outline, dissolve-on-death, heat-haze (`design/01` 5.2/5.4) — GPT-Image-2-generated art is now treated as final production art (`design/12` 5.3, a 2026-08-03 scope decision, not a tooling change); WeChat device verification is still outstanding
- [x] Accounts (Phase 6, `design/16-accounts.md`): real username/password login (SQLite via `node:sqlite`), never required to play — bound to PvP ladder rating and Forge blueprints/materials/loadout; third-party OAuth reserved, not built
- [x] Internationalization (Phase 7, `design/17-i18n.md`): English-canonical `t()` system with compile-time key checking, 8 locales (中文/Deutsch/Français/Español/Polski/Русский/Italiano), every screen migrated, a language-cycle Settings control, first-boot browser-language auto-detection — enum/data-driven values (damage type, weapon kind, rarity) deliberately left untranslated
- [x] Screen-flow completion (design/10 follow-up, 2026-08-03): a boot loading screen; a menu-driven Mode Select (solo PvE / co-op / PvP solo queue / tutorial) replacing PLAY's direct jump into Forge — co-op/PvP were previously boot-flag-only; a real Matchmaking screen (connecting/error/cancel/retry), fixing a latent bug where a dropped connection hung forever with no feedback; a standalone, always-skippable tutorial level (move/aim/fire → weapon-swap → melee-deflect → the extract-vs-descend checkpoint decision)
- [ ] WeChat mini-game adaptation (run in WeChat DevTools, see `design/04-wechat.md`)
