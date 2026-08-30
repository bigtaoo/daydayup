# Art & animation pipeline

How pixels get onto the screen: **skins** (the `02` appearance layer made concrete), the **spritesheet/atlas + animation-data format**, the **asset-loading path** (web and WeChat), and the **art constraints the tilted view imposes** (`01`). It builds on the Actor/Skin/Weapon split (`02`), the rendering/depth model (`01`), the WeChat asset constraints (`04`), and the events channel (`08`). This doc is the source of truth for **what an art asset looks like, how it loads, and the hard rule that art is pure presentation — it never feeds the engine**.

> **Status (2026-08-02): the pipeline defined here is built and carrying real art.** The
> `.tao` rig runtime ships in the game (`render/`), `tools/animator` authors it, and the
> bound roster is the full 3 characters + boss/critter/brute/floater enemies + a distinct
> sprite for every ranged/melee weapon id + biome floor/wall art + UI/NPC art. The original
> Graphics-only slice (procedural rectangles/ellipses/glows in `Skin.ts`) survives only as
> the fallback drawn when a skin has no atlas entry, and for BULLETS, whose few world px make a
> sprite pointless. (Until 2026-08-20 this sentence also named pickups and the portal as
> "never planned as sprite art" — a judgement made while the walls were still flat rectangles.
> Both now ship real art; see the Update at the bottom of this doc.) The dated Update notes at the bottom of this doc record
> how each piece landed. **Update (2026-08-03): ROADMAP 5.3/5.4 are both closed too** — the
> GPT-Image-2 art this pipeline generates is now treated as final production art (not a
> placeholder awaiting an authored replacement), which also unblocked dynamic/normal-map
> lighting (shipped as a shader-derived approximation, no normal-map asset needed) and the
> four fidelity-roadmap custom shaders. What remains open is only `04` (WeChat device
> verification, blocked on hardware) and real authored SFX/music (`11`, a sourcing/licensing
> task, unrelated to this pipeline). **Update (2026-08-17): the runtime was assembling that
> art wrong** — bone sprites drawn at each bone's pivot instead of its tip, and rotated by the
> bone's raw world angle — which disassembled every rigged character on screen (the hero read
> as a bare ball with a gun on its head) while every individual asset was fine. Fixed, plus the
> energy tether is now actually drawn; see the dated update at the bottom of this doc. The
> module-proportion call that used to be listed here as remaining was settled the same day —
> `MODULE_SCALE = 0.75` (`render/weaponSkins.ts`), the user's own pick between matching the
> concept's ~0.5 ratio and keeping every weapon frame's silhouette readable at gameplay
> scale. **Update (2026-08-18): the facing model got two real corrections** (aim-driven body
> + continuously-tracking eye, see "Facing model" below) and `01`'s per-weapon front/back
> z-order rule — documented since `01` was written, never implemented — now actually runs.
> The one art gap left in this pipeline WAS the **back set beyond the eye**; the half of it that
> mattered in play is closed as of 2026-08-24, with no new art. A character facing away used to
> keep drawing the transparent `belly` chamber set into its FRONT, which is the second of the two
> fixes offered under "Facing model" below — hide it rather than paint a `belly__back`.
> `RigSkin`'s new `FRONT_ONLY_BONES` set does exactly that, and only when no `${boneId}__back`
> texture exists, so shipping the PNG later supersedes the hide for free. `shell__back` remains
> genuinely optional: design/13 chose a radially-ish-symmetric body partly so front/back sets
> nearly collapse, and the shell reads the same from either side.

## The decisions (locked)

