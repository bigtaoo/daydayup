# Gameplay: core loop, modes, parry

What the player actually does. This is the single source of truth for the **core loop**, the **two modes** (PvE search-fight-extract / PvP arena), the **survivability model (HP + shield)**, the **weapon-slot & material economy**, and how **parry (block/deflect)** sits inside all of it. It builds on the weapon system (`03-weapon-system.md`), the entity model (`02-entity-model.md`), and must stay consistent with the netcode decisions already locked in `06-netcode-determinism.md` — especially **casual-first PvP** and **ephemeral in-run power (materials are the only thing that leaves a run)**.

## The decisions (locked)

- **Two separate modes, not one blended activity.** PvE is a **co-op search-fight-extract run** (threat is AI only); PvP is an **independent PvPvE arena** (threat is other players **and** AI). They do **not** share a map, and PvP players **never intrude on a PvE run** — the two are entirely different activities.
- **PvE adopts an extraction loot loop — but a softened, PvE-only form.** You search for loot, push deeper for better rewards, and choose when to bank and leave. What makes this *not* the rejected extraction-shooter (below): **weapons never persist regardless** (they vanish at run end no matter what — there is nothing to "lose"), **only materials extract**, the threat is **AI only** (no rival players hunting you), and death costs only **this floor's un-banked materials** (extraction points are checkpoints). It keeps extraction's push-your-luck tension without its casual-hostile "lose your hard-won gear to a stranger" sting.
- **Weapons are ephemeral; materials are the only carry-out.** Every weapon — brought in or found — is wiped at run end. The single thing that leaves a run is **materials**, the meta-forge currency (`meta` doc, later). This *is* `06`'s "in-run resources are engine state, wiped each match," made literal.
- **PvP normalizes gear via unified presets.** The arena offers a **fixed, balanced set of preset loadouts** everyone picks from — players do **not** bring or clamp their own gear. Matches are decided by skill and in-match choices, not by who has ground more. This is the concrete meaning of `06`'s "casual-first."
- **Meta progression is horizontal.** Persistent progression (spent via material forging) grants **build breadth, cosmetics, and small stat deltas** — never a raw power ladder. In-run finds are the real power axis.
- **Parry is melee-category-limited.** Only melee weapons can deflect, and deflect is part of the swing itself — not a separate block (`03`). Choosing a ranged loadout means giving up parry — it is a genuine trade-off, not a universal skill everyone owns.
- **Landscape-primary.** The game ships **landscape only**; portrait is dropped. Twin-stick + corner buttons (`04`) need the horizontal space, and WeChat supports `deviceOrientation: "landscape"` in `game.json`.

### Why this extraction form, and not full extraction

The original plan rejected extraction wholesale; we adopted a **narrow slice** of it. The distinction is what each column below turns on:

| Model | Verdict |
|-------|---------|
| **PvE search-fight-extract (adopted): AI-only, weapons never persist, materials-only carry-out, per-floor checkpoint** | ✓ Keeps the push-your-luck "bank now or dive deeper" tension, but sidesteps every original objection: nothing persistent is ever lost (weapons were always ephemeral), no rival-player intrusion, and PvE co-op on the deterministic engine (`06`) has no open-world player-state netcode load or client-full-state maphack surface. |
| Full extraction (shared dungeon, **PvP intrusion**, **lose persistent gear** on death) | ✗ Maximal tension but head-on collision with casual-first; "lose the gear you ground for" is the opposite of casual. Heaviest netcode load (open-world player state), and the maphack weakness of client-held full state (`06`) hurts most exactly here. The adopted form keeps none of these. |
| PvP carries full meta gear (RPG PvP) | ✗ Vertical meta would leak straight into PvP → veterans crush newcomers / pay-to-win. Rejected together with the "horizontal meta" decision. |

## Core loop (PvE search-fight-extract run)

One run, floor-based push-your-luck:

```
Loadout (bring up to 2 weapons; none → auto pistol)
   → enter floor 1 (seeded)
      → clear (some of) its rooms: fight, open chests, pick up weapons & materials
      → reach this floor's EXTRACTION ROOM
         → choose: EXTRACT (bank everything, run ends, keep materials)
                 or DESCEND (materials so far are locked in — deeper = better)
   → repeat for ~5 floors; the last floor's boss room IS its extraction room
      (portal opens only after the boss dies)
   → run ends (extracted / boss-cleared / dead)
      → all weapons wiped; banked materials kept; meta advances via forging
   → back to loadout
```

