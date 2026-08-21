# Art

> **Direction locked (2026-07-23):** flat-cel orb-core hero + universal-mount weapons +
> crystal-mirror enemies. See `design/13-worldview-art-direction.md` for the direction and
> the per-subject `prompts.md` files below for the generation prompts.
>
> **Status (2026-08-02):** production assets exist and the game loads them — the client is
> no longer Graphics-only. This directory holds the **source** art (full-resolution
> generator output, `.xcf` edits, rejected attempts kept for reference); what the game
> actually ships is the alpha-trimmed, downsampled, re-encoded copy under `client/public/`.
> Nothing in `art/` is loaded at runtime. **Update (2026-08-04, recounted 2026-08-18):** every
> shipped PNG under `client/public/` (**82 files**) was decoded and its alpha channel audited
> (`tools/png-pipeline/alpha-audit.mjs`) — no opaque-matte-background bug and no
> translucent-haze bug found. All sprite art (characters/weapons/icons/NPC) is clean bimodal
> alpha; the only fully-opaque files are the ones meant to be (`ui/hub_bg.png` and the **12**
> `biome/floor_*`/`wall_*`/`wallface_*` tiles, which are full-bleed backgrounds/tileables with
> no transparency by design). This closes the last open caveat below. **Update (2026-08-20):** the
> pillar sprite (`biome/pillar_neutral.png`) is the 13th file in that directory and the only one
> there with real transparency — the generation it came from had **zero** transparent pixels and a
> transparency CHECKERBOARD painted into it as opaque grey-and-white squares, which no preview can
> distinguish from a real alpha channel. Keyed by luma at import; the audit reports the shipped file
> clean. Re-run `alpha-audit.mjs` after any art batch rather than trusting the picture.
> **Update (2026-08-20, same day):** six more shipped files — the five in-run drop sprites and the
> portal arch (`environment/`, see the new row below) — bringing `client/public/` to **88 PNGs**.
> All six came back with a real alpha channel on the first generation, which is the anti-checkerboard
> paragraph in `environment/prompts.md` doing its job. That audit run also turned up ONE
> pre-existing offender the directory had apparently never been swept for:
> `client/public/environment/door_open_raw.png` decodes as **HAZE** (44.7% partial alpha, a 15.4%
> midtone cluster) and has shipped that way since the 2026-08-04 door pass. Flagged, not fixed.

## Layout

