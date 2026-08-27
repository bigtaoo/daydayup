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
    `GameLoop.cameraFrame` now looks the player's cached `roomId` up in whichever of
    `dungeonRoomRects`/`arenaRoomRects` the run is using (`engine/state/roomModel.ts`, the one
    selector the camera, the floor and `EnvironmentSystem` share) and passes that rect as
    `updateCamera`'s `frame`;
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
  room agrees on how tall "tall" is), and a wall with a room's **floor immediately north of
  it** drops to a low lip (`WALL_H_KERB`, 22) because a full-height wall there would stand
  between the camera and the player it is framing. A kerb is provably safe: a wall is 32 px
  thick and the player cannot overlap it, so their ground point is always at least that far
  north of the south edge. Height *variety* is itself the cue — a room where everything
  vertical is the same size gives the eye no relative measure.
  - **The kerb rule is about where a wall STANDS, not about whose wall it is** (generalized
    2026-08-20). It used to read "the room's own **south** boundary", resolved against the one
    room the wall's centre falls in — and where two rooms stack vertically the boundary between
    them is *two* walls, one grid row apart, authored by two different rooms. The upper room's
    own south wall kerbed correctly; the lower room's north wall answered "I am my room's north
    edge" and stood at 104 px, one row south of the exact floor the kerb exists to keep clear.
    A block's art rises from its own north edge, so it reached a measured **72 px into the room
    above** — 22 runs of it, on all five shipped floors, and the single biggest source of "the
    player is invisible" in the level (see "The occlusion x-ray" below, which is what measured
    it). `wallTier` now asks *"does any room's floor lie immediately north of me"*, which is one
    predicate covering both halves of a shared boundary and strictly generalizes the old test.
    Nothing has to be split apart afterwards: every room authors its own four perimeter walls,
    so a boundary arrives as two rects that are tiered independently, and `RoomBuilder` tiers
    **before** it merges — a collinear north boundary shared by two side-by-side rooms, only one
    of which has a room above it, therefore keeps its tall half (floor 2's `r5_bastion` beside
    `r4_furnace`; under the old rule those were one 32-cell perimeter run). Across level 1,
    19 runs moved from perimeter to kerb: 105 → 86 perimeter, 37 → 53 kerb.
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
  - **Tonal separation** — *retuned 2026-08-19 against a measured frame; see "Volume, measured"
    below for the numbers that replaced these.* The first version kept the cap at ~95% of the
    swatch's own value, dropped the face to ~50%, and put 50% black over both for the east
    band, on the belief that the two swatches start from very different values (light grey
    stone vs dark charcoal brick). Measured, they start from almost the same value (~46), and
    separating the pair around that midpoint left BOTH of them darker than the floor.
  - **A faked side.** A block's east/west sides project to exactly **zero** width under
    `screen.y = gy - z` (this projection has no horizontal skew), so the east side is drawn
    as an **inset** dark band — inset, not extruded, so it can never cross into the
    neighbouring segment of the same perimeter run.
  - **A ground shadow.** Each wall sweeps its footprint down-right by
    `height × SHADOW_SLANT_*` and fills the convex hull of the two rects — four graduated
    passes since 2026-08-19, two before that, because two alphas over hard-edged quads let you
    see both quads. One shared `Graphics` on `layers.shadow` carries a whole room's set. Walls
    were the one tall thing in a room *not* using what this doc already calls "the cheapest 3D
    cheat". The alphas are higher than they look like they should be because the ember floor is
    near-black: what a shadow has to modulate on that biome is the floor's lava cracks, the only
    bright thing on the ground. The original also filled a **contact pass at the footprint
    itself**, which could never be seen — a block's art covers its whole footprint and then
    intrudes a wall height north of it, so every pixel of that fill was behind the block casting
    it. Replaced 2026-08-19 by an ambient-occlusion band hugging the footprint from the
    **outside**, which is both visible and where the crease physically belongs.
  - **A dark silhouette.** The outline was `palette.wallEdge` — a light salmon/steel,
    authored as the highlight edge of a wall lying **flat**, where a light rim is right. On a
    standing block, magnified by the room camera, it read as a bright wireframe box drawn
    over the art, and in the first live render it was the loudest thing in the frame.
    design/13 asks for a flat-cel silhouette, and a silhouette is dark.
- **The camera frame grew with it, and its CLAMP had to open too.** `GameLoop.cameraFrame`
  returns the room rect extended `MAX_WALL_HEIGHT` px upward (bottom edge unchanged), or the
  north wall's face would sit off the top of the viewport — the one thing this whole pass exists
  to show. It has to track the **maximum** tier, since the perimeter is both the tallest and the
  thing bordering that rect. That extension was **silently cancelled until 2026-08-19**:
  `updateCamera`'s vertical pan clamped to `[vh − effH, 0]`, an upper bound of the world's own
  top edge, while a wall on the floor's northern boundary draws its cap and the top of its face
  at *negative* world y. Confirmed live — `layers.world.y === 0`, the room's north wall showing
  face only, no cap, top of the face cut. The bound is now `overscanTop = max(0, −frame.y) × zoom`,
  i.e. the frame is the authority on how much above the world it asked to see, and a frame that
  asks for none (an interior room, or no frame at all) still gets exactly zero.
- **Per-stone relief was tried, measured out, and removed** (`LIT_WALLS`, false since 2026-08-19,
  **deleted 2026-08-20**). Each block used to carry a `NormalLitFilter` tuned for stone
  (`WALL_LIT_*`: a much gentler gradient gain than an actor's, since tiled masonry is nothing but
  luminance edges, and an ambient above `1 − key` so the cap brightens instead of the whole wall
  going darker than its own floor) at one render-target pass per segment, 10-32 per room. An A/B
  of the live frame with every wall filter stripped differs by a **mean of 0.48 out of 765
  (0.06%)**, a maximum of 5%, and only 0.05% of pixels move more than 5/255 — the tuning that made
  it safe is also what left it with no visible amplitude. Originally left switched off rather than
  deleted "so the experiment is repeatable," which in practice meant a permanently-false switch,
  an un-scheduled re-tune, and the single most expensive pass in wall rendering surviving in the
  codebase for no visible benefit; removed outright once nobody had a re-tune actually queued up.
  Only the wall-specific look and its `RoomBuilder` call site went at the time; the actor-facing
  look survived until 2026-08-24, when lighting became one screen-space pass over the whole scene
  layer (`SceneLightFilter`) and the per-actor filter went with it. Walls are inside that pass now,
  but it is normalized so a FLAT texel comes out at exactly its painted colour — measured on the
  shipped art, the median wall pixel moves by 0.1/255 — so this paragraph's finding still holds:
  the relief the walls read with is `wallTone.ts`'s, not a shader's.
- **Pillars follow the same language** (`pillarRender.buildPillarBody`, split out of
  `wallRender.ts` 2026-08-19). They were flat fills
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
  what it was meant to be: the no-art-loaded fallback. **Superseded 2026-08-20** — this body is
  now the FALLBACK for a missing texture, not what ships; see "A pillar is a sprite now" below.
  Its account of why sampling the WALL swatches failed still holds, and is exactly why the art
  that replaced it had to be authored at pillar scale.
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
- **Shadows are a penumbra, not a disc.** Twelve faint nested ellipses stepping from 1.15× to
  0.3× the body radius, so total darkness ramps smoothly to a definite contact core. Four rings at
  graduated alphas — the first attempt — showed four visible concentric edges at 7× and read as a
  targeting reticle. *Retuned 2026-08-19: it was nine rings from 1.45× at ONE flat alpha, which
  makes the outermost ring itself a visible hard rim — most of what made an enemy's shadow read as
  a black plate it was sitting in. The alpha now ramps (squared) across the rings, so the edge is
  nearly transparent while the core still composites to ~0.45. The other half of that fix was its
  SIZE — see "Volume, measured".*
- **Everything round that lies ON THE GROUND PLANE shares one 0.62 foreshortening**
  (`SHADOW_SQUASH`): the ground shadow and the status auras. Both are flat discs at the
  actor's feet, and the camera tilt compresses a disc — drawing one as a perfect
  screen-space circle is the loudest "this is a decal pasted on" cue a round overlay can
  give in a tilted view.
- **The shield is the deliberate exception, and is a true circle** (2026-08-24, user report
  *"护盾成了一个圆圈"*). It was squashed with the other two for six days on the reasoning that
  "everything round wrapping a body foreshortens the same way"; that is wrong for this one.
  A shield is a SPHERE around the body, not a disc under it, and a sphere's silhouette is a
  circle from every angle. Squashed, it read on screen as a flat hoop threaded through the
  character at gun height — the reported 圆圈 — instead of a bubble enclosing it.