- **Weapons found this run are the moment-to-moment power fantasy — and all of it is ephemeral.** Weapons, affixes, and combo effects (`03` "rarity, affixes, combo effects") found *this run* build up your kit, then are wiped at run end. This is `06`'s "in-run resources/drops are engine state, wiped each match."
- **Materials are the only carry-out**, and the deeper you go the better they get. Weapon *finds* stay random at every depth — depth buys material quality, not guaranteed weapons.
- **Extraction rooms are checkpoints.** One per floor; reaching it lets you **extract** (end the run, keep everything) or **descend**. Choosing to descend banks your materials so far, so a death on a later floor costs only **that floor's** un-banked materials (weapons are gone either way). This is the softened extraction form (locked decisions above).
- **You need not clear a floor.** How many rooms you can skip depends on where that floor's extraction room sits — an extraction room mid-floor lets you leave one or two rooms unfought, a natural "greed for the last chest vs. leave safe" micro-decision.
- **Floor count is tentatively 5**, each with **5–10 rooms**; the deepest floor's challenge is a boss whose room doubles as the final extraction (portal after the kill). Exact counts are to-tune (below).
- **Co-op:** same run, cooperative, latency-tolerant, AI-only threat. Starts single-player on `LocalInputSource` to validate feel, then the same `NetInputSource` broadcast for co-op (`06`). Enemy/boss AI runs inside the deterministic engine off injected PRNG, identical on every client. **Downed teammates can be revived** — a free, ~15 s stationary channel by another player (`07`/`08` interaction); revive/team-wipe edge rules in open questions.

### Dungeon generation

- **Hybrid: hand-authored room pieces stitched by a seeded procedural layout.** Reuse funny's PRNG roomgen for the layout/selection; keep encounter quality controlled by curating the room pieces. Standard roguelite answer — full-procedural risks uneven quality, fully hand-built kills replayability. The per-floor **extraction room** is one of the placed pieces, and its position within the floor is what gates how many rooms are skippable.
- Generation is driven by an **injected `Prng` seeded per run** (`06`), so a run is fully reproducible from `seed + input stream` (needed for co-op determinism and headless re-judge).

## Survivability model (HP + shield)

Every actor has **two defensive pools**; the character (skin, `02`) contributes *only* these plus one break-passive — all offensive depth is the weapon.

- **HP is the hard floor.** When HP hits 0 the actor dies (co-op: downed, revivable). HP is **recovered only by items** — a healing pickup restores a **flat +1 HP**, dropped by chests and AI enemies (`07`/`09`).
- **Shield is the soft buffer, taken first.** All incoming damage — including elemental DoT (`07`) — depletes shield before it touches HP.
- **Shield auto-regenerates; HP never does.** After **3 s without being hit**, shield trickles back at **1 point / 10 s**. *Any* hit — including a burn/poison DoT tick — resets the 3 s timer, so clearing a lingering status (kiting, an item) is a precondition for regen. Shield is a between-fights recovery, not a mid-fight heal.
- **Breaking a shield can fire a character passive.** The instant a shield is depleted, the character's bound break-passive (e.g. an AoE burst / knockback on nearby enemies) triggers — this is the concrete form of `02`'s "skin may carry a minor passive." A 0-shield character simply never triggers one.
- **Characters differ only by `(maxHp, maxShield)` + that break-passive.** They are *not* balanced to equal effective HP: a plain starter might be **8 HP / 0 shield** (no regen buffer, no break-passive — pure item-dependence), a skirmisher **3 HP / 10 shield** (huge regenerating buffer, but fragile the instant burst punches through). The engine bodies (absorb order, regen timer, break event) live in `07`/`08`; the numbers live in `@dd/engine` config (`09`).

## PvP (PvPvE arena)

- **3v3 / 4v4, casual-first** (`06`). Full frame-broadcast lockstep + local-player prediction.
- **PvPvE: the threat is rival players *and* AI.** Unlike the PvE run (AI only), the arena also seeds AI enemies as a shared, contested element — a distinct activity, not a reused dungeon. What role the AI plays (neutral hazard, objective, farm) is open design (below).
- **Gear normalized via unified presets.** Players pick from a **fixed, balanced set of preset arena loadouts** — they do not bring or clamp their own gear. This is chosen over normalizing self-owned gear because a closed preset set has a bounded, exhaustible balance surface, whereas clamping the open horizontal affix/combo pool (`03`) is a combinatorial balance problem and lets collection *breadth* leak back in as a soft advantage — exactly the fairness risk `06` warns about. In-match pickups/power-ups (dropped on the map, equal for both teams) provide the in-match progression instead of persistent gear.
- Accepted trade-off: a player's meta collection does **not** show up in PvP. That is the point of separate modes — PvP tests execution, PvE tests build. A later, additive option could let a preset slot be filled by any *balance-equivalent* weapon the player owns; not in scope now.
- Separate mode = arena maps are hand-designed for PvP (sightlines, cover, symmetry), not reused dungeon rooms.

## Economy (summary)

| Axis | Source | Persists past a run? | Affects PvP? |
|------|--------|-----------|--------------|
| **Materials** | banked during a PvE run (deeper floors → better) | **Yes** — the only carry-out; the meta-forge currency | **No** — normalized out |
| **In-run weapons / affixes** | found this run (chests, drops) | **No** — every weapon is wiped at run end | N/A (PvE only) |
| **Brought-in weapon(s)** | forged from materials in meta, equipped into the loadout (0–2; none → auto pistol) | **No** *within a run* (wiped like any weapon); how forging/stash works across runs is the meta doc's scope | N/A (PvE only) |
| **Arena preset / in-match pickups** | preset chosen at match start / dropped on map | No | Yes — the only PvP power source |

