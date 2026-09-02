/**
 * rigWeaponMount — where a rig hangs its weapon module, and whether it hangs one at all.
 *
 * This file exists because of a defect that a green suite could not see and that one real
 * frame made obvious (2026-08-21): every enemy loads a real `.tao` rig, but the decision
 * "may this actor mount a weapon sprite" was gated on `faction === 'player'`, so no enemy
 * ever mounted one. `gun_enemygun.png` shipped fully calibrated in `WEAPON_DEFS` and had
 * never been rendered in the world; the `Graphics` placeholder it fell back to drew at the
 * actor's GROUND origin while a rig body floats above that origin, so on a measured frame it
 * read as a white rectangle lying on the floor beside the creature.
 *
 * The tests below therefore pin two things the old suite had no notion of: which mount path
 * each SHIPPED rig takes (so a body plan can't silently change its mind), and the held path's
 * geometry as a function of the body's MEASURED drawn radius (so a re-cropped body texture
 * moves the gun with it instead of leaving it floating).
 */
import { describe, it, expect } from 'vitest';
import { Rig, type RigDef } from './Rig';
import { ORB_CORE_RIG } from './orbCoreRig';
import { CRITTER_CORE_RIG } from './critterCoreRig';
import { BOSS_CORE_RIG } from './bossCoreRig';
import {
  ACTIVE_WEAPON_SOCKET, AIM_TRACKING_BONES, HELD_MOUNT_R, IDLE_WEAPON_SOCKET,
  MODULE_Z_BEHIND, activeModuleMount, barrelReach, idleModuleMount, moduleMuzzleLocal,
  resolveWeaponMount,
} from './rigWeaponMount';
import type { ResolvedBoneTransform, WorldPose, WorldPositions } from './types';

const noTransforms = new Map<string, ResolvedBoneTransform>();

function poses(entries: Record<string, Partial<WorldPose>>): WorldPositions {
  const m = new Map<string, WorldPose>();
  for (const [id, p] of Object.entries(entries)) {
    m.set(id, { sx: 0, sy: 0, ex: 0, ey: 0, wa: 0, ...p });
  }
  return m;
}

describe('resolveWeaponMount — every shipped rig declares its own mount path', () => {
  it('orb-core mounts on its orbiting sockets (the hero, design/13 universal mount)', () => {
    expect(resolveWeaponMount(new Rig(ORB_CORE_RIG))).toBe('socket');
  });

  // The whole point of the pass. critter-core is shared by brute-core and floater-core
  // (skinRegistry.RIG_DEFS reuses one Rig instance), so all three necessarily answer this way.
  it('critter-core holds its weapon on the body — the enemy body forms have no socket bone', () => {
    expect(resolveWeaponMount(new Rig(CRITTER_CORE_RIG))).toBe('held');
  });

  it('boss-core mounts nothing — its shard rings ARE its armament (design/13)', () => {
    expect(resolveWeaponMount(new Rig(BOSS_CORE_RIG))).toBe('none');
  });

  it('an undeclared rig WITH a socket bone falls back to the socket path', () => {
    const def: RigDef = {
      id: 'legacy-socketed', label: 'Legacy',
      bones: [
        { id: 'root', parent: null, len: 0, rwa: 0, label: 'Root' },
        { id: 'socket_r', parent: 'root', len: 10, rwa: 0, bodyR: 4, label: 'S' },
      ],
      drawOrder: ['socket_r'],
    };
    expect(resolveWeaponMount(new Rig(def))).toBe('socket');
  });

  // The conservative direction, deliberately: a new body plan has to ASK for a weapon rather
  // than sprout one, so this can never repeat the boss's accidental placeholder gun.
  it('an undeclared rig with NO socket bone mounts nothing rather than guessing', () => {
    const def: RigDef = {
      id: 'legacy-bare', label: 'Legacy',
      bones: [
        { id: 'root', parent: null, len: 0, rwa: 0, label: 'Root' },
        { id: 'body', parent: 'root', len: 10, rwa: -90, bodyR: 20, label: 'B' },
      ],
      drawOrder: ['body'],
    };
    expect(resolveWeaponMount(new Rig(def))).toBe('none');
  });

  it('an explicit declaration wins over the bone-shape guess', () => {
    const def: RigDef = {
      ...CRITTER_CORE_RIG, id: 'forced-none', weaponMount: 'none',
    };
    expect(resolveWeaponMount(new Rig(def))).toBe('none');
    expect(resolveWeaponMount(new Rig({ ...ORB_CORE_RIG, id: 'forced-held', weaponMount: 'held' }))).toBe('held');
  });
});

