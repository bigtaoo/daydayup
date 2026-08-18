# Rendering & depth architecture

Goal: a fixed tilted view (not pure top-down; slightly forward-leaning, like Soul Knight) that produces playable spatial relationships with 2D techniques.

## View

- **Tilted (3/4) view:** walls, pillars, and characters show a small "front face" instead of a pure top face, so height and volume read. This is the basis of the 3D feel.
- The camera has a fixed angle and never rotates; it may pan to follow the player.
- **Room zoom-to-cover** (legibility fix, 2026-08-02; cap raised 1.8→2.5 2026-08-12;
  contain-fit → cover-fit 2026-08-12, same day, follow-up; fit target changed from the
  whole floor to the CURRENT ROOM + cap 2.5→4.5 2026-08-17, see "Framing the current
  room" below): the fitted rect is scaled up so BOTH axes cover the viewport (cover-fit —
  zoom by whichever axis needs MORE zoom, capped at 4.5x so a tiny/degenerate room
  doesn't blow sprites into blocks) — `FxController.updateCamera`
  (`client/src/game/fx/FxController.ts`). Originally contain-fit (zoom by whichever axis
  is TIGHTER), which left a real dark `Backdrop`-filled void on the other axis whenever
  the room's aspect ratio didn't match the viewport's — raising the cap (2026-08-12,
  earlier that day) only shrank that void for a too-small room, it couldn't fix an
  aspect-ratio mismatch. Switched to cover-fit (2026-08-12, user's own pick between that
  and "keep the whole room visible, reposition the void") to close it for good: the
  room can now exceed the viewport on the axis that used to have void, and the camera
  pans/clamps to the player there, same as it already did for a big room/arena. A room
  that already covers the viewport at 1x on both axes is untouched (zoom floors at 1,
  never shrinks). See "Camera cover-fit + weapon-slot HUD chip" in `ROADMAP.md`.
  (`CommandBuilder` used to divide a screen-space mouse aim point by this same zoom
  before converting it to world space — moot since `10` v33 removed manual aim; the
  camera zoom itself is otherwise unaffected.)
- **Framing the current room** (2026-08-17, live report: *"镜头往下一些，尽量视口内只有当前
  房间，或者说给角色最好的展示"*). Two changes to the same function:
  - **The fit target is the player's current ROOM, not the whole floor.** A dungeon floor
    is co-resident — every room stitched into one world by `buildFloorGeometry` — so
    fitting `worldSize` meant fitting a ~2000 px floor into a 1920 px viewport, i.e.
    cover-fit resolved to zoom 1 and the player saw several rooms at once, each small.
    `GameLoop.cameraFrame` now looks the player's cached `roomId` up in
    `dungeonRoomRects`/`arenaRoomRects` and passes that rect as `updateCamera`'s `frame`;
    the whole floor stays the fallback for a mode with no room model. Level 1's rooms are
    ~480 px square, so this lands at ~4x and the room fills the viewport — which is what
    forced the `MAX_ZOOM` raise, since 2.5 bound in literally every room.
  - **The look-at point is biased above the player's feet** (`CAMERA_BODY_BIAS_R`, 8% of
    viewport height). Every entity reports its GROUND position, so a camera centred on it
    put the character's feet at screen centre and its whole body in the upper half, above
    a band of empty floor. Biasing the look-at point up in world space slides the rendered
    world DOWN and centres the character.
  - **Panning still clamps to the WORLD, not to `frame`.** Clamping to the room would hard-
    stop the camera at a doorway and cut off the corridor the player is walking into. The
    cost is that the room only fills the viewport exactly when the player is near its
    centre; standing off-centre shows a strip of the neighbouring room. A true one-room-
    per-screen lock would mean a jump-cut at every door, which is a separate design call.

## Coordinates & height model

Every entity has two Y values:

- **Ground coordinates `gx, gy`** — used for depth sorting, shadows, and collision.
- **Height `z`** — visual lift for flying bullets / elevated cosmetics (render only). Actors stay grounded (`z=0`) — there is no jump, and `z` never gates gameplay (`07`).

Render transform: `screen.x = gx`, `screen.y = gy - z`. A large part of the 3D feel comes from objects being able to leave the ground.

