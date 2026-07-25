# PvP arena: battle royale, zone, environment, anti-cheat

The concrete design behind `05`'s PvP section (ROADMAP Phase 4.1, decided). This is the single source of truth for the **`ArenaMap`/`ArenaRoom`/`CellTrait` schema** (the map editor's output contract), the **shrinking-zone stage machine**, the unified **`EnvironmentSystem`** that drives both zone damage and authored hazard tiles, the **team/hostility model** PvP needs that PvE never did, and the **PvP-specific netcode additions** (periodic anti-cheat checkpoints, sparse input sync) that extend `06`.

## The decisions (locked)

- **Battle royale: 8-player solo, elimination + shrinking zone.** Not a symmetric team arena. Every seat is its own `teamId`; squads are a reserved data shape, not a built feature (below).
- **The zone is a room graph shrinking toward an eye, not a geometric circle.** Rooms are the unit of "safe" — this avoids carving a circle through walls a player physically cannot reach, which a raw-radius zone would do on an indoor map.
- **AI is hazard *and* farm, hostile to every seat.** Reuses PvE's `ENEMY_BLUEPRINTS` (`09`) verbatim — no separate PvP roster.
- **Loot is arena-scoped, same drop *model* as PvE, zero connection to a player's account.** Landing kit is a small opener; the arena's own loot table is the real power curve (`05`).
- **One ~60-room hand-authored map at launch, produced by a dedicated map editor** — not a procedural layout. The editor is the authority on room layout, doors, monster placement, loot markers, and per-cell hazard traits; the engine only consumes the produced data.
- **Anti-cheat is a periodic, cross-client consensus check** (below), not a single end-of-match verdict — but it only activates above a quorum, and only kicks on a *confirmed*, non-transient divergence.
- **Net transport moves to sparse, held-until-changed input deltas** (below), matching the sibling project `funny`'s model, chosen specifically so a future move to full state-sync is a payload-type swap, not a re-architecture.

## ArenaMap — the map editor's output contract

Structurally closer to `09`'s hand-authored `RoomPiece` library than to the seeded `generateFloor` dungeon assembly — nothing here is procedurally generated at runtime except which *pre-authored* candidate is picked (the eye room, the per-seat spawn assignment).

```
ArenaMap {
  id, sizeGrid                 // total map extent — the WHOLE map is one SIMULTANEOUSLY co-resident
                                //   live world (unlike a PvE floor's 5-10 rooms, 05, which are real
                                //   but visited SEQUENTIALLY — one room live at a time, 09); here
                                //   every room co-exists at once
  rooms: ArenaRoom[]           // ~60 at launch
  doors: Door[]                // EXPLICIT adjacency — never inferred from rect adjacency (below)
  spawns: Point[]              // >= seat count; system-assigned per match, no player choice
  eyeCandidates: EyeCandidate[]  // candidate final-circle rooms; one drawn per match (below)
}

ArenaRoom {
  id
  rectGrid: { x, y, w, h }     // this room's bounds within the map — used for both the
                                //   room-membership test (below) and the BFS adjacency graph
  solids: AabbGrid[]            // same vocabulary as 09's RoomPiece.solids
  pillars?: PillarGrid[]        // same as RoomPiece.pillars
  cellTraits?: CellTrait[]      // editor-placed hazard tiles (spikes, freeze, ...) — below
  encounter?: WaveScript        // reuses 09's WaveScript/WaveEntry verbatim — same format the
                                //   PvE dungeon uses, editor-authored per room (not procedural)
  lootMarkers?: LootMarker[]    // { point, tableId } — arena-scoped DropTable (09), not PvE's
  props?: PropPlacement[]       // render-only, same as RoomPiece
}

Door {
  roomA: RoomId; roomB: RoomId
  passageGrid: AabbGrid         // the walkable opening between the two rooms
}

EyeCandidate { roomId: RoomId; weight?: number }   // weight=0 (or omitted default 1) never final
```

Two structural rules, both load-bearing:

- **Adjacency is `doors`, always explicit — never inferred from `rectGrid` proximity.** Two rooms sharing an edge with a solid wall between them are *not* adjacent; inferring adjacency from geometry would silently create a false connection there. The BFS shrink model below (§ zone) is only correct if the adjacency graph is exactly what the editor actually placed doors for.
- **Room membership is a point-in-rect test against `rooms[].rectGrid`**, not a derived quantity. An actor's current room is cached (`actor.roomId`) and re-checked only when it crosses a room's rect boundary — the movement system already knows when that happens, so this is O(1) amortized, not an O(60) scan every tick.

### `CellTrait` — authored hazard tiles (spikes, freeze, etc.)

```
CellTrait {
  id
  rectGrid: AabbGrid           // the tile/area this trait covers
  kind: 'spike' | 'freeze' | …
  timed: bool                  // false = always-on; true = phased (below)
  // always-on (timed: false):
  //   effect applies every tick an actor overlaps rectGrid — same shape as zone damage (below)
  // phased (timed: true):
  phase?: { armTicks, activeTicks, offsetTicks? }   // its own cycle, e.g. spikes retract/extend
}
```

- **Always-on** traits are the simple case: a per-tick AABB-overlap check, structurally identical to the zone's per-room check (below) — both are "is this actor's position inside a triggering region right now," which is exactly why they share one system (`EnvironmentSystem`, below) instead of two.
- **Phased** traits need their own tick-indexed phase state per trait instance, held in `GameState` (so it replicates/replays deterministically) — a small state machine per trap (`armed → active → armed → …`), same shape as the zone's own warn/hold phase machine (below), just running on its own cycle instead of the zone's global stage clock.

## The zone: room-graph shrink

### Eye selection and the safe-set rule

```
1. Match start: draw one eyeCandidate by weight via ringPrng  → eye: RoomId
2. BFS over the doors graph from eye, using rooms[]/doors[] in their AUTHORED array
   order (never a Set/Map — 06's "no hash/insertion-order leak into state" rule
   applies here exactly as it does everywhere else) → dist[room] for every room
3. Stage k's safe set = { room : dist[room] <= R_k },  R_k monotonically decreasing
```

**Why this rule and not "randomly pick rooms to poison":** `dist <= d` is, by construction, always a connected region (every room in it has a path to `eye` staying inside it, since distance is monotonic along that path) and strictly shrinks as `R_k` decreases (nested, never relocates). A random per-stage pick can sever connectivity — a safe room can end up encircled by poison with no reachable path out, an unwinnable trap the room-graph rule structurally cannot produce.

### Stage machine: warn → close → hold

```
WARN(warnTicks)   the next stage's soon-to-close rooms are flagged `closing` (HUD/telegraph only,
                   no damage yet)
CLOSE             closing rooms → `poisoned`, damage starts
HOLD(holdTicks)   stable period — this is where fights happen
→ next stage
```