describe('activeModuleMount — the socket path', () => {
  // orb-core's real geometry: `socket_r` is `len 52, rwa 0` hanging off the shell's tip at
  // (0, -46), so its PIVOT is the core's centre and its TIP is 52 px due east of it. The
  // pivot is what the module orbits around, so giving it a value distinct from the tip is
  // what makes the test able to fail (see the held path's own note on this fixture trap).
  const wp = poses({
    socket_r: { sx: 0, sy: -46, ex: 52, ey: -46, wa: 0 },
    socket_l: { sx: 0, sy: -46, ex: -52, ey: -46, wa: 180 },
  });

  // The 2026-09-02 change, and the one property the arc fix rests on: the module rides
  // AROUND the core to wherever the hero is aiming, in the ground plane, instead of being
  // pinned to its bone's tip and merely spun. See rigWeaponMount's GROUND-PLANE ORBIT note.
  it('orbits the core toward the aim at the socket bone reach it declares', () => {
    const east = activeModuleMount('socket', wp, noTransforms, 0, null)!;
    expect(east.x).toBeCloseTo(52, 10);
    expect(east.y).toBeCloseTo(-46, 10);

    const north = activeModuleMount('socket', wp, noTransforms, -Math.PI / 2, null)!;
    expect(north.x).toBeCloseTo(0, 10); // swung off the right-hand side entirely...
    expect(north.y).toBeCloseTo(-46 - 52, 10); // ...and 52 px up-screen of the core

    const south = activeModuleMount('socket', wp, noTransforms, Math.PI / 2, null)!;
    expect(south.x).toBeCloseTo(0, 10);
    expect(south.y).toBeCloseTo(-46 + 52, 10);
  });

  // UNSQUASHED is the whole point (the held path used to squash its own vertical offset by
  // 0.45): the sim spawns a round `muzzleOffset` along the aim ray on the GROUND plane and
  // the renderer maps ground y to screen y 1:1, so anything less than 1:1 here puts the drawn
  // gun off the line its own bullets fly along — which is what drew the arc.
  it('moves the module as far up-screen as across — the ground plane is not foreshortened', () => {
    const across = activeModuleMount('socket', wp, noTransforms, 0, null)!;
    const up = activeModuleMount('socket', wp, noTransforms, -Math.PI / 2, null)!;
    expect(Math.abs(across.x - 0)).toBeCloseTo(Math.abs(up.y - -46), 10);
  });

  it('takes the canonical aim angle as its rotation, and reports the plane it orbits in', () => {
    const m = activeModuleMount('socket', wp, noTransforms, 0.7, null)!;
    expect(m.angle).toBe(0.7);
    // `pivotY` is the height half of the mount (negated): the core's own centre, NOT the
    // module's current y — which mixes in how far north the orbit has carried it.
    expect(m.pivotY).toBeCloseTo(-46, 10);
    expect(m.y).not.toBeCloseTo(-46, 3); // aim 0.7 rad has swung it south of that plane
  });

  it('is null when that bone is not posed this frame', () => {
    expect(activeModuleMount('socket', poses({}), noTransforms, 0, null)).toBeNull();
  });

  // The socket path must NOT consult the body — an orb-core's module orbits on its own bone,
  // and reading `drawnBodyR` there would silently re-place the hero's gun.
  it('ignores the held-path body argument entirely', () => {
    const withBody = activeModuleMount('socket', wp, noTransforms, 0.7, { boneId: 'shell', drawnR: 999 });
    expect(withBody).toEqual(activeModuleMount('socket', wp, noTransforms, 0.7, null));
  });
});

