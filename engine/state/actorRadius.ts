/**
 * Which radius answers "is this blocked by a static solid" — one answer, one place
 * (design/18-test-strategy.md, G4).
 *
 * An actor carries FOUR radii and they are not interchangeable:
 *
 *   - `radius` — the drawn body. What the silhouette occupies.
 *   - `footprintRadius` — the feet circle. What actor-vs-actor crowding uses
 *     (`MovementSystem.resolveActorPairs`), deliberately smaller so a crowd reads as a crowd
 *     rather than a force field.
 *   - `standoffRadius(a)` — personal space while standing still (v55). Not a collision radius
 *     at all: two STOPPED mobs drift apart to it, and nothing else ever consults it.
 *   - `solidRadius` — the clearance against a STATIC solid. `radius` for both players (v43) and
 *     enemies (v48), floored at the player's own clearance for enemies (v50): an actor should
 *     stop at the silhouette it draws, so it reads as standing against a wall rather than sunk
 *     into one, and no actor may stand somewhere the player's body could not follow.
 *
 * Every "am I blocked by a wall/pillar" question must use `blockingRadius`, and the reason it is
 * a named function rather than a convention is that the convention was already broken twice by
 * code that meant to follow it:
 *
 *   - `DoorSystem.inLockingDoorway` tested the passage with `footprintRadius`, on the strength
 *     of a comment claiming that is "the feet circle solids actually push out". It was, until
 *     v43. Fixed in v49.
 *   - `DeathDropsSystem` clamped a spawning minion with `footprintRadius` under a comment saying
 *     "a spawned actor needs its own solid clearance", then handed it to a `MovementSystem` that
 *     pushes it out by `solidRadius` — twice as far for a player-sized body. Fixed in v49.
 *
 * Both are fixed now, but the drift they came from is structural — a rule that lives in a
 * comment moves without the comment — so `clearanceParity.test.ts` MEASURES the consequence of
 * each placement site rather than asserting a relationship between two constants.
 */
import type { Fp } from '../math/fixed';
import { PLAYER_BASE } from '../content/players';
import { STANDOFF_BODY_MULTIPLE } from '../balance/encounter';
import type { Actor } from './entities';

/**
 * The FOURTH radius (ENGINE_VERSION 55) — personal space while STANDING STILL, and the one
 * radius above that is not about collision at all.
 *
 * The three above all answer "may these two shapes overlap"; this one answers "how far apart
 * do two mobs that have stopped want to stand", which is a preference, not a constraint. It is
 * consulted only by `MovementSystem.resolveStandingSpacing`, only between two enemies that are
 * both `holding`, and it never blocks anything: a mob still on the move is judged at its
 * `solidRadius` exactly as before, so a gap wide enough for one body stays wide enough for one
 * body no matter who is standing near it. See `STANDOFF_BODY_MULTIPLE` for the report and the
 * reasoning behind the multiple.
 */
export function standoffRadius(a: Pick<Actor, 'radius'>): Fp {
  return ((a.radius as number) * STANDOFF_BODY_MULTIPLE) as Fp;
}

/** The radius any static-solid question about `a` must use. */
export function blockingRadius(a: Pick<Actor, 'solidRadius'>): Fp {
  return a.solidRadius;
}

/**
 * The clearance a DROPPED ITEM is placed with (ENGINE_VERSION 50).
 *
 * A pickup is not an actor — `MovementSystem` never touches it — so for two versions this was
 * `SIM.pickupRadius`, the pickup's own collect padding, on the reasoning that its clamp answers
 * "can the player reach me" rather than "will I be displaced". That reasoning is right about
 * the question and wrong about the answer, because the thing that has to reach the drop is a
 * PLAYER'S BODY, and the player's body is wider (`solidRadius` 500 fp) than the pickup padding
 * (469 fp). Clamping by the narrower radius let a drop settle in a 31 fp band, and — the part
 * that actually matters — in any pocket, gap or brimmed corner, that a player's own collision
 * circle is pushed out of.
 *
 * Live report, three versions running (*"依然有掉落的物品无法拾取"*, 2026-08-31), with the
 * rule stated by the reporter: *"掉落物品也不能掉在阻挡区域"* — a drop must not land in the
 * blocking region. Using the player's own clearance is that sentence, exactly: after the clamp,
 * the drop sits at a point the player's body could itself occupy, so "walk onto it" is always a
 * legal move rather than a near-miss that depends on the collect padding covering the gap.
 *
 * Honest scope, because measurement came before the change and should not be overstated: at
 * TODAY's numbers the old radius did not actually strand anything. A sweep of 903 real drops
 * across 16 bot-driven runs of all five shipped floors found zero unreachable and zero embedded
 * in stone, with the nearest standable point never further than 116 fp against a 969 fp collect
 * reach. This closes the gap by construction instead of by margin, which is what lets
 * `smoke.test.ts` assert it as an invariant per tick — and an invariant is the thing that
 * survives the next time `WALL_NORTH_BRIM` or a body radius moves.
 */
export function dropClearance(): Fp {
  return PLAYER_BASE.solidRadius;
}
