# `@dd/engine` — deterministic simulation core

The single authority on game outcomes. Everything a match resolves — movement, ballistics,
collision, damage, drops, extraction, revive, the PvP zone and win condition — happens here.
The client, the server, the two authoring tools and the offline balance harness all consume
this package as **TypeScript source** (no build step between packages), so a shared type can
never go stale against a built artifact.

Design docs: `design/06-netcode-determinism.md` (why determinism, and the rules),
`design/08-simulation-core.md` (state schema + step order), `design/07-collision-combat.md`
(the bodies of steps 4–9), `design/09-content-data.md` (what data it reads).

## The rules that make it deterministic

Break one of these and two clients desync — silently, minutes into a match.

- **No host APIs.** No Pixi, no DOM, no `window`, no timers, no I/O. This is enforced by the
  compiler, not by review: `tsconfig.base.json` sets `lib: ["ES2020"]` and this package —
  unlike `client/` — never adds `DOM` back, while its own `tsconfig.json` narrows `paths` to
  itself alone. Touching a browser global or importing another package is a type error.
- **No floats in stored state.** Positions, velocities and angles are fixed-point (`Fp`,
  `math/fixed.ts`) and brad angles (`math/trig.ts`, table-driven trig). Content is *authored*
  in human units (seconds, grid-units/second, degrees) and converted exactly once at
  construction (`content/convert.ts`). Raw floats never survive past construction.
- **No ambient randomness.** `Math.random` does not appear. Every draw comes from a seeded
  `Prng` stream on `GameState` (`math/prng.ts`), and a stream is only drawn from when the
  outcome actually depends on it — a conditional draw changes every later draw.
- **Ordered collections only.** Entities live in arrays; push order is spawn order is
  iteration order. Nothing iterates a `Set`/`Map`/`Object.keys` in a way that leaks insertion
  or hash order into state.
- **The step order is frozen.** Reordering systems changes outcomes. So does changing an
  iteration order, a rounding rule, or a hashed field.

Any change that moves outcomes — or moves the replay hash at all — bumps `ENGINE_VERSION`
(`versionHistory.ts`, currently **39**, with the full per-bump history in
`ENGINE_VERSION_HISTORY.md`). `replay.ts` refuses to replay a mismatched version rather than
produce garbage.

## Layout

```
index.ts             the public surface — everything below is re-exported from here
versionHistory.ts    ENGINE_VERSION (full per-bump history in ENGINE_VERSION_HISTORY.md)
config.ts            WORLD/knockback/shield-regen and other cross-cutting sim constants
sim.config.ts        TICK_RATE and the sim-wide constants
GameEngine.ts        the orchestrator: step(commands) in the frozen order, plus the
                     InputSource-driven advance(frame) used by replay and netcode
replay.ts            headless run + state serialization/hashing, version-guarded

math/                fixed-point, seeded PRNG, brad angles + table trig
state/               GameState, entities, per-tick PlayerCommand, input quantization, events
systems/             one file per step (see the order below) + shared helpers
                     (combat.ts, targeting.ts, spatialGrid.ts)
content/             all gameplay numbers as plain data: weapons, enemies, skins, rooms,
                     arenas, drops, materials, damage types, human-unit conversion
balance/             the build wall: rarity tiers, run buffs, and the run/arena builders
                     that make it compile-time impossible to leak crafted gear into PvP
world/               room pieces + seeded floor generation
net/                 the wire protocol, FrameBroadcast (pure relay) and NetInputSource
```

## The step order (`GameEngine.step`)

```
 1 ApplyInput      9 DeathDrops
 2 AIDecide       10 Pickup
 3 WeaponFire     11 Spawn            (PvE)
 4 Movement       12 Extraction       (PvE, floors mode)
 5 ProjectileStep 13 Revive           (co-op downed/revive)
 6 Deflect        14 WinCondition
 7 HitResolve
 8 StatusEffect   8a Zone / 8b Environment  (PvP, arena mode)
```

Before step 1, every tick draws once from `integrityPrng` and discards it — the value is
never read by any system; only the cursor position matters, because it is hashed into the
anti-cheat checkpoint (`design/15`).

## Working on it

```bash
npm test -w engine          # vitest, 568 tests
npm run typecheck -w engine # tsc --noEmit, DOM-free
```

Every engine change ships with unit tests. Determinism itself is covered by self-consistency
checks — two fresh runs of the same seed + input stream must hash identically — rather than a
committed golden fixture, so there is no fixture to regenerate.

`GameState.test.ts`, `systems/*.test.ts` and `replay.test.ts` are the places to look first
when adding a system; `content/*.test.ts` and `balance/*.test.ts` guard the data model and the
PvP fairness wall.