The split that keeps PvP fair: **materials are horizontal** (they buy build breadth / small deltas via forging, never a power ladder), and **PvP is preset-normalized** so no PvE-earned power reaches it at all. All balance numbers live in `@dd/engine` config (`06` "numbers live in one place"); this doc only names the shape. Exact forging/consumption mechanics are deferred to the **meta** discussion.

## Parry (block/deflect) positioning

The pivot mechanic from `03`. Its identity across the game:

- **Melee-only, and it lives inside the swing.** There is no `isBlocking`/`blockArc` and no block button: a melee swing's sector (arc + range) deflects any enemy bullet caught in it — flipping faction and redirecting it (`03`). Ranged loadouts have no parry — the core ranged-vs-melee trade-off.
- **In PvE:** parry is a skill-expression tool against bullet-hell enemies/bosses — swing through the incoming pattern to bat it back. High skill ceiling, optional (ranged builds route around it with mobility/DPS).
- **In PvP:** deflecting an opponent's bullets back is powerful, but it is **already a commitment, not a free toggle** — parrying costs you a swing (its arc window, its cooldown, and facing the threat), and the melee-only restriction bounds it to players who gave up ranged pressure. Further costs (perfect-swing window, extra recovery) are engine-config balance, decided against real play.

## Controls & orientation

- **Landscape only.** Dropped portrait (see locked decisions).
- **Twin-stick** (`04`): left stick moves, right stick aims + **fires the active weapon**; a corner **switch button** toggles which of the two weapon slots is active (`SWAP_WEAPON`, `08`), and an `INTERACT` button opens chests / picks up (a picked-up weapon replaces the active slot, `02`) / revives a downed teammate. Switching to an empty slot leaves you unable to fire until you switch back or pick a weapon into it. There is no block or jump button — parry is the melee swing (right stick), so *timing the attack* is the deliberate act. (A future dodge, if added, will be a planar blink, not a jump.)
- Aim is abstracted as a screen `point` (mouse, web) or a `dir` (joystick, touch) driving the same loop (`04`), and is **quantized to an integer brad angle** on input for determinism (`06`).

## Relationship to the other docs

- **Weapons** (`03`): the loop's moment-to-moment depth is weapon variety + parry; this doc says *when/where* you acquire and swap them (drops in PvE, normalized loadout in PvP).
- **Entity model** (`02`): a character carries **only** `(maxHp, maxShield)` + a shield-break passive; all offensive depth is the weapon — so a run's power comes from the weapon/affix stack, not the character. Weapon-slot rules (2 slots, pickup-replaces-active-slot, pistol backup) live in `02`.
- **Netcode** (`06`): modes, the ephemeral-in-run split, casual-first, and determinism constraints all originate there; this doc must not contradict it. The adopted PvE extraction form is specifically shaped to stay inside `06`'s casual-first and to add no open-world player-state netcode.

## To design

- **Difficulty / material curve** across the ~5 floors (biomes? how enemy tier and material quality escalate with depth). Floor count and rooms-per-floor (5–10) are tentative and need play-tuning.
- **Reward-choice structure** within/between floors (branching paths, shop, curse/blessing), and where the extraction room sits per floor (it gates how many rooms are skippable).
- **Materials → forging**: the material tiers, and what forging produces — deferred to the **meta** discussion.
- **Character roster & `(maxHp, maxShield)` + break-passive set**: the actual defensive stat pairs and break-passives (`02`/`09`), and cosmetic skins.
- **Healing-item drop rate / cap** (flat +1 HP): how common, any stack limit.
- The PvP **preset loadout set** itself (how many presets, their archetypes/roles), the in-match pickup table, the role of arena AI (neutral hazard / objective / farm), and win condition (elimination / score / objective).

## Open questions

- **Co-op revive & team-wipe:** the ~15 s revive channel is locked, but — how many revives, is the downed player fully vulnerable, and what ends a run on a total team wipe (all materials of the current floor lost, or the whole banked stash)? Decide against real co-op play.
- Is co-op PvE **matchmade** or **friends/party only** at launch? (Affects `06` room/relay transport.)
- **Descend vs extract UI/commitment:** once you descend, is extraction only re-offered at the next floor's room, or can you backtrack? Assume forward-only unless play says otherwise.
- PvPvE arena AI: neutral hazard, contested objective, or material farm — and symmetric spawns only, or contested map objectives?
- Parry vs PvP balance: does deflected player-damage get scaled down to avoid one-shot swings? Decide against real matches.
- Meta "horizontal" boundary: where exactly does a "small stat delta" stop being horizontal and become a ladder? Needs a numeric cap, set in engine config.
- **Shield-break passive in PvP:** if characters exist in the arena, does the break-passive survive preset normalization, or is it normalized out like gear? (Mirrors `09`'s skin-passive question.)
