# Boss-core prompts (archive)

`design/13`'s "the boss closes the loop thematically... a giant failed core" was never
actually produced as production art. `art/units/boss.png` is an orphaned early attempt —
nothing in the client code references it (verified by grep), and `content/enemies.ts`'s
`BLIGHTLORD` blueprint carries no `bodyRig`, so the boss renders today as the plain
`critter-core` body scaled 2x and re-tinted purple (`Actor.ts`'s `atlasKey ?? 'critter-core'`
fallback) — not its own silhouette. A `BOSS_CORE_RIG` (3 visible bones: `core` + two orbiting
`ring_a`/`ring_b` shard rings) exists in `tools/animator/src/skeleton/rigs/bossCore.ts`, but
only as a rig-format proof (`ROADMAP.md` 5.3's "verify the multi-rig claim for real") — it was
never ported to `client/src/render/`, never bound to a `client/public/skins/boss-core/`
bundle, and never wired into `skinRegistry.ts`/`main.ts`'s preload list. These two prompts are
the missing art; the code-wiring steps below are separate, non-art follow-up work.

Generated with **GPT Image 2**. Style must match the existing `units/` art exactly (same
flat-cel language as `shell.png`/`enemy_critter.png`) — this is production art, not a concept
sheet.

## `core` — the boss's main body

> 2D game character sprite, flat cel-shaded mobile game style, matching this game's locked
> hero/enemy art direction exactly: bold clean uniform black outlines, flat solid colour
> fills, simple soft cel shadows, minimal internal detail, strong readable silhouette.
> Deliberately FLAT — like a modern 2D mobile game sprite, NOT a 3D render, no realistic
> rock/metal texture, no heavy gradients, no photographic detail.
>
> The subject is a GIANT floating cracked crystal core — the corrupted failed mirror of the
> game's small clean hero orb-core, much bigger and rougher: one huge, heavily cracked and
> fractured crystal-and-rock body (rounder at top, tapering slightly toward the bottom, no
> arms, no legs), with one single huge angry glowing eye as its whole face (same "single eye"
> language as the game's basic enemy critter, just far larger and fiercer). Raw jagged crystal
> shards burst from cracks across its surface, growing wild and uncontained — the opposite of
> the hero's smooth sealed shell.
>
> Colour: draw the body and eye in NEUTRAL tones only — grey-white stone with clear/pale
> crystal facets, NO purple, NO saturated colour anywhere. This is a deliberate constraint:
> the game re-tints this exact sprite toxic purple at runtime (multiply-tint), so the source
> art must be neutral or the runtime tint will look wrong.
>
> Single object only, no background elements, no orbiting rings in this image (those are a
> separate sprite) — just the cracked core body + eye. Tilted 3/4 game camera view (slightly
> forward-leaning, not top-down), plain neutral grey background, TRANSPARENT background is
> NOT required for this generation pass (it gets background-removed after), no text, no
> ground/shadow.

## `ring` — an orbiting shard-ring fragment

> 2D game item sprite, flat cel-shaded mobile game style, matching this game's locked art
> direction: bold clean uniform black outlines, flat solid colour fills, simple soft cel
> shadows, minimal internal detail. Deliberately FLAT — NOT a 3D render, no realistic metal,
> no heavy gradients.
>
> The subject is a single small JAGGED broken shard of crystal-and-rock, curved into a rough
> partial-ring / crescent fragment shape (not a smooth complete circle — it should read as a
> "broken ring", part of the boss core's corrupted, overgrown crystal). Neutral grey-white
> stone with pale crystal facets, matching the `core` sprite above exactly (same palette, same
> re-tinting requirement — NO purple in the source art). A few tiny crystal spikes may jut
> off the outer edge.
>
> This is a SMALL supporting element, not the main subject — do not draw the boss's body or
> eye in this image, ONLY the single ring fragment, floating in isolation. Tilted 3/4 game
> camera view, plain neutral grey background, no text, no ground/shadow.
>
> (This one image gets reused for both of the boss's two orbiting ring bones — the rig
> mirrors/rotates it into place, so only one ring texture needs to be generated.)

## Workflow reminder (art half)

Save the accepted generations as `art/units/boss_core_raw.png` / `art/units/boss_ring_raw.png`
(rejects as `_alt`/`_alt2`, same convention as every other `art/<category>` batch). Decode
with `tools/png-pipeline/pngCodec.mjs`'s `decodePNG` to confirm real alpha before trusting a
"transparent background" claim (the opaque-matte-bug trap this repo has hit twice before),
then `node tools/png-pipeline/compress.mjs --long-axis=<N> <file>` — use a larger long-axis
than the hero's own parts (the boss's `core` bone has `bodyR: 70` vs. the hero shell's `bodyR:
40`, roughly 1.75x, so scale the target long-axis up from whatever the hero's `shell.png`
used) — and drop the results into a new `client/public/skins/boss-core/` bundle as
`core.png`/`ring.png`.

## Workflow reminder (code half — NOT art, do not skip)

The prompts above only produce pixels. Wiring the boss to actually use them still needs, all
separate from image generation:

1. Port `tools/animator/src/skeleton/rigs/bossCore.ts`'s `BOSS_CORE_RIG` into a new
   `client/src/render/bossCoreRig.ts` (mirrors how `orbCoreRig.ts`/`critterCoreRig.ts` were
   ported from the same tool) + a `BOSS_CORE_REFERENCE_RADIUS` export (use the `core` bone's
   `bodyR: 70`, the same convention `ORB_CORE_REFERENCE_RADIUS`/`CRITTER_CORE_REFERENCE_RADIUS`
   already follow).
2. Author `client/public/skins/boss-core/animation.json`/`frames.json` binding `core`→`core.png`
   and `ring_a`/`ring_b`→`ring.png` (both bones share the one ring texture).
3. Add a `'boss-core'` entry to `skinRegistry.ts`'s `RIG_DEFS` map.
4. Add `['boss-core', '/skins/boss-core']` to `main.ts`'s preload list.
5. Add `bodyRig: 'boss-core'` to the `BLIGHTLORD` blueprint in `engine/content/enemies.ts`
   (currently absent — this is *why* it falls back to `critter-core` today).

Only after all five land does the boss actually render as its own silhouette instead of a
scaled/retinted critter.