- **The eye pool itself, and the full future stage schedule, are never precomputed and stored.** Only the *current* stage's data and the *next* stage's `closing` set (needed for the WARN telegraph) exist in `GameState` at any time — later stages are derived from `ringPrng` lazily, at the tick the previous stage ends. This isn't primarily an anti-cheat measure (see § anti-cheat below for why full-map content doesn't hide this way) — it's just the natural shape for "the schedule literally doesn't exist yet," and it does still remove the *one* thing that's genuinely runtime-randomized (which eye was drawn, and how the schedule unfolds) from being knowable ahead of the reveal.
- Stage count, per-stage room-count targets, `warnTicks`/`holdTicks`, and the per-tick zone damage are content numbers in `@dd/engine` config (`09`'s "numbers live in one place"), tuned against the **PvP-scaled** HP range (below) — a first-pass table is 4.3 tuning work, not part of this doc's locked shape.
- **The last stage (1 safe room) has no further shrink — only escalating damage.** This gives the match a hard time bound without a separate timeout/draw branch in `WinConditionSystem`: pushing every survivor into one room with ever-increasing zone damage makes indefinite stalling structurally impossible, so there is no need for a tie-break-by-timer path.

### Sim state and events

```
state.zone = {
  eye: RoomId
  stage: number
  phase: 'warn' | 'hold'
  ticksToPhaseEnd: number
  safe: RoomId[]
  closing: RoomId[]        // only the NEXT stage's soon-to-close set — nothing further ahead
}
```

Events: `zone_warn { stage, closing }`, `zone_close { stage }`, `zone_damage { target, dmg }` — render/HUD/minimap read these; they never feed back into sim decisions (`06`'s render/logic split, unchanged).

## `EnvironmentSystem` — one step, two data sources

A new engine step (after `StatusEffectSystem`, same global-tick-cadence style as burn/poison — see `07`'s `DOT_INTERVAL` precedent) that, per actor per tick:

1. Is the actor's cached `roomId` in `state.zone.safe`? If not → apply zone damage via `takeDamage(state, actor, dmg, src, 'zone')` (reuses the existing shield-first-absorb / `ticksSinceHit`-reset / shield-break-trigger path `takeDamage` already provides — **standing in poison correctly blocks shield regen**, for free).
2. Is the actor's position inside any **always-on** `CellTrait` rect, or inside a **phased** trait currently in its `active` phase? → apply that trait's effect the same way.

Both checks are "position vs. a triggering region," which is why one system handles both — not two parallel damage-over-position systems. AI enemies go through the same check as players (§ AI below) — no special-casing needed for "does the zone kill monsters too," it just does.

`zone`/trap damage has **no attacker identity** (same shape as `StatusEffectSystem`'s DoT — `07`'s existing "`src` is derived from the opposite faction" precedent doesn't apply here since there IS no faction on the other side; `takeDamage`'s `src` parameter for environmental damage is a new literal, e.g. `'environment'`, not a team).

## Team / hostility model (new — PvE never needed this)

PvE's two-member `Faction = 'player' | 'enemy'` union (`entities.ts:18`) and its ~14 `faction === 'player' ? enemies : players`-shaped ternaries are structurally a **2-faction assumption**, and today **player-vs-player damage does not exist** (same-faction bullets pass through each other; melee only iterates the enemy array; `DeflectSystem` only deflects enemy-faction bullets). PvP requires:

- **`teamId: number` on `Actor` and `Projectile`**, separate from seat `owner` (`state/commands.ts`) — solo BR sets `teamId = owner` (one seat, one team), but the field's existence, not its value, is what "leaves the squad interface open" (`05`) — squads will simply assign the same `teamId` to multiple `owner`s, no schema change needed when that day comes.
- **A single `isHostile(a, b)` predicate** replacing the ~14 faction ternaries (`combat.ts`, `StatusEffectSystem.ts`, `HitResolveSystem.ts`, `ProjectileStepSystem.ts`, `DeflectSystem.ts`, `AIDecideSystem.ts`, `WinConditionSystem.ts`) — AI keeps a reserved `teamId` (e.g. `-1`) hostile to every player `teamId`; two players are hostile iff their `teamId`s differ. This is a `ENGINE_VERSION`-bumping change (it changes what a bullet can hit) and is a prerequisite for arena work, not a part of it — flagged as its own ROADMAP line, not folded into "`buildArenaSpecs`" the way the original ROADMAP draft implied.
- **Melee and deflect need to stop being enemy-array-only.** Once `isHostile` exists, the melee arc and `DeflectSystem` iterate all hostile actors' projectiles/bodies, not hardcoded `state.enemies` — this is what makes player-vs-player melee and parry-stealing-a-rival's-bullet actually possible, which today they structurally are not.

## AI in the arena

- **Same `ENEMY_BLUEPRINTS` as PvE** (`09`) — no new content type.
- **Encounters are fully editor-authored per room** (`ArenaRoom.encounter: WaveScript`), not randomly rolled — the map editor places exactly which monsters go where, same format PvE already uses. There is no PRNG involved in *what* spawns, only in the zone eye and per-seat spawn assignment.
- **Activation is lazy for performance, not for information-hiding.** A room's `WaveScript` only starts dispatching (and `AIDecideSystem` only runs for its actors) once a player first enters that room — pure perf (no need to think for 60 rooms' worth of monsters simultaneously). Since the whole map ships bundled with the client (`09`'s open question leans this way; see § anti-cheat for why this matters), lazy activation does **not** hide monster placement from a client willing to read its own asset bundle — see below.
- **AI drops feed the arena's loot table, not the PvE material bank.** Killing arena AI drops weapons/buffs/heals exactly like a PvE floor; it never touches `state.bankedMaterials` — PvP simply never runs `ExtractionSystem` (`05`'s economy table already says "PvP: normalized out" for materials; this is that rule applying in both directions).

## PvP HP/weapon scaling

`buildArenaSpecs(presetId, skinId)` (`09`) applies a **single scale factor** to both halves of the fight — a character's `(maxHp, maxShield)` and the landing-kit/arena-loot weapons' damage/handling — so relative time-to-kill matches PvE's feel at a bigger absolute number range (PvE's 3–10ish HP pool leaves no room for a shrinking-zone DoT curve to matter; see `05`). This is a **second tuning pass over the same `SkinDef`/`WeaponSpec` content**, applied at the arena-build boundary — not a second content set, and not a change to the PvE numbers themselves. Exact factor and the zone damage curve are content-tuning (ROADMAP 4.3), not part of this doc's locked shape.

## Placement, elimination, win condition

- `WinConditionSystem`'s `Winner = number | 'enemies' | null` (`entities.ts:21`) needs a **placement vocabulary**, not a single winner id: as each seat is eliminated (zone/AI/player damage takes them below the floor with no revive to catch them, since squads/revive are not live at launch — see `05`), record its finish order. The last seat standing is 1st.
- **Same-tick double-elimination tiebreak: deterministic, not a coin flip.** If two seats hit zero on the identical tick, break the tie by ascending `teamId` (lower `teamId` places higher) — arbitrary but fixed and replay-stable, so no new PRNG draw is needed for something this rare.
- `MatchRoom.reportResult`'s `reason: 'extract' | 'wipe' | 'disconnect'` (`server/src/MatchRoom.ts`) needs a PvP branch (e.g. `'placement'`) carrying the finish-order array, since neither existing reason describes "ranked 1st through 8th."

## Anti-cheat: periodic checkpoints, not just an end-of-match verdict

Extends `06`'s existing `runHeadless` backstop (today: one re-simulation, done after the match, from `seed + recorded input`) into something that can act **during** a match, using machinery the engine mostly already has.

### What actually gets compared

**No new "seed" concept needs to go on the wire.** `GameState` already contains every PRNG stream (`aiPrng`/`combatPrng`/`dropPrng`/`roomgenPrng`, plus a new `ringPrng`/`integrityPrng` below) as ordinary state, and `replay.ts` already computes a full deterministic state hash from it. "Compare everyone's seed" is exactly "compare everyone's `stateHash` at the same confirmed tick" — reuse the existing `ClientMsg.result: { stateHash, winner }` shape (`protocol.ts`), generalized from "send once at gameover" to "send every `checkpointTicks`" (a new `ClientMsg` variant, e.g. `{ type: 'checkpoint', tick, stateHash }`). Cadence is **tick-indexed, not wall-clock-timed** — driven by `state.tick % checkpointTicks === 0` so every honest client emits at the identical logical instant, rather than trusting each client's own clock to schedule the check.

### Consensus mechanism: cross-client majority (v1), server-shadow-sim (later)

Two ways to decide "whose hash is wrong," different cost/robustness trade-off:

| | Mechanism | Server cost | Robust when |
|---|---|---|---|
| **v1 (chosen)** | Server just collects each seat's periodic `stateHash` report and flags whichever value disagrees with the majority | **None** — the server today only relays frames (`FrameBroadcast`, `06`); this needs no new server-side simulation capability | Enough honest seats to form a real majority — solid at 8-player FFA |
| **Later escalation** | Server runs its own authoritative shadow copy of `@dd/engine`, driven by the same confirmed frame log it already produces, and treats its own hash as ground truth | Server must actually execute the sim per live match — a real new capability, though a natural extension of the already-headless `runHeadless` from "offline, post-match" to "incremental, live" | Any seat count, including matches too small for a majority to mean anything |

v1 is the right fit for launch: it needs zero new server-side simulation work, and 8-player solo BR is exactly the shape where "majority of 8" is a meaningful signal. The escalation path is explicitly the *same* future move already flagged in `06`'s anti-cheat posture (server-authoritative + fog-of-war) — when that day comes, both the ESP problem and the small-lobby consensus problem get solved by the same investment.

### Quorum and the kick rule

- **Below a quorum of >3 real seats in the match, run no consensus check at all.** Early low-population matches padded with bots are expected to be internally inconsistent in edge cases (each participant may locally see themselves as the winner) — accepted, not worth guarding against; "not enough honest signal to trust a majority of 8" and "not enough population yet to justify guarding it" are the same underlying reason.
- **Only kick on a *confirmed*, non-transient divergence — never on a single disagreeing report.** A client that is merely behind (catching up under the existing lag/backlog multiplier, `06`) can legitimately report a stale hash for a tick it hasn't caught up to yet; that is not a divergence, it just hasn't reached that tick's true state. The rule that avoids punishing this: compare hashes **for the same historical, already-confirmed tick number** (never "whatever tick each client currently claims to be at"), and require the disagreement to **persist across at least two consecutive checkpoints** for that seat before severing it. A transient one-off mismatch is far more likely to be a benign race in when the report was captured relative to a catch-up burst than an actual state fork; a repeat at the next checkpoint, at the same historical tick, is not.
- **Kicked seats reconnect through the existing path** (`ClientMsg.resume` / `ServerMsg.conn_resync`, `06`) — no new reconnect plumbing needed, only the new trigger that decides to sever in the first place.

### `integrityPrng` — a dedicated stream for "make divergence show up fast"

The instinct to draw from the PRNG in as many code paths as possible (even ones whose outcome doesn't matter — an "empty" roll on every projectile spawn, every damage instance, every actor refresh) is sound: it raises how much the state hash's PRNG contribution moves per tick, so a client that's actually diverged (skipping/altering logic a cheat would touch) shows up within a shorter window instead of possibly staying silently consistent for a long stretch. **Give these padding draws their own stream, `integrityPrng`, seeded from the match seed like the others but never read by any gameplay system.** Do **not** route them through `combatPrng`/`dropPrng`/`aiPrng` — those numbers *do* determine gameplay outcomes (spread jitter, loot rolls, AI decisions), and mixing padding draws into them would shift the sequence of real draws whenever an unrelated system's padding call count changes, making balance changes and gameplay-affecting bugs harder to reason about for no actual anti-cheat benefit (the padding-vs-hash-sensitivity goal only needs *some* stream to move fast, not specifically the gameplay ones). Same array-order rule as everywhere else (`06`) — padding draws still must not iterate a `Set`/`Map`.

### The honest limit: this catches tampering, not information cheats

Worth restating precisely, because it's easy to oversell: this entire mechanism — v1 or the server-shadow escalation, any `integrityPrng` density — can only ever catch a client whose **simulated state** diverges from the honest one (a patched client that fabricates HP, skips damage, teleports, etc.). It **cannot** catch a client that never diverges state at all and just **reads more than it should** (wallhack/ESP, aim assist) — that class of cheat submits perfectly legitimate inputs from a better-informed human, so every hash matches, always. Two things follow directly from the map being **hand-authored and shipped bundled in the client** (`09`'s leaning; unchanged here):

- **Lazy activation/lazy-eye-reveal is not an information-hiding measure** for anything the editor placed statically (room layout, doors, monster placement, loot markers, hazard traits) — a client willing to read its own shipped asset bundle already has all of that before the match even starts, regardless of when the *engine* activates it. The only things a client genuinely cannot know ahead of the runtime reveal are the parts that are **actually randomized at match time**: which `eyeCandidate` got drawn, and which seat landed at which spawn.
- **The map-design lever (cover density, sightline breaks — the editor's job, not code's) is the only thing that meaningfully narrows the read-only-information-cheat gap**, and even that only reduces its *value*, not its existence. The structural fix — server-authoritative state + fog-of-war culling — stays exactly where `06` already placed it: an explicit future escalation, not a launch commitment.

## Net: sparse input deltas (extends `06`)

A parallel change to the transport, chosen so a future move to full state-sync only swaps *what* is sparse, not *how* sparse updates are consumed:

- **A `PlayerCommand`'s meaningful fields (`moveBrad`/`moveMag`/`aimBrad`/`buttons`) are transmitted only on change, not resent every tick.** The receiving side (engine input source) holds the **last received command per owner** and reuses it for every tick until a new one supersedes it — this is the same "held input" model the sibling project `funny` uses, and it is how a twin-stick game should behave anyway (a player holding a direction steady has nothing new to say).
- **"Changed" for aim reuses the existing brad quantization**, not a raw-float delta threshold: aim is already quantized to an integer brad for determinism (`06`); an update is worth sending only when the *quantized* value changes, which naturally coalesces sub-quantization stick jitter into "no change" — one existing mechanism doing double duty (determinism *and* now compression), not a second threshold invented on top.
- **Buttons are already edge-shaped** (`FIRE`/`SWAP_WEAPON`/`INTERACT` bit flips) — a press/release is inherently a change; nothing new needed there.
- **This is a wire-format change only — the engine still receives a command for every simulated tick internally** (gaps are filled by holding the last one), so nothing about `@dd/engine`'s determinism or `ENGINE_VERSION` moves. It lives entirely in `net/protocol.ts` / `FrameBroadcast` / `NetInputSource` and their client counterparts.
- **Why this specifically sets up a future state-sync swap for free:** the client-side reconciliation layer this needs (extrapolate/hold between sparse updates, correct — snap or lerp — when a new one arrives) is **exactly** what `LocalPredictor` (`06`, ROADMAP 3.3-follow-up) already does for the local player's movement/aim. The day the project can afford a server that runs real simulation authority (the same escalation named in both the anti-cheat section above and `06`'s original anti-cheat posture), the payload that arrives sparsely changes from "an input that gets applied" to "an authoritative position/state delta" — but the "hold, then reconcile on arrival" consumption pattern on the client is unchanged. Building the sparse/held-update discipline now, even for the cheaper input-relay model, means that switch is a payload-type change, not a rewrite of the client's update-consumption logic.