| Directory | Contents | Shipped copy |
|-----------|----------|--------------|
| `concept/` | Direction/exploration pieces, named after the `prompts.md` prompt that produced them (`01_…`–`05_…`, plus the `retired_…` first direction) | — (reference only) |
| `units/` | Every character and enemy part: the three orb-cores (`shell`/`belly`/`eye_front`/`eye_back`, prefixed `skirmisher_`/`juggernaut_`, unprefixed = the default vanguard), the boss (`boss.png` is an orphaned early attempt, unwired — see `prompts.md` for the real `core`/`ring` pair still needed), and the enemy bodies (`enemy_critter`/`enemy_brute`/`enemy_floater`) + `prompts.md` | `client/public/skins/*/` |
| `weapon/` | Per-weapon-id business-end sprites (`<weaponId>_raw.png`) + `prompts.md` + `leftover/` (picked-over duplicate generations, incl. two rejected grip-pistol ice attempts). All 6 elemental ids now shipped (`flamer`/`teslagun`/`venomspit`/`cinderscatter`/`cryobolt`/`frostseeker`) | `client/public/weapons/` |
| `biome/` | Per element: the top-down floor tile, the top-down wall tile (also reused as a standing wall's top cap), and the wall's front elevation (`wallface_*`, 2026-08-18). Plus one whole-OBJECT sprite, not a swatch: `pillar_neutral_raw.png` (2026-08-20), shared by every biome and tinted per room — six rejected generations kept as `pillar_*_alt*.png`. All with `prompts.md` | `client/public/biome/` |
| `environment/` | Standalone fixtures that stand IN a room rather than surfacing it: the door pair (2026-08-04), the five in-run drop sprites (`pickup_material`/`heal`/`buff`/`crate`/`bandage`) and the extraction portal's masonry arch (`portal_arch`, 2026-08-20) + `prompts.md`. Three rejected drop generations kept as `pickup_*_alt.png` — and re-read every test run as negative fixtures, see `client/src/game/scene/environmentArt.test.ts` | `client/public/environment/` |
| `ui/` | Hub background, button icons, result badges + `prompts.md` | `client/public/ui/` |
| `npc/` | Outpost NPCs (the Forger) + `prompts.md` | `client/public/ui/npc_forger.png` |
| `map/` | The rejected painterly-isometric room backgrounds (`room_*_painterly_rejected`) — kept only as a record of the approach that did not work; the biome look that shipped is the tile art in `biome/` | — (nothing bound) |

Animation data is **not** here: it lives with the rigs (`tools/animator/projects/*.editortao`
and the `RigDef`s in `client/src/render/`), separate from textures, per the skin-decoupling
principle in `design/02-entity-model.md`.

## Pipeline

Source PNG → alpha-trim → box-downsample to a ~320px long axis → re-encode with
`tools/png-pipeline` (a dependency-free pure-Node PNG codec — no image library is available
on the Node side) → commit under `client/public/`. Roughly 20–30× smaller files,
round-trip-verified byte-identical after encode.

Two traps this pipeline exists to catch, both hit for real:

- **Alpha.** A generator that returns an opaque background produces art that looks fine in a
  viewer and wrong in game. Verify the alpha channel by decoding pixels, not by looking.
  `tools/png-pipeline/alpha-audit.mjs` decodes every PNG under a directory and flags an
  opaque-background bug (no transparent pixel at all) or a translucent-haze bug (a midtone
  alpha cluster away from both 0 and 255) — re-run it over `client/public/` after any future
  art batch.
- **Chroma-key fringe.** Keying out a background leaves a halo of near-background pixels;
  defringe it without eroding genuine glow edges.

## Convention notes

- Tilted view: assets are drawn in 3/4 view (with a front face), not pure top-down.
- Each sprite defines a **ground anchor** (the orb's base) for Y-sort and shadows, and **two
  orbiting weapon-socket anchors** for weapon mounting (`13`; no hand — the socket is a
  universal, arm-agnostic mount).
- A new **character** = a new part atlas on the shared orb-core rig (+ its `SkinDef` stats);
  animation data is shared. There is no cosmetic reskin layer.
- Weapon art is composed **socket upper-left, tip lower-right**; `render/weaponSkins.ts`
  carries a per-weapon `rotationOffsetRad` that cancels whatever pointing direction a texture
  actually baked in, measured from real alpha-pixel data rather than eyeballed.
- Source files are named after what they are (`<weaponId>_raw.png`, `belly.png`), never left
  as generator UUIDs. A rejected or superseded attempt keeps the same stem plus `_alt`
  (`_alt2`, …) so it stays next to the version that won.

## Still to come

Nothing open — the list below is now historical (all items closed).

- **(Closed 2026-08-03.)** This directory's art is GPT-Image-2-generated, and the project
  now treats that as final production art rather than a placeholder awaiting an authored
  replacement (`ROADMAP.md` 5.3) — an explicit scope decision, not a pipeline change. The
  caveat this decision did NOT resolve on its own — some assets might still carry the known
  opaque-matte-background bug — was itself audited and closed 2026-08-04 (see the Status
  block above): no shipped asset has the bug.
- Two concrete gaps found by cross-checking the code (not just this doc), both **closed
  2026-08-03**: the boss had no dedicated art/rig at all (it silently fell back to a
  scaled/retinted `critter-core` body) — real `core`/`ring` art now bound via a new
  `boss-core` rig (`units/prompts.md`). All 6 elemental weapon ids that fell back to the plain
  `gun_default` housing now have real art (`weapon/prompts.md`) — `cryobolt`/`frostseeker`
  needed a second generation round each after the first came back as a fiction-breaking
  hand-grip/trigger-guard raygun.
- ~~`normal/` normal maps for the dynamic-lighting milestone~~ — **not needed, per 5.4's
  2026-08-03 update**: lighting derives its per-pixel normal from each sprite's own existing
  diffuse texture at shader runtime (a Sobel-style gradient over rendered luminance/alpha, no
  precomputed normal-map asset), so there is no separate normal-map source-art directory to
  fill. `fx/` particle textures remain unstarted (Particles.ts is still Graphics-only, by its
  own design — no textures needed there either).
