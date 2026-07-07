# Collision & combat

The bodies of the simulation's hit-detection and damage steps. `08-simulation-core.md` locks the `step()` **order and interfaces** — this doc fills in the *what happens* for steps 4–9 (movement/collision, projectile flight, block/deflect, hit resolution, death & drops). All math obeys `06-netcode-determinism.md`: fixed-point (`Fp`), integer brad angles, `isqrt` (never `Math.sqrt`), injected `Prng` (never `Math.random`). It realizes the block/deflect mechanic from `03-weapon-system.md` and the run economy (drops) from `05-gameplay.md`.

> **funny mapping.** funny (`C:\Users\TaoWang\Documents\funny/server/engine/src/`) is a *lane* game: units advance along grid columns and its "collision" is one-dimensional gap arithmetic; its projectiles **home on a target id**; it has **no trig at all**. DayDayUp is free-2D with directional bullets and angular arcs, so collision and ballistics **diverge heavily** — flagged **⟂ diverges** below. What *does* port cleanly is funny's damage discipline: circle radii + `isqrt` distance, flat-armor `takeDamage`, a frozen hit payload, one shared hit-resolver, and two-phase death.

## The decisions (locked)

- **Actors are circles; walls are static solids.** Every `Actor` has `radius_fp` (funny's `radius_fp`). Overlap = centre distance `< r₁+r₂`, distance via `isqrt(dx²+dy²)`. Walls are axis-aligned tiles/AABBs from `RoomState`; actor-wall is resolved by axis separation. Full per-polygon physics is out of scope — this is a shooter, not a physics sandbox.
- **Deterministic uniform-grid broad phase.** ⟂ diverges. A fixed-cell-size spatial hash (cell = a small power-of-two multiple of a grid unit) buckets actors/bullets by `gx/gy`; narrow-phase only tests same/adjacent cells. Iteration is by **ascending entity id within ascending cell index**, never by `Map`/`Set` order (`06` ban). funny needs none of this (its lane grid *is* the index); we build it.
- **Bullets are directional and swept.** ⟂ diverges. A bullet carries a fp velocity from `cos_fp(brad)/sin_fp(brad)` (`03` ballistics), not a homing target. Because a fast bullet can cross an actor's diameter in one tick, collision is a **swept segment test** (this-tick start→end segment vs actor circle / vs wall), not a point-in-circle test at the endpoint — otherwise fast bullets tunnel through targets.
- **Angular arcs live in brad space via `06`'s fp-trig.** ⟂ diverges — **this doc is the first consumer of the fp-trig/brad module `06` calls the biggest new determinism surface.** Melee swing arcs and the block/deflect `blockArc()` are "distance < range AND |angleDiff(toTarget, facing)| < half" tests, with the angle difference computed in integer brad, never radians.
- **One frozen payload, one shared resolver.** Damage (and any crit roll from `combatPrng`) is snapshotted at *fire/swing* time into a payload and applied by a single `resolveHit(payload, target)` — identical for a bullet impact and a melee connect (funny's `ProjectilePayload` + `resolveAttackHit`). A bullet that outlives its firer still lands the frozen damage.
- **Flat-armor damage, integer HP.** `takeDamage(raw) → effective = armor>0 ? max(1, raw−armor) : raw` (funny verbatim). HP is an integer; no fractional health.
- **Invulnerability frames.** ⟂ diverges. After taking a hit an actor gets `invulnTicks` of i-frames (tick-counted, decremented each step); hits on an i-framed actor are ignored. Bullet-hell needs this; funny (no dodging) has none. Counts in whole ticks so it's deterministic.
- **Two-phase death.** A lethal hit sets `hp=0` / `dead=true` and emits `death`; a **sweep at the end of the combat step** removes dead actors and rolls drops. Never splice a live array mid-iteration (funny's mark-then-sweep).
- **Faction gates every interaction.** `faction ∈ {player, enemy}` (`02`). Bullets damage only the opposite faction; **no friendly fire** at launch (config flag if ever wanted). Deflect *flips* a bullet's faction (`03`).

## Coordinates, height, and what "a hit" means

Collision resolves in the **2D ground plane** (`gx/gy`, per `01-rendering.md`); height `z` **gates** whether a ground-plane overlap counts:

- A bullet has its own `z` (muzzle height, may arc via `vz`/gravity). It hits an actor only if the ground-plane circles overlap **and** the bullet's `z` falls within the actor's vertical band `[0, bodyHeight]`.
- This is what lets a jumping player (`z>0`, `02`) clear a ground-hugging hazard, and lets a bullet pass **over** low cover. Exact band heights are balance config (`09`); the *principle* — 2D overlap gated by a z-band — is locked here so it stays consistent with `01`'s height model.

Keep the z-band coarse (a couple of bands, not continuous) at launch; continuous z-occlusion is the `01` fake-3D limit, not a collision goal.

## Step 4 — movement & solid collision

Per moving actor (players + enemies), in ascending-id order:

1. Integrate velocity: `gx += vx·dt`, `gy += vy·dt`, `z += vz·dt`; apply gravity to `vz`, clamp `z≥0` (landing). All `mulFp(v, TICK_DT_FP)` (funny's `mulFp(speed_fp, TICK_DT_FP)`).
2. **Actor–wall:** resolve per axis against `RoomState` solids — move X, push out of any overlapped solid along X; then Y likewise. Axis separation avoids corner-snag artifacts and is order-stable.
3. **Actor–actor:** for each overlapping same-plane pair (broad phase), push both apart along the centre line by half the penetration each — gap math mirrors funny's `subFp(subFp(other − rOther), (self + rSelf))`. Resolve pairs in a **fixed (id-ordered) sequence** so the result is deterministic.

Knockback is just an impulse added to `vx/vy` (in brad direction) by the hit step; it plays out through this integrator next tick — no separate physics pass.

## Step 5 — projectile flight & wall collision

Advance every bullet in `state.projectiles` (push order = fire order):

- New position = old + `velocity·dt`. Record the **swept segment** old→new.
- Test the segment against `RoomState` solids; first wall intersection → bullet stops/expires (emit `bullet_expired`) unless the weapon spec says it bounces (`03` ballistic-shape library, later).
- Decrement `lifespanTicks`; expire at 0 or off-map.
- Bullet–actor overlap is **not** done here — it's the hit step (7), after deflect (6), so a bullet blocked this tick never also registers a body hit this tick (ordering rationale in `08`).

Survivors are collected into a fresh array (funny's `survivors` pattern), never spliced in place.

## Step 6 — block / deflect

The pivot mechanic (`03`). For each actor holding `isBlocking` on a melee weapon, test enemy bullets against its `blockArc()`:

```
inArc(bullet, blocker):
  dx = bullet.gx − blocker.gx; dy = bullet.gy − blocker.gy
  dist = isqrt(dx*dx + dy*dy)
  if dist >= blockRange: return false
  bulletBrad = atan2Brad(dy, dx)          // via fp-trig table, NOT Math.atan2
  return absBradDiff(bulletBrad, blocker.facing) < blockHalf
```

On a match (`03` "deflect"):

- **Flip faction** player↔enemy so it can now hit the original shooter's side.
- **Redirect velocity**: aim at the nearest opposite-faction actor (broad-phase nearest, id-tie-broken), else **mirror-reflect** about the blocker's facing. New velocity from `cos_fp/sin_fp` of the chosen brad at the bullet's original speed.
- Emit `deflect` (render plays the additive flash on the fx layer, `01`).
- Extension hooks (config, not launch): perfect-block timing window → damage bonus; stamina cost. `05` requires deflect be "a commitment, not a free toggle" in PvP — those costs are engine-config balance (`09`).

Deflect runs **before** hit resolution so a just-deflected bullet is already friendly when step 7 looks at it.

## Step 7 — hit resolution

**Bullets → actors.** For each live bullet, swept-segment vs opposite-faction actor circles (broad phase), z-band gated. On the **first** actor along the segment (nearest intersection): build the frozen payload, `resolveHit`, then expire the bullet — unless the weapon is `piercing`, in which case it continues and may hit further actors (funny's pierce, adapted to the swept path). Emit `hit`.

**Melee swings → actors.** A swing is active for a few ticks (`swingTicks`); during active frames, test the weapon's arc (same `inArc` shape, using `arc`/`range` from `MeleeSpec`, `03`) against opposite-faction actors. Each target is hit **at most once per swing** (track hit ids on the swing). On hit: `resolveHit` + apply `knockback` impulse in the swing direction. Emit `hit`.

`resolveHit(payload, target)` — the single shared resolver (funny's `resolveAttackHit`):

```
if target.invulnTicks > 0: return          // i-frames
raw = payload.rawDamage                      // crit already rolled & frozen at fire time
actual = target.takeDamage(raw)              // flat armor, min-1, integer
target.invulnTicks = payload.invulnGrant     // start i-frames (0 for most bullets)
emit hit{ attackerId, targetId, damage: actual, hpRemaining: target.hp }
if payload.knockback: add impulse to target.vx/vy in payload.dirBrad
if target.hp <= 0: target.dead = true        // sweep removes it in step 8
```

Crit: at fire/swing time, `if critPct>0 && combatPrng.nextInt(100) < critPct: raw = round(raw*critMult)` (funny). PvP presets with `critPct=0` never advance `combatPrng`, keeping those replays independent — the same "hard wall" funny relies on.

## Step 8 — death & drops

Single sweep over each entity array, ascending id:

- `dead` actor → emit `death{id, pos, faction, type}`; if it's an enemy with an `onDeathSpawn` (boss adds, funny's `onDeathSpawn`), spawn minions at its position; **roll `dropPrng`** against the drop table (`05`) → push a `Pickup` (in-run drop). Then remove from the array.
- Player down → don't remove; mark `downed` (revive/team-wipe rules are `05`'s open question). Win-condition check (step 11, `08`) reads this.

Drops spawned this tick are **not collectable until next tick's pickup pass** (step 9), per `08`'s ordering rule — no kill-and-vacuum in one frame.

## Events emitted (engine → render, `08`)

`bullet_fired · bullet_moved · bullet_expired · deflect · hit · melee_swing · knockback · death · pickup_spawned · pickup_taken · hp_changed`. Transient, consumed once per render frame; they drive fx/audio only and never feed back into logic. Positions in fp; render converts with `fromFp`.

## Determinism checklist (this doc's surface)

- ✅ All distance/gap/velocity in `Fp`; distance via `isqrt`; **zero `Math.sqrt`**.
- ✅ All angles integer brad; arc/aim/reflect via `06`'s `cos_fp/sin_fp/atan2Brad` tables; **zero `Math.atan2/sin/cos`**.
- ✅ Crit/drop rolls via injected `combatPrng`/`dropPrng`; **zero `Math.random`**.
- ✅ Broad-phase & pair resolution iterate by ascending id / cell index; no `Set`/`Map` order leaks.
- ✅ Swept tests (no float endpoint check) so behavior is speed-independent and can't tunnel.
- ✅ Golden-replay: same seed + same input stream → identical hits, deaths, drops (`06` step-5 check). Any change here that alters outcomes bumps `ENGINE_VERSION` (`08`).

## Relationship to the other docs

- **`08`:** owns the `step()` order and `GameState`; this doc is the body of steps 4–9. `Projectile`/`Pickup`/i-frame fields added here live on `GameState` arrays.
- **`06`:** fp/brad/PRNG rules and the fp-trig module every arc/ballistic here depends on.
- **`03`:** `RangedSpec`/`MeleeSpec` (fire rate, spread, arc, range, `deflect`, knockback) are the *inputs* to steps 5–7; block/deflect is realized in step 6.
- **`05`:** drop tables, revive/team-wipe, and the "deflect must be a commitment" PvP tuning feed steps 6/8.
- **`01`:** the `gx/gy` + `z` height model that "2D overlap gated by z-band" keeps consistent.

## To design

- **`RoomState` collision-geometry schema** — tile/AABB representation, solids, spawn/exit markers (shared with the future `09-content-data.md` room-piece format).
- **Ballistic-shape library** (`03`): straight/arcing/homing/boomerang/pattern — each is a per-tick velocity update rule slotted into step 5. Bounce/pierce/homing are the first extensions.
- **z-band values**: how many bands, body-height per actor type, which hazards are ground-only. Balance config (`09`).
- **Knockback & i-frame numbers**, perfect-block window, stamina — all engine config (`09`), tuned against real play (`05`).
- **Broad-phase cell size** vs typical bullet speed (cell must be ≥ max per-tick bullet travel, or the swept test must span multiple cells).

## Open questions

- **Pierce vs swept path:** a piercing bullet crossing several actors in one tick — hit *all* on the segment this tick, or one per tick? All-on-segment is more correct but needs the swept test to return an ordered hit list.
- **Deflect redirect target:** nearest enemy (feels aim-assisted, good for casual `05`) vs pure mirror-reflect (skill-expressive). Possibly per-weapon. Decide against real play.
- **Actor–actor push in tight rooms:** pure push-apart can jitter when many bodies pack a corner; may need a max-push clamp or priority (players over enemies). Watch in playtest.
- **Enemy-enemy collision:** do enemies block each other (funny does, friendly-collision) or overlap freely? Overlap is cheaper and bullet-hell-normal; blocking looks better but costs pairs. Lean overlap at launch.
- **Melee vs bullet-cloud cost:** a wide swing arc tested against every nearby bullet each active frame — is the broad phase enough on WeChat low-end under a full bullet-hell? Ties to `06`'s 30 vs 20 Hz open question.