- **2026-08-25: it became a SOLID shell, not a rim band** — superseded 2026-08-26 by the bullet
  below, which found that the "Fresnel limb" this pass shipped is itself a ring by another name.
  Kept because the report it answers is real and the hole it closed has not reopened
  (user report: *"现在的护盾是
  一个圆圈包裹着角色, 我希望的是类似一个透明的蛋壳一样的效果将角色全部包裹, 而不是一个圆环"*).
  Un-squashing it fixed the ellipse but left the other half of "圆圈" standing: the shader drew
  `smoothstep(a, b, dist) * (1.0 - smoothstep(b, c, dist))`, a band with a HOLE in it, so a
  shielded character stood in empty space with a hoop around it. It is now a glass sphere —
  a filled interior plus a Fresnel limb (`1 - nz` off a sphere normal, cubed) and one specular
  glint at ~0.6 of the radius, which is the pair of cues that read as "curved and transparent"
  rather than "decal". Three numbers carry the look, and each is pinned twice — as a source
  contract (`filters.test.ts`, "is a solid shell, not a ring") and as a MEASUREMENT
  (`shieldShellModel.test.ts`, which interprets the shipped GLSL and asserts the profile it
  paints: centre painted, no hole out to the surface, circular at every angle, gone past the
  fade). Text was the wrong evidence for a question about a shape — two shaders can satisfy
  every regex and paint different things — and running it found two real facts the source
  reading had missed: the composite is not quite monotonic (the shimmer bands radially, so a
  ray outward ripples by ~0.03% of peak), and an alpha bound read at `uTime = 0` is a lucky
  sample that a doubled composite knob walks straight through:
  - **No term may rise with `dist`.** That is the whole definition of a ring; every
    `smoothstep` over `dist` in this shader is a negated (falling) one.
  - **The fill is damped by the body's own alpha** (`FILL * (1.0 - 0.55 * color.a)`). Over the
    floor it is the bubble you look through; over the character it is an additive wash on top
    of the art, and undamped it flattened the hero's face — the saturated blue eye came out the
    same pale cyan as the shell around it. Measured live, on screen, at both settings.
  - **The radius grew 1.55 → 1.87 body radii**, because "全部包裹" includes the mounted weapon:
    at the smaller radius the gun barrels stuck out through the shell. It still stops short of
    the feet, where the ground shadow has to stay readable (below). The interior composites at
    ~8% alpha over the floor, so it tints rather than hides it — the failure mode the
    2026-08-19 volume pass fixed by shrinking the old ring.
- **...and since 2026-08-26 it is a shell with THICKNESS, with the character between its two
  halves** (user report: *"没有被蛋壳包裹的感觉 … 边缘的那个圈太过实线了"*). The 2026-08-25 pass
  above had filled the ring's hole and stopped there, and the report that followed named both
  halves of what was still wrong. Neither was a tuning problem:
  - **`pow(1 - nz, 3)` is a ring, whatever the surrounding code calls it.** It equals 1 only AT
    the silhouette, so every version through 2026-08-25 was a flat `FILL` plate with all of its
    energy in a hairline around the edge. Measured on the shipped frame: the profile's maximum sat
    at `b = 1.00` and held above half-peak across **0.10** of the radius. What replaced it is the
    length of the view ray's chord through a shell of real thickness — an outer sphere minus an
    inner one, saturated Beer-Lambert style. That profile peaks at the INNER wall
    (`b = 1 - THICKNESS`, 0.78) and falls away on both sides: measured peak `b = 0.80`, half-peak
    width **0.30**. Same measurement from two independent directions — the GLSL interpreter
    predicts 0.78 / 0.31, and a luma cut read off a real GPU frame says 0.80 / 0.30.
  - **"包裹" is not a shape at all, it is a compositing order.** Every version up to here added
    the whole shell ON TOP of the character, so it read as a decal in front of it however the
    silhouette was tuned — nothing was ever behind. The fix is one multiplication: the back
    hemisphere's contribution is scaled by `(1.0 - color.a)`, so the body occludes it and sits
    between the two halves. This is the single change that produces the enclosure cue; the
    thickness above is what stops the enclosure reading as a hoop.
  - **Refraction, for the price of a UV offset.** The filter already samples the character's own
    texture, so bending the sample point by the sphere normal shows the body THROUGH the glass —
    magnified face-on, smeared toward the limb. Faded with the pool along with everything else
    (found by test, 2026-08-26: left at full strength the character stayed warped while the glow
    drained and then un-warped in a single frame when `ActorFilters` detached the filter, a pop
    landing exactly on the break burst), and bounded to a fraction of a body radius — the
    "grows toward the limb" assertion is a ratio and therefore scale-free, so a displacement ten
    times too strong satisfied it.
  - **A generated membrane, not authored art.** A smooth gradient reads as a filter no matter how
    well shaped; the eye needs a repeating detail element before it accepts a surface. The tile is
    a seamless HEX-CELL field computed at boot (`fx/filters/shieldScales.ts`) — see that
    file's header for why a generator beats an image model here, and `design/04` for the package
    budget it costs nothing against. Sampled twice with different projections, front and back, so
    the two layers do not coincide; the projection is `uv / (nz + k)` rather than true spherical
    coordinates, which foreshortens the pattern toward the limb for one divide instead of four
    transcendentals and a pole singularity.
  - **The membrane ADDS, it does not multiply — and it is drawn on the character's art as well as
    in the light over it** (2026-08-27, report: *"护盾中间的6边形看不清，看起来还是一个圈 … 之前调试
    效果时看起来挺好的，和游戏里实际表现差别有点大"*). Two separate defects, and the pair is the
    general lesson for any per-actor overlay here:
    - The pattern was `density * (1 + k * tile)`, a MULTIPLIER on the shell. The shell's interior
      brightness is deliberately ~0.11 (it composites over `Entity`'s ground shadow and must not
      hide it), so across the whole middle of the disc there was nothing for a multiplier to
      scale: measured on a rendered frame at gameplay zoom, 9 of 255, with the pattern reaching
      ~30 only in a thin annulus at `b ~ 0.8`. A pattern in one ring with nothing inside it is a
      circle. Adding instead decouples the pattern's contrast from the shell's own faintness, and
      the tile's ZERO-MEAN encoding (`paintScaleTile`) makes it free on the brightness budget the
      multiplicative form was protecting — the lines are bright because the cells around them
      gave it up. Verified on the live frame, not argued: mean luma over the shell disc is 83.0
      with the membrane and 83.2 without.
    - Every other term this shader has is additive, and the middle of a shielded actor is not
      empty — it is the hero's near-white silver body, over which the shell's own green and blue
      are already past 255. An additive membrane there is not dim, it is arithmetically ABSENT,
      whatever its gain. **That is the whole of the "looked right in isolation, wrong in the
      game" gap**: the debug view had a dark background where the game has a bright character. So
      the pattern also rides the `veil` MIX toward the shield colour, which has no ceiling; a
      cell border reads as a cyan hex line laid over the character at any base brightness.
  - **Taller than wide, not a true circle** (2026-08-27, report: *"现在的盾是正圆的，改成椭圆或许更
    好，高度上长一点，看起来会更有立体感"*). The 2026-08-24 pass un-squashed this shell to a circle on
    the grounds that *"a sphere reads as a circle from every angle"*. True of a real camera, and
    this renderer is not one: the world grid is drawn UNSQUASHED (`layers.world.scale` is 2.667 in
    both axes) while wall heights are extruded 1:1 upward in px (`wallGeometry.ts`'s `WALL_H_*`
    are "in world px"), which together is the shear `(x, y, z) -> (x, y - z)`. A sphere's
    silhouette under a shear is an ellipse with semi-axes 1 and `sqrt(2)`, so a circle was never
    the projection-consistent shape for "a sphere around the body".
    - Shipped at **1.30**, not the derived 1.414, chosen on rendered frames: past ~1.35 the shell
      reads as a pod the character is suspended in rather than a shell wrapped round it, and the
      hero's drawn silhouette is 74.7 x 32 px — **2.3x wider than tall** — so every unit of extra
      height is empty egg.
    - The stronger reason to go taller at all is this scene's own grammar rather than the shear:
      everything round that lies on the ground is squashed to 0.62 (`Entity.SHADOW_SQUASH` —
      shadows, status auras), which makes a circle the ambiguous middle and a taller-than-wide
      silhouette the only one in the scene that cannot be read as lying flat.
    - **Nothing in the GLSL says "ellipse".** The shader is isotropic in region-normalized `uv`,
      so the shape comes entirely from `Actor` sizing `filterArea` to a rect of aspect
      `SHELL_ASPECT` — every constant the measured suite pins (`SHELL_R`, `THICKNESS`, `CULL`) is
      in that normalized space and unchanged, which is why the ellipse cost one line. The flip
      side is that a square `filterArea` silently reverts the circle with no other symptom, so
      both `Actor.test.ts` and `shieldShellModel.test.ts` pin the composition (mutation-checked:
      a square rect fails 1, `SHELL_ASPECT = 1.0` fails 2).
    - The ONE place the shader must know the aspect is the membrane: a hex cell inherits the
      region's stretch like everything else, and a hexagon stretched 1.3x vertically stops
      reading as one — which would have spent the same day's hexagon fix to buy this one. The
      tile lookup divides it back out; a third test pins that.
    - Cost: the region's aspect change alone would be +30% area, shared by all four per-actor
      filters. The clearance pass below more than pays it back — the region ends up 78.7 x 102.3
      against the original 96 x 96 square, i.e. **13% SMALLER** than before either change.
  - **Sized by a stated CLEARANCE, not by a hand-set region** (2026-08-27, report: *"整体缩小一点，
    类似紧贴着角色，稍微留点缝隙即可。缝隙的大小我感觉和图里枪的直径差不多即可"*). The surface now sits
    `SHELL_CLEARANCE` = 0.53 body radii outside the body's drawn edge, down from 0.87 — a shell of
    1.53 body radii rather than 1.87. `Actor` no longer hand-sets `filterArea` to `radiusPx * 3`;
    it inverts the shader's own geometry to solve for the region that puts the surface there, so
    retuning `SHELL_SURFACE` or `SHELL_ASPECT` keeps the clearance meaning what it says.
    - **0.53 is that gun, measured.** The hero's weapon SPRITE is 24 x 16.35 world px, but the art
      inside it is mostly transparent margin: the opaque box is 15.75 x 8.55, so the visible gun is
      8.55 px thick — against a 16 px body radius, 0.53. Taking the sprite rect would have set the
      clearance at 1.02 body radii and left the shell almost exactly where it already was. This is
      the same class of trap as the `BODY_FILL` mismatch: an art number read off the frame rect
      instead of off the pixels.
    - The clearance is uniform on ONE axis only, and no constant fixes that: the body is round
      (32 x 32 world px) while the shell is a 1.30 ellipse, so 8.5 px at the sides is necessarily
      ~15.8 above and below. It is set on the SIDES — the tight axis, where "稍微留点缝隙" is a
      clearance that must not close up. Trading the two off means lowering `SHELL_ASPECT`.
    - The character's WEAPONS reach outside the shell (~2.5 body radii against a 1.53 surface),
      and did before this too. The claim that the envelope "encloses the WHOLE character, mounted
      weapon included" was in both this doc and two tests and has never been true at any of the
      shell's sizes; enclosing them needs a surface ~3 body radii out, i.e. twice this shell.
    - Two tests were PASSING on a stale literal here — both computed the shell's size as
      `SHELL_R * 6 / sqrt(2)`, the old `radiusPx * 3` region copied in as a `6`, and so reported
      1.87 body radii for a shell that had become 1.53. Both derive the region width now.
    - Anything that resizes the shell has to revisit `MEMBRANE_TILE`: it is in normalized units,
      so the cell COUNT across the shell is fixed and a smaller shell means smaller cells. This
      pass took 20 px cells to 16 and a 4 px border line to 3.3; scaling the tile by the same 0.82
      (0.80 -> 0.66) put both back.
    - Cell SIZE has one honest constraint worth writing down: `uv` goes to zero at the shell's
      pole, so however the tile is projected the middle of the shell gets the fewest cells — and
      the middle is where the character is and where the eye already is. No projection fixes that
      (spherical UVs are linear at the pole too); the only lever is overall density.
  - **The damage state changes the SHAPE.** `design/13`'s dual-channel law, which this filter had
    been violating: as the pool drains, whole scales go out one at a time (the tile's green channel
    is that cell's place in a shuffled extinction order) and the tint shifts from cyan toward a hot
    pale tone. Brightness alone was the entire damage signal before.
  - **The interior still stays under the ground shadow.** `Entity`'s `SHADOW_ALPHA_INNER` is 0.1,
    and a shell interior compositing above about that much stops the actor reading as planted. The
    2026-08-26 rewrite paints the back hemisphere over the floor as well as the front — i.e. more
    light there for the same shape — and holds the same bound anyway, via a contrast curve on the
    chord (`pow(…, 1.6)`, which pulls the interior down harder than the wall) rather than by
    relaxing the bound to fit what the new shader happened to produce.
  - **A hit now dents it.** Until 2026-08-26 the shield had exactly one dynamic — `uIntensity`
    tracking the pool — and did nothing at all when the actor was hit; `ActorFilters.hitFlash`
    drove only the white `OutlineFilter`. The envelope is a damped OSCILLATION (`exp` decay times
    `cos`), so the surface springs back past its rest radius and settles: a fade reads as "the
    glow dimmed", a rebound reads as "something hit it". This is what 20-year-old sprite shields
    did with hand-drawn squash frames, and it is the cheapest item on this list. `EventReactor`'s
    `hit` case already carried the impact position, so the direction cost nothing new to plumb —
    it is handed over as a delta from the target's own centre.
  - **The one lever that pays is the radial cull.** The shell reaches 0.62 of the filtered
    square's half-width, so ~70% of its pixels used to run the whole shader to produce zero. A
    single `if (b > CULL) { … return; }` skips them — CULL is set where the only term still alive
    out there has fallen below one 8-bit step, and `shieldShellModel.test.ts` measures that rather
    than trusting it. Measured on an Intel Arc Pro over a 768 px region: **0.223 ms with the cull,
    0.321 ms without**, against **0.162 ms** for the shader this replaced. So the rewrite is +38%
    for roughly three times the visual information, and without the cull it would have been +100%.
    The membrane's own uniform branch (`uMembrane`, the lever for a cheaper tier) measures as no
    saving at all on desktop — that region is fill-bound and two cached tile fetches are not what
    it spends its time on. It stays because it is correct and free, and because a bandwidth-bound
    mobile GPU is where those fetches would show up; that case is unmeasured (`design/04` item 6)
    and nothing here should be read as a promise about it.
- **...and since 2026-08-26 it has an EXIT** (`EnergyShieldFilter.shatter`, the one item the
  thickness rewrite above left open — and the change that moved this filter out of `skinFx.ts`
  into its own `fx/filters/shieldFx.ts`, since it took that file past the 500-line convention). Until this pass `ActorFilters` dropped the filter from its
  composed list on the frame the pool hit 0: the shell vanished between two frames and
  `EventReactor`'s positional burst had to carry the whole moment. Now a `uShatter` uniform runs
  0 → 1 over `SHATTER_MS` (200 ms) while `ActorFilters` holds the filter ATTACHED — the same
  "keep the view alive past the state change" shape `startDissolve` and `Scene`'s dying-view list
  already use, not a second mechanism.
  - **The surface throws itself open and its wall thins to a rim.** The expansion goes into
    `surface` itself, not into `b` afterwards, which is what keeps the radial cull correct for
    free: `b` is measured in surfaces, so a shell that grew 30% has a cull radius that grew with
    it. Eased OUT — the shell leaps at the break and coasts; the reverse profile reads as a bubble
    inflating. Simultaneously `THICKNESS` is scaled down toward zero, so the bright band migrates
    out to the silhouette and narrows: measured half-peak width 0.265 of the surface radius at
    rest, 0.08 at full shatter. A shell that expanded at constant thickness reads as inflating;
    one whose wall stretches thin reads as a surface being pulled apart.
  - **The whole fade lives in the shader, not in a second clock.** One `energy = uIntensity *
    (1.0 - uShatter)` replaces every use of `uIntensity`, so at `uShatter = 1` the shader hands
    back the source texel unchanged — measured as exact equality, not "small" — and the detach
    that follows is invisible. It also runs the membrane's own extinction (`integrity` is derived
    from `energy`) so whole scales go dark in the tile's shuffled rank order and the tint swings
    hot, i.e. the exit is `design/13`'s dual-channel law played at 5× speed.
  - **`BURST` is bounded by the filter's own area, not by taste.** `Actor` pins that area to 6
    body radii per side, so `dist` beyond `0.5·√2` does not exist along its narrowest axis and a
    shell that grew past it would be cut off FLAT on four sides only. `0.44 · 1.30 · 1.18 = 0.675`
    against a limit of 0.707 — and the suite scans the actual visible edge at every instant rather
    than trusting that arithmetic.
  - **The membrane's scales are thrown outward per cell, off the channel that was already there.**
    The tile's GREEN channel is each cell's place in a shuffled extinction order; the exit reuses
    it as a launch speed, so the scales come apart in pieces instead of sliding off as one sheet.
    Reading a per-cell constant costs a tap of its own (which cell is under this pixel is exactly
    what the tap answers), so the membrane branch goes from two tile fetches to four; at rest the
    offset is exactly zero and the second tap lands on the texel the first already pulled in.
  - **The fragments are `Particles.ts`' job, not the shader's** (`shieldShards`, wired from
    `EventReactor`'s `shield_break` case — whose event position IS the target actor's centre,
    unlike the neighbouring `hit`). The decisive reason is the same fixed `filterArea`: anything
    the shader draws is clipped at ~2.4 body radii, and a shard that flies further would simply
    stop existing. A shader also pays for its fragments at every pixel of the region for the whole
    animation, where 11 shards cost 11 shards — and this file already owns motion, gravity, spin,
    lifetime, alpha decay and the quality budget.
  - **The exit flares to full brightness rather than starting from the pool it died with.** A
    shield that broke from 12% would otherwise play its whole 200 ms at 12% brightness, i.e.
    invisibly. That lifts the refraction for one frame too, which is deliberate: the frame it
    lands on is behind `EventReactor`'s 50 ms hit-stop and a 28 px burst, and a shell bending
    light harder as it lets go is the read we want there.
  - **Perf: the exit is free at rest, and the shipped shader did not get slower.** Measured with
    `EXT_disjoint_timer_query_webgl2` (never `performance.now()`, which reported a 1000×-ALU
    control at 2.35× on this same machine), interleaved A/B/C with that control carried through
    every round — see ROADMAP's "The shell gets an exit" for the table.
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

## Volume, measured (2026-08-19)

The two passes above were built by *looking*. This one was built by **measuring the frame they
produced** — `renderer.extract` on `layers.world` at zoom 1, sampled per wall entity using the
geometry the renderer itself had just used (cap sprite y/height, face sprite y/height) rather than
coordinates guessed from the level data. That is what turned five look notes into numbers, and the
numbers said something none of the look notes had:

| surface                | was | now   |
|------------------------|-----|-------|
| pillar top             | 105 | 92    |
| wall cap               |  44 | 76-88 |
| **floor**              |  53 | 39-49 |
| wall face, upper       |  23 | 31-41 |
| wall face, at the base |  14 | 14-25 |
| east side band         | 4-6 | 20-28 |

**A top surface raised 104 px above the ground was darker than the ground it stands on.** That one
inversion is the physical cause of *"就像一张图贴在地上"*, and it explains why a north-south run was
the worst case: 100% of what you see of one IS its cap (its face only shows at the run's south
end), so a run was a floor-value ribbon lying on a floor-value floor. Everything below follows from
fixing the ordering. Tuning lives in `scene/wallTone.ts` — numbers only, no Pixi, no geometry, so
`wallRender.ts` (blocks) and `pillarRender.ts` (cylinders) can share it without importing each
other.

- **The cap's key light is ADDITIVE, not a wash** — *and additive alone was still not enough; see
  "A north-south run is not an east-west wall" below for what replaced the flat constant.* Pixi
  tints only multiply, so a cap cannot be lifted above its swatch's own value by tinting at all. A
  translucent white wash reaches the target value but is a lerp toward white, so it compresses the
  swatch's own contrast by its alpha — and at play scale a wall cap is nothing *but* that contrast,
  so the first version came out as smooth brushed concrete.
- **The face art's own coping course had to be pulled back under the cap.**
  `wallface_<element>.png` is a whole elevation — bright coping at the top, brick, dark base —
  used once at the wall's full height, and that coping measured as bright as the cap above it. A
  vertical surface cannot out-shine the horizontal one it meets, and when it does, the wall's
  brightest band sits halfway down its front and the fold stops reading. A uniform tint cannot fix
  it (the art's internal range is ~5:1, so any multiply that tames the coping crushes the brick),
  hence a local ramp over the top 22% of the face.
- **Every ramp is built from NON-OVERLAPPING bands, and the band count follows from the largest
  alpha step the eye may not see.** Stacked translucent shapes step in *opacity*, so their steps
  compound; non-overlapping bands make each band's alpha exactly its ramp value. The count then
  depends on how bright the surface underneath is: 12 bands is fine for the base crease, 5 is fine
  for the side shading, and the same 5 over the (much brighter) coping showed as five hard
  horizontal stripes at 3x — that one needs 18.
- **The cap's depth gradient is bounded to `CAP_GRADIENT_REACH_PX` of the fold.** A north-south
  run's cap *depth is its length*, so spreading the ramp over its whole 450 px turned it into a
  gradient painted down a beam. The physical cue is local to the fold anyway.
- **Adjacent rooms author the same boundary twice, and it has to be drawn once**
  (`scene/wallRuns.ts`). A horizontal luminance scan across what looks like one thick wall crossed
  **two** 32 px segments, each with its own lit west edge and dark east band, i.e. a bright/dark
  seam down the middle of one stone mass. The cause is content, not rendering: each room authors
  its own perimeter wall, so a boundary is two parallel rects (`[184,8,4,27]` and `[188,8,4,27]` in
  grid units, plus four more pairs on that floor). `mergeWallRuns` joins any two rects whose union
  is *exactly* a rectangle, iterating to a fixed point — 32 raw walls become 27 blocks on level 1's
  first floor. Render-only: `s.walls` is untouched, so collision is unaffected. **Same-tier only**,
  and that restriction is load-bearing rather than cautious: adjacent rects of different tiers are
  everywhere (a north perimeter wall with an interior solid flush beneath it; a stacked-room kerb
  against the lower room's east/west perimeter wall, 22 such pairs on the shipped floors), and one
  block cannot be two heights at once. It is also what makes tiering **before** the merge work as
  a splitting mechanism rather than needing one — see the kerb rule above.
- **A room now has a centre and corners** (`scene/roomLight.ts`). Measured, the floor was 39-53
  *everywhere* — every room, corner and centre alike. Two consequences no per-object shading can
  fix: a floor of five rooms reads as one flat sheet, and a black cast shadow has nothing brighter
  to be dark against (which is why a wall's shadow measured a 5% modulation on the near-black ember
  floor). This is the cheap static half of the lightmap milestone below — concentric stroked rects
  fading in from each room's own bounds, no light sources, no second render target. The dynamic
  half stays parked.

### The character, same treatment

- **The sphere shading was sized against a radius the art does not reach.** `RigSkin` passed the
  body bone's declared `bodyR`; decoding the shipped PNGs' alpha bounding boxes shows they paint
  **0.68-1.00** of it (`skinRegistry.BODY_FILL`). Nothing here is masked — that is deliberate, a
  mask per actor would be 30 stencil passes in a busy room — so for `critter-core` (0.70) every
  band outside 0.70 landed on transparent background and painted a hard-edged dark **disc** around
  the crystal. An earlier session looked straight at that disc and recorded it as an over-large
  ground shadow. The hero's 0.81 put a fainter halo just outside its white shell the same way.
  Fixed by passing the drawn radius (`bodyR x bodyFill`); `rigComposition.test.ts` re-measures the
  real pixels every run, so re-cropping a body texture cannot leave the number stale.
- **The ground shadow was sized off the sim radius too**, via a hand-tuned `radiusPx * 0.7`. Every
  rig's `referenceRadius` IS its body bone's `bodyR`, so the gameplay radius already equals the
  rig's declared body radius, and the 0.7 was one uniform fudge across a roster whose art fills
  between 0.68 and 1.00 — which is why it looked acceptable on the hero and made an enemy's shadow
  ~45% wider than the crystal standing in it. `Actor` now sizes it from `Skin.bodyDrawnR`. Its
  per-ring alpha also **ramps** (squared) instead of being flat: a flat alpha makes the outermost
  ring a visible hard rim, which is most of what made a shadow read as a plate.
- **The terminator was rebuilt as a full ramp** (`render/rigShading.ts`). Four concentric arcs put
  the darkest band on the rim with hard angular cut-offs at each arc's ends, so the shadow side
  read as dirt rather than as a turning surface. It is now a smooth chord-band ramp across the
  whole body with a **reflected-light rollback** that keeps the outermost sliver brighter than the
  shadow core — the single change that most restores design/13's crisp flat-cel silhouette.
  Pixi 8's `FillGradient` would be the obvious tool and cannot be used: it calls
  `DOMAdapter.createCanvas()` at `fill()` time, which throws in this repo's canvas-free tests, and
  reading the retained instruction list is exactly how the look is machine-checked here.
- **The light mark is a HUE, not a value.** design/13's shells are near-white — the lit cap of the
  hero's shell measures 255 before any shading — so the old white specular was arithmetically a
  no-op, and the first warm wash at 0.17 alpha was imperceptible for the same reason one step
  further out. At 0.28 it actually tints, and it does real work on the dark re-tinted enemy bodies
  the same code shades.
- **A hover of 3.5 px could not produce the cue it exists for.** `3.5 x SHADOW_SLANT` is
  (1.5, 0.8) world px of shadow offset — under one screen pixel. Raised to 6 (peak 9.5), with the
  rest of the readability bought from a steeper `SHADOW_LIFT_FALLOFF` rather than from lifting the
  body further, because past ~10 px a character stops reading as hovering and starts reading as
  flying.
- **The modules are seated against the core** (`drawModuleContacts`) — nested contact shades at
  each socket bone's tip, clamped so the whole ellipse stays inside the drawn body. A socket tip is
  *outside* the shell (orb-core: len 52 vs bodyR 40), so an unclamped blob would have painted a
  dark smudge beside the character instead of a contact shade on it.
- **A shielded actor lost its grounding entirely.** `EnergyShieldFilter`'s rim band peaked at
  `dist 0.5` of a filter area six body radii wide, i.e. **2.1 body radii** from the actor's centre:
  the ring was more than twice the size of the character it wrapped and blanketed the floor around
  its feet with opaque cyan, hiding the shadow the rest of this work exists to produce. Pulled in
  to peak at 1.2 body radii, with the glow's own alpha over transparent background cut from 0.85
  to 0.7.

**Two of this pass's tests are worth knowing about, because their obvious form does not work.**
Containment of the sphere shading cannot be checked against a Graphics' `bounds`: the ramp runs
diagonally, so its extreme points sit at 45° where an axis-aligned box never reaches, and a bounds
assertion passes with the safety margin deleted. It has to measure each mark's own distance from the
body centre. And the tether repaint's memoization cannot be checked by counting strokes, because
"skipped the redraw" and "cleared and rebuilt to the same count" produce identical counts — it takes
a marker stroke left on the Graphics that `clear()` would remove. Both are the same trap: an
assertion that is true of the fix but *also* true of its absence.

**What is deliberately not physical.** A tucked run's clip (above) hides stone that really is
nearer to the camera than the crown drawn above it. It is a choice, made twice on report, and the
whole reason `screen.y = gy - z` works at all is that this projection is already lying: it draws a
horizontal plane and a vertical one both unforeshortened. Keeping the room's back wall unbroken is
worth one more lie of the same kind.

**What is still deliberately unfixed.** A north-south run's visible cast shadow is only
`height x SHADOW_SLANT_Y` ~ 23 px of hem to the south, because the block's own art covers the rest
of the hull; lengthening it for walls alone would break the one thing every shadow in this project
agrees on (`Entity.SHADOW_SLANT_*` — actors, bullets, pillars and walls share one light). The base
hug carries that job instead. (The other half of this paragraph — "the pillars remain the
smoothest objects in a room... without real pillar art" — was closed on 2026-08-20 by generating
real pillar art; see "A pillar is a sprite now" below.)

## A north-south run is not an east-west wall (2026-08-19)

Reported on a screenshot of level 1's start room, circling its west perimeter run:
*"那段墙体看起来很奇怪啊"*. Three defects, and they share one cause: **every number in
`wallTone.ts` had been measured on an east-west wall, where the cap is a 32 px band under a lit
coping — and then applied unchanged to a north-south run, where the cap is 100% of what you see of
the wall.** The wall in question is 64 px wide and 224 px deep (two rooms' perimeter walls merged
by `wallRuns.ts`), so the same constants were being asked to describe a field 7x deeper than the
one they were tuned against. Found by A/B-ing the live scene layer by layer — hide one child of
every wall entity, re-extract, compare — which is cheaper than an edit-reload cycle and isolates a
cue exactly.

1. **A flat additive key light destroyed the stone.** `CAP_LIGHT` reached its target luma and the
   cap still read as pale concrete, because contrast is perceived as a **ratio**, not a difference:
   the swatch's stone-to-mortar range is ~30..60 (2:1), and adding a constant 47 to both ends
   gives 77..107 (1.4:1). The previous pass set out to protect that amplitude and did — in
   absolute terms only. The cap now takes its key light as **the cap swatch drawn a second time in
   `add` mode** (`CAP_BOOST_ALPHA`/`CAP_BOOST_TINT`), which is `value x (1 + alpha)`: the same
   target value with the ratio intact, and the warmth carried on that copy's tint rather than in a
   second draw. Pixi still cannot multiply *up* with a tint; this is how you do it anyway.
2. **The cap tiled from each block's own origin.** A 64 px-wide run therefore windowed the same
   left quarter of a 256 px swatch every time — on ember that is one large stone, i.e. no legible
   pattern at all, however good the swatch is — and an L corner's two blocks met at a mismatched
   seam. `tilePosition = (-r.x, -r.y)` puts every wall top in **world space**, so a room's walls
   read as one continuous quarry and corners join invisibly.
3. **The east band and west chamfer spanned the block's whole art.** That is right for an
   east-west wall: the band is the block's east *end*, and this projection stacks that end's cap
   and face rows on each other. On a north-south run the identical rects are 224 px long and run
   down the block's **length**, so a 13 px stripe at alpha 0.86 was painted along the top of the
   wall — a hard-edged flat grey panel with the stone visibly continuing underneath it, and the
   loudest artifact in a 3x render. Now bounded to `SIDE_CAP_SOLID_PX` (one wall thickness, which
   *is* an east-west cap's whole depth, so that case is unchanged) plus a `SIDE_REACH_TAPER` fade,
   with a narrow ramped bevel (`CAP_EDGE_*`) along the rest of the cap's long edges instead.

Measured after, on the same floor and the same probe geometry: north-south cap **72-78**,
east-west cap **70**, floor **41**, face upper **43** — the hierarchy the flat version reached
(89/78/45) with the masonry visible instead of washed out.

Mutation counts, reverting one half of the fix at a time against
`client/src/game/scene/wallRender.test.ts` (28 tests): world-space tiling **1**, the side band's
bound **1**, the multiplicative key light **4**, the cap-edge bevel **1**.

### The corner: two blocks, one continuous top

Follow-up report on the same wall: *"竖着的墙，直接盖在了横着的墙上面。如果横着的墙是有高度的，竖着
的墙只能到其底部"* — the north-south run looks pasted on top of the east-west one.

**The geometry was right and the drawing was wrong.** For the x range the corner occupies, the
stone mass really is solid from the east-west wall's north edge (y 32) all the way to the run's
south edge (y 288), so the correct picture is ONE continuous top ribbon from screen y −72 to 184,
with no brick face visible in that x range at all — which is what the two blocks together already
produced. (The alternative the report suggests — the run stopping at the far wall's *base* — would
draw the far wall's face in front of stone that stands nearer to the camera than it. Two walls of
equal height meeting at a corner have coplanar tops; the run reaching the far wall's fold is what
that looks like. A visibly stepped corner is a *height* decision, i.e. a different `WALL_H_*`
tier, not a drawing one.)

What was wrong: `mergeWallRuns` merges only pairs whose union is a rectangle, so an L or T corner
is always two blocks — and each of them drew its full "this is where I end" set right in the
middle of that continuous top. Measured down the run's centre line, the junction read **66 → 79**
with a highlight line on it, i.e. a brighter rectangle with a hard 90° corner laid over the brick.
Three cues, all false:

| cue | why it was wrong there |
|-----|------------------------|
| the run's lit coping on its cap's north edge | that edge is buried inside the corner and catches no light |
| the run's dark silhouette on the same edge | an outline drawn across the middle of one surface |
| the east-west wall's cap depth gradient (0 → `CAP_GRADIENT_MAX`) | shades the cap toward a fold that, for those x, does not exist |

`wallRuns.wallJoins` now returns, per block, the local-x intervals along its north and south edges
at which another mass **of at least its own height** carries straight on; `WallJoins` masks all
three cues out of them. Height is load-bearing in the same way `mergeWallRuns`' same-tier rule is:
a *shorter* neighbour (a kerb against a perimeter wall) leaves a real step that must keep its
coping and its gradient.

With the false edges gone, the last thing still reading as "pasted on" was the occlusion itself —
a hard stone/brick boundary with nothing to say which side is nearer. `CORNER_AO_*` creases the far
wall's face outward from each join, stronger on the down-light (east) side. Measured: brick at the
contact **22**, brick 40 px clear of it **33**.

Verified by measurement, not by looking: after the fix the residual step across the junction is
85 → 74, and the swatch's own two rows there are 50 → 45 — the same 1.1 ratio, i.e. what is left is
the stone's pattern and nothing artificial. (That the ratio survives at all is a second check on
the multiplicative key light; a flat additive would have compressed 1.11 to about 1.05.)

Mutation counts against `wallRuns.test.ts` + `wallRender.test.ts` (55 tests): buried-north-edge
mask **1**, buried-south-edge mask **1**, corner crease **1**, the neighbour-height filter **1**,
interval coalescing **1**.

### ...and the corner again: a deep run TUCKS (2026-08-19)

Third report on the same wall, and the one that changed the rule rather than a number:
*"中间的墙体处理的很好，但是上面那段就不对了。我觉得应该是中间的墙要看起来到横着的墙的底部，然后相交的
部分进行立体化处理"* — the run's south END (cap over a brick face) is right; the corner still is not.

Seamless was never the ask. **A block's art intrudes one wall HEIGHT north of its own footprint**,
which is the cheat that makes a wall look like a wall — and it means a deep north-south run climbs
the far wall's brick face and interrupts the one surface in the frame the eye is using as the
room's back wall. Making that overlap seamless only made it a cleaner interruption.

So a **deep** run (`rect.h > its own height`) whose north edge is fully buried now **tucks** under
the wall to its north instead of over it. This is a deliberate **stylisation, not a correction** —
the run's stone really is nearer to the camera than the brick it hides, and the previous pass's depth
arithmetic was right.

**Where exactly it stops took one more round, and that round is the useful part.** Clipping the run
at the far wall's FOOT — everything in the room starts at the back wall's foot, the convention most
top-down games of this shape use — shipped a render and was rejected: *"感觉还是不对，我觉得应该要覆盖
到我标记的区域"*, with a rectangle drawn over the brick immediately above the run. Measured against
the frame, that rectangle's top edge sat at world y **−10**; a row-luma scan of
`wallface_fire.png` puts the underside of its **crown course** (rows 0-31 of 127: lit coping, then
the dark mortar line) at world y **−14.6**. The ask was precise, and it was not "cover more" or
"cover less" — it was *this line*:

> The crown is the longest unbroken horizontal line in a room, so it is the line the eye identifies a
> back wall by. Break it and the wall stops being one wall. Keep it, and every brick course below it
> is fair game for whatever stands in front.

Hence `WallJoins.tuckLiftPx = farHeight × (1 − faceCrownFraction(element))` — taken from the
**shortest** northern neighbour, since the crown that has to survive is that neighbour's own. Three
answers were tried in order and only the third is right: full overlap (breaks the crown), the wall's
foot (hides brick the run is entitled to stand in front of), just under the crown. Visually the run
ends up reading as slightly shorter than the wall it meets, which is what an abutting wall under a
coping course looks like — and the swatch's own mortar line lands on the junction, so the joint comes
out looking authored rather than clipped.

**And the crown line is per ELEMENT, which only the test found.** `FACE_CROWN_FRACTION` shipped for
one round as a single constant measured off `wallface_fire.png`. The first run of
`wallComposition.test.ts` (below) scanned all four shipped face swatches and reported ice's mortar
line at row **17** where the constant said 31: fire and lightning put theirs at 27 of 127, neutral at
25 of 125, and **ice's coping band is a third shorter than the others'**. So two biomes out of four
were being clipped straight through the crown — the exact defect this whole treatment exists to
prevent — invisibly, on content no render of the ember floor could ever have shown. `FACE_CROWN_ROWS`
is now a measured `[row, totalRows]` table keyed by element, `RoomBuilder` looks it up from the room's
own biome, and the fraction rides along on `WallJoins` so the crease that follows a join is sized by
the same number that placed it.

Then the junction is no longer an overlap but a **re-entrant corner**, and gets a crease on both
surfaces (`TUCK_*`) — the *"立体化处理"* half:

| crease | measured |
|---|---|
| `TUCK_CAP_*` on the run's own cap, ramping north into the wall | 73 → **67** at the contact |
| `TUCK_FACE_*` on the far wall's crown, over the run's width | crown 48 → **38** |

The face crease sits on the **crown and nowhere else**, for two reasons that happen to coincide:
every brick course below it is behind the run's own cap now, and the crown is the brightest band on
the wall (~80 after `FACE_TINT`), so it is the only band where the alpha is visible at all. Two
earlier placements are worth recording as the instructive failure — confined to the contact
(`TUCK_FACE_FRACTION = 0.5`) it measured **9 vs 13**: arithmetically present, invisible, because the
bottom 42% of that face is already crushed by `BASE_AO_*`. Same trap as the pre-2026-08-19 contact
shadow. **Always check what value a surface still has where you are about to darken it.**

**`rect.h > height` is load-bearing, not caution.** Two parallel east-west walls stacked
north-south (32 deep, 104 tall) share this exact geometry, and there they are one mass whose top is
drawn by the northern one's cap: the southern one's art *must* keep reaching north of its footprint
or its cap and most of its face would simply be missing. Only a run with a cap to spare may clip.
The clip is otherwise provably safe for any block — it removes exactly the band
`[r.y − height, r.y]`, and the neighbour that authorised the tuck is by definition at least that
tall, so that neighbour's own art always covers exactly that band.

Because a tucked neighbour stops *at* a wall's south edge, that wall's fold there is real — so
`wallJoins` sorts each south-edge join into `south` (buried: mask the fold and the cap gradient) or
`tuckedSouth` (exposed: crease the face), never both. Getting that wrong deletes a real edge.

Mutation counts against `wallRuns.test.ts` + `wallRender.test.ts` (67 tests): the tuck itself **4**,
the cap crease **1**, the crown crease **1**, the `h > height` guard **1**, the whole-width guard
**1**, the `south`/`tuckedSouth` split **2**, re-locking the tile offset after the clip **1**, the
crown lift **2** (computed, and applied), taking it from the shortest neighbour **1**.

### `wallComposition.test.ts` — the assertion class all four rounds were missing

One wall was reported wrong four times, and every round shipped a green suite. The tests written each
round were not wrong, they were the wrong **class**: `wallRender.test.ts` and `wallRuns.test.ts` pin
one block, or one pair of hand-written rects, against numbers chosen by whoever had just chosen them
in the source. Neither can answer the questions the reports were actually about — *does the shipped
content reach this code path at all*, *do the pieces still tile the plane*, *is the constant still
true of the art it was measured from*. This repo has shipped the first of those before: the old
`w > h` height guard left 1 wall standing where 32 should, because level-1's rooms are almost
entirely `w <= h`.

So the new file runs the **real** floors through the **real** sequence (`placeAuthoredFloor` →
`buildFloorGeometry` → `wallTier` → `mergeWallRuns` → `wallJoins`, RoomBuilder's own), and asserts
relationships between blocks rather than restated coordinates:

- every floor produces deep north-south runs *and* tucks them (the `w > h`-class regression);
- a clip never opens a hole — the neighbour that authorised each tuck provably paints the band the
  clip removed, checked against real geometry instead of proved on paper;
- no tucked run crosses its neighbour's crown, measured against that neighbour's **own** height;
- every south-edge join lands in exactly one of `south` / `tuckedSouth`, never both;
- a join only ever exists where a tall-enough neighbour really touches — and the shipped
  kerb-north-of-perimeter-wall pairing (22 of them: a stacked-room boundary sitting directly north
  of the lower room's east or west wall) proves the height filter is load-bearing, not defensive;
- **nothing along a stacked-room boundary reaches further into the room above than one kerb's
  worth** — stated as art geometry against `WALL_H_KERB` rather than as a tier name, so any tier
  whose art clears the floor passes and both `interior` (70) and `perimeter` (104) fail. The
  boundaries are enumerated from the **room rects**, not from the runs, and that detail is the
  whole test: keyed off the runs, the three boundaries whose two halves merge into one 64 px-deep
  kerb (floor 2 `r5_bastion`, floor 3 `r3_crucible`, floor 4 `r5_boss`) matched no run at all and
  were silently skipped — it passed on the other eight and looked green. Rooms cannot merge, so
  the count (11, pinned) cannot fall because the drawing changed. Excluded on purpose, with the
  reason written down: a block starting one row further south is the lower room's east/west wall,
  whose art also pokes 40 px into the room above over a 32 px strip at the corner — a north-south
  run spilling past its own end, which no tier rule can fix and which the occlusion sweep owns;
- its counterweight: a north wall the room above only *partly* covers must keep the uncovered half
  tall (the check that would catch a future move of tiering to after the merge);
- `FACE_CROWN_ROWS` matches the real PNGs: it decodes each `wallface_*.png` (zlib inflate +
  unfilter — ~40 lines, and the alternative is trusting a recorded number, which is the failure mode
  the file exists for), asserts the recorded row IS the darkest row of the swatch's top third, that
  the recorded height IS the image's height, that every shipped swatch has an entry, and that the
  coping above the line really is brighter than the brick below;
- and that `RoomBuilder` is actually **wired** to the per-element lookup — read from source, the same
  trick `render/rigComposition.test.ts` uses on main.ts, because `wallJoins` has a safe default and a
  caller that forgets would just clip every fire room a few px low, forever, silently.

17 tests, and every one of them earns its place: mutation counts are the tuck **3**, the crown lift
**2** applied / **2** computed, the fire row **1**, ice's row **1** (i.e. re-introducing the
single-constant bug), the neighbour-height filter **2**, and RoomBuilder's wiring **1**.

**The generalisable lesson, and it is the third time this repo has hit it:** a constant tuned on
one orientation of one asset is not a constant, it is a special case. The `w > h` guard that used
to disqualify north-south runs from standing at all, the cap gradient that had to be bounded
because a run's cap depth is its whole length, and this pass are all the same mistake at different
scales — so when touching `wallTone.ts`, check the change against **both** a 32 px-deep cap and a
200 px-deep one before believing a number. The corner is the same shape of mistake one level up:
every cue in `wallRender.ts` is a statement about where a block ENDS, and at an L or T corner half
of those statements are false.

**And the cheapest tool this pass produced.** Both rounds were diagnosed by A/B-ing the *live*
scene rather than editing and reloading: `roomBuilder.wallEntities` is a flat list of blocks whose
children are `[face, cap, capLight, shading, edge]`, so hiding one child index across every wall
and re-running `renderer.extract` isolates exactly one cue per frame, three calls per variant and
no rebuild. That is how "the flat additive is the problem" and "the grey stripe is the shading
layer" were each settled in one frame instead of a guess-and-check loop.

## The occlusion x-ray: the character is never lost behind a block (2026-08-20)

Live report, with the wall circled: *"角色跑到墙下面去了"* — the character walked to the north
side of one of `ember_l1_alcove`'s interior blocks and was **gone**. Not clipped, not half
hidden: measured on the extracted frame, the rect where the body should be read luma **78.4**
while the cap stone right beside it read **77.1**. The character was arithmetically
indistinguishable from the wall.

**Nothing was drawing wrongly.** Every layer was individually correct, and their combination
hides the player:

- A block's art spans `south - height - depth .. south`, i.e. it intrudes one full wall height
  north of its own footprint (the section above says exactly this, and it is what makes a wall
  look like a wall).
- That intrusion lands on **walkable floor**, and the block sorts on its south edge, so it is
  drawn in front of anybody standing there.
- The player's own wall clearance (`PLAYER_BASE.solidRadius`, 16 px) puts them 16 px north of
  the footprint at closest approach, so the cap reaches `70 - 16 = 54` px above their feet —
  and the drawn body is **32** px tall. Fully covered, with 22 px to spare.
- 2D sorting is per-object, so "mostly behind" is not available: the whole character goes.

In real geometry the head would poke over a wall this tall by a few px; the fake-3D
approximation eats that margin, and this doc's own "Limits of fake 3D" section is where this
case had been parked. **Being hidden is not the bug — being hidden with no way to tell is.**

**The fix is an x-ray, not a geometry change** (`scene/occlusion.ts`, driven per render frame
from `GameLoop.updateFx` alongside the dynamic lighting, which already has the local player and
this frame's dt). Any standing block currently drawing over the local player fades to
`XRAY_FADE` (0.34) over 90 ms and back over 220 ms — slower back, so walking along a block
cannot strobe. What was rejected and why:

- **Lowering the interior tier** so the head clears the cap. Physically consistent and needs no
  per-frame state, but it only ever buys back the top few px of the body, and it breaks the
  deliberate `WALL_H_INTERIOR == pillar height` agreement that lets a room's verticals be read
  against each other.
- **Drawing the player OVER the block.** Always visible, but it reads as standing on top of the
  wall — the same spatial confusion, inverted, and it permanently costs the occlusion cue.
- **Growing the collision footprint** so the blind band is unreachable. Invisible walls, and it
  eats a wall height of floor around every block in the room.

**Since 2026-08-20 this also covers every live enemy, not just the local player** — live report
with a screenshot circling a monster gone behind a wall: *"如果只有怪物在墙下面的话，就看不到怪物了"*
(if only a monster is under the wall, you can't see the monster at all). The x-ray used to take a
single `OcclusionFocus` (`GameLoop.updateFx` built it from `scene.player` alone), so a monster
standing in the exact hidden band the fix above closes for the player got no x-ray at all and
rendered fully swallowed by the wall — the very failure this section exists to remove, just for a
different actor. `occlusion.updateOcclusion` now takes a LIST of foci (`Scene.enemies` enumerates
every live enemy view alongside `scene.player`), and a block fades if it hides ANY of them — the
cap and deep-fade decisions are each an OR across the whole list, not "whichever focus happens to
be checked first."

**Only the CAP fades — and where that is not enough, the face follows.** Measured both ways on a
live frame: fading the whole block loses the stone and the block reads as a hole in the room, so
the default pass moves the cap layers only (`occlusion.xrayLayers`, tagged in `buildWallBlock`) and
leaves the face, the shading and the silhouette at full strength, with the cast shadow never moving
at all. The result reads as a glass-topped block on a solid brick elevation, which still says "you
are behind this". Layers are tagged by label, not child index, and each layer's authored alpha is
*scaled* rather than replaced, so the cap's additive key light stays proportional on the way down.

For an interior block that is the whole story: 70 px of art over a 64 px footprint means the
engine's own clearance keeps the body's feet 10 px *above* the cap/face fold, so the face never
covers any of the character. It is not the whole story for a **tall wall on a shallow footprint** —
which needs `depth + clearance + bodyH <= height`, and which every 104 px room boundary over a
32 px footprint satisfies. There the body can sit entirely below the fold and fading the cap
achieves *literally nothing*. `occlusion.needsDeepFade` is a second pass for exactly that: when the
FACE alone covers as much of the body as it takes to trigger the x-ray at all (the same
`MIN_COVER_FRACTION`, deliberately not a second number), the face and its shading go too. **Since
2026-08-27 only the BAND of the face a body can reach goes** — the block's base stays opaque through
the fade; see "The deep pass stops where the body does" below for the bound and what it fixed. It costs
something real — dropping a face reveals what is *behind* the wall, and at a room boundary that is
the next wall's own bright cap showing through as a pale band — which is why it is a fallback and
not the default. Swept over the shipped floors it fires on **0.2%** of the standable floor (1.2% before the kerb tier fix below). The two
passes stage naturally as you walk into a wall: the cap goes first, and the face only once the cap
has stopped being the thing in the way.

**A pillar gets the same treatment, and it has no cap/face split at all.** A pillar is
drawn upward from its own ground point, so the surface a character disappears into is its
70 px **shaft**, not the little ellipse on top — its whole body fades. This doc used to call
being hidden behind a pillar intended (see "Depth sorting" below); a body that vanishes
completely is not, whatever shape the thing hiding it is. A pillar is also a *narrower* target,
so the player brushes past its blind side more often, not less.

**What deliberately does NOT trigger it: the south kerb.** A 22 px lip reaches 6 px above the feet
of a player standing flush against it — the character was never hidden, and fading the whole
southern lip of the room every time the player walks along it would be a bigger artifact than the
6 px it fixes. `MIN_COVER_FRACTION` (0.45 of the drawn body height) is what draws that line, and
the *drawn* body is the denominator on purpose: an absolute px threshold is exactly the kind of
number that goes stale the next time the art grows.

**A perimeter run DOES trigger it, and the first version of this section claimed otherwise.** The
claim was that a room's boundary covers floor on the far side of itself, so a player inside the
room is always south of its sort line. True of a room's north wall, false in general — and
`occlusionCoverage.test.ts` found both counterexamples in the shipped content:

- **A long north-south run whose north END is open floor** (a door passage between two rooms). The
  run's art spills one wall height past its own footprint onto ground the player walks over once
  that door unlocks, and standing there they are half swallowed by its cap. **Fixed at the
  geometry, same day, once it turned out to swallow the DOOR too, not just a player who happens
  to stand there** — live report with a screenshot circling the door: *"门不能被高墙挡住了。门应该
  是随时清晰可见的"* (a door must not be blocked by a tall wall — it should be clearly visible at
  all times). The door sprite lives on `layers.ground` (`RoomBuilder.buildDoors`), always behind
  the Y-sorted `entities` the run stands on, so no amount of Y-sort or x-ray fading could ever
  help it — the x-ray only ever protects the local player's silhouette (see below), and a door
  isn't one. `wallRuns.bordersDoorNorth` finds a run whose north edge meets a door passage's south
  edge, and `blockCapTop` clips that run's cap to stop at its own footprint (`doorClip`, zero
  lift) instead of spilling past it — the same clip `tuckNorth` already applies against a
  neighbouring wall's crown, just with nothing left to reveal underneath.

  **The cap-only clip left a SHALLOW run still spilling, and this was recorded as an open
  question rather than measured** — the note here used to read "a SHALLOW run beside a door
  still spills; that residual case is the general doors-have-no-x-ray problem above, not this
  clip's to solve." `doorSpillCoverage.test.ts` (2026-08-20) swept the real pipeline instead of
  guessing and found the shallow shape firing **12 times across all five shipped floors** — not
  hypothetical, and in fact the MORE common shape (`carveDoorGaps`'s ordinary-thickness stub
  walls flanking a door opening are almost all shallower than their tier height; the deep run
  above is the unusual case). Root cause was one layer deeper than the cap: a block's FACE is
  drawn at a fixed tier height regardless of its own footprint depth, which is exactly what lets
  a wall "stand" taller than its own collision thickness — but it means that whenever the
  footprint is shallower than that height, the FACE ALONE already reaches past the run's own
  north edge, with no cap involved at all (measured: a 32 px-deep PERIMETER stub spilled 72 px of
  pure face with the cap-only clip already in place). `wallRuns.effectiveWallHeight` closes it by
  shrinking the height fed to BOTH the face and the cap for a `doorClip`ped shallow run — a
  genuinely deep run is unaffected, `Math.min` returns its tier height unchanged.
- **A wall between two vertically stacked rooms** — much the bigger case, and **since 2026-08-20
  it is fixed at the tier instead of covered up by the x-ray**. Measured on a live frame at floor 0's
  `r4_forge`/`r5_extraction` boundary (vertical luma scan down world x=350, fix stashed and
  unstashed at identical framing): stone used to start at world y **440** — `544 − 104`, the
  perimeter art top — and now starts at **492**, `512 − 22`, the kerb's. 50 px of the room above
  goes back to being floor. `wallTier` classified a wall by
  the one room its centre falls in, so the lower room's north wall stood at 104 px one grid row
  south of the upper room's floor, its art covering a measured 72 px of it; a player standing
  there was **completely invisible** before the x-ray existed, and the x-ray then had to dissolve
  a room boundary on every one of the five floors to keep them visible. Both halves of a shared
  boundary are kerbs now (see "Every wall stands, at one of three heights" above), which removed
  a third of the blind floor on level 1 and two thirds of the deep-fade cases. What the x-ray was
  doing here was real work on a wall that should never have been that tall.

What does still hold — and is what stops a boundary fading while you walk along it — is the
geometry: a perimeter run can only ever fire from **north of its own footprint**, never from the
room floor it borders. Every remaining case measures at most one wall thickness wide (32 or 64 px)
— a north-south run or a door-carved fragment of one; the room-width east-west runs that used to
appear here were the stacked boundaries, and they are gone.

**Measured, before → after** (`renderer.extract`, luma 0-255, the body's own rect derived from the
player view's global position): the character behind the block **78.4 → 105.7**, against **125.8**
standing on open floor — so the x-ray recovers 84% of the body's own value, where before it
recovered none of it (78.4 vs the 77.1 of the stone next to it). The block's face measures 33.8
either way and the floor 39.8 either way: nothing outside the cap moved.

**And measured over the whole of level 1, which is what sized the fix.**
`client/src/game/scene/occlusionCoverage.test.ts` sweeps every position the player can legally
stand at on all five shipped floors — 97,803 samples at 8 px — scoring each against an independent
oracle (rectangle overlap between a block's drawn art and the drawn body, never calling the rule
under test):

The right-hand column is the level as it ships today; the middle column is the same sweep before
the 2026-08-20 kerb fix, i.e. how much of this the x-ray was carrying alone.

| | with the tier bug | as shipped |
|---|---|---|
| at least half the character hidden, before the x-ray | 8.5% | **5.4%** |
| character **completely** invisible, before the x-ray | 5.5% | **3.3%** |
| still more than half hidden, after | **none** (worst case 43.8%) | **none** (worst case 43.8%) |
| needs the deep pass | 1.2% | **0.2%** |
| samples where a *perimeter* run fires | 4,626 | **1,574** |

Two things came out of that sweep that no hand-written fixture was going to produce: the
perimeter-run cases above, and the fact that a cap-only fade left **88 samples 100% hidden** and
another 40 at 75% — which is what the deep pass exists for. (That second number was 561 before the
kerb fix; the 88 did not move, so the deep pass is sized by geometry the tier fix does not reach —
it came down from 148 with the door-alignment fix of the same day, which removed the four 16 px-deep
wall runs that were its worst case.)
It also caught a bad fixture in `RoomBuilder.test.ts`, whose "player standing behind the block"
position was actually inside the stone.

### The deep pass stops where the body does (2026-08-27)

The five places the arena's own sweeps had named as "point a camera here" were looked at on
2026-08-27 and came back acceptable, **with one reservation**: the deep pass "reads as a glass block
with hard edges, since a ghosted rectangle is more *pane* than *x-rayed stone*". This is that
reservation closed, and the cause was not the fade value or the edge — it was the EXTENT.

`needsDeepFade` decides *whether* a block's front face has to go translucent. Nothing decided *how
much of it*, so the whole face went. On the shipped arena's deep case — 70 px of art over a 32 px
footprint — a body standing at the closest legal approach occupies the face's **top 22 px**, and the
projection puts the rest of it, 48 px, over the floor BETWEEN the character and the wall. Measured on
a live frame at the worst sample the sweep knows (`catacombs_r4c6`, a 256x32 run): the lower two
thirds of that rectangle going translucent takes away the block's dark base course, its plinth and
its footing on the floor, and lets the room's own floor read through where the stone met it. That is
the whole of "pane": the block loses its mass everywhere except where losing it was the point.

**`occlusion.deepFadeReach(height, footprintDepth)` bounds it, and the bound is geometry.** A focus
is a character standing NORTH of the block — it cannot overlap the footprint, so its ground point is
at most `sortY - footprintDepth`, and a body is drawn UPWARD from its ground point, never below it.
So the lowest face row any body can reach is `height - footprintDepth` px below the cap/face fold,
full stop. `wallRender.addWallFace` draws the face as two pieces on that row: the band above it keeps
`XRAY_DEEP_LABEL` and fades, and the base below it carries `FACE_BASE_LABEL` — in neither x-ray
group, so it holds full strength through both fades, the same standing the silhouette has. For every
deep block on the launch map that keeps **32 of 70 px, 46% of the face**, opaque.

Four properties make the split honest rather than a tuning knob:

- **It cannot bury anything the old fade revealed.** The band is exactly the reachable-body
  envelope, so `f.y <= foldY + reach` for every focus the rule fires for — checked on all 778
  deep-firing samples of the arena's 72,686 and on the five PvE floors, not on the rects the rule
  was derived from. The x-ray's own acceptance numbers (worst case 43.8% still hidden, the head
  always kept) are unchanged, because nothing that was see-through stopped being see-through.
- **The bound is derived at clearance ZERO on purpose.** The player's own 16 px wall clearance means
  the sweep never uses more than 22 px of the 38 px band, and that leftover 16 px is head-room
  rather than slack: `foci` includes every live enemy, and an enemy keeps its FEET circle against
  solids (`enemies.ts`, `solidRadius: bp.footprintRadius`, as low as 6 px), so a mob legitimately
  stands 10 px closer than anything the sweep can place.
- **It is invisible at rest.** Both pieces are the same swatch at the same `tileScale`, and the base
  carries the band's height as its own `tilePosition` so the courses run straight on across the
  join. A live A/B that split all 227 splittable blocks in frame moved pixels **only inside the one
  deep-faded block's base rows** (3.49% of the frame, all of it in one 513x91 box) and nothing
  anywhere else.
- **It costs no draw call.** The extra `TilingSprite` batches: 45 draws before, 45 after, on the same
  frame.

**The new edge, and the bound it is judged against.** A hard join mid-face is a new horizontal step
where there was none, so it was measured rather than eyeballed: 12.99 luma across the seam row
(35.3 → 48.3, row means over a 120 px-wide strip of the block's own face). The same wall unfaded
already carries **22.73** at its own cap/face fold, and the split's worst per-row step anywhere on
the face is 13.62 — which lands 9 px BELOW the seam, on a stone course inside the now-opaque base.
So the join is 57% of a step this surface shows all the time and is not even the loudest thing on it;
no feather was added, and a stack of graduated sub-pieces (the only way to ramp a multiplicative
group's alpha) was not worth that.

**The SHADING is not split, and that is a measurement not an omission.** `drawBlockShading` is one
Graphics for the whole block, so unlike the face it cannot keep the base's share of itself at full
strength; splitting it would double a per-block Graphics that the draw-call passes budget. On a live
frame the base with its shading faded is indistinguishable from the base with it solid — the base
contact crease is the only pass down there and it is subtle against opaque stone. The cast shadow on
the floor (`layers.shadow`) never faded in the first place, so the block's contact with the ground
was never in question.

**A DOOR is deliberately excluded.** `doorRender.buildDoorBlock` passes no reach, so its face stays
one piece with all of it fading. The derivation above assumes the focus is north of the footprint,
and a door's passage floor is INSIDE its own footprint: a character in the doorway stands on exactly
the rows the derivation excludes. Same reason the recess, the leaf and the glow are all in the deep
group there.

#### What the tests were not asked, and the stale oracle among them

The battery above proves the tests that EXIST are load-bearing; it says nothing about where they
were never aimed. Re-reading the pass for that turned up five places, and the first is the one that
was actively wrong:

- **Both 70k-sample coverage oracles still modelled the old behaviour.** `occlusionCoverage` and
  `arenaWallCoverage` compute what a body has behind stone from rectangle overlap, and their model
  of a deep-faded block read *"which leaves nothing"* opaque. That stopped being true the moment the
  face was split, and it was OPTIMISTIC — it credited the x-ray with visibility the renderer no
  longer delivers. An oracle that agrees with the rule for the wrong reason is worse than no oracle.
- **Fixing it was not enough, and measuring that is the point.** With the reach cut by 24 px the
  corrected oracle correctly reports 25% of the body still buried — and the acceptance assertion it
  feeds, bounded at *half* the body, passes anyway. What the split guarantees is not "less than
  half" but EXACTLY NOTHING, because the band is the reachable-body envelope. So both sweeps now
  assert that per (sample, block) pair: a block taking the deep pass leaves zero rows of the body
  behind stone. That is the rectangle-overlap derivation of the same invariant the rule states, and
  it is what makes a reach cut by ONE px fail.
- **The split sat outside every draw-call budget.** The live 45 → 45 measurement holds *because*
  the extra piece is a batchable sprite; nothing in the suite pinned that. A base drawn as a
  `Graphics` fill instead would look identical, pass every other test, and cost a draw call on 227
  blocks — which is exactly how the 2026-08-24 pass found 50 of 107 draw calls in the first place.
  `wallComposition.test.ts` now sweeps the shipped floors for two properties: every child
  `addWallFace` adds is a sprite in the swatch path, and the no-swatch fallback's pieces (which ARE
  a Graphics each, so the split really does add one there) stay inside the auto-batch line.
- **The base holding full alpha through a real fade was covered by accident.** `RoomBuilder`'s deep
  test asserted it via a filter called `silhouette` that happened to include the base — true today,
  and the kind of coverage that evaporates the next time someone renames a variable. Named
  explicitly now, alongside a new check that the occluder box's fold row and the drawn split agree,
  derived from the box's THIRD number (`foldY - top`, the cap's drawn depth) rather than from
  `foldY` twice: `reach = height - depth`, so the base's height IS the footprint depth.
- **`expect(base.label).toBe(FACE_BASE_LABEL)` was a tautology** — it reads the constant it checks,
  so `FACE_BASE_LABEL = 'xray'` satisfies it while moving the base into the CAP fade. Re-gated as a
  relationship: the value must collide with neither group's marker. Third time this exact shape has
  come up (`EDGE_ALPHA`, `VOID_CROWN_ALPHA`, now this).

**And the hole no fixture in the file could reach.** Feeding the occluder box `wallHeight(run.tier)`
where the block is drawn at `effectiveWallHeight` survived the entire client suite. The reason is
content, not assertions: every fixture in `RoomBuilder.test.ts` is a room *without a door*, and the
two heights are equal everywhere except the 12 shipped shallow runs beside one — so on those
fixtures the mutant is behaviour-identical. Where they differ the consequence is total:
`effectiveWallHeight` returns `min(height, r.h)`, so a door-clipped shallow run stands exactly as
tall as its own footprint is deep, which makes its reach **zero** and its whole face a single
never-fading piece. Drawn at the tier height it would get a band, and the deep pass would dissolve
part of a wall that cannot hide anybody. Closed twice over: a door in the `RoomBuilder` fixture, and
a sweep in `doorSpillCoverage.test.ts` over all 12 real cases which also asserts that the tier height
*would* have produced a band — so the fixture is proved to disagree instead of assumed to.

**Five rounds, 79 mutant runs over 51 distinct mutants, 2 controls intact. 8 survivors, 7 of them
now tests and 1 an equivalent mutant.** The distribution is the lesson: round 1's survivors were all
about the code, and every survivor after it was about **which content the tests run on**.

## A door is a wall block whose face is an opening (2026-08-20)

Every standing thing in a room had been through the volume passes above — walls, pillars, the
character — and the one fixture the player most needs to read at a glance had not: a door was a
flat `Sprite` on `layers.ground`, stretched to its `passageAabb`.

**The art was never a floor decal.** `door_{locked,open}_raw.png` are front ELEVATIONS: a portrait
stone frame around a hazard-striped slab, and the same frame as an empty arch with a transparent
middle. That is the identical mistake `13` records for the wall swatches before 2026-08-18 ("they
were being laid flat on the wall's own footprint, so the tilted view's promised small front face
existed on pillars and nowhere else"), still live for doors two days later. Measured on a live
full-floor extract of level 1: 221x320 of portrait art squeezed into a 64x128 rect for an
east-west passage — and into a 128x64 **landscape** rect for a north-south one — so the locked
door read as a red rug lying on the floor between two 104 px stone masses and the open one as a
mangled hoop. The two files also carried ~33 px of transparent margin on every side (the leaf
covered 67% of its own width) and, worse, DIFFERENT margins from each other, so the two states
were not even registered against one another. Both are now trimmed to their alpha bbox by the
repo's own `tools/png-pipeline/compress.mjs` — 221x320 → 147x217 and 215x320 → 156x224 — rather
than corrected with a fudge factor in the renderer.

**The geometry needs no orientation branch, which is the good part.** A door's passage rect is a
hole in a wall: its short axis is the wall's own thickness, its long axis the gap. Under
`screen.y = gy - z` the mass ABOVE a doorway therefore lands exactly where a wall block's CAP
lands (the footprint displaced one height north) and the opening lands exactly where that block's
FACE goes. So `scene/doorRender.ts` builds a door as a wall block whose face is an opening, from
the same shell as `wallRender.ts` (`addWallFace`, `addCapLayers`, `drawBlockShading`,
`addBlockEdge`, `drawWallShadow` — all now shared rather than re-implemented), and one
construction covers both orientations:

- **cap** — the wall over the lintel, tiled from the same world-aligned swatch as the runs either
  side, so a room's crown line runs unbroken THROUGH the doorway.
- **face** — the wall's own elevation across the full height, darkened by a recess ramp
  (`RECESS_*`), then the leaf. The first version filled the opening with flat near-black instead
  and that was wrong twice: on a 22 px kerb door it WAS the whole fixture (a black rectangle
  punched in the room), and stone in deep shade reads as a passage where a void reads as a bug.
  Measured after: the open arch's interior sits at luma 19 against a 37 floor and a 75 cap — half
  the floor's value, which is what makes it read as a hole.
- **leaf** — the elevation, fit by WIDTH, bottom-anchored, overflow cropped off the top via a
  source frame (`doorLeafFrame`). Never scaled to fit both axes: an opening is 64x104 on a
  perimeter wall and 128x22 on a kerb, and fitting both would squash the kerb case 8:1. A tall
  door shows the whole leaf under a band of lintel stone; a kerb door shows the leaf's own base —
  frame feet and the bottom hazard stripe — at the same stone scale as everything else in the room.
- **hazard bloom** (locked only, additive) — nine graduated ellipse rings on the floor plus a wash
  over the leaf. Five rings still showed three of their own edges; the pool is worth having, and
  measurably so: A/B'd against the same frame with the layer hidden it moves a 200x90 px region by
  a mean of **+4.0** luma (max +27, 41% of pixels past 3/255) — unlike `LIT_WALLS`, which was
  measured at 0.06% and deleted.

**A door stands exactly as tall as the wall it interrupts** (`wallRuns.doorFlankTier` — the
SHORTEST run abutting the passage along the gap, then `wallHeight`). This is the rule that keeps
the fix from re-opening a bug the wall passes already closed twice: nearly half the doors in the
shipped game (11 of 24, swept in `doorStandCoverage.test.ts`) are cut into a KERB, the low
boundary between two vertically stacked rooms, which is low precisely because a room's floor lies
immediately north of it and anything tall there stands between the camera and the player. A
doorway is no more entitled to that space than the wall is, so it inherits the shorter flank and
gets its legibility from the hazard bloom instead of from height. The other 13 stand at
`WALL_H_PERIMETER`. Taking the shortest also means a door can never out-top the mass it is set
into. Doors additionally get their own `wallJoins` pass (against the walls, not folded into the
walls' own pass — every wall tone was measured with doors absent from that list), so a doorway's
cap runs into the flanking caps without either side drawing an "I end here" coping across one
continuous stone top.

**And a door is now an x-ray occluder like everything else that stands** (`occlusion.ts`). It has
to be: the passage floor is entirely inside the fixture's own art, so a character walking through
a doorway is behind it by construction — while a door lived on `layers.ground` it could not
participate at all, which is what forced the separate `bordersDoorNorth` cap clip for the walls
around it (that clip stays: a run south of a door still sorts in front of it). Verified live on
all four doors of level 1's first floor: a focus standing in the doorway takes the fixture to
`XRAY_FADE` 0.34 and it returns to 1 when the focus leaves. The kerb door correctly fades its cap
only — a 22 px opening puts the body above the cap/face fold, where `needsDeepFade` is false.

## The floor stops at its rooms (2026-08-20)

The floor was one `TilingSprite` of a 256 px swatch over the world, and measured on a live
full-floor extract of level 1 that had two separate defects in it.

**One: 29-56% of it was painted where no room exists.** `worldW/worldH` are the bounding box of a
floor's co-resident rooms, and a `graph2d` layout's rooms do not fill their own bounding box —
across the five shipped floors the box is 1.41-2.26x the rooms' area (`floorCoverage.test.ts`). On
floor 0 that surplus is a single featureless 1500x430 field with no walls, no room light and no
decals in it, which the eye reads as one enormous room the level happens to have wall-lines drawn
across. Everything outside a room now belongs to the backdrop, and the frame reads as five rooms
connected by doors instead.

That is only safe because a PvE floor's rooms *are* its walkable space, which is asserted rather
than assumed: `floorCoverage.test.ts` flood-fills each shipped floor's grid from every room centre
through non-wall cells and requires every reachable cell to be inside a room rect (0 outside, all
five floors). "Not inside a wall" would have been the wrong test — a floor's bounding box contains
large enclosed regions that no room occupies and nothing walls off; they are simply unreachable.
**A PvP arena used to be the opposite case, and that stopped being true when the map changed.**
The same sweep over `arena_prototype_60` found 5240 of its 11,524 non-wall cells (45%) reachable
and outside every room rect *and* every door passage — that map had `solids: []` everywhere, so it
had no walls to stop anyone — and a per-room floor there would have left a player walking over the
backdrop. `groundLayer.floorRegionsPx` was a branch on map KIND because of it. `arena_launch`
(2026-08-25) walls every room, so 2026-08-26 that branch became a MEASUREMENT
(`scene/floorPartition.roomsCoverReachableSpace`, one rasterize + one BFS at room-build time):
`arena_launch` reports 0 cells outside and its floor now stops at its 60 rooms — 322 stamp sprites
covering 9,246,720 px of a 11,770,880 px world box, the 2465 cells of deliberately-empty slots and
outer margin no longer painted — while `landing_basic`, three wall-less rooms in open world, still
gets the whole-world floor. Every room keeps its own wash/mottle/light either way.

**Two: the floor had no variation at all.** Three 256x256 patches of open floor, 512 px apart, in
three DIFFERENT rooms, came back with identical statistics (mean 38.6, sd 4.6, min 21, max 105) and
97% of their bytes equal — the 3% that differed was `roomLight.ts`'s corner falloff, not the floor.
An exact 8-grid-cell period, the same in every room, on every floor, from a swatch whose own
contrast is sd 5.2. `floorRender.ts` adds four layers, and the order they are listed in is the order
of how much they actually did:

| layer | what it does | measured |
|---|---|---|
| per-room floor (above) | the floor stops at the rooms | 29-56% of the old floor was surplus |
| per-room wash | one warm-or-cool multiply per room, hashed from its world position | room floor means now span **40.6-54.2** luma; they were identical |
| mottle | dark and additive blobs at 1.4-3.6 tiles across, deliberately incommensurate with the tile grid | 64 px patch-mean sd **2.69 → 4.23**, spread 10.7 → 14.9 (A/B on one frame) |
| stamp | one Sprite per tile, mirrored from a hash of its grid position | two rooms' patches went from 97% byte-identical to 57% of bytes differing |
| wear | stains, rubble specks lit from the same upper-left key light, and a worn patch across each doorway along its travel axis | — |

Three things this pass got wrong first, all of them found by looking at a 2x crop rather than by
reasoning:

- **A per-tile tint paints the tile grid.** The stamp originally dimmed each tile by a hashed
  0.93..1.0, and a 7% step between two adjacent 256 px squares is a *flat rectangle*: the floor came
  out as a visible checkerboard of slightly different greys, i.e. more legible as a grid than the
  repeated cobble ever was. Removed. Value variation belongs at a scale unrelated to the tiles.
- **Mirrors only, never rotations.** A seamless tile stays seamless mirrored (its left edge equals
  its right edge, so a mirrored copy still matches its neighbour) and does not rotated, where the
  other axis's edges arrive at the seam. `tileVariant` therefore offers flips and nothing else, and
  a test says so, because "add a rotation for more variety" is the obvious next idea.
- **A blob at one alpha shows its own rim.** Three mottle bands at a flat alpha drew visible arcs on
  the floor; five with the alpha ramped by band index do not. Same lesson as `CAST_PASSES` and the
  door bloom's nine rings, for the third time in this document.

Everything here is hashed, never `Math.random` — a room must draw the identical floor on every visit
and on every client (design/06's rule applied to the render layer, as with `Pickup`'s golden-angle
bob phase).

## The same sweeps, on the arena (2026-08-26)

Everything above this line about walls, doors and the x-ray was measured on `EMBER_L1_FLOORS` — the
five PvE floors — and so were all five of the content sweeps that guard it (`wallComposition`,
`occlusionCoverage`, `doorStandCoverage`, `doorSpillCoverage`, `doorOcclusionCoverage`). The PvP
arena had no walls at all until `arena_launch` was authored, so there was nothing else to sweep;
now there is, and `client/src/game/scene/arenaWallCoverage.test.ts` runs the same pipeline over it
(492 wall rects -> 294 blocks, 124 pillars, 44 stacked-room boundaries, 74 passages, 72,686
standable samples). Three things above are not true there, and they are here rather than only in
ROADMAP because they are statements about the RULES, not about that map:

- **`bordersDoorNorth` used not to run in an arena at all — fixed the same day.** The clip described
  under "The occlusion x-ray" and "A door is a wall block whose face is an opening" was fed from
  `GameState.dungeonDoors` alone, which is populated in dungeon mode only, so an arena passed an
  empty door list: `doorClip`/`effectiveWallHeight` were dead there and 58 of `arena_launch`'s 74
  passages had wall art over them, 36 covered to their full depth. `RoomBuilder.build` now unions
  `s.arenaMap.doors` into that list. The rule needed no change to work on this content — it matches
  44 runs, 21 of them the shallow case, with no spill in either direction — and the residual is 10
  partly-covered passages, worst 40 px of a 96 px gap, none buried. Door FIXTURES stay dungeon-only:
  a fixture is built per `DoorRuntime`, an arena `Door` is an adjacency record with no lock and no
  leaf, and an arena passage is meant to stay open. So `doorFlankTier` is still unexercised there.
  The passage list feeds `groundLayer`'s worn-floor patch too, which is the cue that a hole in the
  stone is a threshold — without it the courses ran on unbroken and a buried passage read as a wall
  somebody meant to build. That patch is additive, so its visibility is `luma(WEAR_COLOR) * WEAR_ALPHA`
  per band regardless of the floor under it: the faintest band adds 5.62 and the four-band centre 22.49,
  a little under double the bare neutral floor's own 25.9. Both are pinned in `floorRender.test.ts`
  against perceptual bounds (a visible step at 3, a reads-as-a-lamp ceiling at 45) rather than against
  the constants, because the constants only matter through that product — a 2026-08-26 battery found
  all three value mutants surviving the whole suite while every geometry mutant died.
- **"at most two blocks fade at once" is a claim about WALLS.** It holds for walls on the arena too,
  and pillars break it: an interior kit's 2x2 colonnade cluster fades four at one spot (1 sample of
  72,686). A pillar fades whole rather than cap-only, so four of them is a different look from four
  wall caps, and nothing has judged it yet.
- **`FACE_CROWN_ROWS` is consulted per element, and an arena is `neutral`.** A tuck on the arena
  stops under a crown line 20% of the wall's height instead of fire's 21.3%, so the corner geometry
  the four 2026-08-19 reports converged on had never been evaluated at the fraction the arena
  actually draws with. It holds: 24 tucks, no hole opened, no crown crossed.

One number moved rather than broke: the worst block's shading geometry is **208 floats** on the
arena against level 1's 120, which is over `wallComposition.test.ts`'s own
`< AUTO_BATCH_VERTEX_LIMIT / 2` guard and well under Pixi's actual 400-float line. Join-span count
drives it, not width — the map's widest run (1760x32) costs 152.

## The arena's frame, measured on a GPU (2026-08-26)

The sections above count draw calls, and `perf/README.md` records four CPU numbers. None of them
said what the arena's frame actually *costs*, and the standing assumption in design/04's on-device
list was that a handset was needed to find out. It was not — it needed the right browser surface.
The in-app browser pane here is a software rasterizer (`Microsoft Basic Render Driver`, no
`EXT_disjoint_timer_query_webgl2`), which is where "no GPU timing on this machine" came from; real
Chrome on the same box is an Intel Arc Pro on D3D11 and supports it.

**`arena_launch`, 1920x855, resolution 1.0, camera at zoom 4.29, menus hidden: ~3.8-4.3 ms of GPU
time per frame, 36 draw calls, 20 program switches, 10 framebuffer binds.** Both controls fired —
an empty target costs 0.000 ms, and a 0.5/1.0/2.0 resolution sweep moves 3.20/4.31/5.93 ms with
non-overlapping bands — which is the only reason those are quotable. Method and full caveats live
in `client/src/perf/README.md`; the tooling is `client/src/perf/gpuTimer.ts`.

Two things follow, and both contradict what the draw-call work above would predict.

**The frame is not fill-bound.** *(Falsified 2026-08-26 — see the follow-up below: every filter in
this scene has `resolution: 1`, so a renderer-resolution sweep does not scale the fill inside them.)*
16x the pixels buys 1.85x the time: ~3.0 ms of the frame is
resolution-independent, ~0.7 ms is fill. So the render-quality tiers (2026-08-25), whose whole
mechanism is removing full-viewport passes and halving resolution, are aimed at about a fifth of
this scene's cost. They are still right for the PvE room they were measured on, where 11 filter
passes *were* the frame — this is a statement about the arena.

**The walls and pillars are a tenth of the frame; the floor is more than half.** Hiding one
render-group root at a time, against a 4.05 ms frame: `ground` 2.28 ms (56%), `shadow` 0.63 ms
(16%), `entities` — all 294 wall blocks and 124 pillars — 0.39 ms (10%). `ground` measured **flat**
across the full 16x pixel range (2.15/2.17/2.76 ms). *The share is right and the inference is not:*
cutting `ground`'s submitted triangles 17x later changed nothing, so it is neither fill nor
submission — see the follow-up below.

The mechanism is `buildGroundLayer` meeting a map far larger than the one its policy was tuned on.
It paints `drawRoomWash` + `drawFloorMottle` + `drawFloorDecals` **per room** into two
`staticGraphics()` Graphics, and `arena_launch` has 60 room rects over 4485x3462 px of floor, so
those two contexts are **284,966 and 265,566 floats** (1375 and 1343 fills). `staticGraphics.ts`
states the content its rule was measured against — *"a room's shared wall-shadow Graphics is ~24k
floats, the floor's decal pass ~50k"* — and on `ground`/`shadow` forcing `batch` bought -24 draw
calls for -0.08 ms there. Here the same two passes are 5.7x and 11x larger and are submitted whole
every frame regardless of where the camera is. The policy is not wrong; it is running an order of
magnitude outside its measurement. Fixing that is worth roughly **5x** what culling the walls and
pillars would buy, which is the opposite of where "294 blocks resident, no culling" pointed.

Not yet done, and deliberately so: this is one desktop GPU saying the arena is comfortable (~4 ms
of a 16.7 ms budget). It does not answer the on-device question, and the reason is now sharper
rather than vaguer — the dominant cost is geometry submission, which is the half that gets
relatively *worse* on a mobile GPU. *(That last clause did not survive the follow-up below. The
on-device question is still open, and now open for a reason nobody has named yet.)*

**And none of it needed a GPU to see, which is the part worth keeping.** The float counts come out
of the real `GraphicsContextSystem` headlessly - `staticGraphics.test.ts` had been driving it that
way since 2026-08-24 - so "is this pass inside the envelope its batch policy was measured on" was an
offline property the whole time, with no test asking it. `scene/groundGeometryBudget.test.ts` now
does: it sweeps `ARENA_CATALOG` against a per-Graphics budget anchored to `staticGraphics.ts`'s own
~50k measurement, exempts `arena_launch` through an explicit list, and **asserts that the exemption
still FAILS the budget** so the known defect is the gate's own control. It also pins the shipped
aggregates exactly (`ground` 284,966 / 265,566, `shadow` 49,392 - which reproduce the live browser
census byte-for-byte) off the REAL `RoomBuilder.build` rather than off a mirror of it.

Two things fell out of building that gate, both from judging every mutant twice - once against the
new file alone, once against the whole pre-existing scene/render/perf suite:

- **Deleting `drawFloorMottle` entirely survived every test in the suite.** So did a 6th mottle band,
  a doubled rubble density and a doubled stain density. The aggregate simply had no reader.
- **A 2% tolerance is the wrong shape here.** Removing `drawRoomWash` moves the second pass by 480
  floats - **0.18%** - which is the size of change a band is worst at seeing. The pins are exact
  instead: the pipeline is deterministic over fixed content, so a tolerance absorbs no noise and
  only hides drift. Changing the floor art means re-measuring in the same commit, the way
  `arenaWallCoverage.test.ts` already treats its 294/124/74 counts.

One thing the gate deliberately does NOT chase: `MOTTLE_PX_PER_BLOB` is **inert on this map**.
Halving it leaves `arena_launch` byte-identical, because all 60 rooms (82,944-286,720 px, median
143,360) round to the same count of 2 under either constant - the comment promises "~one blob per
510x510 of floor", and on the arena the mottle is a flat 2 blobs per polarity per room whatever the
room's size. Recorded as an asserted equivalence rather than pursued as a coverage hole.

One measurement rule came out of it, recorded because it inverts a result: **attribute by hiding a
render-group ROOT, never a child inside one.** Hiding the 322 floor sprites *inside* `layers.ground`
measured slower than leaving them visible (4.52 vs 4.14 ms) — the toggle invalidates the group and
the batcher repacks ~550k floats, costing more than the geometry removed. That is the same
invalidation hazard `staticGraphics.ts` documents, seen from the measuring end.

### Follow-up: the floor is cullable now, and the diagnosis above was wrong (2026-08-26)

The fix the section above nominates is done. `groundLayer.ts` mounts the ground as one piece per
room (per region, per door) instead of one `Graphics` per stage, each tagged with the rect it
actually paints, and `groundCulling.ts` switches the off-screen ones off once per frame from
`FxController.updateCamera`. The stage order is unchanged and so is the geometry: the two overlay
halves still sum to 284,966 and 265,566 floats, byte-for-byte the pre-split browser census.

Standing in the arena's first room the batcher packs **101,304 floats / 49,962 indices** instead of
**1,730,364 / 845,796** — 13 of 374 pieces, 17x less vertex data and 17x fewer triangles, ~6.5 MB
less in the batch buffer. **And the GPU frame did not measurably move**: interleaved A/B, cull on
against every piece forced visible, 13 samples each, 4.07 vs 4.28 ms with the min/max bands
overlapping. By the standard the measurement above set for itself, that is a null result.

Which is the finding. **The floor's ~2 ms is not vertex work, not triangle count, and not draw
calls** (the whole layer is 3 of the frame's 42). And the reasoning that pointed there was resting
on a control that measured the wrong thing: the "16x the pixels for 1.85x the time" sweep varies
`renderer.resolution`, but `layers.lit` (ground + shadow + entities), `layers.fx` and `layers.world`
all carry filters at Pixi's default `resolution: 1`, which does **not** follow the renderer's.
Almost the whole scene is drawn into targets pinned at 1x, so that sweep scales the final blit and
little else. "Resolution-independent" was a property of the filter chain.

So the arena's dominant cost is unattributed again, and it is a better-posed question than it was:
something about having a floor on screen costs 2 ms, and it is insensitive to how much floor. The
next sweep varies the on-screen AREA the blended overlays cover at a fixed resolution, and A/Bs the
`layers.lit` filter off — `perf/README.md`'s fifth measurement records both, plus two harness traps
(a `gl.finish()`-bounded wall clock reads 10x lower and fails its own resolution control; a
background tab's sample loop is clamped to ~1 s per sample).

The per-room split ships on its own merits rather than on a frame-time claim: it costs nothing
measurable, it cuts real memory, it removes the "one 285k-float `Graphics`" shape that
`staticGraphics.ts`'s batch policy was never measured at, and vertex throughput is exactly the half
that gets relatively worse on a phone. `groundGeometryBudget.test.ts` was rewritten around it — the
`arena_launch` exemption is gone (no piece is large any more), and the gate it leaves behind is the
one the old shape had no way to state: **what a single camera submits**, swept over every room of
every catalog map through the real `FxController.updateCamera` (worst 76,646 floats of 574,692, or
13%). Its control runs the other way — pull the camera back past the map and every piece must come
back, or a `groundPieceBounds` returning empty rects would pass everything.

### Both of those experiments came back no, and the floor is half spill (2026-08-27)

Ran. Neither hypothesis survived, and the third thing found on the way is the one with a fix behind
it. Full numbers, controls and traps in `perf/README.md`'s sixth measurement; the shape of it:

- **The `layers.lit` filter is not the amplifier.** Ground on/off costs 1.92 ms with the scene-light
  pass mounted and 1.80 ms with `lit.filters = []` — unchanged within noise. The filter itself is
  0.4 ms, which is 10% of the frame and is what the render-quality tiers are actually aimed at.
- **The cost is not the area it covers.** `layers.ground` is a render-group root, so scaling it
  about the screen origin shrinks its covered pixels with byte-identical submission. A quarter of
  the viewport costs *more* than the whole one (2.51 vs 1.71 ms); a sixteenth still costs 0.92.
  The same session's calibration — ten full-screen alpha quads, ~0.10 ms each, linear in area —
  proves the timer resolves area-proportional fill when it is there.
- So the elimination now reads: not vertex work, not triangle count, not draw calls, not the passes
  above it, not covered area. What is left is per-primitive fragment work on thousands of small
  blended primitives, whose triangle setup and 2x2-quad overshading do not shrink with the area
  they land on. Stated as what the elimination leaves, not as a measured mechanism.
- **What pays: 45% of the floor is rooms the camera is not in.** A mottle blob reaches 460 world px
  past its room — ~1970 screen px at zoom 4.29 — so `groundCulling.ts` correctly keeps four dark and
  four light halves on screen where one room is visible. The room you stand in paints 1.00 of the
  viewport per stage; its three neighbours paint 1.31 (dark) and 1.91 (light) more, all spill.
  Hiding just those six pieces: 4.07 to 3.32 ms. The stage split agrees from the other side — the
  additive light half is 1.03 ms and the dark half 0.68, while the region grid (0.05) and the room
  light pool (0.03) are free.

The fix that follows is a geometry clip on each room's dark/light `Graphics`, the same shape as
`arenaWallCoverage.test.ts`'s wall clip, with 0.75 ms as the number to beat.

A mutation battery over the cull's CALL CHAIN — `groundCulling.ts`, `groundLayer.ts`,
`FxController.ts`, 29 mutants, each judged twice (against the two test files the cull commit added,
and against the whole client suite with those two removed) — came back **26 killed, 3 controls
survived as designed, 1 real survivor**. 17 of the kills were NEW coverage, which is what the added
files bought. The survivor is the one that matters: moving `cullGroundLayer` back **below**
`syncCamera`'s `if (!activeQuality().sceneLight) return` — the exact shape this method had before
2026-08-26 — passed all 3,309 client tests. Correct code, connected, and read by nothing, in the
worst possible place: the low tier is the DEVICE tier, so a phone that drops to it would keep all
374 of `arena_launch`'s floor pieces resident, and the machine that most needs the cull was the only
one that would not get it. Closed by `FxController.test.ts`'s "still culls the ground on the low
tier", which carries the tier as its own control; replaying the mutant with it in place turns
exactly one test red out of 3,310.

A **second battery** then took the layer outside that file set — a battery's survivor count is only
ever scoped to the files it mutates. 20 mutants over what CONNECTS the floor and its cull
(`GameLoop.cameraFrame`, `layers.ts`, `RoomBuilder`, `floorRender.ts`, `roomLight.ts`,
`render/quality.ts`), 3 controls, **2 survivors**, and they are two different kinds of blind spot:

- **A duplicated rule, pinned in one copy and not the other.** `cameraFrame` and
  `groundLayer.roomRectsPx` both choose between the two co-resident room models with "dungeon
  first". `groundLayer.test.ts` pins its copy against a state holding both lists; reversing
  `cameraFrame`'s ternary passed all 3,310 tests. If they ever disagreed the camera would frame a
  room out of one model while the floor beneath it was painted from the other. (`EnvironmentSystem`
  makes it three selectors and it uses a *different* rule, `zoneEnabled` — worth knowing.)
  **Closed 2026-08-27, by deleting the duplication rather than adding a third pin:** all three now
  call `engine/state/roomModel.ts`, and the invariant the two rules could only disagree about — that
  `EngineConfig.dungeon` and `.arena` are alternatives, previously asserted only in their own doc
  comments — is enforced where it is decided (`GameState`'s constructor throws on a config carrying
  both). The two consumer tests above are what made that refactor safe: both passed unchanged, and
  they are still the only thing proving each call site READS the shared rule instead of re-inlining
  its own.
- **An aesthetic constant under a geometry-shaped suite.** `roomLight.ts`'s `EDGE_ALPHA` went 0.26
  to 0.9 — a near-black ring around every room — and nothing failed. Every existing test in that
  file pins the ramp's *geometry* (monotonic, non-overlapping, inside its own room, scaled to the
  short side); the band count is geometry and was covered, the alpha is a look decision and no
  geometry assertion can see one. The new bound is taken from the real `drawWallShadow` rather than
  transcribed — the pool must stay fainter than the base-hug crease it stacks with (0.24 vs 0.34),
  and the three darkenings composited must leave floor to see (0.71 against a 0.8 bound; 0.93 at
  the mutant's value) — so re-tuning the wall moves the gate instead of stranding it.

Each new test turns exactly one test red out of 3,312 when its mutant is replayed.

One method note that outranks all of the above, because everything measured before it was suspect:
**carry a twin control arm.** Two arms that apply no change at all, at opposite ends of the arm
order. A mid-session run had two identically-rendering arms read 3.556 and 5.985 ms while each
sample looked tight; a backgrounded tab degrades gradually over an hour and never says so. If the
twins disagree by more than ~0.1 ms the run is junk, and a `captureScreenshot` that times out is the
same tab saying the same thing.

### The clip that follows, and where a cut on a floor is allowed to land (2026-08-27)

`scene/floorClip.ts`. A room's blobs no longer paint outside the room, so a piece's cull rect is its
room instead of its room plus 460 px of spill, and the cull from the day before then drops a
neighbour's halves on its own — unchanged, still an exact intersection. **0.53-0.93 ms of a ~4.4 ms
arena frame** across three counterbalanced sessions, on-screen ground pieces 13 -> 7, 19.9% fewer
floats on the layer, and 66% less submitted by the worst camera. `perf/README.md`'s seventh
measurement has the arms and the three junk runs that preceded them.

The interesting half is not the millisecond, it is **where a cut on a floor may land**, because
truncating a smooth field leaves a step of the field's own local value and a straight step on a floor
is exactly what `floorRender`'s header rejected the per-tile tint for. A hard clip at the room rect
measures a **29.98 luma** step across a doorway (median 7.24) on a floor whose base luma is 25.9 —
measured before the shape was chosen, not feared afterwards. Two facts about the shipped content
decided the design instead, both swept rather than assumed:

- **A room rect includes its own perimeter wall, exactly one grid cell deep.** Sampled 2 / 16 / 30 px
  inside every room edge of `arena_launch` and all five PvE floors: **100% wall footprint or authored
  passage, 0% bare floor**; at 34 px in it is floor. So `CLIP_FEATHER_PX` is `PX_PER_GRID` because
  that is the depth of stone a room rect contains, and any cut inside it is invisible.
- **The passages are the exception and they are 8-17% of that band.** A doorway is floor on both
  sides, so no depth of clip is hidden there.

So the clip RAMPS: each of a blob's five nested bands is clipped at its own inset, faintest at the
room's edge and strongest a full cell in, with a hashed sub-band offset per blob so two blobs never
cut on the same line. The largest step any single cut can then make is ONE band's alpha — the step
that band's own rim already makes in the shipped art — which is the bound `floorClipCoverage.test.ts`
gates against, derived from the mottle rather than transcribed (re-tuning `MOTTLE_LIGHT_ALPHA` moves
the gate). Measured with the ramp: **2.59 luma** worst, 0.48 median, against a 4.90 bound. Rubble is
the one class dropped rather than cut — a 2-4 px speck at alpha 0.46/0.13 has nothing to ramp over.

And in a live frame, over all 74 passage floors, the clipped doorway is **smoother** than the
unclipped one: worst per-pixel step 36.16 -> 18.51, median 24.23 -> 14.65. What used to be roughest
there was a neighbouring room's rubble speck painted 400 px from home. The 14-18 luma that remains is
the floor swatch's own texel variation.

**And it was finally LOOKED at, 2026-08-27.** Every number above is a luma measurement taken through
`extract.pixels`, because the tab that could have shown a picture never composited — the clip shipped
without a frame behind it, which this repo's own rules say is not finished. Frames now exist: the
floor reads continuous standing in a doorway (including across two DISTRICT seams, where the two
floors are treated differently and a clip edge would show first), and continuous across all 60 rooms
in a single whole-map frame. The measurement was right. See ROADMAP's "The camera list, answered" for
the frames, for the four other verdicts it collected, and for the harness note that matters more than
any of them: a backgrounded Chrome tab gets FROZEN, which leaves synchronous JS working perfectly
while every `await` hangs and `drawImage(app.canvas)` silently returns the last presented frame.

Two mutation batteries, each judging every mutant twice — against the new test file alone and against
the pre-existing suite with that file parked. The first (26 mutants over the call chain:
`floorClip.ts`, `floorRender.ts`, `groundLayer.ts`, `groundCulling.ts`, `RoomBuilder.ts`) came back
21 killed / 2 survivors. The sweeps were then widened from `arena_launch` to all six shipped maps,
which found that the doorway bound had been measured on one of them — PvE floor 2 reads 3.04 luma
against a JND of 3, so the gate is the derived one-band bound (4.90) and the JND claim is
distributional. The second battery (17 mutants over what the clip DEPENDS on: `floorPartition.ts`,
`roomLight.ts`, `render/staticGraphics.ts`, plus the cull's comparison) came back 16 killed / 1
survivor — a confirmed equivalence. See ROADMAP for all four findings, including the one that was a
bug in the test rather than in the code.

## The void gets a face (2026-08-27)

The one finding the camera list left open: `arena_launch`'s twelve deliberately-empty grid cells
read from the room next door as **a hard-edged flat black rectangle with no rim, no depth cue and
no far side** — about a fifth of a 16:9 frame. It was recorded as an art call ("give the void's
vertical edges the same treatment as the map's outer boundary, author a pit rim, or accept it"),
with the note that the map's outer silhouette has the same property, so *"fix the twelve"* was not
obviously the right scope.

It was not the right scope. **The defect is one rule, and it belongs to the projection.**
`screen.y = gy - z` has no horizontal component, so a block's east and west sides project to
exactly zero width — the art simply stops at the footprint's edge. Where the next thing along is
another room's floor or more stone, that is correct: the neighbour carries the picture on. Where it
is the void, the stone does not end, it is **cut off**. A void to the SOUTH never reads that way,
because a whole wall height of lit FACE stands between the floor and it. The twelve cells and the
map's outer boundary are the same rule answered at two places, and so is every PvE floor's own
silhouette.

Measured, on a live frame beside empty slot r1c5 (scene-light filter detached, so what is being
read is geometry rather than the light pass darkening the rooms beyond):

| | luma across the boundary, west → east |
|---|---|
| Before | 87 (cap) … 53 → 26 → **6** in three pixels |
| After | 87 (cap) … 53 → 26 (silhouette) → **83** (arris) → 44 → 2 over 30 |

### The rule, and why it is spans and not a boolean

`scene/wallVoidEdge.ts` answers *which parts of a block's east/west sides face nothing at all*,
against what the ground layer actually PAINTS (`floorRegionsPx`, not the room rects — the two
diverge in the fallback case, where a mode with no usable room model paints the whole world box and
therefore has no interior void for a return to face) plus every wall run on the floor. It reports
**spans in footprint-local y**, not two booleans, because a run's side is routinely part void and
part neighbour: `arena_launch`'s east-west runs meet the empty slots END-ON — 32 px of a 64 px side
— and that end head is exactly the shape the finding was about. A boolean would either paint over
the neighbour or drop the case.

Each span also carries the **gap**: how much empty world px is out there, `Infinity` at the map's
own edge. That is the bound on how far a return may reach, because the wall on the far side of the
same void is drawing its own return inward and the two may at most meet. It is not hypothetical
headroom — `ember_l1` floor 2's narrowest void is 32 px, exactly twice `VOID_RETURN_PX`, so shipped
content sits ON the limit with none to spare and the next authored room could cross it silently.
The renderer clamps to `gap / 2`; both sweeps assert both halves (nothing shipped forces the clamp,
and floor 2's margin is exactly zero).

### The return, and why it is the CAP's swatch

`scene/wallVoidReturn.ts` carries the cap's own swatch 16 px past the footprint, **in the same
world-space tiling**, tinted for a vertical surface and ramped out to the backdrop. The tiling is
most of what sells it: the mortar runs straight on over the arris instead of restarting, so it
reads as a solid turning a corner rather than as a stripe painted beside one. The face swatch would
have been the wrong choice — it is an elevation, and its rows are a lit coping over a dark base, a
vertical order that means nothing on a surface seen edge-on.

Three numbers, each argued from a surface that already exists rather than tuned to taste:

- **16 px** — half a grid cell, one course of the cap swatch, 32 screen px at play zoom. Narrower
  and the ramp has nowhere to fall (the cap's existing dark bevel is 5 px and reads as part of the
  void); wider and the wall grows a buttress, which invented mass must not do.
- **The tints** are the key light's own direction. A cap facing straight up takes the swatch
  unmodified and a vertical surface takes `FACE_TINT` (0.78), so a WEST return — turned toward the
  upper-left key — sits between them (0.83) and an EAST return — turned away — sits below both
  (0.42).
- **The falloff is squared**, not linear (`render/shadeRamp.powerRamp`, new). A linear fade across
  16 px is already half gone at its midpoint, which leaves a bright line with a smudge beside it; a
  squared one holds ~75 % to the midpoint and then plunges, which is what a lit face turning into
  shadow does. Measured luma at the midpoint: 20 linear against 32 squared.

Only the EAST side draws a lit **arris**. The west already has `addBlockEdge`'s coping stroke and
`drawSideBands`' chamfer along exactly that line — cues that used to say *"I end here"* and, with a
return outside them, become the fold's own highlight without changing a pixel. The east had only
the dark silhouette, which against a luma-6 backdrop is not an edge at all.

The return is added LAST in `buildWallBlock`, after `addBlockEdge`: it sits outside the footprint,
so it is the block's outermost surface and its arris belongs on top of the dark silhouette rather
than under it. It is tagged with the CAP's x-ray group, not with the silhouette's — a block the
occlusion x-ray is fading has to fade whole, and a solid return beside a dissolved cap reads as a
second object standing there.

### What it fires on

| | runs with a free east side | free west side | spans | of those, partial (end-on) | narrowest gap |
|---|---|---|---|---|---|
| `arena_launch` | 42 | 41 | 83 | 13 | 288 px |
| `ember_l1` floors 0-4 | 8 / 15 / 17 / 11 / 8 | 7 / 14 / 14 / 9 / 5 | 108 | 5 | **32 px** (floor 2) |

So it was never twelve cells: it is 83 free sides on the arena and 108 across the five PvE floors,
and every one of them is the same rule. Not an `interior`-tier block among them, which is the check
that says the scoping is right — an interior block is surrounded by its own room's floor and can
never have a free side.

### Why NORTH is not in this, and how that was checked rather than assumed

A block's north side faces the void just as often (11 runs on `arena_launch`, mostly the map's own
top edge). It is deliberately left alone, for two reasons, and the second is the one that settles
it:

1. There is already art between the floor and that void. A block's cap is drawn one full wall
   height NORTH of its own footprint and its north edge carries a lit coping (`addBlockEdge`'s
   `openNorth`), so the eye gets a stone top ending at a rim — the same thing the south side gets
   from its face, and the reason neither direction was in the report.
2. **The camera cannot get there.** `GameLoop.cameraFrame` grows the framed room upward by exactly
   `MAX_WALL_HEIGHT`, which is the same distance the block's art reaches, so a player standing hard
   against their room's north wall sees that wall's cap filling the top of the frame and nothing
   beyond it. Checked, not reasoned: `foundry_r4c0` at its own north edge (the widest room with an
   empty slot directly above it, so the lowest zoom and the most overscan available) puts the top
   of the viewport at world y 1414 against an art top of 1400 — 14 px, and the frame shows
   unbroken brick.

Which is the honest shape of the rule: **east and west are the directions where this projection
lets you look past a wall into nothing.** If the camera frame ever grows upward by more than a wall
height, (2) stops holding and the north side needs the same treatment — the predicate already has
the shape for it.

### What it costs

`voidEdges` runs once per block at room-build time, against the floor regions and every other run —
0.64 ms for all 294 of `arena_launch`'s blocks, next to `floorPartition`'s 3 ms in the same phase.
Per frame it costs geometry rather than draw calls: a free side adds one `TilingSprite` sampling the
SAME lit cap texture every other block's cap already samples, plus one `Graphics` of a quad and a
line. `arenaWallCoverage.test.ts` gates both halves of that — every return's Graphics under a
quarter of Pixi's auto-batch line, and **one** shared ramp bake for all 83 of them, which is the
part that would quietly break if the falloff's shape ever varied per block.

Nothing here is gated on the quality tier, and that is the existing rule rather than an omission:
`render/quality.ts`'s low tier turns off everything that costs a render-target PASS (scene light,
screen fx, bloom, actor shaders) and leaves scene-graph geometry alone — the same treatment every
other wall cue gets.

## A pillar is a sprite now (2026-08-20)

The last item on the scene queue: *"pillars read as smooth cans next to the walls"* — their cap was
a hand-toned gradient where a wall cap is a real swatch under an additive key light, and their shaft
a mathematically perfect colour ramp with seven fixed mottle blobs on it. Closed by generating art
for the object itself (`art/biome/prompts.md`'s "Pillar SPRITE" section has the prompt, the rejects
and the two import steps) and drawing it with `pillarRender.buildPillarSprite`. `buildPillarBody`
stays as the fallback for a missing texture, the same contract every other biome swatch has.

- **One file, every biome.** A pillar is a fixed-size object — `radius: 1` in every shipped room,
  drawn 84x98 — so unlike the walls it needs no tileable swatch, and unlike the walls it does not
  need one file per element: `pillarTint(palette)` mixes `PILLAR_BIOME_MIX` of the biome's wall
  colour into WHITE and multiplies, which is where the hand-toned body already got its biome hue.
  `getPillarTexture` still resolves `pillar_<element>` first, so a per-element file remains a
  file-drop away.
- **Scaled by WIDTH; the art's aspect sets how tall a pillar stands.** Width is the axis the
  footprint has to agree with, so `pillarSpriteMetrics` fits the sprite to `bodyW + 2 x overhang`
  and lets `tex.height / tex.width` decide the rest. That leaves one thing to the file: `WALL_HEIGHT`
  is what every standing thing in a room agrees on, and the shipped art's 0.849 aspect happens to
  land within 4 px of the hand-toned cylinder's own top. Both `pillarRender.test.ts` and
  `pillarArt.test.ts` assert that bound rather than trust it.
- **The occluder box is measured off the sprite, not off the ellipse maths.** The x-ray reads
  `pillarArtExtent`, and the two bodies draw different shapes: an extent describing the other one
  would fade a pillar for a character it does not cover, or leave one solid over a character it
  does. With a texture the extent is `halfW = w/2`, `top = PILLAR_BASE_PX - h` — the sprite's own
  box, bottom-anchored at the ground point.
- **Mipmaps at load time, and no `repeat`.** A 326 px source drawn at 84 px is a ~4:1 minification
  when the camera sits at zoom 1, which is the exact shape of the 2026-08-12 rig-art bug (bilinear
  filtering with no mip chain reads a 2x2 texel neighbourhood and returns colour noise). The sprite
  key in `render/biomeTiles.ts` therefore loads with `data: { autoGenerateMipmaps: true }` —
  confirmed live, `mipLevelCount` 9 after upload — and skips the `addressMode: 'repeat'` every
  tiling swatch gets, which on a lone object would sample the far side of its own silhouette.
- **Nothing the art carries is drawn twice.** The closed top ellipse, the three shading bands, the
  curved course joints and the silhouette are all in the file; the sprite body adds only the base
  contact crease, because the art measures the same value at its foot as up its shaft (58 vs 59) and
  the crease is the only thing grounding it. The hand-toned body's mottle table and white coping
  stroke are deliberately absent from the textured path.

**Measured, in a live frame** (`renderer.extract` over the real level 1 gallery room at zoom 1, UI
and actors hidden, sample rects derived from the sprite's own `getBounds()`):

| surface | hand-toned | first accepted file | shipped |
|---|---|---|---|
| top | ~92 | 87.3 | **87.3** |
| lit limb | ~73 | 71.6 | **50.4** |
| mid band | ~62 | 52.4 | **35.8** |
| dark limb | ~19 | 25.1 | **16.7** |
| foot | — | 36.7 | **25.0** |
| in the same frame | | wall caps 72-81, wall faces 27.3-27.5, floor 48.5 | |

The middle column is why `tools/png-pipeline/lumaCurve.mjs` exists. **A generated sprite can be
right on one surface and wrong on another, and a uniform multiply cannot fix that**: the file's top
surface already landed on design/01's target while its shaft ran at roughly twice the wall face
beside it — the same stone, the same key light, one of them reading as a different material. A
luma-keyed curve (`--lo=85 --hi=95 --lo-gain=0.68 --hi-gain=1`) leaves the top alone and pulls the
shaft down, which is the same fold between a bright top and a much darker face that `wallTone.ts`
already builds for the walls, applied once offline instead of as a per-object filter.

## Depth sorting (Y-sort)

- The entity layer sets `sortableChildren = true`; each frame we set `entity.zIndex = entity.gy`.
- Lower on screen (larger gy) draws later → occludes objects above it. A character walking behind a pillar is hidden; in front, it hides the pillar.
- **Hidden, but never LOST**: since 2026-08-20 any standing block that is drawing over the local player OR a live enemy x-rays out of the way (see "The occlusion x-ray" above). The sort itself is unchanged — the character really is behind the stone, and the stone is what goes translucent.

## Shadows

- A soft shadow is drawn from the **ground coordinates** (`shadow.gy = gy`), so it stays on the floor no matter how high the body is.
- It shrinks, fades, **and slides away from the fixed upper-left key light** as the lift grows → reinforces the sense of height. This is the cheapest "3D cheat". `Entity.SHADOW_SLANT_X/Y` are the one place the slant is defined; actors, bullets, pillars and walls all use them, so nothing in a room disagrees about where the light is.
- Static tall objects (pillars) are drawn *upward* from a grounded origin rather than lifted by the transform, so their `z` is 0 and the displacement has to be supplied by hand (`Entity.shadowOffsetX/Y`).
- See "Grounding the character" above for the shape of the shadow itself (nested ellipses, not one disc) and for the 0.62 foreshortening every round thing lying on the GROUND PLANE shares — and for why the shield, which wraps the body rather than lying under it, is deliberately not among them.
- **Its radius comes from the DRAWN body, not from a collision radius** (`Skin.bodyDrawnR`, 2026-08-19) — see "Volume, measured" for why a number sized off the rig's declared radius made an enemy's shadow ~45% wider than the enemy.

## Layers (bottom to top)

| Layer | Contents | Sorting |
|-------|----------|---------|
| ground | floor (stamped per room), its wash/mottle/wear decals, the 64 px grid, the per-room light pool | fixed |
| shadow | all cast shadows | fixed (below entities) |
| entities | characters / enemies / pillars / bullets / **standing wall blocks + door fixtures** | **Y-sort (zIndex = gy)** |
| fx | muzzle flashes, explosions, deflect flashes, per-element bullet trails (additive blend) | overlay |
| ui | HP, weapon, crosshair — split into `hudOverlay` then `menu`, see below | topmost |

> **`ui` is two sub-layers, and only the upper one is scaled (2026-08-25).** `hudOverlay` holds the
> in-run HUD, the touch controls and the minimap; `menu` holds every full-screen screen plus the forge's
> floating SETTINGS button, and paints over `hudOverlay` (which is why a pause menu is legible mid-run).
> `menu` is a `MenuLayer` (`game/ui/menuLayer.ts`): it carries a fit-scale, `min(1, w/760, h/640)`, so a
> viewport shorter than the menus' design space shrinks the whole layer instead of each screen re-flowing
> — a WeChat landscape phone is 390 logical px tall, about half what these screens are laid out for.
> Capped at 1, so it is the identity transform on any desktop viewport. `hudOverlay` is deliberately
> outside it: a thumbstick should be thumb-sized on a phone, not shrunk with the menus. Before the split
> these were bare siblings in `ui` whose order came from *when* `Game` happened to add each one, which is
> also how the SETTINGS button ended up under the forge's own backdrop, invisible at every viewport.
> See design/04-wechat.md's **Viewport** section.

> **Lighting (2026-08-24): shipped, as one screen-space pass rather than a composited lightmap layer.**
> `ground`, `shadow` and `entities` are grouped under a `lit` container (`scene/layers.ts`) that carries a
> single `SceneLightFilter` (`fx/filters/litFx.ts`); `fx` and `hud` stay outside it — a muzzle flash IS
> light, and a floating health bar is a readout, not a surface. The pass derives a per-pixel fake normal
> from the composited layer's own luminance, applies the fixed key light, and then adds every live point
> light with real per-texel direction and falloff, so a flash lights the floor it goes off on. It replaced
> a `NormalLitFilter` attached to EVERY actor, which cost one render-target pass per character and broke
> the sprite batch — measured at render p50 10.4ms of a 16.7ms frame; the one pass is 2.4ms.
> The older cheap static half — a per-room falloff painted on `ground` (`scene/roomLight.ts`) — landed
> 2026-08-19 and is unchanged.

> **Draw calls (2026-08-24, the same day's follow-up): 165 -> 108, program switches 102 -> 98, and the
> render group is no longer thrown away every frame.** The filter pass above cut render p50 to 2.4ms but
> barely touched the batcher — 157 draw calls for a scene of 893 nodes. `perf/drawAttribution.ts` (new,
> and `window.__perf.attribute` / `.census` from a `?perf=1` console) attributed them: **wall blocks 79 of
> 165**, actors 22, the `shadow` layer 22, doors 14, ground 5. Two causes, both structural, both fixed
> without touching the Y-sorted `entities` layer that every occlusion cue depends on:
>
> 1. **The cap's additive key light was a second copy of the cap sprite** (`wallTone.CAP_BOOST_*`, which
>    exists because a Pixi tint cannot multiply *up*). A blend-mode change breaks the sprite batch, so
>    each of the 27 wall runs plus 4 doors cost a draw call for itself and two more for the halves of the
>    batch it split. The lift is a function of the swatch alone — the cap is opaque, so the destination
>    the additive copy reads is exactly the cap drawn before it — so it is now pre-multiplied into the
>    texture once (`scene/capLight.ts`) and the cap is one ordinary sprite. **-29 draw calls, -31 nodes**,
>    and verified by frame read-back rather than by eye: rebuilding the two-layer form in the live scene
>    and diffing the composited frame gives **0 of 1,641,600 pixels different**. All four `wall_*.png`
>    swatches are fully opaque (minimum alpha 255), which is the assumption that makes the identity exact;
>    the brightest pixels clamp (ice: 1.8% of blue) at the same point the additive blend clamped them.
> 2. **Pixi v8 only auto-batches a `Graphics` under 400 floats of geometry**
>    (`GraphicsContextSystem.updateGpuContext`), and nothing this project hand-bands comes close — the
>    room's shared wall shadow is ~24k floats, the floor's decal pass ~50k, one actor shadow ~830. Each was
>    a draw call plus, between sprites, a program switch each way. `render/staticGraphics.ts` forces
>    `batchMode: 'batch'` for authored-once geometry — but only on `ground` and `shadow`, which
>    `scene/layers.ts` now gives their **own render groups**. That second half is what makes the first
>    affordable: writing any descendant's `zIndex` invalidates the whole enclosing render group
>    (`sortMixin.depthOfChildModified`), and `entities` writes one per actor per frame, so before the split
>    the floor, the ground shadows, the health bars and the UI were all re-collected 60 times a second
>    (168 Graphics re-added per frame, 54 of them unchanged since the room loaded). **-24 draw calls**, and
>    render collection 0.60 -> 0.52ms. Also pixel-identical (0 of 1,641,600) against both halves reverted.
>    Caveat, measured and kept: `shadow` is static only in that it never resorts — bullets and actors add
>    and remove a shadow on it, which does invalidate the group, so under sustained fire its batched
>    geometry repacks most frames at about **+0.12 ms**. Shipped on the balance against -22 draws there
>    and -0.08 ms the rest of the time, not because it is free.
>
> **Rejected, with the measurement**: forcing the same batch mode on the wall shading inside `entities`.
> It is the single biggest remaining item — 50 draw calls and 50 program switches for 27 objects — and
> batching it works, but that group *is* invalidated every frame, so the batcher repacks ~18k floats and
> 2247 fills per frame. Measured **+0.7ms on a 2.4ms render** for -50 draws. Not shipped; the draw-call
> count is not the thing being optimised, the frame is.
>
> **What that leaves, and the two ways out** *(both resolved the same day — see the third pass below;
> route 1 shipped, in a form that needed no canvas, and route 2 stayed rejected)*. ~90 of the 98 program
> switches and 90 of the 108 draw calls
> are Graphics inside `entities` (wall shading 50, actor rig shading 22, doors 10) — all of them static
> geometry that is only unbatched because it is too big. Bringing the wall shading under the 400-float
> line was probed live by swapping in a smaller geometry: the frame goes to **52 draws / 43 programs**.
> Two routes there, in preference order:
> - **Replace the hand-banded ramps with `FillGradient`.** `wallShadingSurfaces.ts` draws every ramp as
>   `CAP_GRADIENT_BANDS`/`SIDE_STEPS`/`BASE_AO_BANDS` separate rects at stepped alphas — 65-102 fills per
>   block. A gradient fill is one quad, so the shading would drop under the auto-batch line *and* pack
>   far cheaper than today's unbatched path. It would also be **smoother**, which is the direction the
>   band counts were already being pushed (see `CAST_PASSES`: "at two alphas you see both of them"). Not
>   pixel-identical, so it needs a look before it ships.
> - **Bake each block's shading to a texture at room build.** Removes the per-frame cost entirely, but the
>   camera zooms, so a 1x bake would soften the one surface that has had six rounds of tuning, and it costs
>   ~27 render textures per room. Rejected for now on both counts.
>
> The pass order flagged during the filter work is unchanged and still correct: `SceneLightFilter` shades
> the composite *after* an actor's own overlays (shield glow, hit outline, dissolve). Nothing here moved a
> layer or a filter, and the byte-exact frame diffs above are what proves it rather than inspection.

> **Draw calls, third pass (2026-08-24, same day again): 102 -> 27, program switches 93 -> 17.** The two
> routes the note above left open were the two candidates, and both came out the same way — not by
> overriding Pixi's batching rule but by making the geometry small enough not to trip it. One new module
> does both: `render/shadeRamp.ts`, which builds a shading gradient as a **sampled texture** instead of a
> stack of hand-stepped rects.
>
> The mechanism, because the obvious tool does not work here. `FillGradient` — the route this doc named
> first — calls `DOMAdapter.createCanvas()` at `fill()` time and throws `ReferenceError: document is not
> defined` in this repo's canvas-free test environment, which is where the wall and rig shading are
> machine-checked; `rigShading.ts` has carried a note ruling it out on those grounds since 2026-08-19,
> and that note was right. A `BufferImageSource` needs no canvas. So a ramp is a 256-texel RGBA texture
> painted from a profile function and cached by key, and a cue is one quad sampling it. Two consequences
> worth stating separately from the draw calls:
> - It is **testable**, where a gradient fill would not have been. `readRampFill` inverts the fill's
>   matrix back to the ramp's own segment and `rampProfile` reads its texels, so a test asserts *where a
>   cue starts and ends and what shape its falloff is* — strictly more than the old band comparison,
>   which could only ever see band centres.
> - The ramps are anchored to an explicit **segment** in local space, not to the filled shape's bounds.
>   Half of this project's cues are drawn on a rect that `clampSpan` has already narrowed
>   (`wallShadingJoins.drawCornerAO`), and a ramp bound to the shape would *compress* the whole falloff
>   into whatever slice survived instead of truncating it.
>
> 1. **Wall/door block shading: 50 draw calls and 50 program switches -> 0.** Every ramp in
>    `wallShadingSurfaces.ts` / `wallShadingJoins.ts` is one quad. A block's shading went from 65-116
>    fills and 520-2010 floats to 8-15 fills and ~150 floats — under the 400-float line with two orders
>    of magnitude of room, so all 27 wall runs and 4 doors now batch with the cap and face sprites beside
>    them. Across the room: 2294 fills -> 316.
>    Not pixel-identical, and measured rather than asserted: rebuilding the stepped form in the live scene
>    and diffing the composited 1920x855 frame gives **max 11/255 on 7.0% of pixels, mean 1.62, and 86% of
>    the changed pixels within 2/255** (old-vs-old reproduces at 0 difference, which is what makes the
>    number trustworthy). That is the signature of replacing a step function with its continuous form: the
>    deviation is bounded by half a band step, and the analytic bound for the coarsest ramp on a lit cap
>    (`CAP_EDGE_*`, 5 steps at alpha 0.5) is 13-17/255 — two independent methods agreeing.
>    It is also **visibly better**, which is the point the band counts were already being pushed toward.
>    At a 6x crop the west chamfer's 5 steps are countable as vertical stripes in the old form and gone in
>    the new one; `SIDE_STEPS`' own doc had recorded the same defect ("five hard horizontal stripes") for
>    the coping correction. The per-surface band counts are therefore deleted, not retuned — `RAMP_TEXELS`
>    puts the worst step below 1/255 for every profile at once. `wallTone.ts` keeps the *reasoning* as a
>    comment, since it is the reasoning a future ramp needs.
> 2. **Rig sphere shading: 20 draw calls and 20 program switches -> 3 and 2, and it stops scaling with the
>    enemy count.** `rigShading.drawSphereShading` was 40 chord bands plus 3 ellipses per rig instance —
>    55 fills, 710 floats, one draw call and two program switches per actor on screen, at 8 live enemies
>    where a level-1 room holds 15-30. It is now one quad sampling `sphereShadeField()`, a 256x256 field
>    **normalised by radius**, so it is one bake for the whole game rather than one per (skin, radius) —
>    no renderer needed, and it works in a test. It is still a `Graphics` and not a `Sprite` because
>    `RigSkin` counter-flips it with `scale.x = flipX`, which mirrors a quad's local geometry but would
>    throw away a Sprite's size.
>    The frame diff here is larger and the reason is a **defect in the form it replaced**, found by
>    looking at where the deltas were: every pixel differing by more than 20/255 sat at 0.8-1.0 of the
>    body radius and at one of the two poles of the light axis (537 lit, 474 dark, 38 elsewhere). A chord
>    band took its half-width from whichever edge was *further* from the centre — provably inside the
>    circle, and increasingly conservative toward a pole, where the chord shrinks fastest. The two
>    outermost bands of 40 had a half-width of **exactly zero**: 3.6% of every body circle, in two
>    crescents at the poles, was never painted. That is where the warm wash peaks and where the
>    reflected-light sliver traces the silhouette — the two marks whose whole job is the rim.
>    `rigShading.test.ts` now pins that the shading reaches the rim at both poles.
>
> **Two flaws the tests caught in the new code**, both worth recording because neither is visible by
> inspection: a zero-length ramp segment makes `rampFill`'s matrix singular, and Pixi *inverts*
> `style.matrix` at geometry-build time, so it would have filled with non-finite values and taken every
> other fill in that Graphics down with it (reachable from any cue whose surface collapses); and the
> silhouette feather was originally applied on top of a masked `sphereShadeAt`, which cut the antialias
> off at its own midpoint and made the containment test pass for the wrong reason — there was nothing
> outside the circle left to contain. A 35-mutant battery over both files' constants and ramp directions
> ends at **35 killed, 0 survived**; the first run had 6 survivors, of which 3 were reversible ramp
> directions in the wall shading (a one-character edit that leaves fill count, colours, alphas and covered
> rect all identical) and are now asserted.
>
> **The batching claim is an invariant over shipped content, not a number in this note.**
> `wallComposition.test.ts` runs every wall of all five shipped level-1 floors — **173 blocks** — through
> the real `GraphicsContextSystem` and requires each to come back batchable; the worst is **120 floats
> over 15 fills** (p50 112), against 520-2010 before. Two things that took a second attempt to gate
> properly. A float *budget* does not hold the rule: reverting one cue to five stepped rects costs +32
> floats and survived a headroom bound loose enough to allow a future cue, so the rule is asserted
> structurally instead — every fill in a block's shading is a ramp fill (texture + matrix), and the only
> non-fill is the cap/face fold, which is genuinely one hard line. And texture SHARING had no guard at
> all: batchable blocks only land in one batch if they sample the same few textures, so a profile that
> varied with geometry would split the batch with every other assertion green. Pinned at 3 shared
> profiles across every wall in the game.
>
> One more gap the mechanism change opened without any test noticing: `RigSkin`'s counter-flip was
> asserted as `view.scale.x * shade.scale.x === 1`, which was sufficient while the marks WERE the
> geometry. With the marks in a texture, a cancelled transform no longer implies a cancelled look — the
> field mirrors with the quad only because it is sampled in local space, and mirrors *in place* only
> because the quad is centred. Now asserted end to end (same world rect whichever way the body faces),
> and confirmed by a mutant that de-centres the quad.
>
> (Measured before and after at one fixed point — room built, nothing fired, 27 wall runs and 9 actors,
> 52 children on `entities` both times, `git stash` between the two reads. The per-group deltas below are
> identical in every reading taken this session; only the frame TOTAL moves with how many doors and
> pickups are on screen, which is why the note above records 108 for the same scenario.)
>
> **What is left, and it is no longer wall shading.** 27 draws / 17 programs, with 9 unbatched Graphics:
> a door's recess/glow/sill (2010 and 1434 floats, 10 fills each — stroke-heavy, not banded, so the ramp
> treatment does not apply), the player's tether Graphics (912 floats), and four 496-float objects — which
> were the four PILLAR CREASES in that room, converted 2026-08-26 (see below); on a PvE floor there are
> four of them and on the PvP arena there are 124. None
> of it costs frame time today (render p50 ~2.1ms of a 16.7ms budget); it is headroom for a low-end mobile
> GPU where a program switch is far more expensive than it is here.
>
> **One divergence created on purpose**: `pillarRender` still steps its own copy of the base contact
> crease at `BASE_AO_BANDS` = 12, while the wall's samples a ramp. The two agree to within one band step
> (0.3/12 = 0.025 alpha, which `FACE_COPING_BANDS`' doc calls borderline rather than safe), and converting
> it is not a one-liner — that crease is a `roundRect` whose last band also skirts `PILLAR_BASE_PX` below
> the floor line at a held alpha, so it is two shapes under a ramp, not one. Pillars were not costing a
> draw call, so it is recorded rather than rushed.
>
> **Closed 2026-08-26, and the premise it was parked on was the thing that was wrong.** "Pillars were
> not costing a draw call" was measured on a level-1 PvE floor, which has a handful of them. The PvP
> launch arena has **124**, and they were **245 of that frame's 278 draw calls** — the single most
> expensive object class in the map, while its 294 wall blocks cost 2. Everything else in the note held
> exactly: it is two shapes under a ramp, not one, and for the reason predicted. `rampFill` only
> guarantees no wrapping while the filled shape is a SUBSET of its own ramp segment, so one `roundRect`
> over the whole crease under a ramp anchored at the ground line would sample past the last texel and
> `repeat`-wrap to alpha 0 — a crease that fades out exactly at the foot. Shipped as a plain rect under
> the wall's own `linearRamp()` plus a held `roundRect` skirt, which also keeps the TEXTURE shared with
> every wall face (the alternative, a rises-then-holds baked field, is one fill but keys a bake per
> distinct pillar height and shares nothing). Measured on one commit, same scene, swapping one file:
> **262 draws / 254 programs → 14 / 6**, unbatched `Graphics` in the scene **124 → 0**, the crease
> itself **496 floats / 12 fills → 78 / 2**. `BASE_AO_BANDS` is gone; nothing in this renderer
> hand-steps a gradient any more.
>
> The look is unchanged, and that is provable rather than eyeballed: a stepped ramp fills band *i* at
> its CENTRE value, so a linear ramp over the same span passes exactly through every band's value at
> that band's midpoint and can differ only inside a band — **worst case half a step, 0.01279 alpha
> (3.26/255)**, pinned in `pillarRender.test.ts` along with the skirt's matching half-step. Worth
> stating because no frame diff was obtainable: every canvas reader tried failed its own control (see
> the measurement note below, which now has three more entries).
>
> **Measurement note, since it cost two rounds.** `gl.readPixels` on this canvas returns a stale frame:
> the context is created with `antialias: true` and `preserveDrawingBuffer: false`, so the resolved
> default framebuffer only updates when the page composites — which never happens in a hidden tab, so a
> deliberate "hide everything and re-read" check reported *zero* difference. `renderer.extract.pixels`
> works but has its own trap: the scene's light and post filters are screen-space, so extracting a custom
> frame lights only the region matching the real on-screen position and 25 of 27 wall blocks come back
> pure black (mean luma 0), i.e. a dark overlay on them is a genuine no-op. What is reliable is
> `renderer.render(stage)` followed immediately by `drawImage(app.canvas, …)` into a 2-D canvas, in the
> same task — and then verifying the harness by restoring the original form and requiring the third read
> to match the first exactly. Every number above comes from that, with the restore check at 0.
>
> **Amended 2026-08-26: "in the same task" is exactly what does NOT work, and it fails silently.** The
> pillar-crease pass could not obtain a frame diff at all, and each attempt looked like a different bug:
>
> 1. `render()` + `drawImage(app.canvas)` three times inside ONE evaluation returns the SAME stale
>    composite for all three. The resolved framebuffer updates on a page COMPOSITE, and a synchronous
>    task never yields to the compositor — so the technique above is only sound when its three reads are
>    in three separate tasks. Symptom: blanking the entire world layer "changed" 0 pixels, while a
>    signature stored in a previous evaluation differed by 99%.
> 2. `perf/frameProbe.ts`'s `probeFrames` inherits that: it reported `trustworthy: true` with a real
>    4.6% diff once, then `trustworthy: false` on the next attempt purely because the camera had been
>    pinned in the same evaluation as the probe.
> 3. `extract.pixels({target, frame})` needs a genuine Pixi `Rectangle` (it calls `frame.copyTo`; a
>    plain object throws), and the `frame` is not screen space — a hand-computed screen rect returned
>    **one distinct luma value** across 34,000 samples.
>
> Two rules came out of it. **Carry your own control aimed at the same subtree**, not just the
> harness's: `probeFrames`' built-in control blanks the stage and passed while hiding 124 pillar sprites
> moved 0 pixels, and that mismatch is what exposed ②. And when the quantity is one-dimensional — a
> ramp, an alpha profile — **answer it analytically from the shipped code instead**: sample the ramp
> texture with `rampProfile` and compare it against the formula it replaced. That is what pinned the
> crease conversion at half a band step (0.01279 alpha) when no reader would produce a frame.
>
> Also worth knowing when the subject is a wall or pillar: the occlusion x-ray **fades your subject**.
> A first probe honestly read 0 because every pillar at that camera was faded, and a faded pillar's
> crease contributes nothing. A block only fades when its `sortY` is south of the player, so stand
> NORTH of the cluster to get unfaded subjects on screen.

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
- A character standing in the band a standing block's art intrudes over (one wall height north of its footprint) is judged wholly BEHIND it, and a 70 px block is taller than the 32 px body — so "partly hidden" is not available and the player simply disappeared. **Reported live 2026-08-20 and now mitigated by the occlusion x-ray above**, which is a stylisation, not a fix to the sort: the case itself is still a limit of the projection.
- **An east/west side has no projection at all.** `screen.y = gy - z` has no horizontal component, so a
  block's east and west faces are exactly zero px wide and its art simply stops at the footprint's edge.
  Harmless where a neighbour's floor or stone carries on; a cliff where the next thing along is the void.
  Mitigated 2026-08-27 by the void return (above), which is an invention rather than a projection — the
  limit itself does not go away, and anything else that wants to show an east-west drop has the same
  problem.
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
2. **[shipped 2026-08-03]** Dynamic lighting: a per-pixel fake normal derived at shader time from a sprite's own rendered luminance/alpha (a Sobel-style gradient over 4 neighbour-texel taps, the same trick milestone 5's `OutlineFilter` already uses for alpha-edge detection — no normal-map texture asset exists or is needed), shaded against a fixed key light (reusing `RoomBuilder.ts`'s "lit from upper-left" pillar-shading direction) plus a small dynamic point-light registry (`game/fx/lighting.ts`'s `LightRegistry` — the local player's own glow + transient muzzle-flash/impact bursts). This is a scoped equivalent of "normal maps + point lights + lightmap (multiply composite)," not that literal architecture: no `RenderTexture`/deferred-lighting layer exists anywhere in this codebase, and building one would be disproportionate to a fixed-camera 2D sim — a fifth custom `Filter` does the job instead, following the same template as the four milestone-5 shaders below. **Re-shaped 2026-08-24** into `SceneLightFilter`, ONE pass over the `lit` layer instead of one `NormalLitFilter` per actor: the per-actor form cost a render-target pass per character and broke the sprite batch (render p50 10.4ms of a 16.7ms frame, 175 draw calls / 105 program switches for 9 actors; one pass is 2.4ms). The move also upgraded the point lights from one averaged direction per actor (`LightRegistry.strongestAt`) to real per-texel direction and falloff for every light at once, and extended lighting to the floor and walls, which the per-actor form could never reach. Unblocked once ROADMAP 5.3 settled that GPT-Image-2-generated art counts as final production art (no more "normal-map authoring needs real art first" gate) — see ROADMAP's 2026-08-03 updates on both items for the full account.
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
   - **`EnergyShieldFilter`** — a transparent shell enclosing the character (a rim band until
     2026-08-25, a filled disc with a Fresnel hairline until 2026-08-26, a chord through a
     shell of real thickness with the body between its two hemispheres since; see "The shield
     is the deliberate exception" above and the three bullets after it for the rewrites and what
     each measured), built on the same UV-distance-from-centre technique as `VignetteFilter`
     (not true alpha-edge detection, so it needs no extra per-skin wiring against either the
     Graphics placeholder body or a real `.tao` rig). It is the one filter here that samples a
     SECOND texture — the generated membrane tile, `fx/filters/shieldScales.ts` — and the one
     with a radial cull, which is the only measured perf lever it has. `Actor.setShield` drives `intensity` off the actor's live two-pool shield ratio
     (design/02/05/07) — full glow at a full shield, fading as it drains, and since 2026-08-26
     playing a ~200 ms EXIT of its own once it hits 0 (`shatter`: expanding, wall thinning,
     scales thrown outward, light collapsing to exactly nothing) rather than being dropped
     between two frames. `EventReactor`'s burst and `ParticleSystem.shieldShards` cover the
     same instant in world space. Its UV-distance-from-0.5 assumption DOES need the render area itself to be
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
     frequency + amplitude), and by the scene-lighting pass (each texel's WORLD position,
     `uRegion`). `OutlineFilter` deliberately does NOT use it: it only ever steps by one
     texel, and `uInputSize.zw` is already exactly that. A filter that takes the prelude
     must NOT also declare `uInputSize` itself — that is a hard 'redefinition' compile
     error, and a filter whose program fails to compile renders its whole layer black.
     `EnergyShieldFilter` additionally sets `clipToViewport: false`, because Pixi otherwise
     intersects the region with the viewport (`FilterSystem._calculateFilterBounds`) and
     would re-introduce a lopsided ring for any shielded actor standing at a screen edge;
     that is safe only because `filterArea` already bounds it to a small fixed square, and
     is deliberately NOT done for the two screen-wide post-fx, which need the clip to size
     themselves to the viewport. General lesson: when a filter's symptom flips on and off
     with the camera zoom, suspect the pow2 filter-texture pool before suspecting Pixi.

## Render quality tiers (2026-08-25)

Everything the fidelity roadmap above shipped ran **unconditionally**. There was no quality
setting anywhere in the codebase, and every perf number in this document was measured on a
desktop Chrome — so a device that could not afford the frame had nothing to turn off. That is
the gap this closes, and it is worth stating that it is a DESIGN gap rather than a missing
measurement: `04`'s checklist items 3 and 6 ("frame rate on low-end Android", "lighting
performance on low-end devices") were unanswerable in the only way that matters, because a bad
answer had no remedy attached to it.

`render/quality.ts` holds two tiers and the table that separates them. `render/qualityWatchdog.ts`
holds the `'auto'` policy. `game/renderQuality.ts` applies a tier to the live renderer.

| Knob | high | low | why it is on this list |
|---|---|---|---|
| `resolutionCap` | 2 | 1 | Fill rate. A DPR-3 phone rendering at 2 draws 4x the fragments of one at 1, and **every pass below pays that multiplier again**. The platform's own `min(devicePixelRatio, 2)` still applies on top — the cap only ever lowers it. |
| `sceneLight` | on | off | The one `SceneLightFilter` pass over `layers.lit`. |
| `screenFx` | on | off | `VignetteFilter` + `ChromaticAberrationFilter` over `layers.world`. |
| `bloom` | on | off | The bloom-lite `BlurFilter` over the additive `layers.fx`. |
| `actorShaders` | on | off | The four per-actor skin shaders. One render-target pass **per actor** that currently has a status effect — the cost profile the 2026-08-24 lighting pass existed to remove from the frame, still reachable through the status shaders. |
| `particleBudget` | 1 | 0.35 | Burst counts and ambient dust rate. Each particle is its own `Graphics` node. |

**Measured, in the live scene** (`?perf=1`, a level-1 room with 8 enemies, via
`perf/drawAttribution`'s GL counters):

| | high | low | delta |
|---|---|---|---|
| draw calls | 31 | 23 | -8 |
| **render-target switches** | **11** | **1** | **-10** |
| program switches | 20 | 12 | -8 |
| texture binds | 100 | 90 | -10 |

The render-target line is the one that matters. On a mobile tile-based GPU each of those is a
full-viewport resolve, and the low tier removes ten of eleven — before the resolution halving
quarters the fragments in the one that remains. The A/B was confirmed to be real rather than
a no-op by frame diff: switching tiers moves **48.8%** of the composited frame, against an
independent liveness control (hiding `layers.entities`) at 32.4%.

Two rules the tiers are built around:

- **Quality is presentation-only.** It never reaches the sim (`06`/`12`'s locked "art never
  decides an outcome"), so two clients on different tiers stay byte-identical in simulation. A
  low-tier client sees a flatter scene, never a different fight.
- **`'auto'` never climbs back up.** A device that downgraded is by definition one whose frame
  budget the high tier does not fit, so re-enabling would re-measure a slow frame and downgrade
  again — an oscillation the player would read as the game flickering between two looks. An
  explicit `'high'` pick always outranks the watchdog: the player asking for the good-looking
  version beats our guess about their hardware.

### The one place the tiers are not simply "less"

The low tier has no `DissolveFilter`, so a dying actor would stand at full opacity for the whole
`DISSOLVE_MS` and then vanish in a single frame — which reads as a dropped frame, not as a
cheaper effect. `ActorFilters` therefore drives a plain alpha ramp off the same clock
(`ActorFilterHost.setSkinAlpha`). The other three shaders need no such stand-in: they each have a
non-shader companion that still carries the information (the status aura ring, the hit flash's
own positional burst), so dropping them costs detail rather than meaning.

### What a device tester can read without any tooling

The settings screen's quality button reports what `'auto'` actually RESOLVED to, not just that
it is auto: once the frame watchdog fires it reads `AUTO (LOW)` / `自动 (低)`. That makes `04`'s
item 3 answerable by anyone holding the phone — a low-end device reporting itself — rather than
requiring a remote console session.

## The drops and the gate get real art (2026-08-20)

The pillar pass above closed the scene queue for *surfaces*. This one closes it for the objects that
stand on them: the five in-run drop kinds and the extraction portal. Both were still Pixi `Graphics`
— `design/12` had recorded them as "never planned as sprite art", a judgement made while walls were
flat rectangles on the ground layer, and by now they were the loudest placeholders in the frame.
**Render-only, no `ENGINE_VERSION` impact.** Art prompts and the three rejected generations are
archived in `art/environment/prompts.md`.

**A drop is scaled by its LONG axis to one shared 18 px extent** (`Pickup.ART_LONG_AXIS`), so each
file keeps its own aspect — the crystal draws 11x18, the bandage 18x9 — while a floor of mixed loot
still reads as one size class. This is the pillar's "scale by one axis, let the art choose the other"
rule with the axis picked differently, and for a different reason: a pillar's width has to agree with
a collision footprint, whereas a drop has no footprint at all and only has to agree with its siblings.
`weapon` is exempt and always will be: it draws that weapon's own business-end art, so
`getPickupTexture` has no `pickup_weapon` key and `Pickup` never asks for one.

**The gate is split between art and code, along the line "does it move?"** Only the masonry arch is a
sprite — bottom-anchored on the ground point, fitted by width, its height falling out of the file's
aspect (the shipped 576x539 lands within a pixel of `archH`). The ground bloom, the two
counter-rotating rings of arcs, the bright core and the infalling motes stay program-drawn because
they animate every frame. Consequence worth stating: the arch art is authored as NEUTRAL stone with
COLOURLESS crystal, because one `Sprite.tint` cannot tint the shards without tinting the masonry, so
the checkpoint's green comes from the code-drawn layers instead.

**Two numbers moved because real stone has thickness, and they are both measured off the file.** The
vortex's radii were fractions of `archW`, the object's outer half-width — free while the "arch" was a
single stroked ellipse whose stone had no thickness at all. The shipped arch's legs take 22% of the
outer width each, so `ringA`'s authored `0.78 * archW` was drawing the brightest ring straight onto
the masonry. Fixing it needed the right *measurement*, and the first attempt used the wrong one: the
horizontal cross-section of the opening at one height (45.4%) ignores that the vortex is an ellipse
which also extends upward into the narrowing crown. Sweeping the file's alpha for **the largest
ellipse, squashed the way the code squashes it, that touches no opaque pixel** gives the real answer —
and it depends on where the ellipse is centred: only `0.365 * archW` at the arch's mid-height, but
`0.560` with the centre dropped to a QUARTER of the arch's height, where the straight legs become the
only constraint. So `VORTEX_CENTER_OF_ARCH_H` exists now too, and the vortex sits low in the doorway,
which is also where an arch's opening actually is. `environmentArt.test.ts` re-derives both constants
from the shipped alpha every run.

**Three things only a rendered frame could have said**, all found by compositing the sprites at their
real drawn size over the real floor swatch and by pulling frames out of the live client:

- **A one-pixel arrowhead.** The buff sigil's inner mark was generated as an *outline* — 5.8% of the
  object's width per stroke, which is one pixel at 18 px. It measured as a correct shape and was
  invisible in game. The regeneration's solid mark is 27% of the width, about 5 px.
- **An eye.** The bandage came back as a circular end-on roll with concentric rings and a dark centre
  hole. In a game whose hero, every critter and the boss are all single-eyed, a pale disc with a dark
  middle lying on the floor is a fiction-breaking read, and no per-file measurement would ever have
  flagged it. The fix is the silhouette (a side-on capsule, aspect 1.92), which is therefore what the
  test asserts.
- **The glow had become a plate.** Each drop sits on an additive glow that had been ONE flat circle at
  a single alpha since 2026-08-02. Behind a 14 px flat Graphics silhouette that read as "this shape,
  glowing"; behind real art it read as a coloured token the object was standing on. It is now twelve
  non-overlapping annuli on a squared falloff — the same construction as `roomLight`'s room falloff and
  `wallTone`'s coping ramp, and for the same reason (stacked translucent shapes step in OPACITY and
  compound). Ten bands stepped by 0.061 alpha, which still read as a ring; twelve step by 0.052.

**And one defect this pass introduced and then caught in its own frame:** pulling the vortex's radii in
to fit the opening while leaving its stroke widths and mote sizes at their old absolute values took
`ringA` from 26% of its own radius thick to 44%, and the vortex read as a scatter of debris rather
than a spinning ring. One `VORTEX_SHRINK` factor now scales widths and mote sizes with the radii, and
the test bounds the stroke-width-to-radius RATIO rather than an absolute width, so it cannot go stale
the next time the arch art changes.

**Verification. +87 tests (1968 → 2055), 39 mutants, 39 killed** — after four survivors were closed,
and all four were real gaps. Two of them were the same gap: `getPickupTexture`'s `pickup_` key prefix
and `getPortalArchTexture`'s key string are *never executed* under vitest, because no texture ever
enters the registry there — a typo in either silently leaves every drop and every portal on its
Graphics fallback forever, which looks exactly like art that was never generated. That is what
`environmentSpritesLoad.test.ts` is for (stub `Assets.load` to succeed, then assert each getter
resolves to its OWN file), and it is the same split `biomeTilesLoad.test.ts` already keeps from
`biomeTiles.test.ts`. The other two were assertions too loose to discriminate: a mote-size bound that
0.16 satisfied when the shrunk value is 0.11, and a glow-ramp convexity threshold a linear ramp
cleared by 0.007. `environmentArt.test.ts` decodes the six SHIPPED files and measures them (real alpha
with transparent corners, no baked halo, trimmed to content, resolution headroom against
`MAX_ZOOM * DPR`, every band clear of the floor's own 39-49 luma, the crate's top the brightest plane,
the arch in the wall face's tonal family with its shards untouched by the curve) — and runs the same
assertions over the three `_alt` rejects, so a check that stops telling accepted from rejected art
fails instead of passing vacuously.