**Bullets are drawn leaving the barrel tip, not the sim's muzzle point** (2026-08-17, live
report: *"子弹要从枪口打出"*). The two are not the same place, and can't be: the engine puts
a bullet `muzzleOffset` along the aim ray **on the ground plane** and then lifts it by
`bulletZ`, while the rig rotates the gun **in screen space** at its socket bone's own
height — so aiming downward slides the sim's spawn point south across the floor while the
drawn barrel swings down the screen, leaving the two on visibly *parallel* lines (~16 world
px apart, and this camera zooms 4x). `RigSkin.muzzleLocal` reports the mounted module's
business end (socket-bone tip + a ray/rect measure of how far the texture reaches from its
anchor in its own baked direction), `Actor.muzzlePos` lifts that into world space, and
`Bullet.setMuzzleOrigin` eases the difference out over the first ~120 ms of flight. Fixed
on the VIEW, not by moving the sim's own muzzle: the sim position stays authoritative for
hit detection, and a longer sim muzzle would let a player standing flush against a wall
spawn shots on its far side. Null for anything with no rig-mounted module — every enemy,
whose placeholder barrel already ends within a pixel of its own sim muzzle.

## Standing walls (2026-08-18)

For most of this project's life the "walls show a small front face" line above was **only
true of pillars**. Every wall was drawn as its own collision footprint, flat, on the
`ground` layer (`RoomBuilder`) — no height, no face, no participation in the Y-sort — so a
room's entire sense of volume rested on the ≤2 round pillars a level-1 room happens to
have, and a character could never be occluded by a wall. Fixed by drawing a wall as an
extruded block on the `entities` layer — `scene/wallRender.ts` owns the drawing,
`scene/wallGeometry.ts` the height rule:

- **Geometry is forced by `screen.y = gy - z`.** The segment's container sits on the wall's
  **south edge**, so `Entity.place` gives it `zIndex = that edge` and it Y-sorts against
  actors as one object standing on that line. The **front face** then occupies local
  `-height .. 0` and the **top cap** the footprint depth above that. Union: the footprint
  plus one wall height of intrusion northward, which is exactly what makes a wall look like
  a wall.
- **Two assets, both already per-biome.** `wallface_<element>.png` is the front elevation
  (`art/biome/prompts.md`); `wall_<element>.png` — the pre-existing top-down swatch — is
  reused as the cap. The face tiles **horizontally only**, at a uniform
  `tileScale = height / texture height`, because its top rows are a lit coping and its
  bottom rows a dark base. A missing swatch falls back to Graphics banding and still stands.
- **Every wall stands, at one of three heights** (`wallGeometry.wallTier`/`wallHeight`). A
  room's boundary (`WALL_H_PERIMETER`, 104) towers over the blocks inside it
  (`WALL_H_INTERIOR`, 70 — deliberately the pillars' height, so everything standing in a
  room agrees on how tall "tall" is), and the room's own **south** boundary drops to a low
  lip (`WALL_H_KERB`, 22) because a full-height wall there would stand between the camera
  and the player it is framing. A kerb is provably safe: a wall is 32 px thick and the
  player cannot overlap it, so their ground point is always at least that far north of the
  south edge. Height *variety* is itself the cue — a room where everything vertical is the
  same size gives the eye no relative measure.
  - **This replaced an orientation rule, and that is the whole point** (superseded
    2026-08-18, same day, after the user reported the walls *still* reading as
    *"一张图贴在地上"*). The first version of this pass only stood up an **east-west run that
    was not its room's south perimeter**, on the grounds that a long north-south run "reads
    as a defect — nearly all you see is its cap band sitting 70 px off its own footprint".
    That exclusion is what kept rooms looking painted on: level 1's shipped content is
    almost entirely disqualified by it (`ember_l1_gallery`'s east and west sides are 1×16
    grid runs; `ember_l1_kiln`'s four interior solids are 2×2 **squares**, so `w <= h` for
    every one of them), and a player could cross a whole room seeing nothing stand up but
    its north edge. The fix was not to hide those walls but to draw the volume properly —
    see the next bullet. Orientation now changes nothing about how tall a wall is.
