# Elemental-weapon prompts (archive)

`engine/content/weaponSpecs.ts` defines 6 player-facing weapon ids that `client/src/render/
weaponSkins.ts`'s `WEAPON_DEFS` table had no entry for: `flamer`, `cryobolt`, `teslagun`,
`venomspit` (the fire/ice/lightning/poison starter-pistol variants), plus `cinderscatter`
(epic scattergun/fire variant) and `frostseeker` (legendary seeker/ice variant). All 6 fell
back to the plain neutral `gun_default.png` housing — re-tinted by element at runtime
(`Actor.ts setWeaponKind`'s `ELEMENT_COLORS[damageType]` tint), but with no distinct silhouette
of their own. This broke the pattern every other elemental weapon in the roster follows:
`emberblade`/`frostbrand`/`stormglaive` (fire/ice/lightning variants of the SAME `saber` melee
frame) each got dedicated art rather than reusing `sword_default.png`.

**Status (2026-08-03): 6 of 6 shipped.** All six now have real art wired into `WEAPON_DEFS`
(`client/public/weapons/gun_{flamer,teslagun,venomspit,cinderscatter,cryobolt,frostseeker}.png`,
sources archived as `art/weapon/<id>_raw.png`). `cryobolt`/`frostseeker` took two rounds: the
first attempt for both came back as a hand-gun with a trigger guard (kept in
`art/weapon/leftover/` as `*ice_weapon_icon*`/`*crystal_tech_rifle_icon*`), which this game's
fiction doesn't support — no hands anywhere in the roster, every existing weapon (including
`gun_default.png`) is a grip-less cylindrical module that plugs straight into the orbiting
socket. The prompts below were rewritten to forbid that explicitly and the second attempt
landed clean for both. Redundant duplicate generations from the whole batch also live in
`art/weapon/leftover/`. The prompts are kept here as the reusable reference for the next batch
(a rarity-tier follow-up, a new element, etc.), not because anything is still missing.

Generated with **GPT Image 2**. Style/orientation must match the existing `weapon/` batch
exactly — see `art/README.md`'s "Convention notes" (socket upper-left, tip lower-right) and
the [[daydayup-art-pipeline-conventions]] memory (bake orientation into the prompt, don't fix
it post-hoc; state the transparent-background requirement explicitly; GPT Image 2 drifts
toward drawing a whole free-standing object unless told not to).

## Shared style paragraph (paste as context for every prompt below)

> 2D game weapon icon art, flat cel-shaded mobile game style, matching this game's locked art
> direction: bold clean uniform black outlines, flat solid colour fills, simple soft cel
> shadows, minimal internal detail, strong readable silhouette, reads clearly at tiny icon
> size. Deliberately FLAT — like a modern 2D mobile game sprite / sticker, NOT a 3D render, no
> realistic metal, no heavy gradients, no photographic texture.
>
> The subject is ONLY the weapon itself — a modular crystal-tech weapon business-end that
> plugs into this game's universal orbiting mount-socket. Do NOT draw the robot body, no
> character, no hands, no background scenery — just the single weapon object, floating in
> isolation, composed **socket end upper-left, business end lower-right** (matching this
> game's `gun_default`/`sword_default` convention exactly — do not compose it pointing any
> other direction). The back (upper-left) end has a small round socket-connector nub,
> identical in shape/size to this game's existing weapon socket connector, clearly the part
> that plugs into the mount. **The weapon is a sealed cylindrical/tapered module with NO hand
> grip, NO pistol handle, and NO trigger guard anywhere on it** — nothing in this game has
> hands or fingers (it plugs into a floating socket, nothing ever holds it), so a grip or
> trigger shape is a fiction-breaking mistake, not just a style nitpick; every existing weapon
> in this game (`gun_default.png` included) is a straight housing with no protruding handle.
> TRANSPARENT background (real alpha, not a grey or white matte fill — this must survive being
> decoded and checked pixel-by-pixel for alpha). No text, no ground/shadow, no character.

