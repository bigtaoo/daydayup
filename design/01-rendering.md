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
`MIN_COVER_FRACTION`, deliberately not a second number), the face and its shading go too. It costs
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
**A PvP arena is the opposite case and deliberately keeps the whole-world floor**: the same sweep
over the shipped `arena_prototype_60` finds 5240 of its 11,524 non-wall cells (45%) reachable and
outside every room rect *and* every door passage, so a per-room floor there would leave a player
walking over the backdrop. `groundLayer.floorRegionsPx` is that branch, and the arena's 60 rooms
still get their own wash/mottle/light on top of the continuous floor.

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
| ui | HP, weapon, crosshair | topmost |

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
