import type { Rig } from './Rig';
import type { ResolvedBoneTransform, WorldPose, WorldPositions } from './types';

// Split out of RigSkin.ts (2026-08-21, 500-line convention): everything about WHERE a rig
// hangs its weapon module and whether it hangs one at all. Same category as `rigShading.ts`
// / `rigTethers.ts` — pure geometry over a posed rig, no Pixi state — and moved for the same
// reason: RigSkin was at 490 lines and the enemy-mount pass needed room for a second mount
// path.
//
// Two mount paths exist because the roster has two body plans (design/13):
//
//   - 'socket' — the hero's orb-core, whose weapon modules ORBIT the core on their own bones
//     ("two weapon modules that orbit it on glowing energy tethers"). The module sits on a
//     socket bone's TIP, which FK moves every frame, and a tether is drawn from the core out
//     to it. This is the path that has always existed.
//
//   - 'held' — the enemy body forms, which have no socket bone and never will: critter-core
//     is deliberately the smallest useful rig (one bone, no arms), and brute-core/floater-core
//     SHARE that one `Rig` instance (`skinRegistry.RIG_DEFS`). A socket bone was the obvious
//     alternative and measuring ruled it out: one shared rig can only declare ONE socket
//     length, but the three bundles paint 0.70 / 1.00 / 1.00 of the same declared `bodyR`
//     (`skinRegistry.BODY_FILL`, measured from the shipped PNGs), i.e. real drawn half-widths
//     of 35 / 50 / 50 authoring px. At the hero's `len` of 52 the module clears the critter by
//     17 px but only 2 px on the brute and floater; at a length that clears those two it
//     floats ~30 px off the critter with nothing drawn between, because an enemy rig has no
//     tether to bridge the gap. Splitting one rig into three to get three lengths would
//     triple the rig defs (and their ported animator siblings) for one number. Mounting off
//     the body's own MEASURED drawn radius instead adapts to all three for free, and stays
//     correct if any body texture is re-cropped, since `BODY_FILL` is re-measured against the
//     real PNGs by `rigComposition.test.ts` on every run.
//
//   - 'none' — a body plan that carries no weapon at all. boss-core: design/13's boss is "a
//     giant cracked crystal core with orbiting shard rings", and its ring_a/ring_b ARE its
//     armament, so a mob's rifle would be wrong on it. It still fires in the sim; what it must
//     not do is draw one.
export type WeaponMountMode = 'socket' | 'held' | 'none';

// The socket that visibly carries the mounted weapon sprite (design/03 "swapping the
// active slot swaps which socket fires" — the demo's `attack` clip already privileges
// this socket for its recoil kick, so mounting here keeps the two in sync). Both
// sockets still track aim rotation; only this one shows a weapon module.
export const ACTIVE_WEAPON_SOCKET = 'socket_r';
// The other arm carries a module too (design/13's "TWO weapon modules that orbit it", and
// the concept turnaround draws both) — same art, purely decorative: `03`'s model is one
// ACTIVE weapon at a time, so this one never fires, takes no recoil, and is not what the
// aim-tracking rotation is applied to. It points OUTWARD along its own tether instead of at
// the reticle, which is both how the concept draws the relaxed pose and what keeps its barrel
// from crossing the core whenever the hero shoots toward that side.
export const IDLE_WEAPON_SOCKET = 'socket_l';
// Only the ACTIVE socket's ring tracks aim; the idle one turns with its own module so ring
// and module read as one assembly.
export const AIM_TRACKING_BONES: ReadonlySet<string> = new Set([ACTIVE_WEAPON_SOCKET]);

/** zIndex for a weapon module that should sit BEHIND the body (design/01 "per-weapon local
 *  z-order": facing away, the module is on the far side of the core). Below every bone
 *  binding's zOrder (0..4 for orb-core) and below the tether's own -1. */
export const MODULE_Z_BEHIND = -2;

/**
 * How far a 'held' module's anchor sits from the body's centre, as a multiple of the body
 * art's REAL drawn radius (`bodyR * bodyFill`, not the declared `bodyR`).
 *
 * 1.0 — i.e. exactly on the drawn silhouette's edge — measured, not guessed: at 1.15 the
 * floater's module showed a visible gap, because `bodyFill` is the art's MAXIMUM opaque
 * half-width (whichever row is widest) while the mount sits at mid-height, where that
 * bundle's diamond-ish silhouette is narrower. At 1.0 all three enemy bodies read as
 * carrying the gun: the housing tucks into the body (the texture's anchor is 0.35 of its
 * width, so ~21 authoring px of housing falls inside) and the barrel + its muzzle crystal
 * clear the silhouette. Pushing it further out is what an orbiting socket is for; a mob
 * holds its gun.
 */
