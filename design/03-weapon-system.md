# Weapon system

The heart of the game. Design goal: a very large variety of weapons with distinct behavior, where melee can block/deflect bullets.

## Categories

- **Ranged:** pistol, rifle, shotgun, laser, bullet-pattern emitter, … Parameterized: fire rate, bullet count, spread, bullet speed, ballistic shape, damage.
- **Melee:** sword, hammer, spear, … Swing arc/angle, damage, knockback, plus **block/deflect** capability.

## Damage types & status effects (shipped 2026-07-10, `ENGINE_VERSION` 8)

Every weapon carries a `damageType`; a hit is no longer a bare integer. `physical` is the plain flat-damage path, and the four elements each layer an **on-hit status** the combat systems interpret (bodies in `07`, data in `09`):

| type | on hit |
|------|--------|
| **physical** | raw damage only |
| **fire** | **burn** — a refreshing damage-over-time (topped up while you keep hitting) |
| **ice** | **chill** — a movement slow for a duration (Movement scales displacement) |
| **lightning** | **chain** — the hit arcs to the nearest other same-side actor in range |
| **poison** | **stacks** — independent stacks, each aged on its own timer (ramps with uptime) |

Enemies carry a per-type **resist/weakness** multiplier (per-mille; `1000` normal, `2000` weak/×2, `500` resist/×½), so matching the enemy's weakness melts it and hitting its resist floors toward min-1. A hit never rounds below 1. This is the axis that makes the 12-weapon roster a *choice* — plus elemental enemy variants (`emberling`/`frostling`/`galvanist`/`ironclad`) that each resist one element and are weak to a counter (`09`).

The lingering DoT/chill is ticked by a dedicated `StatusEffectSystem` (tick step 8, `08`), on a global `tick % DOT_INTERVAL` cadence so every affected actor ticks in lockstep — no per-actor clock, fully deterministic (`06`). All status math is integer/fp; the chain uses squared-distance nearest (no trig). A deflected bullet keeps its element, so a parried fire bolt burns enemies.

> **Fixed:** `applyResist` (`content/damage.ts`) rounds instead of truncating specifically on the weakness (`mult > 1000`) branch, so a base-1 hit ×1.8 shows as 2, not silently floored back to 1 — resistance (`mult < 1000`) still truncates toward the min-1 floor so it always reduces. Asymmetric on purpose (see the function's own doc comment) — a replay-affecting rounding rule, guarded by an `ENGINE_VERSION` note there.

## Weapon composition: Frame × Element

The concrete answer to this doc's opening goal ("a very large variety of weapons with distinct behavior"): a weapon is **not** hand-built one at a time — it is **composed from two orthogonal axes**, so a large roster grows from a few authored pieces (`09`'s "content is data keyed by type; special behavior is a tagged field").