describe('activeModuleMount — the held path', () => {
  // `sx/sy` (the bone's PIVOT) are deliberately given values DIFFERENT from `ex/ey` (its
  // TIP). The first version of this fixture left both at 0, and the mutation battery walked
  // straight through a `pose.ex` -> `pose.sx` edit — the exact bug class that shipped a
  // visibly disassembled hero for three weeks (art drawn at each bone's pivot instead of its
  // tip). A rig hangs its body off a pivot at the actor's FEET, so pivot and tip are a whole
  // body-length apart and confusing them is not a subtle error.
  const body = poses({ body: { sx: 7, sy: 11, ex: 0, ey: -40, wa: -90 } });

  it('hangs off the body bone TIP, not its pivot — they are a body-length apart', () => {
    const m = activeModuleMount('held', body, noTransforms, 0, { boneId: 'body', drawnR: 35 })!;
    expect(m.y).toBeCloseTo(-40, 10); // the tip's ey, nowhere near the pivot's sy of 11
    expect(m.x).toBeCloseTo(35 * HELD_MOUNT_R, 10); // the tip's ex of 0, not the pivot's 7
  });

  it('holds the module out along the aim, on the body art edge', () => {
    const m = activeModuleMount('held', body, noTransforms, 0, { boneId: 'body', drawnR: 35 })!;
    expect(m.x).toBeCloseTo(35 * HELD_MOUNT_R, 10);
    expect(m.y).toBeCloseTo(-40, 10);
    expect(m.angle).toBeCloseTo(0, 10);

    const down = activeModuleMount('held', body, noTransforms, Math.PI / 2, { boneId: 'body', drawnR: 35 })!;
    expect(down.x).toBeCloseTo(0, 10);
    expect(down.y).toBeCloseTo(-40 + 35 * HELD_MOUNT_R, 10);
  });

  // Was squashed 0.45 vertically until 2026-09-02, on a "the gun walks across the body's
  // SURFACE" reading. It does not: a mob holds its gun out at arm's length in the direction
  // it aims, which is a GROUND-PLANE displacement, and the renderer maps ground y to screen y
  // 1:1 (`Entity.applyTransform`: `screen.y = groundY - z`). Squashing it put the drawn gun
  // off the line its own bullets fly along, i.e. gave every mob's shot the same arc out of the
  // barrel the hero's had. See rigWeaponMount's GROUND-PLANE ORBIT note.
  it('moves the module as far down-screen as across — the ground plane is not foreshortened', () => {
    const across = activeModuleMount('held', body, noTransforms, 0, { boneId: 'body', drawnR: 50 })!;
    const down = activeModuleMount('held', body, noTransforms, Math.PI / 2, { boneId: 'body', drawnR: 50 })!;
    expect(Math.abs(across.x - 0)).toBeCloseTo(Math.abs(down.y - -40), 10);
  });

  it('reports the plane it is held in, not its swung position', () => {
    const down = activeModuleMount('held', body, noTransforms, Math.PI / 2, { boneId: 'body', drawnR: 35 })!;
    expect(down.pivotY).toBeCloseTo(-40, 10); // the body tip's own height
    expect(down.y).not.toBeCloseTo(-40, 3);
  });

  /**
   * The measurement that chose this path over adding a socket bone, expressed as a test.
   *
   * critter-core / brute-core / floater-core share ONE `Rig`, so a socket bone could only
   * ever declare one length — but the three shipped bundles paint 0.70 / 1.00 / 1.00 of the
   * same declared `bodyR` of 50 (`skinRegistry.BODY_FILL`, re-measured from the real PNGs by
   * `rigComposition.test.ts`), i.e. drawn half-widths of 35 / 50 / 50 authoring px. Mounting
   * off the drawn radius is what makes one rule fit all three, so it has to actually vary
   * with it.
   */
  it('follows the body art, not the declared bodyR — the reason a shared socket bone could not work', () => {
    const at = (drawnR: number) => activeModuleMount('held', body, noTransforms, 0, { boneId: 'body', drawnR })!.x;
    const critter = at(50 * 0.7); // bodyFill 0.70
    const brute = at(50 * 1.0); // bodyFill 1.00
    expect(critter).toBeLessThan(brute);
    expect(brute / critter).toBeCloseTo(1 / 0.7, 6);
  });

  // `computeFK` folds a clip's rotation into a bone's tip but NOT its translation, so a rig
  // whose idle clip bobs the body would leave the gun hanging in the air without this.
  it('rides the body bone through a clip translation (the hover bob)', () => {
    const t = new Map<string, ResolvedBoneTransform>([
      ['body', { translateX: 3, translateY: -6 } as ResolvedBoneTransform],
    ]);
    const m = activeModuleMount('held', body, t, 0, { boneId: 'body', drawnR: 35 })!;
    expect(m.x).toBeCloseTo(3 + 35 * HELD_MOUNT_R, 10);
    expect(m.y).toBeCloseTo(-46, 10);
  });

  it('is null when the body bone is unposed, or when no body was resolved', () => {
    expect(activeModuleMount('held', poses({}), noTransforms, 0, { boneId: 'body', drawnR: 35 })).toBeNull();
    expect(activeModuleMount('held', body, noTransforms, 0, null)).toBeNull();
  });

  it("mounts nothing for 'none', body or not", () => {
    expect(activeModuleMount('none', body, noTransforms, 0, { boneId: 'body', drawnR: 35 })).toBeNull();
    expect(activeModuleMount('none', body, noTransforms, 0, null)).toBeNull();
  });
});