- **Art is pure presentation and never decides an outcome.** Animation, textures, and particles read `GameState` + the per-frame `events` queue (`08`) and draw. They **never** write back to engine state, never gate a hit, never advance a tick. A frame event may *trigger* a muzzle flash, but the engine already decided the shot (`08`'s "events are the only engine→render channel"). This keeps determinism intact (`06`): two clients can run different art/quality tiers and stay byte-identical in simulation.
- **Skin = animation-rig + swappable atlas, decoupled (`02`).** Animation data (frame timing, anchors, event frames) is authored **once per rig** and shared; a skin is just "which atlas fills this rig." Swapping a skin swaps the texture atlas key, not the animation logic (`02`'s "build it this way from the start, or adding skins later hurts").
- **A skin is a character with balanced stats (`14`), but its *art* is still pure presentation.** Each skin carries its own `(maxHp, maxShield)` + break-passive (`05`/`09`/`14`) — there is no cosmetic-only reskin layer, and unlike the earlier plan the character (incl. passive) **does apply in PvP**, kept fair as a side-grade by balance discipline (`14`), not normalized out. What stays true for *this* doc: the **art** never decides an outcome (above) — the stat differences live in `SkinDef` data (`09`), the pixels just draw the character. Silhouettes should telegraph the character's archetype (`13`).
- **Tilted-view-native art (`01`).** Every actor/prop is drawn with a small front face (not a pure top-down sprite), authored for `screen.y = gy - z` and Y-sort by `gy`. Sprites have a defined **ground anchor** (feet at `gy`) and a **height extent** so shadows and occlusion read correctly (`01`).
- **Placeholder-first, atlas-later.** Systems consume a `Skin`/texture interface; the *slice* fills it with `Graphics`, real art fills it with atlas frames — same interface. Gameplay is never blocked on art (`02`/`03`'s data-driven intent).
- **Animation = funny's skeletal editor + `.tao`, copied in and locally maintained.** Reuse `funny/tools/animator` (2D skeletal, PixiJS) and its `.tao` format rather than a new tool or DragonBones/Spine; files save to **local disk only** (no shared workspace). Full rationale + model in the Animation section below.

## Animation: reuse funny's skeletal editor (`.tao`)

**Decision (locked, 2026-07-23):** DayDayUp does **not** build a new animation tool and does **not** adopt DragonBones/Spine. It **reuses funny's home-grown 2D skeletal editor** (`funny/tools/animator`, PixiJS) and its `.tao` runtime format. Rationale: the engine already mirrors funny (`06`), the editor's runtime math is dependency-free and *designed to be copied into the game* (below), it already supports weapon mounting, and it has no third-party runtime or licence. This is the concrete answer to this doc's old "animation-data source of truth" open question, and the implementation of `02`'s `Skin { rig, atlasKey, socketAnchor() }` (the weapon mount is the orbiting socket, not a hand — `13`).

- **The rig is our own, purpose-built for the orb-core** (`13`) — a tiny hierarchy: `root → shell → eye + belly-fill + 2× orbiting weapon-socket`. **No arms, no legs → no humanoid skeleton and no walk cycle**; motion is hover-bob, lean into travel, and squash-stretch on `root`. funny's fixed 11-bone humanoid `Skeleton` is **not** adopted — we take only its dependency-free FK / `sampleClip` runtime math and the `.tao` format, and author our own small rig defs (one per body archetype: orb-core, crystal critter, boss core). The rest pose faces the camera; left/right is a flip. The editor is rewritten for this project (below), so it holds **multiple rig definitions**, not one hardcoded humanoid.
- **Two-layer params = `02`'s "skin = rig + atlas".** **Binding** is the static per-skin rest pose (`anchorX/Y`, `rotation`, `scaleX/Y`, `flipX`, `zOrder`); **Keyframe** is the per-frame delta (`rotation`, `translate`, `scale`, `alpha`). A skin is the same skeleton with its **own part PNGs + Binding** — swapping a skin swaps the parts, never the animation clips.
- **The runtime is pure and render-only.** `Skeleton.computeFK` (forward kinematics) and `interpolate.sampleClip` (keyframe interpolation) are **no-DOM / no-Pixi / no-dependency** pure functions — ported straight into `@dd/engine`'s **render side**. They read `GameState` + the `events` queue (`08`) and draw; they **never** feed the sim (`06`) — the locked "art never decides an outcome" rule, made literal.
- **Weapons mount to the two orbiting weapon-socket bones — for the body plan that HAS them.**
  Since 2026-08-21 the mount is a declared property of the rig (`RigDef.weaponMount`, resolved by
  `render/rigWeaponMount.ts`) with three values, because the roster turned out to need three:
  `'socket'` is the rule below (orb-core, the hero); `'held'` mounts a single module on the body
  art's own measured edge, for the enemy body forms, which have no socket bone and no arms to hang
  one off; `'none'` draws no weapon at all (boss-core, whose shard rings are its armament, `13`).
  The default for a rig that declares nothing is deliberately conservative — `'socket'` only if the
  socket bone exists, else `'none'` — so a new body plan has to ASK for a weapon rather than sprout
  one. The rest of this bullet describes the `'socket'` path. A `.tao` declares attachment points (bone + offset); each of the two sockets orbits the core on a tether and **rotates to the exact aim angle** — the weapon module (barrel / blade) is a sprite parented to a socket, following its FK pose every frame (`13`'s universal mount, `02`'s "the mount follows the frame, weapon tracks it"). Swapping the active weapon slot (`03`) swaps the sprite at that socket; front/back z by facing is the attachment draw order (`01`). There is **no `gear_hand` and no per-weapon `grip`/arm-clip** — a socket is arm-agnostic, so one mount holds any frame, ranged or melee; melee's swing is the socket sweeping its arc (the deflect sector, `03`/`13`) and the tether length sets melee reach. **Rarity reads off the mounted weapon** via a per-rarity ornament/emissive overlay on the frame sprite (not a separate sprite per rarity — that would multiply `03`'s frame×element production); the overlay uses the rarity border palette (白→蓝→紫→橙→金, `14`), kept distinct from the element-FX colour language (`13`).
- **No per-frame animation events.** FX (muzzle flash, impact) are triggered by the engine `events` queue (`08`) — "events are the only engine→render channel" — **not** by animation frames, so the visual can never drift out of sync with the sim hit window (this retires the old event-alignment worry). Purely-cosmetic cues (a footstep puff) derive from the run clip's own time, render-side only.
- **Shadow is program-drawn** (funny's shipped approach): a `shadow` attachment point carries only position + ellipse size — the runtime draws one shared soft ellipse, zero texture, always flat on the ground. No shadow is ever baked into a sprite (`01`).
- **Formats:** `.tao` (a zip of `animation.json` + packed `spritesheet.png/json`) is the runtime asset; `.editortao` (source PNGs + edit state) is the working file — a single dot-segment extension (not the old compound `.tao.editor`, which OS file associations and some save dialogs don't round-trip reliably). **Files are saved to local disk only — no shared/online workspace** (funny's Supabase/Workers/GitHub-sync bridge is dropped for this project). The editor's IndexedDB autosave is a local convenience; the disk `.editortao` is the source of truth, committed to the repo alongside the exported `.tao`.
- **The tool is copied in and maintained here.** `tools/animator` is lifted into DayDayUp and **owned/maintained per-project** (it will diverge — rig defs, export tiers, etc.) — not a live dependency on funny.

### Facing model (twin-stick 360° aim)

funny is a lane auto-battler (units only face left/right); DayDayUp aims in **360°**, and a 2D bone rig gives L/R flip + part rotation, **not** a true 3D turn. Chosen model — **two-hemisphere billboard + aim-driven sockets + a continuously-tracking eye**. The orb-core makes this cheap: it is radially-ish symmetric, so the front/back sets nearly collapse.

> **Two corrections shipped 2026-08-18, both from the same root cause: the billboard's four
> discrete states (L/R flip × front/back) were carrying the whole 360° read, and they were
> being driven by the wrong angle.**
>
> 1. **The body follows AIM, not movement.** The implementation had put `setBodyFacing` on
>    the movement vector, as a humanoid "upper body aims, lower body walks" split inherited
>    from funny. The orb-core has no lower body, so there was nothing for that split to
>    describe: strafing left while firing right pointed the eye away from the target, and
>    standing still held whatever direction the player last walked. `Scene.reconcile` now
>    turns the body toward the aim through `render/facing.ts`'s `turnToward`, rate-limited to
>    `BODY_TURN_PER_TICK` (0.27 rad/tick ≈ a 0.4 s about-face) — the limit matters because
>    auto-aim-to-nearest (`10`) makes the aim angle jump the instant a closer enemy appears,
>    and snapping the body to it read as a twitch. `Scene.positionLocal` (the co-op predicted
>    -pose path, which runs at render rate) deliberately carries the value forward instead of
>    re-deriving it, or the body would turn at double speed.
> 2. **The eye tracks continuously, with no new art.** For a body plan that is mostly one big
>    eye (`13`), the direction cue nobody has to be taught is where the eye is *looking*, so
>    the `eye` slot now slides inside the shell along the aim on an ellipse (`EYE_TRACK_R` =
>    14 authoring px, vertical travel squashed to 45% because this is a tilted view, `01`),
>    shrinking up to 15% as the aim turns away from the camera. Computed in **canonical
>    (pre-mirror) space** like the sockets, so it lands on the correct side of the shell after
>    `view.scale.x` flips the rig. That turns four poses into a continuum using `eye.png`
>    exactly as it already ships.
>
> ~~Still open, and the only part of this that would need new art:~~ **Closed 2026-08-24** by the
> second option this paragraph already named. When the back set shows, the eye swaps to
> `eye__back` and the front-facing `belly` chamber is now HIDDEN rather than drawn as though the
> character were still facing the camera — `RigSkin`'s `FRONT_ONLY_BONES`, gated on there being no
> `${boneId}__back` texture, so a future `belly__back` PNG takes over with zero code change. Note
> what that set is keyed off: what the art DEPICTS, not which bones lack back art. `shell` lacks
> it too, and hiding the shell would delete the character.

> **Update (2026-08-18, later the same day): a *volume* pass on top of the facing pass.** The
> user's reply to the above was that the character did now read as having direction — *"眼睛和手
> 能按方向变化了"* — but still not as having **form**: *"我希望能再强化一下立体效果"*. The facing
> model was doing its job; what was missing was lighting and grounding, neither of which any
> amount of facing work produces. Three additions, all render-only and all free of new art:
>
> 1. **Sphere shading** (`render/rigShading.ts`) — marks over the rig's body bone, pinned to the
>    key light's *screen-space* direction so they do **not** mirror with `view.scale.x`. This is
>    what makes a flat-cel shell read as a sphere: the eye travels, the light does not. Applied to
>    any rig whose body bone has a `bodyR` worth shading, so enemy and boss bodies get it too.
>    Nothing is masked (a mask per actor would be 30 stencil passes in a busy room), so every mark
>    has to stay inside the body — `rigShading.test.ts` pins that invariant, since it is the one a
>    tuning change could silently break.
>
>    **Both halves of this were wrong and were rebuilt 2026-08-19** (see `01` "Volume, measured").
>    The marks were a white specular plus four concentric dark arcs: measured, the specular is
>    arithmetically a no-op over design/13's near-white shells and the arcs put their darkest band
>    on the rim with hard angular cut-offs, reading as dirt rather than as a turning surface. They
>    are now a smooth chord-band ramp with a reflected-light rollback, plus a warm wash for the lit
>    side (hue is the only channel white art leaves available). And "strictly inside `bodyR`" was
>    the wrong bound: `bodyR` is a *declared* radius, the art paints 0.68-1.00 of it, so the marks
>    were spilling onto the transparent background — see "A bone's `bodyR` is a declared radius"
>    below.
> 2. **Far-side depth cues on the modules** — the per-weapon z-order flip (item 2's sibling,
>    shipped hours earlier) reads on its own as "the module changed layer". A depth scale and a
>    depth tint on top of it read as an orbit around a sphere. Recomputed against the current
>    `showBack` every frame, not in `setWeaponTint`, which only knows the element hue.
> 3. **Hover + a shadow that responds to it** — see `01` "Grounding the character". Worth
>    noting *here* because it is the one place an authored clip and the runtime overlap: the
>    `idle` clips already bob the body's bones, but a clip cannot move the shadow, so the
>    height half of the hover now lives in `Entity.visualZ` and the two stack.

- Body plays its hover/idle authored facing the camera; **L/R mirror** by the horizontal sign of the aim/move vector.
- A **front and a back body set**: aim toward the bottom of the screen (toward camera) draws the front (the eye), toward the top (away) draws the back (a lens/vent where the eye would be — the concept turnaround). Picked by the aim vector's **vertical hemisphere**, so all 360° reads correctly. For the orb this back set is a **single swapped part** (eye→vent), not a whole second body.
- The **two orbiting socket bones rotate to the exact aim angle**; the mounted weapon module follows, so the muzzle (or the blade's sweep) always points at the reticle.
- **Shippable in stages:** front-only first (sockets aim + L/R flip); the back part-swap is a trivial content add, **no engine change**.

### Render clock

Animation is time-driven on the **render clock**, not the sim clock. Sim is 30 Hz (`08`); art plays at any authoring fps and interpolates via `sampleClip`. Which clip plays is a pure function of `GameState` (moving? attacking? `hp<=0`?) each render frame — it holds no authoritative data.

> **Firing is NOT a clip (2026-08-30, user report *"角色射击时，没有射击动画... 看起来非常死板"*).**
> `attack` is authored in the three `char_*` bundles and has never been played, and the reason
> it stayed that way is structural rather than an oversight: clips here are sampled WHOLE
> (`RigSkin.playClip` swaps `this.clip` outright — there is no additive layer), and the four
> ENEMY bundles ship no `attack` clip at all. So playing it would (a) do nothing for any mob,
> and (b) for a hero, drop every bone the clip does not track back to rest for its duration —
> orb-core's `attack` touches only `socket_r`, so the shell/eye/belly hover bob authored into
> `idle` would snap to 0 the instant a shot went out and snap back 350 ms later. The starter
> blaster's 6-tick (200 ms) cooldown is shorter than the clip, so held fire would pin the body
> at bob 0 and release would pop it.
>
> What ships instead is `render/rigRecoil.ts`: a one-shot 0→1→0 envelope (150 ms, fast kick,
> slower settle) layered **over** whatever clip is playing, triggered by `bullet_fired`'s
> `ownerId` through `Actor.onFired`. It slides the active weapon module and its socket ring
> back along the BARREL (aim space, which the authored clip's rig-space `translateX` could not
> do) and leans the whole body a third as far. Because it moves the MOUNT rather than the
> sprite, `muzzleLocal` recoils with it for free — the drawn barrel tip, the bullet's spawn
> correction and the muzzle fx all follow the gun. One path covers all seven rigs.
>
> The authored `attack` clips are left in the bundles. They are still the right home for a real
> per-character firing pose, once every rig has one and there is a blend to play it through.

## Atlas / spritesheet format

- **Packed texture atlases** (Pixi spritesheet JSON + a single page image per skin, multi-page if it overflows max texture size). One atlas per skin keeps swaps to a single texture bind.
- **Power-of-two pages, trimmed frames, documented max size.** Low-end WeChat/Android GPUs cap texture size (verify on device, `04`); pick a page cap (e.g. 2048) and pack within it. Trim transparent margins but **keep the ground/socket anchors in original (untrimmed) frame space** so `02`'s mounting math stays stable.
- **Premultiplied alpha**, consistent across pages, matching the renderer's blend setup (the fx layer already uses additive, `01`).
- **Props & environment** (pillars, crates, walls, floor decals) are atlas frames too, authored tilted (front face + top cap, like the slice's procedural pillar in `Game.ts:buildPillars`) with a ground anchor and height extent for Y-sort/shadow (`01`).

## Asset loading (web + WeChat)

- **Pixi `Assets` is the single loader**, fed a manifest of atlas bundles keyed by skin/room-set. Load a **core bundle** at boot (player, common enemies, UI, current room set); lazy-load per-biome/enemy bundles between rooms (`05`) so the initial download stays small.
- **WeChat path (`04`) — shipped 2026-08-25, and not the way this bullet predicted.** It used to say real art "requires extending the adapter's `fetch` → `wx.request` / `wx.downloadFile`". It did not: Pixi falls back to `DOMAdapter.createImage()` whenever `globalThis.createImageBitmap` is missing, which is exactly the WeChat case, so the PNG path needed no network primitive at all — only a package-relative path. What genuinely could not work was the JSON sidecars (`taoBundle` called the *global* `fetch`), now read with `FileSystemManager.readFileSync`. Both sit behind `render/assetHost.ts`; the five loaders kept their public shape. `04`'s "Asset loading" table is the reference. The lowest-base-library question this bullet raises is still open and is still the right question — it is now narrowed to two facts (`wx.createImage()` filling `width`/`height` before `onload`, and `readFileSync(..., 'utf8')` returning a string), because everything above them is covered by `wechatAssetLoad.test.ts` — and both were then confirmed in the real simulator on 2026-08-25, along with `wx.loadSubpackage` and WebGL2. Note the scope of that: the ART pipeline reaches this target now, but the game does not yet START on it (boot never reaches `Game.start()`, `04`'s checklist item 10), so nothing here has been seen RENDERED on a WeChat surface.
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
- **Kebab-case, namespaced keys:** `enemy.critter.run`, `player.socket-anchor`, `fx.muzzle.small`. Event tags are a small closed vocabulary shared with fx/audio (`11`, when it lands): `footstep`, `muzzle`, `hit-active`, `impact`, `death`.
- **One rig per body archetype**, many skins per rig — enforced so a new character is a new atlas + manifest row + a `SkinDef` stat row (`09`/`14`), no new animation code (`02`).

## Relationship to the other docs

- **`02`:** character/animation decoupling, socket mounting, "characters are a balanced roster, not cosmetic skins" — this doc is that model's concrete data format.
- **`01`:** depth/Y-sort/shadow/height and the fake-3D limits art must respect; the fidelity roadmap art must stay compatible with.
- **`04`:** WeChat asset loading (the two mechanisms), the package budget and its gate, and the WebGL1 silent-degradation rules that make shipped art dimensions a rendering concern, not just a size one.
- **`08`:** the `events` queue that triggers animation events / fx; the render-vs-sim clock split.
- **`06`/`09`/`14`:** determinism (art never feeds logic); the PvP fairness wall keeps *crafted weapons* out of the arena structurally, while *characters* (skin stats + passive) do enter PvP as balanced side-grades — art is still never a power source, the stats live in `SkinDef` data.
- **`10`:** UI art (HUD icons, buttons) shares this pipeline but is authored for the `ui` layer and screen space, not world tilt.
- **`13`:** the worldview + art *direction* (style, the element colour law, biome looks, tone) this pipeline renders; `13` sets *what* the world looks like, this doc sets *how* the assets are built and animated.
- **`11` (audio, reserved):** animation event frames are the shared trigger vocabulary for sound.

## To design

- ~~**Bundle boundaries**~~ — **designed and shipped 2026-08-25.** `client/src/render/assetPacks.json` is the single pack table, read by the runtime (`assetManifest.ts`), the build (`build/wechatAssetSync.mjs`) and the byte gate (`build/checkWeChatPackage.mjs`). The boot core bundle is `main` (3.31 MB / 4.00 MB); four subpackages hold what a fresh run cannot reach — the ice/lightning/poison swatches (no authored dungeon maps to those elements) and `skins/boss-core` (floor 5 only). `brute-core`/`floater-core` deliberately stay in main: both spawn on floor 1. All four load once at boot rather than per-room, which satisfies WeChat's first-download rule without paying for an `await` on the way into a room; making one genuinely lazy is `ensurePack(name)` at the point of use plus dropping it from the boot set, with no loader change. See `04`'s "Package budget".

  The sizing answer was the opposite of what this list assumed. It queued "bundle boundaries" and "atlas packing" together, as if the 13.66 MB of `client/public` were a packing problem. It was not: `orb-core`'s bone textures were still 1254² while the two sibling characters on the *same rig* had shipped at 256² for months, and six byte-identical 650 KB `socket_*.png` copies were 3.9 MB on their own. Downsampling alone took it to 3.20 MB. **Atlas packing would have saved almost none of those bytes** — merging RGBA PNGs removes no pixels — so it stays queued for its real benefit (draw calls) rather than for size, and it is not urgent while render p50 is 2.1 ms of 16.7.

  Two rules the pass established for re-encoding shipped art:
  - **Never trim a rig bone's canvas.** `animation.json` binds it as `scale = authoringPx / sourceWidth` with the pivot at the canvas centre, so cropping the transparent margin resizes AND re-pivots the bone. `processPNG`'s `trim: false` (and `compress.mjs --no-trim`) exist for this; untrimmed output also happens to be *smaller*, since fully transparent rows cost almost nothing once deflated.
  - **Prefer exact 2:1 steps.** 320 → 160 and 256 → 128 make every output texel the mean of exactly four inputs, with no resampling phase error. Measured through the live renderer at real on-screen size, the exactly-halved families (UI icons, weapons) came back essentially pixel-identical to the originals (p50 ≤ 0.2/255, p95 ≤ 3.3/255); the rig art's non-integer 1254 → 256 step reads p50 0.7–4.5 and p95 15–21, concentrated on silhouette edges.
- ~~Placeholder→final swap process~~ — moot as of 2026-08-03: this pipeline's GPT-Image-2 output is now the final art, so there is no later swap to design for. The `Skin` interface (Graphics slice vs. `.tao`-driven atlas) stays exactly as documented above regardless — that decoupling was never specific to a placeholder/final distinction.
- **Normal-map / lighting authoring** for `01`'s milestone-2 lightmap — flat+normal vs. pre-shaded.
> Resolved by the Animation decision above: **animation-data source** (funny's editor + `.tao`) and **atlas tooling** (the editor packs the spritesheet via shelf bin-packing; anchors are authored in-tool as Bindings/attachment points) — no longer open.

> **`animator` port done (2026-07-26):** `tools/animator` (own package, Vite + vitest, mirrors `tools/map-editor`'s scaffolding) now holds the editor. Lifted verbatim: `interpolate.ts`'s `sampleClip`/`interpolateBone`, the `.tao`/`.editortao` JSZip I/O, the timeline/renderer/interaction plumbing (all rig-agnostic already). Rewritten: funny's static 11-bone-humanoid `Skeleton` class → an instantiable `Rig` (`skeleton/Rig.ts`) built from a `RigDef`, so the tool can hold more than one skeleton (a crystal-critter or boss-core rig is new data, not new code). The orb-core's own rig ships as the first `RigDef` (`skeleton/rigs/orbCore.ts`): 6 bones — `root → shell → eye + belly + 2 orbiting weapon-socket bones` — no arms/legs/walk-cycle anywhere. Preset clips replaced funny's six humanoid ones with `idle` (hover-bob), `move` (lean-into-travel, renamed from `walk`), `attack`, `hurt`, `death`, `spawn` — all squash-stretch/translate-driven since rotation doesn't cascade translate/scale/alpha to child bones in this FK model. Supabase/Workers/GitHub workspace-sync bridge dropped entirely (local-disk `.tao`/`.editortao` + IndexedDB auto-save only, per the locked decision above). **Deliberately out of this pass** (game-render-side work, needs the `.tao` schema to exist first): wiring the ported FK/`sampleClip` math into `@dd/engine`'s render pipeline / `Skin.ts`, aim-driven weapon-socket rotation at runtime, and the front/back eye texture swap-by-hemisphere (the `eye` bone/image-slot exists; the swap itself is content+render logic, not editor work).

> **Real orb-core art bound + editor gains multi-variant image support + a second rig verified (2026-07-27):** AI-generated placeholder art (`art/units/`: shell, belly, eye front/back, weapon-socket, a base enemy critter, a boss core — GPT Image 2) is now bound into a real seed project (`tools/animator/projects/orb-core.editortao`), not just loose PNGs — built programmatically (Node + the project's own `jszip` dependency, no manual drag-and-drop) and verified live against the running dev server (all 5 bone slots bound with correct z-order, all 6 preset clips intact, no console errors). Closes the "eye front/back texture swap" editor-side gap called out above: `ImageController` now supports **named image variants per bone slot** (`setVariantBlob`/`setActiveVariant`/`getVariantIds`), not just one texture — a slot's binding (anchor/scale/rotation) stays shared across variants (same footprint, so it drops into the identical socket, per this doc's own facing-model rule), only the texture differs; `.editortao` persists every variant (`images/<slot>__<variantId>.png` + an `activeVariantIds` label map) and `.tao` export bakes every variant into the spritesheet (`<slot>` = active frame, `<slot>__<variantId>` = alternates) for a future renderer to pick from by aim hemisphere — the render-side picking logic itself was still the deliberately-deferred item below at the time this paragraph was written; it shipped in the 2026-07-27 update two paragraphs down (`RigSkin.ts`'s `showBack`/`facingFromAim`), so only history, not a current gap. Along the way, found and fixed a real latent bug (pre-dating this session): `loadEditorBlob` never cleared `ImageController` before restoring a new project, so images/variants could leak from whichever project was open before — surfaced by a live two-project-load test, not spotted by inspection. Also: `.tao.editor` renamed to **`.editortao`** throughout (single dot-segment — the old compound extension wasn't reliably recognized by OS file associations / some save dialogs). Separately, verified this doc's "a crystal-critter or boss-core rig is new data, not new code" claim for real: added `skeleton/rigs/bossCore.ts` (`root → core → 2 orbiting shard-ring bones`, structurally distinct from the orb-core — no eye/belly/sockets) and an opt-in `?rig=boss-core` dev toggle in `App.ts` (same convention as this project's other query-param dev harnesses); loaded a boss seed project (`projects/boss-core.editortao`, `boss.png` bound to `core`) against the live app with zero changes to `Rig`/`ImageController`/`IOController`/`ImagePanel` — confirmed the tool genuinely generalizes to a second body archetype. This is a verification harness, not a production multi-rig project switcher — IndexedDB project auto-save/switching wasn't rig-aware yet at the time (**fixed 2026-07-27, later still**: `ProjectMeta` gained an optional `rigId`, stamped on every create/rename/autosave and checked before ever opening a project, so a project saved under one `?rig=` can no longer silently load under another and blank the character). `enemy_critter.png`/further boss atlas art remain real-art-production work, same as the orb-core parts before this pass.
>
> Design-decision note: the concrete per-element/per-biome hex palette this doc's "To design" list still calls out was NOT locked as part of this pass — the placeholder art above used first-pass suggested hex values consistent with `13`'s colour LAW (fire/ice/lightning/poison/physical), not officially chosen final values.
>
> **Update (2026-07-27):** the per-element hex half of that note is resolved — `13`'s "Element palette (locked)" table writes down the values `client/src/game/theme.ts` already ships (per-biome background palettes are still open). Same pass: two more character orb-cores bound (`skirmisher`/`juggernaut` — `projects/skirmisher-core.editortao` / `juggernaut-core.editortao`, same rig/bindings/clips as `orb-core.editortao`, only shell/belly/eye art differs, scale-corrected for their 1024px source vs the base's 1254px); the game's `RigSkin` renderer wired to pick a character's bundle by `SkinDef.atlasKey` (`skinRegistry.ts`'s `RIG_DEFS` keyed `char_vanguard`/`char_skirmisher`/`char_juggernaut`, all sharing one `Rig` instance since it's the same skeleton) instead of a single hardcoded `'orb-core'`; the two previously-deferred render gaps this doc calls out above — **aim-driven weapon-socket rotation** and **weapon mounting** — are done (`RigSkin.ts`: `socket_l`/`socket_r`'s rendered rotation now tracks the live aim angle every frame instead of only the authored clip, and a neutral `gun_default`/`sword_default` sprite mounts on the active socket by equipped weapon kind — one sprite per KIND, not per weapon frame, since `content/weapons.ts` doesn't yet give ranged/melee frames distinct `skinRef`s); and a minimal one-bone `critter-core` rig (`skeleton/rigs/critterCore.ts`, `projects/critter-core.editortao`) binds the existing neutral `enemy_critter.png` so it can be previewed/animated in the editor.
>
> **Update (2026-07-28): per-weapon-id art superseded the "one sprite per KIND" placeholder above.** `client/src/render/weaponSkins.ts` now keys business-end art by `WeaponSimSpec.name` (falling back to the `ranged`/`melee` kind default for the two ids without dedicated art) — 9 of 11 weapon ids (`scattergun`/`seeker`/`mortar`/`lasercutter`/`tomahawk`/`novaburst`/`gyre`/`hammer`/`spear`) ship their own AI-placeholder sprite (alpha-trimmed, box-downsampled, hand-rolled-PNG-codec-encoded — no image lib on the Node side). Because most of this art was composed "socket on the right" rather than `gun_default`/`sword_default`'s own "socket upper-left" convention, each texture carries a measured (not eyeballed) `rotationOffsetRad` that cancels its own baked pointing direction so `RigSkin`'s aim-tracking rotation still points the mounted sprite at the reticle. `blaster`/`repeater`/`cannon`/`enemygun`/`saber`/`emberblade`/`frostbrand`/`stormglaive`/`carom`/`leech` still share the generic housing (no mechanically distinct silhouette to justify unique art). True texture-atlas packing was deliberately not built — loose per-weapon PNGs match the existing skinRegistry convention, and 9 icon-sized sprites don't justify a hand-rolled packer.
>
> **Update (2026-07-27, later still): critter-core wired into the real game render, closing the gap above.** `client/src/render/critterCoreRig.ts` ports the rig into the client bundle (mirrors `orbCoreRig.ts`'s pattern, its own `CRITTER_CORE_REFERENCE_RADIUS`); `Skin.ts`/`skinRegistry.ts` were generalized to carry a per-rig reference radius instead of one hardcoded orb-core constant, and `RigSkin` gained `setTint()` — a Pixi multiply-tint over every bone sprite, the actual mechanism for "one neutral-grey critter body, re-tinted per elemental variant at runtime" (`13`) rather than one art file per variant. `Actor.ts` passes an enemy's already-resolved blueprint tint straight through. Enemies kept their old Graphics gun-barrel/blade weapon indicator at the time (critter-core has no socket bones to mount a weapon sprite on) — **superseded 2026-08-21**: a socket bone was measured and rejected, and enemies now mount the real sprite on a second, socket-less mount path. See the 2026-08-21 update at the end of this section. `enemy_critter.png` turned out to have the same opaque-magenta-background/no-alpha-channel bug as orb-core's original art (real-art-production work, not a code gap) — critters render at the correct size and tint, just with a visible matte patch until that's regenerated with transparency.

> **Update (2026-08-17): the assembled character was wrong on screen for three weeks — a
> two-line placement bug in the runtime, not an art problem.** User report: "角色的形象实际
> 看起来和最初的设计不符" (the character doesn't look like the original design), pointing at a
> plain white ball with a gun stuck to the top of its head, with no eye, no crystal belly and
> none of `13`'s two orbiting weapon modules on tethers. Every piece of art was correct and
> loaded; `RigSkin.update()` placed it wrong in two compounding ways. **(1) Sprites were drawn
> at each bone's PIVOT instead of its TIP.** Every rig here hangs its body off a pivot at the
> actor's feet via one upward body bone whose `len` IS the hover height (`shell` 46, critter
> `body` 40, boss `core` 60) and whose `bodyR` body circle sits at the tip — which is also
> where the editor's own skeleton view draws it. Drawing at the pivot put the shell a full
> body-length below its own children, so `eye`/`belly`/`socket_l`/`socket_r` (all parented to
> `shell`, all measured from its tip) landed on ONE point above the shell's head: four sprites
> plus the mounted weapon stacked on each other, the shell's painted eye socket left empty,
> and the two 52-px socket orbits collapsed to zero separation. **(2) Rotation used the bone's
> raw world angle**, so every body bone's rest angle leaked into its art — the body bones point
> up (`rwa -90`), so the hero's crystal spikes pointed left and every critter/boss body was 90°
> off too. Fixed: art centres on `pose.ex/ey` and rotates by `pose.wa - rwa` (the delta from
> rest), so art authored the way it reads on screen stays upright and only animation/aim turns
> it. Two smaller things came out of the same pass: a bone's animated `rotation` was applied
> TWICE (once folded in by `Rig.computeFK`, once again in `update()`), and `Actor`'s own
> `BODY_LIFT_R` lift is now placeholder-only — a rig already carries its hover height in that
> body bone, so lifting again double-counted; the status aura and floating health bar moved
> onto the body's measured centre accordingly. The **energy tether** is now drawn (it never
> was): any bone declaring the `outerW`/`innerW` widths the editor already uses for a tubular
> bone gets a two-pass glowing arc from its pivot to its tip, which covers orb-core's two
> sockets and boss-core's two shard rings without either being special-cased. `tools/animator`
> got the identical placement change (`rendering/Renderer.ts` + a `bones` field on
> `RenderData`) — the editor previewing a different layout than the game ships is exactly how
> this got authored and shipped in the first place. The mounted module was ~2x the concept's
> module-to-core ratio (`art/concept/02_weapon_mount_ranged.png`) and covered the eye — now
> `weaponSkins.ts`'s single `MODULE_SCALE = 0.75` factor (the user's explicit middle between
> matching the concept and keeping every weapon frame's silhouette readable), applied in
> `getWeaponScale` so the per-texture measured sizes stay untouched — and the idle arm carries
> a decorative second module pointing outward along its own tether, so the silhouette finally
> matches the concept's two-armed read.
>
> **The testing law this establishes** (asked for directly: "之前好像也是这么反馈的，结果没修好。
> 你能加上测试保证正确吗" — and fair, because the 2026-08-12 shield-centring pass had this bug's
> own symptom in a comment and read it as the rig's design). A placement/assembly claim is only
> pinned when it is checked against the **real shipped bundle**, as a **relationship** rather
> than a restated coordinate, for **every** rig — `rigComposition.test.ts` (85 cases) loads
> `client/public/skins/*/animation.json` + `frames.json` + each PNG's real IHDR width, resolves
> skin → rig exactly as the game does (`skinRegistry.RIG_DEFS` × the preload pairs parsed from
> `main.ts`, so a new character cannot skip it), runs the real `RigSkin`, and asserts: body on
> its own hover height; every sprite upright at rest; **rendered footprint == 2 × that bone's
> `bodyR`** (every shipped binding satisfies this exactly — treat it as the authoring law when
> re-exporting art, and it's the guard against the ~15.7x scale class of bug); decorative parts
> contained by the body vs orbiting modules clear of it; no two parts co-located; one shared
> orbit radius; a tether per orbiting bone; and all of it re-checked across every shipped clip
> at 12 samples (this FK model doesn't cascade translate to children, so a body-only hover bob
> would tear the character apart). Every check is mutation-verified: reverting tip placement
> fails 22, reverting rest-relative rotation fails 10, reverting `MODULE_SCALE` fails 14 — while
> the pre-existing 1272-test suite passed straight through the original bug. That band also
> immediately caught a **second real bug**: `KIND_DEFAULTS`' `104/1536` scale divisor was stale
> after its art was downsampled to 320px, so the never-invisible fallback silhouette rendered at
> ~0.2x the core (a nub); fixed to `90/320`.

## A bone's `bodyR` is a declared radius, not what the art paints (2026-08-19)

`rigComposition.test.ts`'s **rendered footprint == 2 x bodyR** law above is about the *sprite box*,
and every shipped binding satisfies it exactly. What it deliberately does not say is how much of
that box is opaque — and decoding the shipped PNGs' alpha bounding boxes shows the answer varies a
lot per bundle:

| skin | opaque half-width / `bodyR` |
|------|-----------------------------|
| `char_juggernaut` | 0.87 |
| `char_vanguard` | 0.81 |
| `char_skirmisher` | 0.69 |
| `critter-core` | 0.70 |
| `brute-core` | 1.00 |
| `floater-core` | 1.00 |
| `boss-core` | 0.68 |

So `bodyR` (and the gameplay radius, which equals it for every rig here since every
`referenceRadius` IS the body bone's `bodyR`) can be up to ~45% wider than the creature inside it.
**Anything sized against the character's silhouette has to use the opaque extent instead**, and two
things were silently getting this wrong until it was measured: the sphere shading painted a
hard-edged dark disc onto the background around `critter-core`, and every ground shadow was scaled
to the box rather than to the art (see `design/01`'s "Volume, measured"). Neither is visible in the
source of either file.

The measurement is recorded as `skinRegistry.BODY_FILL`, one entry per preloaded skin, and
`rigComposition.test.ts` **re-decodes the real PNGs on every run** (via the repo's own
`tools/png-pipeline/pngCodec.mjs`) and fails if a recorded number drifts from the pixels —
mutation-verified by falsifying one entry (`critter-core` 0.70 → 1.00) and watching it go red. The
plumbing is pinned separately (`skinRegistry.test.ts`: the three orb-core characters share a Rig but
must NOT share a fill, since their shells paint 0.81, 0.69 and 0.87 of the same declared radius), so
a silent fallback to 1.0 fails too. That is
the same shape of guard as the assembly invariants above, applied to the same class of failure:
**when art changes, every hand-tuned number that was sized against the OLD art is now wrong and
nothing in either file shows it.** Re-cropping or replacing a body texture must move the table.

## Update (2026-08-20): the drops and the gate leave the Graphics slice

The Status block at the top of this doc used to name three things as "never planned as sprite art":
bullets, pickups and the portal. That was written while `RoomBuilder` still drew every wall as a flat
rectangle on the ground layer — once the walls stood up, the floor was a real swatch, the doors were
fixtures and the pillars were sprites, those three were simply the loudest placeholders left in the
frame. Two of the three now ship real art. **Bullets do not, and the reason is worth writing down
rather than re-deciding later: a bullet is drawn at ~5 world px, where a texture buys nothing a
tinted additive dot does not already give, and costs a sampler per projectile in the busiest part of
the frame.**

**Five drop sprites, one per `PickupKind` except `weapon`.** A weapon drop already drew that weapon's
own business-end art, which is the whole point of the universal mount — a generic "loot" icon would
have thrown that away, so `getPickupTexture` has no `pickup_weapon` key at all and `Pickup` never asks
for one. Drops are scaled by their LONG axis to one shared 18 px extent, so each file keeps its own
aspect (the crystal ships 116x192, the bandage 192x100) while a floor of mixed loot still reads as one
size class.

**The portal is a split, not a sprite.** Only the masonry arch is art; the ground bloom, the two
counter-rotating rings, the bright core and the infalling motes stay program-drawn, because they
animate every frame and GPT Image 2 emits one flattened raster. That split is also why the arch is
authored as NEUTRAL stone with COLOURLESS crystal: a single `Sprite.tint` cannot tint the shards
without tinting the masonry, so the checkpoint's green arrives from the code-drawn layers instead.
This is the first asset in the project deliberately authored to be *incomplete* — the file is the half
of the object that never moves.

**Two pipeline facts this batch adds to the loading path described above.**

1. **`environmentSprites.ts` was loading every texture with no mip chain**, including the door pair,
   which has shipped that way since 2026-08-04. A door is a 156 px source drawn at 64 px; a drop is a
   192 px source drawn at 18 px, a 10:1 minification — worse than the 4:1 that made the pillar sprite
   need mipmaps and the same class of defect as the 2026-08-12 rig-art colour noise. Fixed for all of
   them; `autoGenerateMipmaps` has to be passed at LOAD time, since setting it on an
   already-uploaded texture provably does nothing.
2. **The generator now emits `.webp`.** `tools/png-pipeline/pngCodec.mjs` is a PNG codec and cannot
   read it, so decoding to PNG (losslessly, via Pillow) is a new first step before the repo's own
   pipeline can touch a generation at all. Everything after that is unchanged: `lumaCurve.mjs` where a
   file's tonal placement needs a fold, `compress.mjs` to trim and downsample, `alpha-audit.mjs` to
   verify.

Full account, including the three rejected generations and what each one cost, is in
`art/environment/prompts.md`; the render-side geometry is in `design/01`'s "The drops and the gate".

## Open questions

- **Texture format & max page size on the lowest base library** — must be measured on a real device (`04` checklist), not chosen from docs; affects atlas packing.
- **`ImageBitmap` availability in the WeChat loader** — if unreliable, which decode path does `Assets` take, and does it force a specific image format? (`04` flags this as surfacing "once real assets land" — this is that moment.)
- **Bundled vs. fetched art** — fetched art is determinism-safe (presentation only) but complicates release/versioning; where's the line, and does it share `09`'s content-delivery decision?
- ~~**Non-biped rigs.**~~ **(resolved 2026-07-23, `13`):** the humanoid diver is dropped. The hero is a floating **orb-core** and enemies are **single-eyed crystal critters** — all simple non-humanoid shapes. We author **our own small rig defs** (root + a few attachment/socket bones per body archetype), not funny's fixed 11-bone humanoid, and the rewritten editor holds **multiple rig definitions**. This removes the whole "humanoid vs quadruped" tension — nothing is humanoid.
- **Rig granularity** — do all characters share the one orb-core rig (max animation reuse — likely, since they differ only by parts/theme) or do some themed cores get bespoke bone tweaks (silhouette variety)? **Partially answered:** `brute`/`floater` (shipped 2026-07-28, `13`) reuse `critter-core`'s single one-bone rig — new art bundles, not new rig definitions — so reuse has not yet hit a wall through 6 body variants (3 orb-core characters + critter/brute/floater). (`02`)