export const HELD_MOUNT_R = 1.0;
/** The vertical half of the held mount's offset is squashed: this is a tilted view
 *  (design/01), so a body's surface covers less screen distance vertically than
 *  horizontally. Same constant and same reason as `RigSkin`'s own `EYE_TRACK_SQUASH`. */
export const HELD_MOUNT_SQUASH = 0.45;

/**
 * Which mount path this rig uses. Declared on the `RigDef` itself, because it is a statement
 * about the BODY PLAN (does this creature have arms that orbit, does it carry a weapon at
 * all) and therefore belongs beside `bones`/`drawOrder` rather than in a side table keyed by
 * skin name — all three of critter/brute/floater share one rig and must answer identically.
 *
 * The fallback for a rig that declares nothing is deliberately conservative: 'socket' if it
 * actually has the socket bone to mount on, 'none' otherwise. So a new rig can never
 * accidentally sprout a weapon it was never designed to hold; it has to ask for one.
 */
export function resolveWeaponMount(rig: Rig): WeaponMountMode {
  return rig.weaponMount ?? (rig.boneMap.has(ACTIVE_WEAPON_SOCKET) ? 'socket' : 'none');
}

/** Where a module sits and how it is rotated, in the rig's own authoring-px space. */
export interface ModuleMount {
  x: number;
  y: number;
  /** Local rotation in radians, BEFORE the texture's own `rotationOffsetRad` is added. */
  angle: number;
}

/**
 * The ACTIVE module's mount for this frame, or null when this rig mounts nothing.
 *
 * `canonicalAngle` is the pre-mirror aim angle (`RigSkin.canonicalSocketAngleRad`) — every
 * local angle here is computed in canonical space so the whole-rig `view.scale.x` flip
 * renders it pointing at the real reticle.
 *
 * For 'held', `bodyPose`/`bodyTransform`/`drawnBodyR` describe the body bone the module hangs
 * off. The `+ translate` on the body's tip is there for the same reason the sprite loop and
 * the contact shades do it: `computeFK` folds a clip's ROTATION into a bone's tip but not its
 * translation, so a module would otherwise be left behind by the idle clip's hover bob.
 */
export function activeModuleMount(
  mode: WeaponMountMode,
  worldPose: WorldPositions,
  transforms: Map<string, ResolvedBoneTransform>,
  canonicalAngle: number,
  body: { boneId: string; drawnR: number } | null,
  recoilPx = 0,
): ModuleMount | null {
  if (mode === 'socket') {
    const pose = worldPose.get(ACTIVE_WEAPON_SOCKET);
    return pose ? recoiled({ x: pose.ex, y: pose.ey, angle: canonicalAngle }, recoilPx) : null;
  }
  if (mode !== 'held' || !body) return null;
  const pose = worldPose.get(body.boneId);
  if (!pose) return null;
  const t = transforms.get(body.boneId);
  const cx = pose.ex + (t?.translateX ?? 0);
  const cy = pose.ey + (t?.translateY ?? 0);
  const reach = body.drawnR * HELD_MOUNT_R;
  return recoiled({
    x: cx + Math.cos(canonicalAngle) * reach,
    y: cy + Math.sin(canonicalAngle) * reach * HELD_MOUNT_SQUASH,
    angle: canonicalAngle,
  }, recoilPx);
}

/**
 * Slide a resolved mount straight back down its own barrel by `px` (`rigRecoil.ts`'s
 * envelope supplies the number; 0 is the identity and the only value at rest).
 *
 * UNSQUASHED, unlike the held path's own outward offset above: that offset walks across the
 * body's surface, which the tilted view foreshortens, while this one runs along the BARREL,
 * which is drawn at the full canonical angle (`mount.angle`, straight into `sprite.rotation`).
 * Squashing it would slide the gun off its own axis. Same reason `moduleMuzzleLocal` steps
 * unsquashed to reach the business end.
 *
 * Applied to the MOUNT rather than to the sprite, so `moduleMuzzleLocal` reads it for free —
 * the barrel tip, the bullet's spawn correction and the muzzle fx all recoil with the gun
 * instead of hanging in the air where it used to be.
 */
function recoiled(mount: ModuleMount, px: number): ModuleMount {
  if (px === 0) return mount;
  return {
    x: mount.x - Math.cos(mount.angle) * px,
    y: mount.y - Math.sin(mount.angle) * px,
    angle: mount.angle,
  };
}

/**
 * The DECORATIVE second module's mount, or null when this rig has none. Only the 'socket'
 * path has one — a mob carries a single gun, and design/13's "two weapon modules" is the
 * hero's silhouette, not the roster's.
 *
 * It turns with its own bone (rest angle 180° = away from the core), not with the reticle —
 * computed pre-mirror like every other local angle here, so the whole-rig flip keeps it
 * pointing outward on whichever side it ends up.
 */