describe('idleModuleMount — the decorative second module is the hero silhouette only', () => {
  const wp = poses({ socket_l: { ex: -52, ey: -46, wa: 180 }, body: { ex: 0, ey: -40 } });

  it('sits on the idle socket and turns with its OWN bone, not the reticle', () => {
    const m = idleModuleMount('socket', wp)!;
    expect(m.x).toBe(-52);
    expect(m.y).toBe(-46);
    expect(m.angle).toBeCloseTo(Math.PI, 10); // socket_l's rest angle, i.e. away from the core
  });

  // design/13's "two weapon modules that orbit it" describes the hero. A mob carries one gun,
  // so the held path must not mirror a decorative second copy onto the other side.
  it('is null on the held path — a mob carries one gun', () => {
    expect(idleModuleMount('held', wp)).toBeNull();
  });

  it("is null for 'none'", () => {
    expect(idleModuleMount('none', wp)).toBeNull();
  });

  it('is null when the idle socket is unposed', () => {
    expect(idleModuleMount('socket', poses({ socket_r: {} }))).toBeNull();
  });
});

describe('rigWeaponMount — the constants the renderer depends on', () => {
  it('names the sockets the orb-core rig actually declares', () => {
    const orb = new Rig(ORB_CORE_RIG);
    expect(orb.boneMap.has(ACTIVE_WEAPON_SOCKET)).toBe(true);
    expect(orb.boneMap.has(IDLE_WEAPON_SOCKET)).toBe(true);
  });

  it('aim-tracks the ACTIVE socket only — the idle arm turns with its module', () => {
    expect(AIM_TRACKING_BONES.has(ACTIVE_WEAPON_SOCKET)).toBe(true);
    expect(AIM_TRACKING_BONES.has(IDLE_WEAPON_SOCKET)).toBe(false);
  });

  it('puts a far-side module below every bone binding and below the tether', () => {
    // orb-core's bindings run zOrder 0..4 and the tether sits at -1 (RigSkin); a "behind"
    // module has to be under all of them or it reads as a gun on the hero's chest.
    expect(MODULE_Z_BEHIND).toBeLessThan(-1);
  });
});

