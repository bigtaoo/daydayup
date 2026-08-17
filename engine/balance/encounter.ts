/**
 * Room encounter budget (design/05 "Room encounter budget", ENGINE_VERSION 41) —
 * how much of a room's garrison is allowed to shoot at the player AT ONCE, and how
 * long the room takes to wake up.
 *
 * These exist because room-wide aggro plus a per-enemy fire decision multiplies:
 * every mob independently doing the reasonable thing (close in, then shoot) adds up
 * to an unsurvivable volley, and no per-enemy number can fix that — 15 enemies each
 * firing a 1-damage shot every 1.5s is 10 damage/second against a starter character's
 * 9.2 effective HP, whatever each individual mob's stats say. `client/sim/
 * pveLevelSim.sim.ts` measured exactly that on the shipped level 1: 14 of 15 enemies
 * firing simultaneously, first hit 0.6s after the room woke, dead in ~2s, in 100% of
 * bot runs at both skill profiles.
 *
 * So the budget is a property of the ROOM, not of the mob — the same place aggro
 * already lives (design/05's room-as-the-aggro-unit model). A room may hold a crowd;
 * only `ROOM_FIRE_BUDGET` of them may be shooting at any instant, and the rest queue
 * up at their engage range waiting for a slot to open (which happens when a shooter
 * dies, or when the player moves and someone else becomes the nearest). That is the
 * standard arrangement in the games this one takes after — a room of 15 reads as
 * dangerous without being an execution.
 *
 * Both numbers are deliberately in `balance/` rather than `content/enemies.ts`: they
 * are not a property of any one blueprint, they are the encounter-level dial the
 * level's difficulty is actually tuned on. Re-run `npm run test:pve-sim` after
 * touching either — its balance gates are what hold them honest.
 */

/**
 * Most enemies in one room that may have `firing` set on the same tick. The nearest
 * ones to the target win the slots (`AIDecideSystem`), so the threat always comes
 * from the mobs closest to the player rather than from an arbitrary array-order
 * subset.
 *
 * Sizing, measured rather than assumed: each shooter is one `ENEMY_GUN_SIM` shot per
 * 1.5s = 0.67 damage/s. At 3 slots the sim's careful bot cleared the entrance room
 * but died on floor 1 in every run — a room cost 5-9 damage against a renewable 3.2
 * shield, so the 6-point HP pool drained one room at a time with no way back up. At 2
 * it costs 4-8, floor 1 is passable but not free (the careful bot descends in ~37% of
 * runs and deaths spread across floors 0-3), which is the difficulty this level is
 * aiming for. Survival comes down to spacing and movement — a mob that is closing
 * distance cannot shoot at all (v40) — which is the intended skill axis.
 */
export const ROOM_FIRE_BUDGET = 2;

/**
 * A woken room's mobs may move immediately but may not fire for this many ticks
 * after activation — the reaction window a player needs to read the room they just
 * walked into. Spread per enemy over `NOTICE_SPREAD_TICKS` so the first volley
 * arrives staggered instead of as one wall of bullets: with a level's authored spawn
 * points, some mobs are inevitably already inside engage range the tick the room
 * activates, and a flat delay would just move the whole simultaneous volley later.
 *
 * Derived from the enemy's own `id` rather than an `aiPrng` draw (`noticeDelayTicks`
 * below) — ids are assigned in deterministic spawn order (`GameState.nextId`), so the
 * stagger is fully reproducible without adding a PRNG draw site, and needs no new
 * per-enemy state field to serialize.
 */
export const NOTICE_DELAY_TICKS = 18; // 0.6s floor
export const NOTICE_SPREAD_TICKS = 30; // + up to 1.0s more, per enemy

/**
 * Ticks after its room's activation before enemy `id` may open fire. Pure function of
 * the id — see `NOTICE_DELAY_TICKS`. The modulus is coprime with typical garrison
 * sizes so consecutive ids (a room's spawn order) don't land on the same delay.
 */
export function noticeDelayTicks(id: number): number {
  return NOTICE_DELAY_TICKS + (id % NOTICE_SPREAD_TICKS);
}
