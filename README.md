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
| `npm run test:pve-sim` | The PvE level simulator — bot-driven real runs of level 1, per-room reaction window / peak shooters / clear rate, plus the difficulty gates (`client/sim/`, also out of the default glob) |

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

An already-open tab picks up a deploy on its own. The client build emits
`dist/version.json` (`build/versionManifestPlugin.mjs` — a hash over the bundle *and*
`client/public/`, so an art-only deploy counts too), and
`client/src/platform/web/autoReload.ts` re-checks it whenever the player returns to the tab,
reloading when it no longer matches the hash the page booted with — held back while a run or
an online session is live, then applied on the next return. `client/public/_headers` keeps
`index.html`/`version.json` uncached at the edge, which is what makes the check meaningful;
don't drop it. Production builds only — the dev server keeps using Vite HMR. Ported from
`funny`'s equivalent; see `design/ROADMAP.md`'s 2026-08-15 entry for how the two differ.

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
- [x] Art pipeline (Phase 5): `.tao` rig runtime, full 3-character + boss/critter/brute/floater roster art, a distinct sprite for every ranged/melee weapon id, per-element biome floor/wall art (including the standing walls' front elevation, 2026-08-18 — before that every wall was drawn flat on its own footprint and only the pillars had any height; a same-day follow-up made EVERY wall stand, at three heights, since the first rule's "east-west runs only" exclusion disqualified almost all of the shipped level-1 content and left rooms still reading flat, and added the shading that geometry alone does not give — cap/face/side tonal separation, per-wall ground cast shadows, a dark silhouette, and hand-toned stone pillars off the pre-art palette hues), hub background + button icons + the Forger NPC, UI widget kit, post-processing/particles, all five fidelity-roadmap shaders — dynamic per-pixel lighting (shader-derived fake normal, no normal-map asset needed), energy shield, hit-flash outline, dissolve-on-death, heat-haze (`design/01` 5.2/5.4) — GPT-Image-2-generated art is now treated as final production art (`design/12` 5.3, a 2026-08-03 scope decision, not a tooling change); WeChat device verification is still outstanding. The rig runtime's placement model was wrong until 2026-08-17 (art drawn at each bone's pivot rather than its tip, and rotated by the bone's raw world angle) — every rigged character rendered visibly disassembled while all of the art itself was fine; fixed along with the previously-undrawn energy tethers, and now guarded by `client/src/render/rigComposition.test.ts`'s assembly invariants over every shipped bundle. The facing model got the same treatment on 2026-08-18: the body now turns toward the AIM instead of the movement vector (an orb-core has no lower body to justify the humanoid split it inherited), the eye slides continuously inside the shell along that aim rather than the billboard's four discrete states carrying the whole 360° read, and `design/01`'s per-weapon front/back z-order rule finally runs every frame. A same-day volume pass then added the lighting that facing work cannot produce: a fixed specular highlight and a curved terminator over the body bone (counter-flipped so the key light does not mirror with the character — the eye moving while the highlight stays put is what reads as a sphere), a far-side weapon module that shrinks and darkens rather than only changing layer, a hover whose lift the shadow actually responds to, and one shared 0.62 foreshortening for every round overlay including the shield ring, which had been a perfect screen-space circle. A third pass on 2026-08-19 stopped looking and started MEASURING the frame (`renderer.extract` at zoom 1, sampled per wall entity from the renderer's own geometry), which found what two look-driven passes had missed: a wall cap raised 104 px read DARKER (44) than the floor it stands on (53), so every other height cue was arguing against the most basic one and losing; each room boundary was drawn as two independent blocks because adjacent rooms each author their own wall, putting a lit/dark seam down the middle of one stone mass; the camera clamp had silently cancelled the wall-height frame extension since the day it shipped, so a room's tallest wall never showed its top; the per-wall stone-relief filter cost 10-32 render targets per room for a measured 0.06% difference and is now off; and both the sphere shading and every ground shadow were sized against a rig's DECLARED body radius while the shipped art paints only 0.68-1.00 of it — which had been painting a hard-edged dark disc onto the background around every crystal enemy, recorded in an earlier session as an over-large shadow. Fixed with an additive cap key light, run merging, a per-room floor light pool (the cheap static half of design/01's parked lightmap), and art-derived body radii guarded by a test that re-decodes the real PNGs every run. One wall then took four more reports on 2026-08-19, all of them the same defect: every tonal constant had been measured on an EAST-WEST wall, where the cap is a thin band under a lit coping, and applied unchanged to a north-south run, where the cap is 100% of what you see. The flat additive key light was destroying the swatch's contrast RATIO (2:1 to 1.4:1) and is now the cap drawn a second time in `add` mode; caps tile in world space so an L corner's two blocks share one stone field; the east band no longer paints a grey stripe down a run's whole top; and a deep run now TUCKS under the wall it meets, stopping just below that wall's crown course — the longest unbroken horizontal in a room, and the line the eye identifies a back wall by. The crown line is measured per element, because `wallface_ice.png`'s coping band is a third shorter than fire's — a bug found by the new `client/src/game/scene/wallComposition.test.ts`, which runs the real level-1 floors through the real wall pipeline and decodes every shipped face swatch to check the constant against its art
- [x] Accounts (Phase 6, `design/16-accounts.md`): real username/password login (SQLite via `node:sqlite`), never required to play — bound to PvP ladder rating and Forge blueprints/materials/loadout; third-party OAuth reserved, not built
- [x] Internationalization (Phase 7, `design/17-i18n.md`): English-canonical `t()` system with compile-time key checking, 8 locales (中文/Deutsch/Français/Español/Polski/Русский/Italiano), every screen migrated, a language-cycle Settings control, first-boot browser-language auto-detection — enum/data-driven values (damage type, weapon kind, rarity) deliberately left untranslated
- [x] Screen-flow completion (design/10 follow-up, 2026-08-03): a boot loading screen; a menu-driven Mode Select (solo PvE / co-op / PvP solo queue / tutorial) replacing PLAY's direct jump into Forge — co-op/PvP were previously boot-flag-only; a real Matchmaking screen (connecting/error/cancel/retry), fixing a latent bug where a dropped connection hung forever with no feedback; a standalone, always-skippable tutorial level (move/aim/fire → weapon-swap → melee-deflect → the extract-vs-descend checkpoint decision)
- [x] Level 1 balance pass (2026-08-17, `ENGINE_VERSION` 41): a headless PvE level simulator (`npm run test:pve-sim`) — bot-driven real runs reporting per-room reaction window / peak simultaneous shooters / clear rate, with difficulty gates — and the rebalance it measured out: a per-room concurrent-fire budget, staggered room wake-up, halved garrisons, renewable shield regen, plus a door-lock softlock it caught. See `design/05` "Room encounter budget"
- [x] Room feel pass (2026-08-17, `ENGINE_VERSION` 42): the camera frames the current room instead of the whole floor and centres the character rather than their feet; bullets are drawn leaving the gun's actual barrel tip (the sim's ground-plane muzzle and the rig's screen-space one sit on parallel lines — corrected on the view, so hit detection stays authoritative); enemies collide with each other again, gained a perception radius inside the existing room-activation gate, and move slower; the shield shimmer breathes instead of strobing. See `design/05` "Room feel pass". Level 1 is measurably easier as a result — re-tightening garrisons is tracked as open work there
- [x] Wall clearance (2026-08-19, `ENGINE_VERSION` 43): the character stops at its own body radius against a wall or a pillar instead of at its 7 px feet circle — from a play report that walking into a corner read as sinking into the stone. New `Actor.solidRadius`, split off `footprintRadius`, which keeps its old value and now covers only actor↔actor push-out (a body overlapping another body reads as a crowd; a body overlapping stone reads as sunk into it). Enemies keep their old clearance, so no mob path or level-1 garrison measurement moves. See `design/07` and `design/ROADMAP.md` "Sunk into the wall"
- [x] Occlusion x-ray (2026-08-20, client-only): a standing wall block or pillar that is currently drawing over the player goes translucent, from a play report that the character *"跑到墙下面去了"* — walked to the north side of an interior block and vanished (measured: the body's rect read luma 78.4 against the cap stone's 77.1, i.e. arithmetically indistinguishable from the wall). No single layer was wrong — a block's art intrudes one wall HEIGHT north of its own footprint onto walkable floor and sorts in front of it, the player's clearance puts them at most 16 px into that band, so a 70 px block covers all 32 px of the drawn body and per-object sorting offers no "partly hidden". The default pass fades the CAP only (fading the whole block was tried on the live frame and reads as a hole in the room), so the face, the silhouette and the ground shadow keep the mass solid; a pillar has no cap/face split and fades its whole shaft, since that is what a character behind it disappears into. A second pass takes the face too where a tall wall on a shallow footprint buries the body below the cap/face fold and a cap fade would achieve nothing — 1.3% of the floor. Then *"加测试"* produced `occlusionCoverage.test.ts`, which sweeps all 97,803 positions the player can legally stand at across the five shipped floors against an independent overlap oracle, and immediately falsified two claims this session had already written into design/01: a perimeter run DOES trigger the x-ray (a wall between two vertically stacked rooms was the *lower* room's 104 px north perimeter, not the upper room's 22 px kerb — so 72 px of that room's floor made the player completely invisible; fixed at the tier the same day, see "Wall tier" below), and a wall's face DOES cover the player on a shallow footprint. Measured over level 1: 5.5% of standable floor made the character 100% invisible before, none of it leaves more than half hidden after (worst case 43.8%). See `design/01-rendering.md` "The occlusion x-ray" and `design/ROADMAP.md`
- [x] Door grid alignment (2026-08-20, `ENGINE_VERSION` 44): a door's passage rect now lands on a whole grid cell, from a geometry audit that the occlusion sweep above prompted — four wall runs in the shipped level-1 content stood **16 px deep** where every other wall on all five floors is a full 32. Not an art bug and not a merge artifact: `DOOR_EDGE_MARGIN_GRID` is 1.5 and the anchor step is `span / 4`, so a drawn passage could land on a half or even a quarter cell, and `carveDoorGaps` — doing exactly the right rect-difference — then cut a correspondingly misaligned hole, leaving whatever remained of the wall run past it fractionally deep. A 16 px footprint under a 104 px-tall perimeter run is the worst case for the standing-wall art (a cap band on a third of the depth every wall tone was measured on) and it is the geometry that made the x-ray need its second, face-fading pass at all. Fixed in three places because any one alone leaves the hole open: the drawn anchor is snapped in a new shared `world/dungeon/doorAnchor.ts` (the copy of that math each of the two placement functions carried verbatim is now the one thing they share, so a fix cannot land on one path and miss the other — the procedural path was the worse of the two, with 33 fractional passages across a 10-seed sweep); level 1's nine fractional `passageGrid` values are floored to whole cells as data, which is what actually removes the four runs from a real run; and the map editor's save gate rejects a hand-typed fractional passage, which it never did even while holding `solids` to whole cells. `DOOR_EDGE_MARGIN_GRID` itself stays 1.5 — it is the fit threshold, and no integer value satisfies both halves of what the tests already pin, which the suite now demonstrates rather than asserts (setting it to 1 fails 5 tests, to 2 fails 6). See `design/05` "Door position is authored freely" and `design/ROADMAP.md` "The 16 px wall runs"
- [x] Wall tier: the boundary between stacked rooms (2026-08-20, client-only): `wallGeometry.wallTier` decided a wall's height from the one room the wall's **centre** falls in, so "am I a south boundary?" could only ever be asked about that one room — and where two rooms stack vertically the boundary between them is *two* walls, one grid row apart, authored by two different rooms. The upper room's own south wall kerbed correctly at 22 px; the lower room's north wall answered "I am my room's north edge" and stood at the full 104 px, one row south of the exact floor the kerb tier exists to keep clear. A block's art rises from its own north edge, so it reached a measured 72 px into the room above — 22 runs of it, on all five shipped floors. This is the *"kerb rule is defeated for any shared boundary"* follow-up the occlusion sweep found and the entry above recorded; the x-ray was keeping the player visible there, which is work a correct tier does not need done. The rule now asks *"does any room's floor lie immediately north of me"*, one predicate covering both halves of a shared boundary, which strictly generalizes the old test (a room's own south wall is the case where the room to the north is the wall's own room). No splitting pass is needed and that is the point: every room authors its own four perimeter walls, so a boundary arrives as two independently-tiered rects and `RoomBuilder` tiers **before** it merges — a collinear north boundary shared by two side-by-side rooms, only one of which has a room above it, therefore keeps its tall half, where the old rule had merged the two into one 32-cell perimeter run. Measured over level 1 with the fix stashed and unstashed: the share of standable floor that leaves the character at least half hidden before the x-ray drops 8.5% → **5.4%**, completely invisible 5.5% → **3.3%**, the deep face-fading pass 1.2% → **0.2%**, and 19 runs move from perimeter to kerb (105 → 86 perimeter, 37 → 53 kerb). Confirmed on a live frame too (luma scan down world x=350 at floor 0's `r4_forge`/`r5_extraction` boundary: stone used to start at y 440 = `544 − 104`, now starts at 492 = `512 − 22`). PvP is untouched — the 60-room arena's rooms all carry `solids: []`, so it has no wall runs at all. See `design/01-rendering.md` "Every wall stands, at one of three heights" and `design/ROADMAP.md` "The wall between two rooms was standing on the wrong floor"
- [ ] WeChat mini-game adaptation (run in WeChat DevTools, see `design/04-wechat.md`)
