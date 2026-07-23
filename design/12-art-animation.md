# Art & animation pipeline

How pixels get onto the screen: **skins** (the `02` appearance layer made concrete), the **spritesheet/atlas + animation-data format**, the **asset-loading path** (web and WeChat), and the **art constraints the tilted view imposes** (`01`). It builds on the Actor/Skin/Weapon split (`02`), the rendering/depth model (`01`), the WeChat asset constraints (`04`), and the events channel (`08`). This doc is the source of truth for **what an art asset looks like, how it loads, and the hard rule that art is pure presentation — it never feeds the engine**.

> **Status:** the current vertical slice is **Graphics-only** (procedural rectangles/ellipses/glows in `Game.ts`, `Skin.ts`) — deliberately, so WeChat boot+render was verified with zero image loaders (`04`). This doc defines the pipeline that replaces those placeholders when real art lands; nothing here is built yet.

## The decisions (locked)

- **Art is pure presentation and never decides an outcome.** Animation, textures, and particles read `GameState` + the per-frame `events` queue (`08`) and draw. They **never** write back to engine state, never gate a hit, never advance a tick. A frame event may *trigger* a muzzle flash, but the engine already decided the shot (`08`'s "events are the only engine→render channel"). This keeps determinism intact (`06`): two clients can run different art/quality tiers and stay byte-identical in simulation.
- **Skin = animation-rig + swappable atlas, decoupled (`02`).** Animation data (frame timing, anchors, event frames) is authored **once per rig** and shared; a skin is just "which atlas fills this rig." Swapping a skin swaps the texture atlas key, not the animation logic (`02`'s "build it this way from the start, or adding skins later hurts").
- **A skin is a character with balanced stats (`14`), but its *art* is still pure presentation.** Each skin carries its own `(maxHp, maxShield)` + break-passive (`05`/`09`/`14`) — there is no cosmetic-only reskin layer, and unlike the earlier plan the character (incl. passive) **does apply in PvP**, kept fair as a side-grade by balance discipline (`14`), not normalized out. What stays true for *this* doc: the **art** never decides an outcome (above) — the stat differences live in `SkinDef` data (`09`), the pixels just draw the character. Silhouettes should telegraph the character's archetype (`13`).
- **Tilted-view-native art (`01`).** Every actor/prop is drawn with a small front face (not a pure top-down sprite), authored for `screen.y = gy - z` and Y-sort by `gy`. Sprites have a defined **ground anchor** (feet at `gy`) and a **height extent** so shadows and occlusion read correctly (`01`).
- **Placeholder-first, atlas-later.** Systems consume a `Skin`/texture interface; the *slice* fills it with `Graphics`, real art fills it with atlas frames — same interface. Gameplay is never blocked on art (`02`/`03`'s data-driven intent).
- **Animation = funny's skeletal editor + `.tao`, copied in and locally maintained.** Reuse `funny/tools/animator` (2D skeletal, PixiJS) and its `.tao` format rather than a new tool or DragonBones/Spine; files save to **local disk only** (no shared workspace). Full rationale + model in the Animation section below.

## Animation: reuse funny's skeletal editor (`.tao`)

**Decision (locked, 2026-07-23):** DayDayUp does **not** build a new animation tool and does **not** adopt DragonBones/Spine. It **reuses funny's home-grown 2D skeletal editor** (`funny/tools/animator`, PixiJS) and its `.tao` runtime format. Rationale: the engine already mirrors funny (`06`), the editor's runtime math is dependency-free and *designed to be copied into the game* (below), it already supports weapon mounting, and it has no third-party runtime or licence. This is the concrete answer to this doc's old "animation-data source of truth" open question, and the implementation of `02`'s `Skin { rig, atlasKey, handAnchor() }`.

- **The rig is a fixed 11-bone humanoid** — `root → spine → head / 2×arm / 2×leg` (funny's `Skeleton`). Rest pose faces **right**; left/right is a flip, not a second rig. Fits the reclaimer diver and humanoid enemies directly; non-biped creatures are the open question below.
- **Two-layer params = `02`'s "skin = rig + atlas".** **Binding** is the static per-skin rest pose (`anchorX/Y`, `rotation`, `scaleX/Y`, `flipX`, `zOrder`); **Keyframe** is the per-frame delta (`rotation`, `translate`, `scale`, `alpha`). A skin is the same skeleton with its **own part PNGs + Binding** — swapping a skin swaps the parts, never the animation clips.
- **The runtime is pure and render-only.** `Skeleton.computeFK` (forward kinematics) and `interpolate.sampleClip` (keyframe interpolation) are **no-DOM / no-Pixi / no-dependency** pure functions — ported straight into `@dd/engine`'s **render side**. They read `GameState` + the `events` queue (`08`) and draw; they **never** feed the sim (`06`) — the locked "art never decides an outcome" rule, made literal.
- **Weapon/gear mounts to a `gear_<slot>` attachment point.** A `.tao` declares attachment points (bone + offset); a weapon renders as a sprite parented to **`gear_hand`**, following the hand bone's FK pose every frame — this *is* `02`'s "hand anchor follows the frame, weapon tracks it." Swapping the active weapon slot (`03`) swaps the sprite at `gear_hand`; front/back z by facing is the attachment draw order (`01`). A per-weapon `grip` (`03`/`09`) picks which arm clip aims it. **Rarity reads off the mounted weapon** via a per-rarity ornament/emissive overlay on the frame sprite (not a separate sprite per rarity — that would multiply `03`'s frame×element production); the overlay uses the rarity border palette (白→蓝→紫→金, `14`), kept distinct from the element-FX colour language (`13`).
- **No per-frame animation events.** FX (muzzle flash, impact) are triggered by the engine `events` queue (`08`) — "events are the only engine→render channel" — **not** by animation frames, so the visual can never drift out of sync with the sim hit window (this retires the old event-alignment worry). Purely-cosmetic cues (a footstep puff) derive from the run clip's own time, render-side only.
- **Shadow is program-drawn** (funny's shipped approach): a `shadow` attachment point carries only position + ellipse size — the runtime draws one shared soft ellipse, zero texture, always flat on the ground. No shadow is ever baked into a sprite (`01`).
- **Formats:** `.tao` (a zip of `animation.json` + packed `spritesheet.png/json`) is the runtime asset; `.tao.editor` (source PNGs + edit state) is the working file. **Files are saved to local disk only — no shared/online workspace** (funny's Supabase/Workers/GitHub-sync bridge is dropped for this project). The editor's IndexedDB autosave is a local convenience; the disk `.tao.editor` is the source of truth, committed to the repo alongside the exported `.tao`.
- **The tool is copied in and maintained here.** `tools/animator` is lifted into DayDayUp and **owned/maintained per-project** (it will diverge — rig defs, export tiers, etc.) — not a live dependency on funny.

### Facing model (twin-stick 360° aim)

funny is a lane auto-battler (units only face left/right); DayDayUp aims in **360°**, and a 2D bone rig gives L/R flip + limb rotation, **not** a true 3D turn. Chosen model — **two-hemisphere billboard + aim-driven arm**:

- Body plays locomotion (idle/run) authored facing the camera; **L/R mirror** by the horizontal sign of the aim/move vector.
- A **front and a back body set**: aim toward the bottom of the screen (toward camera) draws the front art, toward the top (away) draws the back (hood/backpack). Picked by the aim vector's **vertical hemisphere**, so all 360° reads correctly.
- The **weapon arm bone rotates to the exact aim angle**; the `gear_hand` weapon follows, so the muzzle always points at the reticle.
- **Shippable in stages:** front-only first (arm aims + L/R flip); the back set is a pure content add (extra attachment set + a hemisphere selector), **no engine change**.

### Render clock

Animation is time-driven on the **render clock**, not the sim clock. Sim is 30 Hz (`08`); art plays at any authoring fps and interpolates via `sampleClip`. Which clip plays is a pure function of `GameState` (moving? attacking? `hp<=0`?) each render frame — it holds no authoritative data.

## Atlas / spritesheet format

- **Packed texture atlases** (Pixi spritesheet JSON + a single page image per skin, multi-page if it overflows max texture size). One atlas per skin keeps swaps to a single texture bind.
- **Power-of-two pages, trimmed frames, documented max size.** Low-end WeChat/Android GPUs cap texture size (verify on device, `04`); pick a page cap (e.g. 2048) and pack within it. Trim transparent margins but **keep the ground/hand anchors in original (untrimmed) frame space** so `02`'s mounting math stays stable.
- **Premultiplied alpha**, consistent across pages, matching the renderer's blend setup (the fx layer already uses additive, `01`).
- **Props & environment** (pillars, crates, walls, floor decals) are atlas frames too, authored tilted (front face + top cap, like the slice's procedural pillar in `Game.ts:buildPillars`) with a ground anchor and height extent for Y-sort/shadow (`01`).

## Asset loading (web + WeChat)

- **Pixi `Assets` is the single loader**, fed a manifest of atlas bundles keyed by skin/room-set. Load a **core bundle** at boot (player, common enemies, UI, current room set); lazy-load per-biome/enemy bundles between rooms (`05`) so the initial download stays small.
- **WeChat path (`04`):** the current adapter is Graphics-only and loads no remote assets; real art requires extending the adapter's `fetch` → `wx.request` / `wx.downloadFile`, and verifying the **texture loaders' reliance on `Image` / `ImageBitmap` on the lowest base library** — flagged in `04` as the thing that only surfaces once real assets land. Prefer formats the WeChat loader handles without `createImageBitmap` where that path is shaky.
- **Bundle with code vs. fetch at runtime** interacts with `09`/`06`: bundled assets version with the client and the `ENGINE_VERSION`/replay guarantee; runtime-fetched content can update without a release but must not carry anything the engine reads (it doesn't — art is presentation, so fetched art is safe for determinism; only fetched *config/rooms* touches `09`'s versioning concern).
- **No runtime canvas texture generation on WeChat** beyond the adapter's `createCanvas` (`04`); procedural looks are done with Pixi `Graphics` (portable, as the slice's glow already is) or shaders — subject to `04`'s no-`eval` shader-upload constraint.

## Tilted-view art requirements (from `01`)

Authoring rules so 2D art produces the fake-3D feel and doesn't hit `01`'s known break cases:

- **Front face + implied top**, fixed camera angle — every sprite drawn as if seen slightly forward-leaning (`01`).
- **Ground anchor at the feet** → `gy`; **height extent upward** → the sprite occupies `gy-height .. gy`, so Y-sort and the separate shadow layer work (`01`).
- **Shadows are a separate layer element** (`01`), not baked into the sprite — drawn at ground coords, shrinking/fading with `z`. Author sprites without a baked shadow.
- **Avoid `01`'s break cases:** don't author one giant sprite that must be simultaneously in front of and behind a tall prop; split tall objects into Y-sortable segments; keep occlusion silhouettes clean.
- **Fidelity roadmap alignment (`01`):** art must be authorable for later normal-map lighting (milestone 2) — keep a consistent light direction in hand-painted shading, or author flat + normal maps, so the lightmap pass composites cleanly.

## Naming & authoring conventions

- **Stable ids, not filenames, in data.** Rig states, frame refs, atlas keys, and event tags are the contract with `02`/`08`; renaming a source file must not break a skin. Map files→ids in the manifest.
- **Kebab-case, namespaced keys:** `enemy.slime.run`, `player.hand-anchor`, `fx.muzzle.small`. Event tags are a small closed vocabulary shared with fx/audio (`11`, when it lands): `footstep`, `muzzle`, `hit-active`, `impact`, `death`.
- **One rig per body archetype**, many skins per rig — enforced so a new character is a new atlas + manifest row + a `SkinDef` stat row (`09`/`14`), no new animation code (`02`).

## Relationship to the other docs

- **`02`:** Skin/animation decoupling, hand-anchor mounting, "characters are only skins" — this doc is that model's concrete data format.
- **`01`:** depth/Y-sort/shadow/height and the fake-3D limits art must respect; the fidelity roadmap art must stay compatible with.
- **`04`:** WeChat asset-loader constraints; the adapter `fetch` extension and lowest-base-library texture verification.
- **`08`:** the `events` queue that triggers animation events / fx; the render-vs-sim clock split.
- **`06`/`09`/`14`:** determinism (art never feeds logic); the PvP fairness wall keeps *crafted weapons* out of the arena structurally, while *characters* (skin stats + passive) do enter PvP as balanced side-grades — art is still never a power source, the stats live in `SkinDef` data.
- **`10`:** UI art (HUD icons, buttons) shares this pipeline but is authored for the `ui` layer and screen space, not world tilt.
- **`13`:** the worldview + art *direction* (style, the element colour law, biome looks, tone) this pipeline renders; `13` sets *what* the world looks like, this doc sets *how* the assets are built and animated.
- **`11` (audio, reserved):** animation event frames are the shared trigger vocabulary for sound.

## To design

- **Bundle boundaries** — what's in the boot core bundle vs. lazy per-biome/enemy, sized against WeChat download limits (`04`).
- **Placeholder→final swap process** — keep the `Skin` interface stable so the Graphics slice and `.tao`-driven art are interchangeable during production.
- **Normal-map / lighting authoring** for `01`'s milestone-2 lightmap — flat+normal vs. pre-shaded.
- **`animator` port scope** — what to lift from `funny/tools/animator` first (editor + FK/`sampleClip` runtime + `.tao` I/O), and what to strip (the Supabase/Workers/GitHub workspace-sync bridge — dropped, local-only).

> Resolved by the Animation decision above: **animation-data source** (funny's editor + `.tao`) and **atlas tooling** (the editor packs the spritesheet via shelf bin-packing; anchors are authored in-tool as Bindings/attachment points) — no longer open.

## Open questions

- **Texture format & max page size on the lowest base library** — must be measured on a real device (`04` checklist), not chosen from docs; affects atlas packing.
- **`ImageBitmap` availability in the WeChat loader** — if unreliable, which decode path does `Assets` take, and does it force a specific image format? (`04` flags this as surfacing "once real assets land" — this is that moment.)
- **Bundled vs. fetched art** — fetched art is determinism-safe (presentation only) but complicates release/versioning; where's the line, and does it share `09`'s content-delivery decision?
- **Non-biped rigs.** funny's `Skeleton` is a **fixed 11-bone humanoid** (hardcoded bone defs). The diver + humanoid enemies fit directly, but the concepted blight quadruped does not. Options: (a) extend `Skeleton` to hold **multiple rig definitions** (moderate refactor — the recommended lean), (b) author exotic creatures as simple cut-out/frame sprites outside the humanoid rig, (c) keep early monsters humanoid/near-humanoid and defer exotics. Decide when the first non-biped enemy is built.
- **Rig granularity within humanoids** — do all bipeds share the one rig (max animation reuse) or do some get bespoke bone tweaks (silhouette variety)? (`02`)