Both prompts below are **complete, standalone, copy-paste-ready** strings (the shared style
paragraph above is already folded into each one — you don't need to splice anything). Both
failed once already on exactly the grip/trigger-guard point (`art/weapon/leftover/*ice_weapon_
icon*`/`*crystal_tech_rifle_icon*` — real, on-theme ice colours and iconography, but drawn as a
handheld raygun with a trigger guard) — the negative constraint above was added specifically
because of that failure, so don't drop it if you shorten these for a different tool.

## `cryobolt` — ice starter-pistol variant

> 2D game weapon icon art, flat cel-shaded mobile game style, matching this game's locked art
> direction: bold clean uniform black outlines, flat solid colour fills, simple soft cel
> shadows, minimal internal detail, strong readable silhouette, reads clearly at tiny icon
> size. Deliberately FLAT — like a modern 2D mobile game sprite / sticker, NOT a 3D render, no
> realistic metal, no heavy gradients, no photographic texture.
>
> The subject is ONLY the weapon itself — a modular crystal-tech weapon business-end that
> plugs into this game's universal orbiting mount-socket. Do NOT draw the robot body, no
> character, no hands, no background scenery — just the single weapon object, floating in
> isolation, composed socket end upper-left, business end lower-right (matching this game's
> gun_default/sword_default convention exactly — do not compose it pointing any other
> direction). The back (upper-left) end has a small round socket-connector nub, identical in
> shape/size to this game's existing weapon socket connector, clearly the part that plugs into
> the mount. The weapon is a sealed cylindrical/tapered module with NO hand grip, NO pistol
> handle, and NO trigger guard anywhere on it — nothing in this game has hands or fingers (it
> plugs into a floating socket, nothing ever holds it), so a grip or trigger shape is a
> fiction-breaking mistake; every existing weapon in this game (gun_default.png included) is a
> straight housing with no protruding handle. TRANSPARENT background (real alpha, not a grey or
> white matte fill — this must survive being decoded and checked pixel-by-pixel for alpha). No
> text, no ground/shadow, no character.
>
> The weapon is a longer, more angular precision crystal-tech barrel with a narrow focused
> muzzle (reads deliberate/sniper-ish, not a spray weapon) — a straight tapered tube, the same
> family of shape as this game's own `seeker`/`lasercutter` housings, NOT a handgun silhouette.
> A pale-blue (#81D4FA) glowing crystal core sits visible mid-barrel behind a small transparent
> window. Clean flat ice-crystal facets (NOT painterly frost texture) rim the muzzle, with a
> small snowflake icon badge on the housing (this game's element icon-badge convention).

## `frostseeker` — ice variant of the existing `seeker` frame (legendary)

> 2D game weapon icon art, flat cel-shaded mobile game style, matching this game's locked art
> direction: bold clean uniform black outlines, flat solid colour fills, simple soft cel
> shadows, minimal internal detail, strong readable silhouette, reads clearly at tiny icon
> size. Deliberately FLAT — like a modern 2D mobile game sprite / sticker, NOT a 3D render, no
> realistic metal, no heavy gradients, no photographic texture.
>
> The subject is ONLY the weapon itself — a modular crystal-tech weapon business-end that
> plugs into this game's universal orbiting mount-socket. Do NOT draw the robot body, no
> character, no hands, no background scenery — just the single weapon object, floating in
> isolation, composed socket end upper-left, business end lower-right (matching this game's
> gun_default/sword_default convention exactly — do not compose it pointing any other
> direction). The back (upper-left) end has a small round socket-connector nub, identical in
> shape/size to this game's existing weapon socket connector, clearly the part that plugs into
> the mount. The weapon is a sealed cylindrical/tapered module with NO hand grip, NO pistol
> handle, and NO trigger guard anywhere on it — nothing in this game has hands or fingers (it
> plugs into a floating socket, nothing ever holds it), so a grip or trigger shape is a
> fiction-breaking mistake; every existing weapon in this game (gun_default.png included) is a
> straight housing with no protruding handle. TRANSPARENT background (real alpha, not a grey or
> white matte fill — this must survive being decoded and checked pixel-by-pixel for alpha). No
> text, no ground/shadow, no character.
>
> The weapon reuses this game's existing "seeker" frame's own sleek tracking-bolt rifle
> silhouette — a straight tapered barrel, same overall housing shape, NOT a handgun — but
> re-themed ice instead of neutral: a pale-blue (#81D4FA) glowing crystal core visible through
> the housing and a light frost-rime accent at the muzzle, instead of a plain grey housing.
>
> (If your generation tool accepts a reference image, attach `art/weapon/seeker_raw.png`
> alongside this prompt and ask for "the same silhouette, re-themed ice, no grip" instead of
> relying on the shape description alone — this keeps the two frame-siblings visually
> consistent AND reuses `seeker`'s already-correct grip-less silhouette as a hard visual
> anchor.)

## Workflow reminder (art half)

Save each accepted generation as `art/weapon/<id>_raw.png` (rejects/duplicates into
`art/weapon/leftover/`, not `_alt`/`_alt2` — this batch arrived as several independent full
generations per weapon rather than one accepted + numbered rejects, so a flat `leftover/`
folder was clearer than a naming scheme; keep using `_alt`/`_alt2` for a single weapon's own
reject sequence). Decode with `tools/png-pipeline/pngCodec.mjs`'s `decodePNG` to confirm real
alpha (do not trust the preview by eye — several of this batch's PNGs had a translucent, NOT
fully opaque, background baked in, which looks fine by eye and wrong once decoded), then `node
tools/png-pipeline/compress.mjs --long-axis=320 <file>` (matches every other weapon in
`client/public/weapons/`) and drop the result into `client/public/weapons/gun_<id>.png`.

## Workflow reminder (code half — NOT art, do not skip)

All 6 entries already exist in `WEAPON_DEFS` (`client/src/render/weaponSkins.ts`) as of
2026-08-03, done exactly this way — kept here as the reference for the *next* weapon batch:

1. Add an entry: `path: '/weapons/gun_<id>.png'`, an eyeballed `anchor`, and a `scale` (match
   the `78–90 / 320` range the rest of the table uses — this batch used 78–80/320).
2. Measure each `rotationOffsetRad` for real — do not eyeball it. Load the PNG, take the
   alpha-farthest pixel from the (eyeballed) anchor as the tip, `rotationOffsetRad =
   -atan2(tipY - anchorY, tipX - anchorX)` in image space (y-down) — see the `KIND_DEFAULTS`/
   `WEAPON_DEFS` header comment in that file for the method, and this batch's 6 entries for a
   worked example.
3. `preloadWeaponSkins()` already iterates `allDefs()` (both `KIND_DEFAULTS` and `WEAPON_DEFS`)
   — no change needed there when new entries are added.
4. Verify live: `?wpn=<id>` (dev query param), `beginRun()` + `mainMenu.hide()` from the
   console, hover the mouse due right of the player, and confirm the mounted sprite's tip
   points at the cursor — this is how the wrong-rotation class of bug would actually show up,
   a static screenshot at rest doesn't exercise `rotationOffsetRad` at all.