describe('barrelReach — how far a weapon texture extends from its anchor', () => {
  it('reaches the right edge for art baked pointing +x', () => {
    expect(barrelReach(100, 50, { x: 0.2, y: 0.5 }, 0)).toBeCloseTo(80, 6);
  });

  it('reaches the left edge once the offset flips the baked direction', () => {
    expect(barrelReach(100, 50, { x: 0.8, y: 0.5 }, Math.PI)).toBeCloseTo(80, 6);
  });

  it('takes the NEARER of the two edges the ray could leave through', () => {
    // Baked 45° down-right out of a wide, short texture: the bottom edge comes first.
    const r = barrelReach(400, 20, { x: 0.5, y: 0.5 }, -Math.PI / 4);
    expect(r).toBeCloseTo(10 * Math.SQRT2, 6);
  });

  // Also from the battery: dropping the negation in `cos(-rotationOffsetRad)` survived,
  // because every fixture above is vertically symmetric about its anchor (anchor.y 0.5, or an
  // offset of 0/pi where the sign cannot show). With the anchor off-centre, a sign flip sends
  // the ray out through the near edge instead of the far one and the reach changes.
  it('respects the SIGN of the offset — the baked direction is -rotationOffsetRad', () => {
    // Anchor high in the texture: 10 px of room upward, 90 px downward.
    const anchor = { x: 0.5, y: 0.1 };
    const down = barrelReach(400, 100, anchor, -Math.PI / 2); // baked pointing +y (down)
    const up = barrelReach(400, 100, anchor, Math.PI / 2); // baked pointing -y (up)
    expect(down).toBeCloseTo(90, 6);
    expect(up).toBeCloseTo(10, 6);
    expect(down).not.toBeCloseTo(up, 3);
  });

  it('handles an axis-aligned direction without dividing by zero', () => {
    expect(Number.isFinite(barrelReach(100, 50, { x: 0.5, y: 0.5 }, -Math.PI / 2))).toBe(true);
    expect(barrelReach(100, 50, { x: 0.5, y: 0.5 }, -Math.PI / 2)).toBeCloseTo(25, 6);
  });
});

/**
 * The recoil offset (2026-08-30, user report *"角色射击时，没有射击动画"*). `rigRecoil.ts` owns
 * the envelope; what belongs here is that the number it produces slides the mount straight
 * back down the BARREL, on both mount paths, and that it is the identity at rest.
 */
describe('activeModuleMount — the fire recoil', () => {
  // orb-core's real socket: pivot at the core's centre, tip 52 px east of it. The PIVOT is
  // what the module orbits around and the pivot-to-tip distance is how far out it rides, so
  // a fixture that left `sx/sy` at the origin would silently give it a 69.6 px reach.
  const socketPose = poses({ socket_r: { sx: 0, sy: -46, ex: 52, ey: -46, wa: 0 } });
  const bodyPose = poses({ body: { sx: 7, sy: 11, ex: 0, ey: -40, wa: -90 } });
  const heldBody = { boneId: 'body', drawnR: 35 };

  it('is the exact identity at rest, on both paths', () => {
    expect(activeModuleMount('socket', socketPose, noTransforms, 0.7, null, 0))
      .toEqual(activeModuleMount('socket', socketPose, noTransforms, 0.7, null));
    expect(activeModuleMount('held', bodyPose, noTransforms, 0.7, heldBody, 0))
      .toEqual(activeModuleMount('held', bodyPose, noTransforms, 0.7, heldBody));
  });

  it('slides the socket module BACK along its own aim, never forward', () => {
    const m = activeModuleMount('socket', socketPose, noTransforms, 0, null, 10)!;
    expect(m.x).toBeCloseTo(52 - 10, 10); // aiming +x, so the kick is -x
    expect(m.y).toBeCloseTo(-46, 10);
    expect(m.angle).toBeCloseTo(0, 10); // the gun recoils, it does not re-aim
  });

  it('follows the aim around the circle rather than kicking in a fixed direction', () => {
    const down = activeModuleMount('socket', socketPose, noTransforms, Math.PI / 2, null, 10)!;
    expect(down.x).toBeCloseTo(0, 10); // the orbit has carried it off the right-hand side
    // 52 px down-screen of the core (the orbit), then 10 straight back UP it (the kick).
    expect(down.y).toBeCloseTo(-46 + 52 - 10, 10);
  });

  // Held path, straight back up the screen from a down-aim — the same full-distance kick the
  // socket path gets. (Until 2026-09-02 this test read the other way round: the held path's
  // outward offset was squashed 0.45 while its recoil was not, and the assertion was that the
  // two differed. Both are unsquashed ground-plane displacements now, so what is left to pin
  // is that the recoil still spends its whole distance on this path too.)
  it('slides the held module BACK along its own aim by the full distance', () => {
    const rest = activeModuleMount('held', bodyPose, noTransforms, Math.PI / 2, heldBody)!;
    const kicked = activeModuleMount('held', bodyPose, noTransforms, Math.PI / 2, heldBody, 10)!;
    expect(kicked.y).toBeCloseTo(rest.y - 10, 10);
    expect(kicked.x).toBeCloseTo(rest.x, 10);
  });

  it('moves the mount by exactly the distance it is given', () => {
    const rest = activeModuleMount('socket', socketPose, noTransforms, 0.7, null)!;
    const kicked = activeModuleMount('socket', socketPose, noTransforms, 0.7, null, 10)!;
    expect(Math.hypot(kicked.x - rest.x, kicked.y - rest.y)).toBeCloseTo(10, 10);
  });

  it('still returns null for an unposed bone — a recoil cannot conjure a mount', () => {
    expect(activeModuleMount('socket', poses({}), noTransforms, 0, null, 10)).toBeNull();
    expect(activeModuleMount('none', socketPose, noTransforms, 0, heldBody, 10)).toBeNull();
  });
});

