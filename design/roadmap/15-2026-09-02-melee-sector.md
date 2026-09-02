# Work log — 2026-09-02 (the melee sector)

Volume 15. Same day as `14`, split off it because that volume reached 964 lines
(`ROADMAP.md` "Appending to the log": past ~1000 lines, start the next number; splitting one
busy day across two volumes is fine).

## The swing shows the sector it actually hits (2026-09-02, client only, no engine bump)

From a live question in two parts — is the melee attack animation's amplitude tied to the
weapon's own attack sector, and can there be an fx that shows that sector. The honest answer to
the first was **no, the two were completely unrelated numbers**, and that turned out to be the
more interesting half.

**What the two sides actually said.** `HitResolveSystem.meleeArc` hits every hostile inside
`arcHalf` of the facing and within `range` of the actor's centre; `DeflectSystem` parries bullets
in the identical sector, off the identical two fields. The authored roster spans **60° (spear) to
220° (hammer)** and 1.3–2.1 grid of reach. The animation was one hardcoded sweep: `-22°` behind
the aim to `+46°` past it, 68° total, 260 ms, for every weapon in the game — the trigger chain
carried a single bit (`onAttack(kind)`) and no spec at all. So the spear's animation was **wider
than the sector it can hit in**, the hammer drew **31% of its own**, and because the parry reads
that same `arcHalf`, the gap was not a missing flourish: it actively misinformed the player about
which bullets their swing could bat away.

### Half one: the weapon sizes and paces the swing

`render/rigAttackMotion.ts` gained `SwingShape` (the weapon's `arcDeg` + its recovery in ms) and
`swingSchedule()`, which derives the travel and the timing:

- sweep = `arcDeg × (68/162)`, clamped to **[26°, 104°]**
- envelope = `recovery × (260/366.7)`, clamped to **[130, 400] ms**

Both factors are **defined as the ratio between the starter saber's own shape and the constants
that were hand-tuned against it** (`DEFAULT_SWING` = 162°, 11 ticks @ 30 Hz), not typed in — so
`swingSchedule(DEFAULT_SWING)` reproduces the pre-pass envelope exactly rather than approximately,
and a drifted factor fails a test instead of quietly changing the starter weapon. A caller with no
spec (the `Graphics` placeholder; any enemy, none of which carry a melee weapon) gets that same
default. The spear now pokes at 25° in 213 ms, the hammer heaves 92° over 400 ms.

The clamps are about the body, not the reach: the blade hangs off an **aim-tracking socket**, so a
sweep much past ~100° swings it *through* the character rather than around, and a sector narrow
enough to derive under ~26° stops reading at the 13–20 px an actor occupies. The **fx is
unclamped** — it draws the true sector — which is the division of labour worth remembering here.

The shape reaches the envelope through the chain that already existed, one argument wider:
`EventReactor` → `Actor.onAttack(kind, swing)` → `Skin.attack` → `RigSkin.attack` →
`AttackMotion.kick`. Three of those four hops have no observable behaviour of their own, which is
why each is now asserted individually (below).

### Half two: the sector, drawn

New `client/src/game/fx/slashArc.ts` — the weapon's real arc, at its real radius, swept once per
swing, scheduled off `swingSchedule`'s own strike window so the light on the ground and the blade
in the air are one motion rather than two effects that overlap.

**Why it is a `Mesh`, the only one in this renderer.** The look needs alpha varying along two axes
at once: radially (transparent at the body, a bright rim at the reach limit, so the edge is a
*stated* boundary) and along the sweep (hot at the blade, fading through the wake). Pixi's
`Graphics` can only carry a **one-dimensional** ramp — `render/shadeRamp.rampFill` maps a linear
gradient through a texture matrix, and a matrix cannot express a polar mapping — so the Graphics
version of this is N adjacent constant-alpha sub-wedges, i.e. exactly the banded, draw-call-heavy
shape `shadeRamp.ts` exists to have deleted. A textured mesh gets both axes from its own UVs in
one draw call: 32 columns across the arc, `u` running back from the blade's current angle, `v`
from the actor's edge out to the reach limit.

**Why the brush is baked in code rather than generated art.** This is the second confirmed
instance of design/12's own rule (the first was the shield's scale tile): reach for the image model
when the asset needs a MATERIAL, generate it when it needs a parametric field. Here it is a radial
profile times a tail profile, converged on by editing a number, and it has to be additive-clean at
any arc width — so it goes through `shadeRamp.bakedField`: 256×64, POT and mipmapped (WebGL1 on
WeChat silently disables mips on NPOT), premultiplied white, **zero bytes** against design/04's
package budget, and readable back by a test. One bake serves 60° through 220° because the angular
span lives in the geometry and the brush is parametrised on *fractions* — sweep fraction and radius
fraction — so nothing stretches. Each swing tints it by element (`swordGlow` for physical, since
`ELEMENT_COLORS` deliberately omits that entry and the faction colour would read as a team marker).

Two details that carry the look. The **unswept part of the sector is not drawn**: every column
ahead of the blade collapses onto the blade's own angle, making those triangles zero-area, which is
what gives the leading edge a hard boundary — a fade there reads as the whole sector lighting up at
once. And the arc **outlives its own sweep** by twice its length: once fully swept, the whole
sector is lit and fading, and that is the frame where the reach is most legible.

