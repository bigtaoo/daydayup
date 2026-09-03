// Engine weapon spec -> render attack shape. Split out of EventReactor.ts (2026-09-02,
// 500-line convention) as form (1) — four independent free functions with no shared state, no
// reference to the reactor, and one job between them: turning what the sim holds
// (`WeaponSimSpec`, in brad/ticks/fp) into what the rig's attack envelope reads
// (`render/attack/*`, in degrees/ms/grid-per-second).
//
// It lives beside its only consumer rather than under `render/` on purpose: the conversion is
// the boundary itself, and `render/rigAttackMotion` is deliberately free of engine imports (see
// its siblings' headers — every unit conversion belongs at the READ site, which is here).
import { TICK_RATE, type MeleeSimSpec, type RangedSimSpec, type WeaponSimSpec } from '@dd/engine';
import { fpToPx, bradToRad, PX_PER_GRID } from '../coords';
import type { ShotShape, SwingShape } from '../../render/rigAttackMotion';

/** The actor with this id in a list that may not be there at all. The tolerance is the point and
 *  it is this file's existing stance rather than a new one (see `consume`'s own note on lazily
 *  resolving the local seat): a render-layer consumer draining a queue must degrade to "not
 *  found" on a state it cannot fully read, not throw and take the frame with it. It reaches a
 *  partial state in practice — a menu frame, a stale queue, and every faked host in the suites.
 *
 *  Widened from a single `players` lookup when the ranged branch started using it, and that is
 *  exactly when it began to matter: the second list is one the previous version never touched. */
export function byId<T extends { id: number }>(list: readonly T[] | undefined, id: number): T | undefined {
  return list?.find(x => x.id === id);
}

/** Narrow a resolved attacker to the weapon KIND the event that named it announced. A player
 *  who swapped between the tick a `bullet_fired` was emitted and the frame it is drained holds
 *  the other kind by now, and drawing a swing off a gun's numbers (or the reverse) is worse than
 *  falling back to the starter weapon — so a mismatch reads as "unresolved", not as a cast. */
export function specOf<K extends WeaponSimSpec['kind']>(
  attacker: { spec: WeaponSimSpec } | undefined,
  kind: K,
): Extract<WeaponSimSpec, { kind: K }> | undefined {
  const spec = attacker?.spec;
  return spec?.kind === kind ? (spec as Extract<WeaponSimSpec, { kind: K }>) : undefined;
}

/** The four `MeleeSimSpec` fields the swing envelope is derived from, in render units:
 *  `arcHalf` is brad (half-sector), `swingTicks` the sim's ACTIVE HIT WINDOW in ticks
 *  (design/07 step 7), `swingCooldownTicks` the recovery the follow-through plays out in, and
 *  `knockback` an fp/tick impulse converted back to the grid/s it was authored in. The window
 *  and the recovery are BOTH read and are not interchangeable — see `SwingShape`. */
export function swingShapeOf(spec: MeleeSimSpec): SwingShape {
  return {
    arcDeg: (bradToRad(spec.arcHalf) * 360) / Math.PI,
    windowMs: (spec.swingTicks * 1000) / TICK_RATE,
    recoveryMs: (spec.swingCooldownTicks * 1000) / TICK_RATE,
    knockback: (fpToPx(spec.knockback) / PX_PER_GRID) * TICK_RATE,
  };
}

/** The `RangedSimSpec` half of the same conversion: the weapon's fire cadence as ms, and the
 *  damage one trigger pull puts out (`render/attack/shotShape.ts` explains why it is measured
 *  per pull rather than per bullet). */
export function shotShapeOf(spec: RangedSimSpec): ShotShape {
  return {
    intervalMs: (spec.fireRateTicks * 1000) / TICK_RATE,
    punch: spec.damage * spec.bullets,
  };
}
