# Collision & combat

The bodies of the simulation's hit-detection and damage steps. `08-simulation-core.md` locks the `step()` **order and interfaces** — this doc fills in the *what happens* for steps 4–9 (movement/collision, projectile flight, deflect, hit resolution, death & drops). All math obeys `06-netcode-determinism.md`: fixed-point (`Fp`), integer brad angles, `isqrt` (never `Math.sqrt`), injected `Prng` (never `Math.random`). It realizes the swing-based deflect mechanic from `03-weapon-system.md` and the run economy (drops) from `05-gameplay.md`.

> **funny mapping.** funny (`C:\Users\TaoWang\Documents\funny/server/engine/src/`) is a *lane* game: units advance along grid columns and its "collision" is one-dimensional gap arithmetic; its projectiles **home on a target id**; it has **no trig at all**. DayDayUp is free-2D with directional bullets and angular arcs, so collision and ballistics **diverge heavily** — flagged **⟂ diverges** below. What *does* port cleanly is funny's damage discipline: circle radii + `isqrt` distance, flat-armor `takeDamage`, a frozen hit payload, one shared hit-resolver, and two-phase death.

## The decisions (locked)

- **Actors are circles; solids are static.** Every `Actor` has `radius_fp` (funny's `radius_fp`) for bullet/melee hits, plus a smaller `footprintRadius_fp` (the feet) used only against solids — so a tall sprite can stand against a pillar its body visually overlaps. Overlap = centre distance `< r₁+r₂`, distance via `isqrt(dx²+dy²)`. **Round pillar solids are implemented** (centre-line push-out by penetration depth, isqrt); AABB tile/`RoomState` walls (resolved by axis separation) are still deferred. Full per-polygon physics is out of scope — this is a shooter, not a physics sandbox.
- **Deterministic uniform-grid broad phase.** ⟂ diverges. A fixed-cell-size spatial hash (cell = a small power-of-two multiple of a grid unit) buckets actors/bullets by `gx/gy`; narrow-phase only tests same/adjacent cells. Iteration is by **ascending entity id within ascending cell index**, never by `Map`/`Set` order (`06` ban). funny needs none of this (its lane grid *is* the index); we build it.
- **Bullets are directional and swept.** ⟂ diverges. A bullet carries a fp velocity from `cos_fp(brad)/sin_fp(brad)` (`03` ballistics), not a homing target. Because a fast bullet can cross an actor's diameter in one tick, collision is a **swept segment test** (this-tick start→end segment vs actor circle / vs wall), not a point-in-circle test at the endpoint — otherwise fast bullets tunnel through targets.
- **Angular arcs live in brad space via `06`'s fp-trig.** ⟂ diverges — **this doc is the first consumer of the fp-trig/brad module `06` calls the biggest new determinism surface.** A melee swing arc is a "distance < range AND |angleDiff(toTarget, facing)| < half" test (integer brad, never radians); the SAME arc both damages enemies and deflects bullets — there is no separate `blockArc`.
- **One frozen payload, one shared resolver.** Damage (and any crit roll from `combatPrng`) is snapshotted at *fire/swing* time into a payload and applied by a single `resolveHit(payload, target)` — identical for a bullet impact and a melee connect (funny's `ProjectilePayload` + `resolveAttackHit`). A bullet that outlives its firer still lands the frozen damage.
- **Flat-armor damage, integer HP.** `takeDamage(raw) → effective = armor>0 ? max(1, raw−armor) : raw` (funny verbatim). HP is an integer; no fractional health.
- **Invulnerability frames.** ⟂ diverges. After taking a hit an actor gets `invulnTicks` of i-frames (tick-counted, decremented each step); hits on an i-framed actor are ignored. Bullet-hell needs this; funny (no dodging) has none. Counts in whole ticks so it's deterministic.
- **No height / no jump.** Collision is strictly 2D on the ground plane — there is no `z`/`vz`/gravity on actors and no jump. (An earlier z-band "shoot over cover / jump over hazard" model was dropped: the logic-layer height complexity wasn't worth it. A future dodge is a planar blink, not a hop.) `z` survives only as a cosmetic bullet muzzle-height for the fake-3D render, never gating a hit.
- **Two-phase death.** A lethal hit sets `hp=0` / `dead=true` and emits `death`; a **sweep at the end of the combat step** removes dead actors and rolls drops. Never splice a live array mid-iteration (funny's mark-then-sweep).
- **Faction gates every interaction.** `faction ∈ {player, enemy}` (`02`). Bullets damage only the opposite faction; **no friendly fire** at launch (config flag if ever wanted). Deflect *flips* a bullet's faction (`03`).

## Coordinates and what "a hit" means

Collision resolves entirely in the **2D ground plane** (`gx/gy`, per `01-rendering.md`). There is **no height gating**: a hit is a ground-plane circle overlap, full stop.

`z` is not a gameplay dimension. Actors have no `z`/`vz` (jump removed). A bullet still carries a small `z` (muzzle height) but it is **purely cosmetic** — the fake-3D render lifts the sprite by it; no system reads it to decide a hit. The earlier "z-band gates overlap → jump over hazards / shoot over low cover" idea was dropped as too much logic-layer complexity for this shooter; if verticality is wanted later it comes back as its own explicit feature, not a field silently threaded through every hit test.

## Step 4 — movement & solid collision

Per moving actor (players + enemies), in ascending-id order:

1. Integrate velocity on the 2D plane: `gx += vx`, `gy += vy` (per-tick displacement is pre-baked, so it's a plain `addFp`, no dt multiply). No z / gravity — movement is planar.
2. **Actor–solid:** push the actor's `footprintRadius` circle out of each overlapping static solid. For a **round pillar** (implemented): if centre distance `< footprint + solidRadius`, shift the actor out along the centre line by the penetration depth (`isqrt` for the distance; a concentric overlap nudges a fixed +x for determinism). AABB tile walls (axis-separation push) are deferred.
3. **Actor–actor:** for each overlapping same-plane pair (broad phase), push both apart along the centre line by half the penetration each — gap math mirrors funny's `subFp(subFp(other − rOther), (self + rSelf))`. Resolve pairs in a **fixed (id-ordered) sequence** so the result is deterministic. *(Still deferred; the static-solid half above is what ships.)*

Knockback is just an impulse added to `vx/vy` (in brad direction) by the hit step; it plays out through this integrator next tick — no separate physics pass.

## Step 5 — projectile flight & wall collision

Advance every bullet in `state.projectiles` (push order = fire order):

- New position = old + `velocity·dt`. Record the **swept segment** old→new.
- Test the segment against `RoomState` solids; first wall intersection → bullet stops/expires (emit `bullet_expired`) unless the weapon spec says it bounces (`03` ballistic-shape library, later).
- Decrement `lifespanTicks`; expire at 0 or off-map.
- Bullet–actor overlap is **not** done here — it's the hit step (7), after deflect (6), so a bullet blocked this tick never also registers a body hit this tick (ordering rationale in `08`).

Survivors are collected into a fresh array (funny's `survivors` pattern), never spliced in place.

## Step 6 — deflect (the swing IS the parry)

The pivot mechanic (`03`). Deflect is **not** a held state — it is part of a melee swing. For each actor whose melee weapon swung this tick (`justSwung`) and whose spec has `deflect`, test enemy bullets against the **swing's own arc** (the same `range`/`arcHalf` that damages enemies in step 7):

```
inArc(bullet, swinger):
  dx = bullet.gx − swinger.gx; dy = bullet.gy − swinger.gy
  dist = isqrt(dx*dx + dy*dy)
  if dist >= range: return false
  bulletBrad = atan2Brad(dy, dx)          // via fp-trig table, NOT Math.atan2
  return absBradDiff(bulletBrad, swinger.facing) < arcHalf
```

On a match (`03` "deflect"):

- **Flip faction** player↔enemy so it can now hit the original shooter's side.
- **Redirect velocity**: aim at the nearest opposite-faction actor (broad-phase nearest, id-tie-broken), else **mirror-reflect** about the swinger's facing. New velocity from `cos_fp/sin_fp` of the chosen brad at the weapon's `deflectSpeed`.
- Emit `deflect` (render plays the additive flash on the fx layer, `01`).
- Extension hooks (config, not launch): perfect-swing timing window → damage bonus; extra recovery. `05` notes deflect is already a commitment (it costs a swing) — any further costs are engine-config balance (`09`).

Deflect runs **before** hit resolution so a just-deflected bullet is already friendly when step 7 looks at it.

## Step 7 — hit resolution

**Bullets → bullets.** Resolved **first**, before the actor loop. Each overlapping opposite-faction bullet pair annihilates (both expire) — a bullet cancelled here can't also land a body hit this tick. Endpoint circle-overlap, `i<j` so a pair is tested once; push order breaks ties (deterministic, `08`). Emit `clash`. Deflect (`06`) flips faction first, so a just-parried bullet can clash with the volley it came from.

**Bullets → actors.** For each still-live bullet, swept-segment vs opposite-faction actor circles (broad phase), 2D only. On the **first** actor along the segment (nearest intersection): build the frozen payload, `resolveHit`, then expire the bullet — unless the weapon is `piercing`, in which case it continues and may hit further actors (funny's pierce, adapted to the swept path). Emit `hit`.

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

### Damage types & on-hit status (shipped 2026-07-10, `ENGINE_VERSION` 8)

`resolveHit` (`applyHit`) is the single funnel for every hit — bullet or melee — and now does, in order:

1. **Resist** — `effective = target.resist[type]==1000 ? raw : max(1, ⌊raw·mult/1000⌋)`. Per-type per-mille multiplier on the target; missing type = `1000`. Floors at 1, so resist reduces toward 1 and weakness (>1000) amplifies (`03`/`09`).
2. **Apply** — `target.hp -= effective`; emit `hit{…, damageType}`.
3. **On-hit status by type** — `fire` starts/refreshes a **burn** (`burnTicks`, `burnDmg = max(1, hit>>1)`); `ice` starts a **chill** (`chillTicks`, `chillSlow` per-mille — `MovementSystem` scales that tick's displacement by `1000−slow`); `poison` pushes an independent **stack** (capped); `lightning` **chains** to the nearest other same-side actor within `CHAIN_RANGE` for `⌊dmg·½⌋` (one hop, no recursion, no further status). Emits a `status` event for fx.

The lingering effects are ticked in the new **Step 8 — status effects** (below), not here — `applyHit` only *starts* them. Determinism: all integer/fp; chain nearest is squared-distance (no trig); no PRNG draw, so damage types add no new random-draw site.

## Step 8 — status effects (elemental DoT / chill)

Runs after hit resolution (7) and **before** death & drops (now 9), so a burn/poison kill is swept and rolls a drop the same tick as a direct-hit kill. For every alive actor:

- On a **DoT-cadence tick** (`state.tick % DOT_INTERVAL == 0`): apply `burnDmg` if burning, and the summed damage of all poison stacks. Burn and poison share the global cadence, so no per-actor clock is stored (deterministic, `06`).
- **Age** every timer by one tick; burn/chill reset their magnitude at expiry (so a later weaker application can't inherit a stale value — HitResolve keeps the MAX burn tick while active); expired poison stacks are compacted out in push order.

Chill is *read* one step earlier (Movement, step 4) using the value set by a prior tick's hit — the slow applies from the next movement pass, standard for a status.

## Step 8 — death & drops

Single sweep over each entity array, ascending id:

- `dead` actor → emit `death{id, pos, faction, type}`; if it's an enemy with an `onDeathSpawn` (boss adds, funny's `onDeathSpawn`), spawn minions at its position; **roll `dropPrng`** against the drop table (`05`) → push a `Pickup` (in-run drop). Then remove from the array.
- Player down → don't remove; mark `downed` (revive/team-wipe rules are `05`'s open question). Win-condition check (step 11, `08`) reads this.

Drops spawned this tick are **not collectable until next tick's pickup pass** (step 9), per `08`'s ordering rule — no kill-and-vacuum in one frame.

## Events emitted (engine → render, `08`)

`bullet_fired · bullet_moved · bullet_expired · clash · deflect · hit · melee_swing · knockback · death · pickup_spawned · pickup_taken · hp_changed`. Transient, consumed once per render frame; they drive fx/audio only and never feed back into logic. Positions in fp; render converts with `fromFp`.

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
- **`01`:** the `gx/gy` ground plane collision resolves in. `z` is render-only in `01`'s fake-3D lift; it is not a gameplay dimension here (no height gating).

## To design

- **`RoomState` collision-geometry schema** — tile/AABB representation, solids, spawn/exit markers (shared with the future `09-content-data.md` room-piece format).
- **Ballistic-shape library** (`03`): straight/arcing/homing/boomerang/pattern — each is a per-tick velocity update rule slotted into step 5. Bounce/pierce/homing are the first extensions.
- **Knockback & i-frame numbers**, perfect-swing window — all engine config (`09`), tuned against real play (`05`).
- **Broad-phase cell size** vs typical bullet speed (cell must be ≥ max per-tick bullet travel, or the swept test must span multiple cells).

## Open questions

- **Pierce vs swept path:** a piercing bullet crossing several actors in one tick — hit *all* on the segment this tick, or one per tick? All-on-segment is more correct but needs the swept test to return an ordered hit list.
- **Deflect redirect target:** nearest enemy (feels aim-assisted, good for casual `05`) vs pure mirror-reflect (skill-expressive). Possibly per-weapon. Decide against real play.
- **Actor–actor push in tight rooms:** pure push-apart can jitter when many bodies pack a corner; may need a max-push clamp or priority (players over enemies). Watch in playtest.
- **Enemy-enemy collision:** do enemies block each other (funny does, friendly-collision) or overlap freely? Overlap is cheaper and bullet-hell-normal; blocking looks better but costs pairs. Lean overlap at launch.
- **Melee vs bullet-cloud cost:** a wide swing arc tested against every nearby bullet each active frame — is the broad phase enough on WeChat low-end under a full bullet-hell? Ties to `06`'s 30 vs 20 Hz open question.
