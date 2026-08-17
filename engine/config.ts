/**
 * Engine-global constants (design/09 "all numbers live in @dd/engine config").
 * Balance/content numbers (weapons, enemies, drops) live under content/ and
 * balance/; this file holds only cross-cutting constants and the version guard.
 *
 * `ENGINE_VERSION`'s replay-compatibility changelog lives in ./versionHistory.ts
 * (CLAUDE.md "500-line file convention", form ① — split out because it's a single,
 * ever-growing doc comment on one constant with zero shared state with anything
 * else here); re-exported below so every existing `import { ENGINE_VERSION } from
 * './config'` site is untouched.
 */
import { TICK_RATE, FP_SCALE, type Fp } from './math/fixed';
import { BRAD_FULL } from './math/trig';

export { ENGINE_VERSION } from './versionHistory';

// ── Two-pool health tuning (design/07; final values are 07 "to design") ──────────
// Whole ticks @30Hz. Shield regen is an idle timer, not a heal: after taking ANY
// damage an actor must stay unhit for DELAY ticks before shield refills +1 per
// INTERVAL, capped at maxShield. A DoT tick resets the timer (StatusEffectSystem),
// so clearing a lingering status is a precondition for regen.
export const SHIELD_REGEN_DELAY = 90; // ~3 s idle before regen starts
// ~2 s per +1 shield thereafter. Was 300 (~10 s) through ENGINE_VERSION 40, which
// made the shield pool effectively single-use in a PvE run: a character refills
// 3.2 shield in ~32 s of taking no damage at all, while a dungeon room takes ~8 s to
// clear and the next one is a few seconds' walk away — so a player entered a 37-enemy
// floor with one 9.2-point pool and no way to get any of it back except heal drops
// (`client/sim/pveLevelSim.sim.ts` measured the result: floor 1 cleared in 0% of bot
// runs even after the room garrisons were halved). 60 makes the two-pool split mean
// what design/07 says it means — shield is the RENEWABLE half, HP the permanent half
// that only a heal pickup restores — and makes disengaging between rooms a real
// tactic instead of a formality.
export const SHIELD_REGEN_INTERVAL = 60;

// ── Knockback friction (design/07, v25) ───────────────────────────────────────────
// knockVx/knockVy decay by this per-mille factor every tick (MovementSystem), so a
// shove fades out instead of persisting or drifting forever. 800 = keep 80%/tick —
// a saber swing's 198 fp/tick impulse falls under KNOCKBACK_SNAP_FP within ~20 ticks
// (~0.7s), covering roughly 1 grid unit of total slide. First-pass, tune against real
// play like every other number in this section.
export const KNOCKBACK_FRICTION_PERMILLE = 800;
export const KNOCKBACK_SNAP_FP = 5; // below this magnitude (either axis), snap to exactly 0

// ── k_* on-hit procs (design/03/09, v28) ──────────────────────────────────────────
// How far a ricochet may retarget from its current position — same "reasonable
// nearby range" idea as content/damage.ts's CHAIN_RANGE, kept separate since the two
// are semantically distinct knobs (a lightning chain's hop vs a ricochet's bounce).
// Computed inline (not via content/convert.ts's toFpGrid) to avoid a circular import
// — convert.ts itself imports WORLD from this file.
export const RICOCHET_RANGE_FP = Math.round(6 * FP_SCALE) as Fp;

// ── Co-op downed / revive (design/05/07, ROADMAP 3.2). Whole ticks @30Hz. A lethal
// hit sends a player `downed`; a teammate revives via a sustained INTERACT channel.
export const DOWNED_BLEEDOUT_TICKS = 900; // ~30 s downed before permanent death (paused while being revived)
export const REVIVE_CHANNEL_TICKS = 450; // ~15 s sustained INTERACT to complete a revive (design/05 locked)
export const REVIVE_HP = 2; // HP a revived player comes back with (a small amount, design/07)
export const REVIVE_RANGE_GRID = 1.5; // how close the reviver must stand, grid units

// ── PvP anti-cheat periodic checkpoints (design/15, ROADMAP 4.4) ──────────────────
// Generalizes the existing end-of-match `ClientMsg.result.stateHash` (replay.ts
// hashState) into a tick-indexed check DURING a match. Design/15 is explicit these
// numbers are a first-pass proposal, not tuned ("real play required").
export const CHECKPOINT_TICKS = 150; // ~5s @ 30Hz cadence between periodic reports
// Below this many REAL (connected) seats, run no consensus check at all — an early
// bot-padded low-population match is expected to be internally inconsistent
// (design/15), and "not enough honest signal to trust a majority" applies at any
// seat count this low regardless of population stage.
export const CHECKPOINT_QUORUM = 3;
// A seat is only kicked once it disagrees with the majority at the SAME historical
// tick across this many CONSECUTIVE checkpoints — never a single stray mismatch
// (which is more likely a client still catching up under the lag/backlog
// multiplier than an actual state fork, design/15).
export const INTEGRITY_KICK_STREAK = 2;

/**
 * World scale — the anchor for every human-unit → fp/brad conversion (design/09).
 * 1 grid unit = 32 px. The demo slice runs render @60fps; the sim runs @30Hz.
 */
export const WORLD = {
  pxPerGrid: 32,
  tickRate: TICK_RATE,
  fpScale: FP_SCALE,
  bradFull: BRAD_FULL,
} as const;

export { TICK_RATE, FP_SCALE };