## Relationship to the other docs

- **`05`:** the PvP section there is the summary; this doc is its full schema and the ROADMAP 4.1 answer.
- **`09`:** `ArenaMap`/`ARENA_PRESETS`/`buildArenaSpecs` slot into the existing `world/arenas/*.ts` config layout; `CellTrait`/zone state are new `GameState` fields alongside the existing `RoomPiece`/dungeon shape.
- **`06`:** the anti-cheat and sparse-sync sections here are additive extensions of its netcode model and anti-cheat posture — no change to the frame-broadcast-lockstep decision itself, and no `ENGINE_VERSION` implication (both are `net/`-layer, outside `@dd/engine`'s deterministic core, except the `teamId`/`isHostile` refactor which is explicitly called out above as its own version bump).
- **`14`:** the PvP fairness wall (weapons structurally walled, characters the one exception) is unchanged by any of the above.

## To design

- Exact zone stage count / per-stage room-count targets / `warnTicks`/`holdTicks` / zone damage curve, tuned against the PvP HP scale factor (real play required).
- The PvP HP/weapon scale factor's actual value.
- The arena's own `DropTable`/loot-marker weighting (analogous to PvE's `DropTable`, `09`, but a separate arena-scoped table).
- Squad revive numbers, once squads are actually scheduled: bandage cost, channel time, whether downed is invulnerable in PvP (leaning "no," per `05`).
- `checkpointTicks` cadence and the exact "confirmed divergence" persistence window (">=2 consecutive checkpoints" above is a first-pass proposal, not tuned).
- Map-editor file format / round-trip tooling for `ArenaMap` (mirrors `09`'s open "TS modules or JSON" question for `RoomPiece`).

## Open questions

- Server-shadow-sim escalation and server-authoritative state-sync (this doc's anti-cheat and net sections) are both explicitly deferred until population/revenue justify the server cost — tracked here so it isn't a surprise later, not because it's undecided in principle (`06` already named the same escalation for a different reason).
- Whether `eyeCandidates` ships as a handful of authored options (current assumption) or eventually itself becomes a larger pool for map variety at scale — not blocking with one launch map.