- **Three surfaces, a faked side, a cast shadow and a dark silhouette** (`wallRender.ts`) —
  four cues whose absence, not the geometry, is what made a standing wall look printed on:
  - **Tonal separation.** The cap keeps ~95% of the swatch's own value; the face drops to
    ~50%; the east side band is 50% black over both. The two swatches do not start from the
    same value (light grey stone vs dark charcoal brick), so a shallow face tint left a deep
    block — level 1's are up to 6 grid cells deep, i.e. ~70% cap by area — reading as a pale
    slab with a thin dark hem.
  - **A faked side.** A block's east/west sides project to exactly **zero** width under
    `screen.y = gy - z` (this projection has no horizontal skew), so the east side is drawn
    as an **inset** dark band — inset, not extruded, so it can never cross into the
    neighbouring segment of the same perimeter run.
  - **A ground shadow.** Each wall sweeps its footprint down-right by
    `height × SHADOW_SLANT_*` and fills the convex hull of the two rects, twice, plus a
    tight contact pass at the footprint itself. One shared `Graphics` on `layers.shadow`
    carries a whole room's set. Walls were the one tall thing in a room *not* using what
    this doc already calls "the cheapest 3D cheat". The alphas are higher than they look
    like they should be because the ember floor is near-black: what a shadow has to modulate
    on that biome is the floor's lava cracks, the only bright thing on the ground.
  - **A dark silhouette.** The outline was `palette.wallEdge` — a light salmon/steel,
    authored as the highlight edge of a wall lying **flat**, where a light rim is right. On a
    standing block, magnified by the room camera, it read as a bright wireframe box drawn
    over the art, and in the first live render it was the loudest thing in the frame.
    design/13 asks for a flat-cel silhouette, and a silhouette is dark.
- **The camera frame grew with it.** `GameLoop.cameraFrame` returns the room rect extended
  `MAX_WALL_HEIGHT` px upward (bottom edge unchanged), or the north wall's face would sit
  off the top of the viewport — the one thing this whole pass exists to show. It has to track
  the **maximum** tier, since the perimeter is both the tallest and the thing bordering that
  rect.