| Axis | Decides | Status |
|------|---------|--------|
| **Frame** | *behavior* — how shots leave the muzzle and how they fly (or, for melee, the swing's shape) | only `straight` shipped — **the main gap** |
| **Element** | *status layer* — burn / chill / chain / poison-stack + resist/weakness (above) | shipped (`ENGINE_VERSION` 8) |

**The bet: variety is combinatorial, not authored per weapon.** `N` ranged frames × 5 elements yields `N×5` distinct-feeling guns from `N+5` pieces. One weapon = one frame id + one **baked-in** element tag + a fixed stat row — nothing hard-coded per weapon. Element is a fixed property of the weapon (a "fire rifle" and an "ice rifle" are different weapons), not swapped by a drop.

> **No affix axis (`14`).** An earlier plan had a third **Affix** axis (roguelite per-instance rolls; rarity = roll count). It is cut — the game takes the Soul-Knight route: weapons are fixed, the in-run power layer is *better weapons + run-scoped buffs*, not weapon modifiers. **Rarity is now an intrinsic, fixed property of each weapon** (a small numeric edge + mainly better "handling/usability", never crushing — `14`), *not* a roll count. **Removed** (ROADMAP 0.1, `ENGINE_VERSION` 9→10) — the shipped affix layer (incl. the `elem_*` set-element affix from `ENGINE_VERSION 9`) is fully deleted; no `affix`/`Affix` symbol remains.

### The Frame axis — ranged

A ranged frame is **emission** (how shots leave per trigger) × **ballistic** (how each shot then moves). The two facets combine — a spread of homing pellets, a burst of lobs.

**Emission** — the `bullets` / `spreadDeg` / `burstCount` fields on `RangedSpec` (`09`), *not* a ballistic id:

| emission | how | fields |
|----------|-----|--------|
| single | one shot (baseline) | — |
| spread | shotgun cone of pellets | `bullets` `spreadDeg` (exist) |
| burst | N shots over a few ticks per trigger | `burstCount` `burstGapTicks` (new) |
| radial | ring / spiral emitter (bullet-hell) | `bullets` + `spreadDeg` ≈ 360 |

**Ballistic** (`ballistic: BallisticId`) — a per-tick velocity rule, integer/brad, deterministic (`06`/`07`). Catalog + params live in `09`. **Shipped 2026-07-24 (ROADMAP 1.1, `ENGINE_VERSION` 15/16):** `straight`/`homing`/`lob`/`beam`/`boomerang`, plus `orbit` + the radial `pattern` (tier 4 below) — the whole Frame axis (tiers 1-4) is closed, no ballistic/pattern remains unshipped:

| ballistic | behavior | params |
|-----------|----------|-----------|
| `straight` | line (baseline) — shipped | — |
| `lob` | flies like `straight`; on natural lifespan end ("landing") detonates an AoE blast through the normal resist/status hit path instead of despawning — shipped (`content/ballistics.ts`) | `blastRadius` |
| `homing` | turns `vx/vy` toward the nearest opposite-faction actor each tick, ≤`turnRateBrad`, speed preserved — shipped | `turnRateBrad` |
| `boomerang` | reverses velocity once at `returnAfterTicks`, hitting each way — shipped | `returnAfterTicks` |
| `beam` | frozen hitscan line at the fire-time origin/facing (does not track the shooter or move); damages every opposite-faction actor on the line on a `state.tick % beamTickInterval` global cadence (same lockstep pattern as DoT, `07`), for `beamTicks` total — shipped | `beamTicks` `beamTickInterval` `beamRange` |
| `orbit` | orbs circling the actor / deployables — shipped (`content/ballistics.ts`'s `orbitStep`) | `orbitRadius` `orbitAngularVelBrad` |

Showcase weapons per new frame (`content/weapons.ts`): `scattergun` (spread emission), `seeker` (homing), `mortar` (lob), `lasercutter` (beam), `tomahawk` (boomerang), `hammer`/`spear` (melee frames below) — all physical, so each frame's own behavior reads clearly independent of the element layer.

### The Frame axis — melee

Melee has no ballistic; its frame is the **swing shape** (`arcDeg` × `rangeGrid` × `swingSec`). That shape doubles as a **parry-frequency axis** — a fast narrow frame parries often (many swings), a wide slow one bats a big sector at once. Every melee frame keeps `deflect: true`, so the ranged-vs-melee trade-off (below) is untouched.

| melee frame | feel | parry character |
|-------------|------|-----------------|
| `dagger` | short arc/range, low cd, low dmg | dense small windows |
| `saber` | balanced (shipped) | baseline |
| `hammer` | wide arc, high knockback, slow — shipped (ROADMAP 1.1) | one big deflect sector, crowd control |
| `spear` | narrow arc, long reach — shipped (ROADMAP 1.1) | deflect / poke at distance |

### Landing order

**Shipped 2026-07-24 (ROADMAP 1.1, `ENGINE_VERSION` 15):**

1. ✅ `spread` — emission jitter drawn from `combatPrng`; a single-pellet weapon draws nothing (unchanged baseline).
2. ✅ `homing`, `lob` — tracking + AoE-on-landing.
3. ✅ `beam` — frozen hitscan line, damage on a global tick cadence.
4. ✅ `boomerang`, plus melee `hammer`/`spear` (pure data — `MeleeSimSpec` needed no new mechanic).
5. ✅ `orbit` + radial `pattern` (ROADMAP 1.1 closeout, `ENGINE_VERSION` 16) — the Frame axis itself has nothing left unshipped.

**✅ `k_*` on-hit procs — first concrete batch shipped (`ENGINE_VERSION` 28).** The
placeholder id prefix now has real content, a first-pass design decision (revise
freely — nothing here is locked the way Frame×Element is): `k_lifesteal` (heal the
firing player by a ‰ of damage dealt, works for both ranged and melee since `applyHit`
is the one shared funnel both go through) and `k_ricochet` (a bullet retargets to the
nearest OTHER hostile within range instead of expiring, up to N times, preserving its
speed). Two showcase weapons carry them: `leech` (melee, lifesteal) and `carom`
(ranged, ricochet). Found and fixed a real, adjacent bug while wiring ricochet's
"what happens to a bullet after a hit" branch point: `RangedSpec.piercing` had been
authored since Stage C but never converted or read anywhere — a "piercing" weapon
behaved identically to a non-piercing one this whole time. All three now share one
decision in `HitResolveSystem`: ricochet first, else pierce (remembering hit ids so a
still-overlapping body isn't hit twice), else expire (the original default).

## Deflect / parry (core mechanic)

Deflect is **part of the melee attack — not a separate state or button.** Pressing attack with a melee weapon produces one swing sector (a fan centered on facing, `arc` half-angle + `range` radius; different weapons have different arc and range). During that swing, within the SAME sector:

- **Enemies** in the sector take the swing's damage (once per swing).
- **Enemy bullets** in the sector are deflected: faction flips to player, velocity is redirected toward the nearest enemy (or mirror-reflected when the arena is clear), and a deflect flash plays (additive on the fx layer).

So there is no `isBlocking`, no block key, no separate `blockArc` — the arc that hits enemies is the arc that bats bullets back. A per-weapon `deflect: bool` gates whether a given melee weapon can parry at all (the ranged-vs-melee trade-off: ranged loadouts get no parry).

- Extensible: perfect-swing timing window for a damage bonus, etc.

> This makes "swing your melee through an incoming bullet, and it flies back at the enemy" work — the pivot of the differentiated gameplay. It rewards *timing the swing*, not holding a button. The demo implements a minimal version.

## Parameterization & extension

Weapons should be **data-driven** as much as possible: one shared ranged/melee implementation derives many weapons from config.

```
RangedSpec { fireRate, bullets, spread, speed, damage, damageType, pattern }
MeleeSpec  { arc, range, damage, damageType, knockback, deflect: bool, deflectSpeed }
           // the swing's arc+range is BOTH the damage sector and the deflect sector
           // damageType: 'physical'|'fire'|'ice'|'lightning'|'poison' (omitted = physical)
```

Adding a weapon = adding a config row (+ code only for special behavior), not hard-coding each one.

- **Mounting (universal socket).** A weapon renders as a sprite on one of the character's two **orbiting weapon-socket** attachment points, following that socket's aim rotation every frame (`02`/`12`/`13`); swapping the active slot swaps which socket fires. The socket is a **universal mount** — its base is identical for every weapon, only the business end (barrel / beam emitter / crystal blade / hammer head) differs — so there is **no `grip` and no per-weapon hold pose**: one arm-agnostic mount holds any frame, ranged or melee, and any character holds any weapon (a character's theme lives on the orb, never on the weapon — `13`). A melee frame's swing is the socket **sweeping its `arc`×`range` sector around the core** — that swept sector is the same one that damages enemies and deflects bullets (above) — and the socket's **tether length maps to melee reach** (short = dagger, long = spear). Mounting is render-only — it never touches the sim (`06`).

## Verified in the demo

- Ranged gun: click to fire, emits a straight bullet.
- Melee sword: click to swing; the swing damages enemies in its arc **and** deflects enemy bullets caught in that same arc back at enemies — no separate block input.
- `[1]`/`[2]` swap the active weapon slot. Weapon positions by facing, with local z-order switching.

## Pickup & switch (shipped — see `05`)

Weapons are **not** auto-picked-up (unlike materials/consumables) — swapping your weapon is a choice, so it stays click-driven:

- **Weapon-pickup panel (render-only, click-to-collect) — shipped (ENGINE_VERSION 32, replacing the single-nearest "ground compare card" + tap-INTERACT gesture below).** Standing near one or more floor weapons pops a non-blocking panel listing every one of them (real icon — the same business-end art the rig mounts, `render/weaponSkins.ts` — + name); tapping a row IS the pickup action, closing just leaves them all on the floor. The panel itself is pure client render (`ui/pickupProximity.ts#nearbyWeaponPickups` + `ui/WeaponPickupPrompt.ts`, driven by `HudView`), same non-blocking-overlay shape as the portal popup (`10`) — the run keeps simulating while it's open, never a modal (still impossible under lockstep, `06`). The *click itself*, unlike the panel's rendering, does touch the sim: it sets `PlayerCommand.pickupTargetId` (a one-shot latch, `CommandBuilder.requestPickup`, same convention as the portal popup's `CONFIRM_EXTRACT`/`CONFIRM_DESCEND`), and `PickupSystem`'s weapon-kind branch collects only when that id matches an alive item within `SIM.lootRevealRadius` — server-authoritative, exactly like every other pickup kind's overlap check.
- **Swaps it into the active slot** and the **replaced weapon drops back onto the floor** (`02`); the switch button chooses which of the two slots to overwrite. No manual drop button. `applyWeapon` (`PickupSystem.ts`) pushes the outgoing weapon as a fresh floor `PickupItem` before overwriting the slot — unchanged from before, only the trigger gesture (click vs. INTERACT) moved.

## To design

The composition model, frame library, and landing order are now locked (above); the affix layer is **removed** (Frame × Element only — ROADMAP 0.1, `ENGINE_VERSION` 9→10) and **intrinsic rarity is shipped** (ROADMAP 0.2 — `RarityTier` white→gold + `RARITY_TIERS` quality mult, applied at weapon convert time; `balance/rarity.ts`). What remains is content + tuning:

- Per-frame numbers and the `WeaponSpec` rows for each frame × element × rarity (values live in `09`'s `content/weapons.ts`). Every weapon already carries a `rarity` (placeholder tiers); the frame library beyond `straight`/`saber` shipped first-pass physical showcases (ROADMAP 1.1) — elemental variants of each new frame (a fire mortar, a lightning beam, …) are still open content work.
- The five rarity base-quality tiers' *final* numbers (first-pass shipped) and the ornament/emissive overlay that makes rarity read off the weapon sprite (`14`/`12`, render-side).
- Config format/loading is `09`'s open question (TS for balance vs JSON for tool-authored data).
