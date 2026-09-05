# Work log — 2026-09-05: a floor gives you less, and lets you choose

Volume 36. One pass, two `ENGINE_VERSION` bumps, because the two halves are separable and the
history is worth being able to read apart afterwards.

Indexed from [`../ROADMAP.md`](../ROADMAP.md).

## A floor's loot gets an allowance (2026-09-05, engine, `ENGINE_VERSION` 57)

Design call from the game's owner:

> The drop rate in the levels is too high. I want each floor to produce only 2 to 3 weapons.
> And monsters should have a very low chance of dropping a health potion — the core of this
> kind of game is trying to clear it without taking damage.

### The measurement came first, and it changed the plan

Before touching a weight, `client/sim/pveLevelSim.sim.ts` grew a per-floor loot table
(`sim/pve/report.ts#floorDropStats` + `DropRecord`/`killsByFloor`/`checkpointFloors` on
`levelSim.ts`). Sixteen real bot runs of the shipped level, printed on every sweep from now on:

| | before |
| --- | --- |
| health potions per kill | **0.215** (7-10 a floor) |
| weapons per completed floor | **1.8 avg, range 0-5** |
| most weapons in one room | **3** |

Nothing was broken. `DROP_TABLE` said 18/84 potions and 5/84 weapons and delivered exactly
that — the table was tuned for a different game than this one turned out to be. What the
numbers *did* change is the shape of the fix: a floor swinging 0 to 5 weapons is a variance
problem, and no weight can solve a variance problem.

Two smaller things the measurement pass had to get right, both of which would have quietly
poisoned the numbers:

- **A weapon a player drops by swapping is not a drop the table produced.** `PickupSystem`
  puts the outgoing weapon back on the floor as a fresh pickup, and counting those inflates
  precisely the number being measured. Excluded by the one signal available: a swap-drop can
  only appear on a tick where a weapon was collected.
- **A team wipe pushes a `win` event too**, with `winner: 'enemies'`. The first version of the
  tracker counted that as reaching a checkpoint, and the first real sweep printed "floor 0: 8
  of 8 visits complete" on the same screen as "5 of 8 runs died in r4_forge". Fixed, and
  pinned by a regression test, because every per-full-floor number depends on that denominator.

### Potions: 18 -> 2, and the shield does the sustaining

21.4% of kills to 2.4%. The 16 points went to `material`, not off the total, so `weapon` and
`buff` keep the exact per-kill odds they had — the weapon COUNT is a separate mechanism, and
folding a weight change into the same version would have made the two impossible to read apart
later. `effectiveWeights` preserves that same invariant when a floor card multiplies the heal
weight, so stacking the potion card never quietly makes weapons rarer.

What replaces drinking is the shield's own idle regen, which was already there and was being
drowned out. "Clear it without getting hit" cannot be the goal in a game that refills you every
fifth kill.

### Weapons: a per-floor allowance, in three parts

The weight keeps setting the PACING; a quota sets the COUNT.

1. **2 or 3, rolled once per floor** when the floor is placed — `SpawnSystem`'s fresh-floor
   path, the one place floor 0's first placement and every descend both pass through, so the
   two are allocated by the same line rather than by a constructor and a descend handler that
   have to be kept in step. A range and not a constant on purpose: a fixed 2 turns the third
   weapon's absence into information, and the point is scarce loot, not predictable loot.
2. **One weapon per room** (`DungeonRoomRuntime.weaponDropped`). The quota bounds the count;
   this bounds the concentration. Without it a floor satisfies "2-3 weapons" by dropping all of
   them off the first garrison — which the baseline already showed happening.
3. **The shortfall is paid when the floor finishes**, so the range is a guarantee in both
   directions instead of a ceiling with a bad tail.

A rolled-but-disallowed weapon degrades to a `material` **at the same PRNG draw count** the
weapon would have cost. That is what lets the allowance be retuned later without shifting where
every subsequent drop in the run lands.

### The guarantee had a hole, and the sweep found it

"Drop the shortfall on the boss's body" was the owner's call, and it needs a boss. Four of the
shipped level's five floors end in `ember_l1_extraction`, which has **zero enemy spawns** —
so on 80% of floors nothing ever died in the capstone and the make-up drop never fired. The
first post-change sweep said so out loud: completed floors reading 1-3 weapons against a 2-3
quota.