/**
 * `moduleMuzzleLocal` — the drawn barrel tip. The bullet spawns here, the muzzle fx burst
 * here, and (since 2026-08-30) it recoils with the gun because the recoil is applied to the
 * MOUNT this reads, not to the sprite afterwards.
 */
describe('moduleMuzzleLocal — the drawn barrel tip', () => {
  // A texture baked pointing +x, anchored 0.2 in: `barrelReach` = 0.8 * 100 = 80, halved by
  // the 0.5 sprite scale = 40 px of reach from the anchor.
  const tex = { width: 100, height: 50 };
  const anchor = { x: 0.2, y: 0.5 };

  it('steps from the mount along the aim by the texture reach, scaled', () => {
    const m = moduleMuzzleLocal({ x: 52, y: -46 }, 0, 1, tex, anchor, 0, 0.5);
    expect(m.x).toBeCloseTo(52 + 40, 6);
    expect(m.y).toBeCloseTo(-46, 6);
  });

  it('steps UNSQUASHED — the barrel is drawn at the full canonical angle', () => {
    const m = moduleMuzzleLocal({ x: 0, y: 0 }, Math.PI / 2, 1, tex, anchor, 0, 0.5);
    expect(m.y).toBeCloseTo(40, 6);
    expect(m.x).toBeCloseTo(0, 6);
  });

  // `RigSkin.view.scale.x` mirrors the whole rig, so the X half of the result — and ONLY the
  // X half — has to come back through that flip to be stated in the rig's parent space.
  it('mirrors X (and only X) for a flipped rig', () => {
    const right = moduleMuzzleLocal({ x: 52, y: -46 }, 0, 1, tex, anchor, 0, 0.5);
    const left = moduleMuzzleLocal({ x: 52, y: -46 }, 0, -1, tex, anchor, 0, 0.5);
    expect(left.x).toBeCloseTo(-right.x, 6);
    expect(left.y).toBeCloseTo(right.y, 6);
  });

  it('recoils with the gun, because it reads the already-kicked mount', () => {
    const socketPose = poses({ socket_r: { ex: 52, ey: -46, wa: 0 } });
    const rest = activeModuleMount('socket', socketPose, noTransforms, 0, null)!;
    const kicked = activeModuleMount('socket', socketPose, noTransforms, 0, null, 10)!;
    const tipRest = moduleMuzzleLocal(rest, 0, 1, tex, anchor, 0, 0.5);
    const tipKicked = moduleMuzzleLocal(kicked, 0, 1, tex, anchor, 0, 0.5);
    expect(tipRest.x - tipKicked.x).toBeCloseTo(10, 6);
  });
});