export function idleModuleMount(mode: WeaponMountMode, worldPose: WorldPositions): ModuleMount | null {
  if (mode !== 'socket') return null;
  const pose: WorldPose | undefined = worldPose.get(IDLE_WEAPON_SOCKET);
  return pose ? { x: pose.ex, y: pose.ey, angle: (pose.wa * Math.PI) / 180 } : null;
}

/**
 * How far a weapon texture reaches from its anchor toward its own baked business end, in
 * unscaled texture px. A ray/rect intersection: the anchor is the ray origin (it is the
 * sprite's own local origin once `anchor` is set), the direction is the texture's baked
 * tip direction — `-rotationOffsetRad`, since that offset is what gets ADDED to rotate
 * the baked direction onto the live aim angle — and the rect is the texture's bounds
 * around the anchor. Assumes the art reaches its own canvas edge in that direction, which
 * is what `WEAPON_DEFS`' measured `rotationOffsetRad` values were derived from (the
 * alpha-farthest pixel from the anchor); the failure mode for a padded texture is a
 * muzzle a few px too far out, not a wrong direction.
 */
export function barrelReach(
  texW: number,
  texH: number,
  anchor: { x: number; y: number },
  rotationOffsetRad: number,
): number {
  const dx = Math.cos(-rotationOffsetRad);
  const dy = Math.sin(-rotationOffsetRad);
  const right = (1 - anchor.x) * texW;
  const left = -anchor.x * texW;
  const bottom = (1 - anchor.y) * texH;
  const top = -anchor.y * texH;
  const tx = dx > 1e-6 ? right / dx : dx < -1e-6 ? left / dx : Infinity;
  const ty = dy > 1e-6 ? bottom / dy : dy < -1e-6 ? top / dy : Infinity;
  return Math.min(tx, ty);
}


/**
 * Where the mounted weapon's business end actually is, in the rig's PARENT space (i.e.
 * `RigSkin.view`'s own `scale.x` flip already applied via `flipX`, the wrapper's uniform
 * scale not yet — `Skin.muzzleAnchor` finishes the job).
 *
 * Exists because the bullet spawns at the SIM's muzzle — `RangedSimSpec.muzzleOffset`, a flat
 * distance along the aim ray from the actor's centre — and the drawn gun's barrel tip is
 * somewhere else entirely: the module hangs off a socket bone that orbits the core (52
 * authoring-px out on `orb-core`) and then extends its own texture beyond that again, so the
 * sim's 30 px landed roughly mid-gun and shots visibly left the middle of the housing rather
 * than the muzzle (user report, 2026-08-17: "子弹要从枪口打出"). `Scene` uses this as the bullet
 * view's FIRST position and lets the normal interpolation carry it to the authoritative sim
 * position over that tick; `EventReactor` anchors the muzzle flash/flame/casing to the same
 * point. The sim is untouched, so nothing here can affect hit detection or determinism, and
 * deliberately so: pushing the sim's spawn point out to the barrel tip instead would let a
 * player standing flush against a wall spawn bullets on the far side of it.
 *
 * The geometry, all in the rig's own authoring-px space:
 *   - the module's own mounted position (`sprite.x/y`, i.e. whatever `activeModuleMount`
 *     resolved this frame — a socket bone's tip or the body's drawn edge, minus this frame's
 *     recoil);
 *   - the barrel points along the canonical aim angle — the sprite's rotation is that angle
 *     PLUS the texture's `rotationOffsetRad`, and the offset exists exactly to cancel each
 *     texture's own baked pointing direction, so the two cancel;
 *   - its distance is how far the texture's own rect reaches from its anchor in that baked
 *     direction (`barrelReach`), scaled by the sprite's scale.
 *
 * Split out of RigSkin.ts 2026-08-30 (500-line convention, form ①): it is mount geometry over
 * a posed rig with no Pixi state of its own, which is this file's whole subject, and
 * `barrelReach` — the one thing it computes with — already lives here.
 */
export function moduleMuzzleLocal(
  sprite: { x: number; y: number },
  canonicalAngle: number,
  flipX: 1 | -1,
  tex: { width: number; height: number },
  anchor: { x: number; y: number },
  rotationOffsetRad: number,
  scale: number,
): { x: number; y: number } {
  const reach = barrelReach(tex.width, tex.height, anchor, rotationOffsetRad) * scale;
  return {
    x: flipX * (sprite.x + Math.cos(canonicalAngle) * reach),
    y: sprite.y + Math.sin(canonicalAngle) * reach,
  };
}