`systems/floorLoot.ts` is the fix: one `payFloorWeaponShortfall`, two trigger sites. A boss
floor pays on the body the tick its garrison falls (`DeathDropsSystem`, step 9); a floor whose
capstone is an empty extraction room pays at that room's centre when the checkpoint opens
(`ExtractionSystem`, step 12), because there is no body to put it on. Idempotent, so the
checkpoint one can sit in a block that re-runs every tick the portal is open.

"Last live enemy" is measured as *no other enemy in that room with `hp > 0`*, deliberately not
as `!rt.hasLiveEnemy` — that flag is `DoorSystem`'s and is recomputed two steps later, so
during step 9 it still describes the room before this tick's deaths. The `hp > 0` test is exact
regardless of iteration order, and it gets the boss-adds case right for free: `onDeathSpawn`
minions are pushed at full HP before the check runs, so a boss that splits does not count as
the room's last enemy.

### After

| | before | after |
| --- | --- | --- |
| health potions per kill | 0.215 | **0.022** |
| potions per floor | 7.4 - 9.7 | **0.8 - 1.3** |
| weapons per completed floor | 1.8, range 0-5 | **2-3, range 2-3** |
| most weapons in one room (kill drops) | 3 | **1** |
| weapons per kill | 0.051 | 0.054 (deliberately unchanged) |

The difficulty cost is real and was measured too: the aggressive bot profile fell from ~967
ticks and 21.9 kills a run to 246 ticks and 6.9, dying in the first room. That direction is the
point of the request, and the cards below give the power back — the careful profile's average
floor reached went 0.8 -> 0.6 on the loot change alone and back to 0.8 once cards were in.

## The reward at a checkpoint becomes a choice (2026-09-05, engine + client, `ENGINE_VERSION` 58)

> When you clear each floor, give three option cards for a power-up, like Soul Knight. One of
> them doubles the monster health-potion drop rate. In a multiplayer level, whichever card the
> most people chose takes effect.

### The catalogue

`engine/balance/floorCards.ts` — plain data and pure functions, same contract as `runbuffs.ts`
next door. Six cards, three effect kinds:

- Four wrap **existing `RUN_BUFFS` ids**, so a card is exactly as strong as the same buff picked
  up off the floor and `BUFF_CAPS` bounds cards and drops together. A parallel damage-scaling
  path is the drift design/18's consistency gates exist to catch.
- `potion_flow` doubles the heal weight (the card the request named), stacking to
  `HEAL_DROP_MULT_CAP` = 8 in three picks — a ceiling chosen for what it lands on: 16/84 is
  19%, just under the 21.4% this table shipped with before the same day made potions scarce.
- `arsenal` adds +1 to every later floor's weapon allowance.

The last two are properties of the RUN, not of a player, and are re-derived from the picked
list on read (`resolveFloorCards`) rather than mirrored into counters — the list is the state
that gets hashed and replayed, and a mirror is a second source that can drift from it.

Card descriptions interpolate the catalogue's own numbers (`floorCardDescVars`). A literal
"+50%" written into eight locale files is eight copies of a number that lives in `RUN_BUFFS`,
and retuning the buff would leave all eight promising the old figure with every test green.

### No pause, because there cannot be one

The offer is a non-blocking overlay over a still-running sim — the same shape the portal popup
has had since `ENGINE_VERSION` 31. Lockstep cannot stop for one player, and a cleared floor is
the one moment where that costs nothing anyway. It opens with the portal and only where there
is a next floor: the last floor never rolls one, since a card it handed out could never be
spent.

### A vote is state, not a pulse

`PlayerCommand.cardVote` (1..3, 0 = "not changing my vote") is copied onto
`PlayerActor.cardVote` and stays there — deliberately unlike `confirmExtract`/`confirmDescend`,
which are one-tick latches, and deliberately not cleared by `ApplyInputSystem`'s idle path.
Two requirements, not conveniences: a vote is changeable right up to the descend, and every
client renders the live tally off shared state, which it can only do if the vote persists.

### What the majority rule had to settle

`tallyCardVote` decides two things the request's sentence does not, both toward determinism
because every client tallies independently and must agree:

- **A tie goes to the lowest slot.** Arbitrary, but it has to be something, and "the leftmost
  card" is at least on screen. A re-roll or a coin flip would not survive being computed on
  four machines at once.
- **An abstention is not a vote.** A `0` seat is skipped, never counted for slot 1.

**A tally of 0 holds the portal** instead of descending without a card. Holding on >=1 vote
rather than "everyone has voted" is the co-op call: a downed or disconnected teammate must not
be able to strand the squad on a cleared floor. It also leaves the descend authority where it
already was (player 0's press), so this pass does not have to settle design/05's still-open
shared-descend question.

**The reward is team-wide**, on the owner's call: the vote is collective, so a buff card pushes
onto every seat's stack — downed seats included, since they are still on the team and still
revivable, and an asymmetry earned by being on the floor at the wrong moment would make
reviving someone worth less than it should be. EXTRACT applies nothing; the run is over.

### Client

`ui/FloorCardPrompt.ts` — three tappable cards above the portal popup, driven off the same
"cleared, and standing at the portal" condition so the two panels can never disagree about
whether the floor is finished. Each card shows a live vote count in co-op (hidden solo, where
there is no majority to resolve) and draws the local seat's own pick selected, because "the
majority decides" is a rule whose outcome has to be visible before it happens rather than
after. A tap is a VOTE and never a descend.

Presses on the panel are swallowed via `onPressStart` -> `CommandBuilder.suppressFireUntilRelease`,
the same mechanism `WeaponPickupPrompt` uses and for the same reason: `WebInput` reads `firing`
off a raw `mousedown` that a Pixi button consuming the event knows nothing about.

### Fallout

- **Every test and fixture that pressed `CONFIRM_DESCEND` now has to vote too**, including
  `fixtures/goldenScenarios.ts` — a scenario that used to change floors would otherwise have
  silently stopped doing so while still passing its own hash, which is the exact class of quiet
  coverage loss the golden gate exists to prevent. It votes for a beat-varied slot rather than
  always slot 1, so the tally and the offer indexing are both really exercised.
- **`PveBotController` votes for slot 1**, or every run in the balance sweep would press
  DESCEND forever on a cleared floor and time out. Deliberately not a drafting bot: this
  harness measures how much damage a room deals and how much loot a floor hands out, and a bot
  that drafted well would turn all of those into statements about its own drafting.

### Two files hit the 500-line gate, and both split

- `engine/state/entities.ts` was at **499** lines; adding `cardVote` crossed it. Split by domain
  into `state/entities/{teams,weapons,actors,projectiles,world}.ts` (form ① — independent type
  modules), with the original path kept as a re-export shell so nothing outside `state/` moved.
  Largest resulting file: 211 lines.
- `client/src/game/Game.ts` and `controllers/GameLoop.ts` crossed it too, and gave up
  `controllers/hudLayer.ts` (overlay mounting) and `controllers/checkpointOverlays.ts` (the
  checkpoint pass). The second is now a PURE module — `pureLayerBoundary.test.ts` surveyed it
  and said so — which is what makes "does the card offer show on exactly the same condition as
  the portal" testable across the whole matrix with no browser at all.

### Tests

New: `engine/systems/floorLoot.test.ts` (14 — quota bounds, the one-per-room cap with its own
counterfactual, both make-up-drop paths, boss adds, scope), `engine/balance/floorCards.test.ts`
(24 — catalogue integrity, the offer draw's distinctness and fixed draw COUNT, every tally rule
including order-independence), `engine/systems/floorCardCheckpoint.test.ts` (18 — end-to-end
through a real engine), `client/.../FloorCardPrompt.test.ts` (19),
`client/.../checkpointOverlays.test.ts` (12). Extended: `drops.test.ts` (+9, including a
recording PRNG stub so the table can be asserted exactly rather than sampled — which needed
`rollDrop` narrowed to a structural `DropPrng` seam, following `rollCrit`'s precedent),
`levelSim.test.ts`, `report.test.ts`, `contentNames.test.ts` (card keys now in the locale
parity net, descriptions included), `CommandBuilder`/`gameWiring`/`GameLoop` tests.

Coverage after: client 97.73% lines / 92.28% branches, engine 97.52% / 92.96%, server unchanged
— all three still over the 90/90 gate.