Retired arcs are pooled (each one otherwise allocates three GPU buffers for ~230 ms), stepped from
`FxController.updateFx` in a list of their own rather than through the `_life` machinery — that
loop fades alpha *and scales* a child, and scaling this fx would grow it past the reach it exists
to state — and dropped on a run boundary, where a `_life` glow is small enough to be left to
expire.

**Where the weapon comes from, and why no engine change.** `melee_swing` carries `ownerId/gx/gy/
facing` and deliberately nothing else (design/08 keeps events to what the sim announces). The
netcode broadcasts *inputs*, so every client already holds the whole `GameState` —
`EventReactor.meleeSwinger` resolves the swinger's `MeleeSimSpec` from there and converts at the
render edge (brad→rad, fp→px, ticks→ms). No event field, no protocol change, no `ENGINE_VERSION`
bump. A lookup that misses is the normal case for an enemy, not an error: `meleeArc` runs over
`state.players` only.

### Measured, because looking could not answer it

The arc sweeps around a character that already wears a cyan shield shell, and no screenshot
separates the two — so the live check was an **A/B extract diff** (`extract.pixels({target: stage,
frame: viewport})` with `arc.visible` toggled), on a frozen frame with the ticker stopped. A real
hammer swing at 84% of its sweep: **9,747 px lit**, radii **71–125** against a geometric 46–119 plus
bloom (the 71 is the radial profile's own onset — the brush is near-transparent below ~35% of the
radius, by design), lit sector **159° of 220°**, and the head on the *mirrored* side, which is the
only evidence that `flipX` is applied at all.

That measurement also made one tuning decision honestly: at `TAIL_POWER` 3.2 the wake was under 1%
of peak by the time the blade was 80% round, so a 220° weapon only ever showed ~90° of itself and
the fx read as a crescent rather than a sector. **3.2 → 2.4** moved the measured lit arc 143° → 159°.
The pane's own `computer screenshot` returned a stale frame twice during this while `extract` was
correct both times — the same verdict as the standing-wall pass: when they disagree, extract is the
truth.

### The tests, and the parity file that did not exist

**4419 → 4497 (+78)**, in 2 new files and 6 existing; `tsc` clean, `check:filelength` clean.

The one worth naming is `client/src/game/fx/meleeArcParity.test.ts`, the same shape and the same
reason as `render/muzzleParity.test.ts`: the sector is authored once and consumed twice, and
**nothing cross-checked the two**. Each side had tests; the conversion between them was asserted
only against numbers restated by hand. It drives the real `HitResolveSystem` and probes the
boundary for all seven weapons:

- **angular parity is exact** — the engine tests the angle to the target's *centre* with no slack,
  so a body 2° inside the drawn edge connects and 2° outside does not, and the drawn edge is
  `arcHalf` to five decimals (the plausible wrong answer — treating `arcHalf` as the full sector —
  is what that pins);
- **radial parity is deliberately conservative** — `meleeArc` reaches `range + target.radius`
  (bodies, not points) while the arc is drawn at `range`, the reach the spec's field means. The gap
  is pinned *to the target's radius* rather than to a number, so the fx can never quietly start
  over-promising. Standing on the lit edge always connects;
- and the arc **sweeps the same way the blade does**, in both facings — two independent paths to
  one decision (the fx takes `flipX` from `facingFromAngle`; the rig states its swing in canonical
  pre-mirror space and lets `view.scale.x` reverse it), with a control proving the direction really
  does invert between them.

**A 39-row mutation battery: 39 authored / 39 executed / 35 killed**, and unusually every one of the
four survivors was a real gap rather than an equivalent — all three of the first ones the same
shape, *a test that reads one channel of a multi-channel buffer*:

| survivor | what it breaks | why 19 cases missed it |
|---|---|---|
| radial UV swapped | bright rim on the character, transparent at the reach limit — the fx inverted | every case read `u`, none read `v` |
| quad triangulated along its inner EDGE | overlaps near the body, leaves a wedge hole along the outer rim | nothing read `geometry.indices` |
| buffer never marked dirty | JS arrays correct, GPU copy frozen on frame one | looked untestable headless — and is not: Pixi's `Buffer` is an EventEmitter, and that re-assignment is what makes it emit `update` |
| exponential tail turned linear | a slash becomes a filled pie slice | satisfied every asserted property (1 at the blade, 0 at the end, monotone) |

All four closed and re-killed (the four-mutant subset re-run rather than the whole battery, which
is the cheap way to prove a gap is actually shut). The tail is now held by a **band** whose bounds
are the design statement — faster than linear, still wide enough that the sector reads — not a
snapshot of the current constant.

### Found and spun out, not fixed here

`MeleeSpec.swingSec` is authored on all seven melee weapons (0.1–0.2 s, documented as the "ACTIVE
hit-window, 07 step 7") and **`toSimSpec` never converts it** — it reaches no `MeleeSimSpec` field
and nothing in the repo reads it. Melee damage resolves instantly on the swing tick. Either the
window becomes real (which would also let both the fx and the envelope pace themselves off the
actual active window instead of a fraction of the recovery, and needs an `ENGINE_VERSION` bump with
the golden-hash gate run *first*) or the field is dead data and should go. Left as its own task
rather than decided in passing.
