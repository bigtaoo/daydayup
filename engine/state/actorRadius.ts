/**
 * Which radius answers "is this actor blocked by a static solid" — one answer, one place
 * (design/18-test-strategy.md, G4).
 *
 * An actor carries THREE radii and they are not interchangeable:
 *
 *   - `radius` — the drawn body. What the silhouette occupies.
 *   - `footprintRadius` — the feet circle. What actor-vs-actor crowding uses
 *     (`MovementSystem.resolveActorPairs`), deliberately smaller so a crowd reads as a crowd
 *     rather than a force field.
 *   - `solidRadius` — the clearance against a STATIC solid. `radius` for both players (v43) and
 *     enemies (v48): an actor should stop at the silhouette it draws, so it reads as standing
 *     against a wall rather than sunk into one.
 *
 * Every "am I blocked by a wall/pillar" question must use the third one, and the reason this is
 * a named function rather than a convention is that the convention was already broken twice by
 * code that meant to follow it:
 *
 *   - `DoorSystem.inLockingDoorway` tests the passage with `footprintRadius`, on the strength of
 *     a comment claiming that is "the feet circle solids actually push out". It was, until v43.
 *   - `DeathDropsSystem` clamps a spawning minion with `footprintRadius` under a comment saying
 *     "a spawned actor needs its own solid clearance", then hands it to a `MovementSystem` that
 *     pushes it out by `solidRadius` — twice as far for a player-sized body.
 *
 * Both are still standing: fixing either changes sim behaviour and needs an `ENGINE_VERSION`
 * bump, so they are deliberate decisions rather than drive-by edits. `clearanceParity.test.ts`
 * is where the divergence is measured instead of asserted from a comment.
 */
import type { Fp } from '../math/fixed';
import type { Actor } from './entities';

/** The radius any static-solid question about `a` must use. */
export function blockingRadius(a: Pick<Actor, 'solidRadius'>): Fp {
  return a.solidRadius;
}