- **Optional per-stone relief.** Each block also carries a `NormalLitFilter` tuned for stone
  (`WALL_LIT_*`: a much gentler gradient gain than an actor's, since tiled masonry is nothing
  but luminance edges, and an ambient above `1 − key` so the cap genuinely brightens instead
  of the whole wall going darker than the floor it stands on). One render-target pass per
  segment, ~10-25 per room — `RoomBuilder`'s `LIT_WALLS` is the single switch that turns the
  whole thing off for a low-end target (design/04's WeChat build).
- **Pillars follow the same language** (`wallRender.buildPillarBody`). They were flat fills
  from `palette.pillar`/`palette.pillarTop`, which are **pre-art fallback hues** — the ember
  palette mixes the element's warm hue into a slate base and lands on a pale mauve, nothing
  like the charcoal-navy stone every shipped swatch actually is. Once the walls read as
  stone, four pale-mauve cylinders were the worst thing left in the frame. Texturing them
  from the wall swatches was tried and was worse (a ~35 px cap ellipse windows one arbitrary
  dark patch of a 256 px swatch — no legible pattern, and with the brick elevation on the
  shaft the whole thing read as an open-topped well). What works is hand-toned charcoal-navy
  stone with the shaft shaded across its curve in **colour-interpolated** bands (stacked
  translucent bands step in opacity, not in tone, and showed hard vertical seams at 4×), plus
  the same base crease and the same dark silhouette. The biome palette is back to being only
  what it was meant to be: the no-art-loaded fallback.
- **The floor grid stepped back.** A full-strength 64 px lattice across the whole floor is
  the loudest "this is a top-down blueprint" cue available, and it fought every depth cue
  above; it is still drawn (distance judging) but at `GRID_ALPHA`.

## Grounding the character (2026-08-18)

Same pass, same report (*"希望能再强化一下立体效果"*): the character had just gained a 360°
facing continuum, but nothing said it was a **volume standing in a space**.

- **Actors hover, and the shadow knows.** The rigs' `idle` clips already bobbed the art
  (orb-core's bones translate -6 authoring px), but a clip only knows about bones, so the
  shadow stayed exactly as wide and as dark as when the body was on the floor — which reads
  as a sprite sliding up and down a flat backdrop, not as a body leaving the ground.
  `Entity.visualZ` lifts the whole entity instead (render-only; `zIndex` still comes from the
  ground coordinate, so lifting can never reorder anything). `Actor`'s `HOVER` table gives
  the hero and the floating enemy forms a small constant lift plus a slow swing and leaves
  design/13's ground critters alone; phase is spread across actors so a room of floaters
  doesn't pulse in lockstep. The clip and the hover stack deliberately — one animates the
  body's parts, the other the body's height.
- **Shadows displace with height.** `shadow.x/y += lift × SHADOW_SLANT_*` — a body at head
  height does not cast straight down. This is the half of the cue a clip could never produce,
  and it is shared by actors, bullets, pillars (which need it supplied by hand: a pillar is
  drawn upward from a grounded origin, so its `z` is 0) and walls.
- **Shadows are a penumbra, not a disc.** Nine faint nested ellipses stepping from 1.45× to
  0.4× the body radius, all at the same low alpha, so total darkness ramps smoothly to a
  definite contact core. Four rings at graduated alphas — the first attempt — showed four
  visible concentric edges at 7× and read as a targeting reticle.
- **Everything round shares one 0.62 foreshortening.** The ground shadow, the status auras
  and `EnergyShieldFilter`'s rim glow. The shield ring in particular was a perfect
  screen-space circle (a raw UV distance), which is the loudest "this is a decal pasted on"
  cue a round overlay can give in a tilted view.
- **The body is shaded as a sphere** (`render/rigShading.ts`). A fixed specular highlight
  toward the key light and a curved terminator falling away from it — drawn, not authored,
  because they must stay pinned to the light's **screen-space** direction while the body they
  sit on mirrors and the eye beside them travels. Eye moving while the highlight does not is
  precisely what reads as a sphere turning under a fixed light. Every mark is an ellipse or
  arc strictly inside the body radius, so no mask is needed and nothing can spill past the
  silhouette (a mask per actor would be 30 stencil passes in a busy room). `RigSkin`
  counter-flips it against `view.scale.x` so the light never mirrors with the body. The
  alphas are roughly double what they were first set to: design/13's shells are near-white
  flat-cel art, and a fifth-opacity black arc over white is nothing.
- **A far-side module is smaller and darker, not just behind.** The per-weapon z-order flip
  (shipped earlier the same day) reads on its own as "it changed layer"; adding a depth scale
  and a depth tint turns it into an orbit around a sphere.


Wall height is `WALL_HEIGHT` (70 px), deliberately the same constant the pillars use, so
everything standing in a room agrees on how tall "tall" is.

## Depth sorting (Y-sort)

- The entity layer sets `sortableChildren = true`; each frame we set `entity.zIndex = entity.gy`.
- Lower on screen (larger gy) draws later → occludes objects above it. A character walking behind a pillar is hidden; in front, it hides the pillar.

## Shadows

- A soft shadow is drawn from the **ground coordinates** (`shadow.gy = gy`), so it stays on the floor no matter how high the body is.
- It shrinks, fades, **and slides away from the fixed upper-left key light** as the lift grows → reinforces the sense of height. This is the cheapest "3D cheat". `Entity.SHADOW_SLANT_X/Y` are the one place the slant is defined; actors, bullets, pillars and walls all use them, so nothing in a room disagrees about where the light is.
- Static tall objects (pillars) are drawn *upward* from a grounded origin rather than lifted by the transform, so their `z` is 0 and the displacement has to be supplied by hand (`Entity.shadowOffsetX/Y`).
- See "Grounding the character" above for the shape of the shadow itself (nested ellipses, not one disc) and for the 0.62 foreshortening every round thing in this view shares.

## Layers (bottom to top)

| Layer | Contents | Sorting |
|-------|----------|---------|
| ground | floor, ground decals | fixed |
| shadow | all cast shadows | fixed (below entities) |
| entities | characters / enemies / pillars / bullets | **Y-sort (zIndex = gy)** |
| fx | muzzle flashes, explosions, deflect flashes, per-element bullet trails (additive blend) | overlay |
| ui | HP, weapon, crosshair | topmost |

> The lighting layer (lightmap) is later inserted between entities and fx, composited with multiply blend. See the roadmap.

## Per-weapon local z-order

A weapon is attached to one of the character's orbiting weapon sockets (`02`/`13`) and rendered separately, and must switch front/back by facing:

- Facing up (dy < 0): weapon renders **behind** the body.
- Facing down / sideways: weapon renders **in front**.
- The actor container itself has `sortableChildren = true`, with body.zIndex = 0.

Otherwise you get the "gun floating on the chest while facing away" artifact.

> **Implemented 2026-08-18** — this rule was written here when the doc was, but the rig
> renderer never honoured it: `RigSkin.mountModule` pinned the module to `socket zOrder + 1`
> (always in front), and set it once at sprite-creation time rather than per frame, so even
> a correct initial value would not have survived the player turning around. Now recomputed
> every frame from `showBack`: `MODULE_Z_BEHIND` (-2, below every bone binding **and** below
> the tether's own -1) when facing away, `socket zOrder + 1` otherwise.

## Limits of fake 3D (honest note)

2D sorting is per-object, not per-pixel. The following cases break and must be avoided or accepted as approximations:

- One large sprite partially in front of and partially behind a tall object (crossing a thick pillar) → judged wholly front or back, artifact at the seam. Mitigation: split tall objects into segments, tune anchors carefully.
- Complex multi-layer occlusion → sorting rules must be refined.
- Continuous slopes / height transitions → approximation only.

For this game's scale (rooms, pillars, crates, enemies) these are largely avoidable. If true continuous 3D occlusion is needed → fall back to a Three.js orthographic camera (see the re-evaluation trigger in 00, Decision 1).

## Ambient animation rates (idle loops have a Nyquist floor)

Every idle loop in this layer is a sine driven by an accumulated `frameDt` clock in
**milliseconds** — `t += frameDt`, then `sin(t * k)`. The rate constant `k` is therefore in
**rad/ms**, and the frequency it produces is `k * 1000 / 2π` Hz. Getting this wrong by a
decimal place does not look like "a bit fast": once the per-frame phase step `k * 16.7`
approaches π, the loop crosses the display's Nyquist limit and **aliases**, so what renders
is a beat frequency between the animation and the refresh rate — jitter whose apparent speed
changes with the player's monitor, not the motion that was authored.

Keep every ambient loop in the band the scene already uses. Current inhabitants:

| Loop | Rate (rad/ms) | Frequency | Phase per 60fps frame |
|---|---|---|---|
| `Portal` alpha pulse | 0.003 | 0.48 Hz | 0.05 rad |
| `Pickup` hover + glow breathe | `2π/2000` | 0.50 Hz | 0.052 rad |
| `Actor` status aura | 0.008 | 1.27 Hz | 0.13 rad |
| *(Nyquist limit at 60fps)* | 0.188 | 30 Hz | π |

`Pickup`'s hover shipped at `0.12` (19.1 Hz, 2.0 rad/frame) and reached a player as "the
items on the ground flicker far too fast" — it had never been a bob at all. Two rules came
out of it:

- **Prefer a period constant to a rate constant.** `BOB_PERIOD_MS = 2000` with the rate
  derived from it states the intent in a unit a human can sanity-check; a bare `0.12` does
  not, which is how it survived review.
- **Give co-located instances different start phases.** Every pickup started at phase 0 and
  advanced identically, so a whole floor of loot rose and fell in unison and read as one
  synchronised flash rather than many objects. `Pickup` now offsets its start phase by the
  golden angle times its engine entity id — deterministic (no `Math.random`, per `06`), so
  two clients still draw the same drop identically.

Note that a bob is visible on more surfaces than the sprite: `z` also drives the shadow's
scale/alpha (see Shadows above), so a strobing height strobes the shadow too. `zIndex` is
the exception and must stay on **ground y** — routing it through screen y would make a
hovering object flicker in and out of the Y-sort against everything near it.

## Text measurement (Pixi's measure canvas is NOT its paint canvas)

Every piece of UI text in this project is a Pixi `Text` on a `fontFamily: 'monospace'`
style. Two independent canvases are involved in drawing one, and **they can resolve the
same font string to different fonts**:

- **Measuring** — `CanvasTextMetrics._canvas` prefers `new OffscreenCanvas(0, 0)` whenever
  the host has one, falling back to `DOMAdapter.get().createCanvas()` only if it doesn't.
- **Painting** — `CanvasTextGenerator` goes through `CanvasPool`, which always uses
  `DOMAdapter.get().createCanvas()` (a real `document.createElement('canvas')` in a browser).

Chrome does not resolve the CSS generic families (`monospace`, `sans-serif`, `serif`, …)
identically in those two contexts — an `OffscreenCanvas` has no document/CSS context to
read the user's configured fixed-width font from, so it falls back to a different family.
Measured on Windows Chrome 2026-08-15 with `bold 15px monospace`:

| string | DOM canvas (painted) | OffscreenCanvas (measured) |
| --- | --- | --- |
| `AAAAA` (Latin) | 41.2px | 45px |
| `ААААА` (Cyrillic) | 41.2px | 85px |

Both canvases are internally consistent (each *paints* what it *measures*, confirmed by
scanning `getImageData` alpha for the first and last non-empty column) — the defect is
purely that Pixi mixes the two. The visible result is a `Text` whose `width` is up to ~2x
its painted width: `anchor.set(0.5)` then centres the oversized measurement and the glyphs
land far left of where they belong. That is what produced the reported "Russian settings
labels sit outside their buttons" bug (`17-i18n.md`), and it silently affects anything else
sized or wrapped from Pixi's metrics.

**Fix:** `render/textMetrics.ts`'s `pinTextMeasurementToPaintCanvas()` overwrites the
statics Pixi memoises its measurement canvas into (`CanvasTextMetrics.__canvas` /
`__context`) with a `DOMAdapter`-created canvas, using Pixi's own `willReadFrequently`
context setting, and clears any font metrics already cached from the offscreen one. Going
through `DOMAdapter` rather than `document` directly is what keeps it correct on WeChat,
where the adapter is weapp-adapter's. Both entries (`main.ts`, `main.wechat.ts`) call it
before anything else, because the canvas is memoised on first use.

`ui/textWidth.ts`'s `estimateMonoWidth` is unaffected and still the right tool for *sizing*
a backing box (it needs no canvas at all, so it works under vitest); this is only about the
measurement Pixi does internally when it lays out and centres the glyphs themselves.

Covered by `render/textMetrics.test.ts`. Node has neither canvas kind, so the test fakes
both — with the real advances from the table above, so an unpinned Pixi picks the
"offscreen" fake exactly as it does in a browser and "pinned vs. not" is a real difference
rather than two names for the same stub. A side effect worth knowing: with a context pinned
this way, `Text.width` becomes computable under vitest at all, which is what lets those
tests assert on label-inside-box geometry that otherwise needs a browser.

**General lesson:** when text is *mis-centred* rather than merely mis-sized, and only in
one script, compare Pixi's measurement canvas against its paint canvas before suspecting
the app's own layout maths.

## Fidelity roadmap (by priority)

1. **[verified in demo]** Tilted view + Y-sort + height/shadow + additive-blend FX.
2. **[shipped 2026-08-03]** Dynamic lighting: a per-pixel fake normal derived at shader time from a sprite's own rendered luminance/alpha (a Sobel-style gradient over 4 neighbour-texel taps, the same trick milestone 5's `OutlineFilter` already uses for alpha-edge detection — no normal-map texture asset exists or is needed), shaded against a fixed key light (reusing `RoomBuilder.ts`'s "lit from upper-left" pillar-shading direction) plus a small dynamic point-light registry (`game/fx/lighting.ts`'s `LightRegistry` — the local player's own glow + transient muzzle-flash/impact bursts). This is a scoped equivalent of "normal maps + point lights + lightmap (multiply composite)," not that literal architecture: no `RenderTexture`/deferred-lighting layer exists anywhere in this codebase, and building one would be disproportionate to a fixed-camera 2D sim — a fifth custom `Filter` (`NormalLitFilter`, `game/fx/filters.ts`) does the job instead, following the same template as the four milestone-5 shaders below. Unblocked once ROADMAP 5.3 settled that GPT-Image-2-generated art counts as final production art (no more "normal-map authoring needs real art first" gate) — see ROADMAP's 2026-08-03 updates on both items for the full account.
3. **[shipped 2026-07-26]** Post-processing: bloom-lite (`BlurFilter` on the additive `fx` layer — a cheap approximation, not real multi-pass bloom), custom `VignetteFilter`/`ChromaticAberrationFilter` (`game/fx/filters.ts`, hand-written GLSL, no third-party filter package), hit-stop (brief sim-tick freeze, offline-only) + screen-shake (decaying trauma, `game/Game.ts`).
4. **[shipped 2026-07-26]** Particle system: `game/fx/Particles.ts` — muzzle flames + shell casings (on `bullet_fired`), explosion debris (on enemy `death`), ambient drifting dust. Graphics-only (no textures), same events-queue-driven render-only discipline as the rest of this doc.
5. **[shipped 2026-08-03] Custom shaders — all four items done:** dissolve on death,
   outline, energy shield, heat-haze distortion. All four are hand-written-GLSL custom
   Pixi `Filter`s in `game/fx/filters.ts`, applied to `Skin.view` only (not the whole
   actor container — weapon/aura/hp-bar/local-ring are separate children), composited
   together via `Actor.applySkinFilters()` when more than one is live at once (order:
   heat-haze warp, then shield glow, then outline highlight, then dissolve last). Shipped
   against today's placeholder art with no issues — the "read best against a real sprite
   silhouette, so this likely wants to follow milestone 2" sequencing preference recorded
   here earlier turned out not to matter in practice. Milestone 2 (lighting) has since
   shipped too (2026-08-03, see above) — the "genuinely blocked on real art" note that used
   to live here no longer applies, now that this project's GPT-Image-2 art counts as final.
   - **`EnergyShieldFilter`** — a shimmering rim-glow using the same UV-distance-from-
     centre technique as `VignetteFilter` (not true alpha-edge detection, so it needs no
     extra per-skin wiring against either the Graphics placeholder body or a real `.tao`
     rig). `Actor.setShield` drives `intensity` off the actor's live two-pool shield ratio
     (design/02/05/07) — full glow at a full shield, fading as it drains, gone once it
     hits 0 (the `shield_break` event's own flash, `EventReactor`, already covers that
     instant). Its UV-distance-from-0.5 assumption DOES need the render area itself to be
     centred and symmetric, though — Pixi's auto-computed filter bounds for `skin.view`
     are not (the placeholder's facing-direction wedge / a real rig's aim-mounted weapon
     sprite both extend outward on one side only), which read as a lopsided glow until
     fixed (2026-08-12): `Actor`'s constructor now pins an explicit, fixed `filterArea`
     on `skin.view`. X stays pinned to the actor's local origin (that asymmetry is
     genuinely facing-dependent). Y is a follow-up fix the same day: a real rig's
     decorative bones hang off the body bone's TIP, not its centre (`orbCoreRig.ts`), so
     the assembled silhouette is consistently top-heavy relative to local `(0,0)` in a
     way that does NOT depend on facing — pinning Y to a flat 0 (the first pass) still
     left the glow hugging the ground with the top of the sprite poking out above it.
     Fixed by measuring `skin.view.getLocalBounds()` once at a neutral rest pose and
     centring Y on that instead — ROADMAP's 2026-08-12 "Shield-centering follow-up" entry
     has the full account, including why the first fix's own test never caught this (it
     only ever exercised the Graphics placeholder, not a real loaded rig). A symmetric
     `filterArea` is necessary but was NOT sufficient — see the `vTextureCoord` gotcha
     below, which is what finally closed this bug out on 2026-08-15.
   - **`OutlineFilter`** — a REAL alpha-edge-detected silhouette outline (samples the
     actual rendered alpha at 4 neighbour texels via Pixi's auto-bound `uInputSize` filter
     uniform), unlike the shield's approximation — needed because an outline must hug
     whatever shape is actually drawn. `Actor.hitFlash()` fires it as a brief "you were
     just hit" flash, wired from `EventReactor`'s `hit` case via a new `Scene.actorAt(id)`
     lookup (added to `EventReactorHost` as a duck-typed `{ hitFlash(): void }`, so
     `EventReactor` still never imports scene/ types) — independent of the existing
     position-anchored `fx.flash()` burst, which reads as "impact happened here" rather
     than "this actor took it".
   - **`DissolveFilter`** — procedural cell noise (a GLSL hash of the UV, no noise
     texture — same "no textures" discipline as `Particles.ts`) burns away in patches as
     death progresses, ember-coloured edge trailing the boundary. Needed a real render-
     side architecture change, not just a new filter: `Scene.reconcile` used to destroy a
     dead entity's view the SAME tick it dropped out of the engine's `alive` list (the
     `seen`-diff cleanup loop). Now, when the vanished view is an `Actor` (not a bullet/
     pickup — those still destroy immediately), `Scene` calls `Actor.startDissolve()`
     (hides weapon/aura/hp-bar/local-ring, leaving only the dissolving body) and keeps it
     in a separate `dying: Actor[]` list, stepped every `Scene.interpolate()` call until
     `Actor.isDissolved` reports the ~700ms animation done, then destroys it for real.
   - **`HeatHazeFilter`** — a cheap sine-based UV wobble (no noise texture, no real
     refraction pass — same "own the code, own the cost" simplification as the vignette).
     Driven by `Actor.setStatus`'s existing `burnTicks > 0` condition (the same signal
     that already drives the burn ring in `AURAS`) — a burning actor's silhouette itself
     shimmers, on top of the ring.
   - **Gotcha hit while building `OutlineFilter`:** redeclaring Pixi's auto-bound
     `uInputSize` filter uniform in a fragment shader without an explicit `highp`
     qualifier fails to link on GL ("Precisions of uniform 'uInputSize' differ between
     VERTEX and FRAGMENT shaders") — the default vertex shader (`defaultFilterVert`)
     implicitly gets `highp` (GLSL ES vertex-stage default for `float`), while a fragment
     shader has no default and Pixi's own precision header pins it to `mediump`. Any
     future filter that reads `uInputSize` (or another Pixi-auto-bound uniform) in its
     fragment stage needs `uniform highp vec4 uInputSize;`, not a bare `uniform vec4`.
   - **`vTextureCoord` is NOT 0..1 — the `FRAME_UV` gotcha (root-caused 2026-08-15, the
     real end of the "lopsided shield ring" saga).** Pixi's default filter vertex shader
     emits `vTextureCoord = aPosition * (uOutputFrame.zw * uInputSize.zw)`, so it spans
     `0 .. (filtered region / allocated texture)`. Those two differ almost always: filter
     inputs come from `TexturePool.getOptimalTexture`, which rounds each dimension up to
     the next power of two, so a 130px-wide region is handed a 256px-wide texture and
     `vTextureCoord.x` never exceeds 0.508. Any shader that treats `0.5` as "the middle"
     is therefore centred on the POOL TEXTURE, not on the sprite — and since a region's
     pixel size is `filterArea × camera zoom × renderer resolution`, crossing a pow2
     boundary flips the effect from correctly centred to entirely off-region with no code
     change. That is what produced the long-reported partial/crescent shield ring, and
     what made it look like "integer camera zoom is fine, 1.5/1.32 is broken" — which got
     misdiagnosed (commit `d5c06db`, since reverted) as Pixi corrupting filters under a
     non-integer ancestor scale, and "fixed" by baking `layers.entities` to a 1:1
     `RenderTexture` every frame. That workaround left the ring still off-centre and cost
     real resolution: the bake texture defaulted to `resolution: 1` with no antialias
     while the renderer runs at `min(devicePixelRatio, 2)`, so every actor/bullet/pillar
     was sampled at roughly `1/(2 × zoom)` of the rest of the frame, and additive children
     (status auras, bullets) lost their blend against the ground. Real fix: the shared
     `FRAME_UV` GLSL prelude in `fx/filters.ts` — `frameUv()` remaps `vTextureCoord` to a
     true 0..1 across the region, `frameOffset()` converts a region-space displacement
     back to texcoord space, `clampToFrame()` keeps displaced samples off the pooled
     texture's stale neighbouring pixels. Used by the shield (ring centre), vignette and
     chromatic aberration (screen centre), dissolve (cell grid), and heat haze (wobble
     frequency + amplitude). `OutlineFilter`/`NormalLitFilter` deliberately do NOT use it:
     they only ever step by one texel, and `uInputSize.zw` is already exactly that.
     `EnergyShieldFilter` additionally sets `clipToViewport: false`, because Pixi otherwise
     intersects the region with the viewport (`FilterSystem._calculateFilterBounds`) and
     would re-introduce a lopsided ring for any shielded actor standing at a screen edge;
     that is safe only because `filterArea` already bounds it to a small fixed square, and
     is deliberately NOT done for the two screen-wide post-fx, which need the clip to size
     themselves to the viewport. General lesson: when a filter's symptom flips on and off
     with the camera zoom, suspect the pow2 filter-texture pool before suspecting Pixi.
