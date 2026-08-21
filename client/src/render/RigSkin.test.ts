/**
 * RigSkin — the `.tao` runtime renderer's facing model (design/12), extended with
 * the upper/lower body split: `setBodyFacing` drives the whole-rig L/R flip + front/
 * back hemisphere, `setAim` drives ONLY the weapon-socket aim-tracking rotation, and
 * the two must stay independent of each other. Uses a minimal fake bundle over the
 * real `ORB_CORE_RIG` (has both weapon sockets) — Pixi Sprite/Container construct
 * fine under plain vitest with no renderer attached (same finding Forge.test.ts/
 * Screens.test.ts made), so no real texture asset is needed, just `Texture.WHITE`.
 */
import { describe, it, expect, vi } from 'vitest';
import { Container, Graphics, Texture } from 'pixi.js';
import { Rig, type RigDef } from './Rig';
import { ORB_CORE_RIG } from './orbCoreRig';
import { CRITTER_CORE_RIG } from './critterCoreRig';
import { BOSS_CORE_RIG } from './bossCoreRig';
import { RigSkin, barrelReach } from './RigSkin';
import type { RigSkinBundle } from './taoBundle';
import type { AnimationClip, SpriteBinding } from './types';

function fakeBundle(rig: Rig): RigSkinBundle {
  const bindings = new Map<string, SpriteBinding>();
  const textures = new Map<string, Texture>();
  for (const boneId of rig.drawOrder) {
    bindings.set(boneId, { anchorX: 0.5, anchorY: 0.5, flipX: false, zOrder: 0, rotation: 0, scaleX: 1, scaleY: 1 });
    textures.set(boneId, Texture.WHITE);
  }
  return { bindings, clips: new Map(), textures };
}

function makeSkin(def = ORB_CORE_RIG, clips?: Map<string, AnimationClip>): RigSkin {
  const rig = new Rig(def);
  const bundle = fakeBundle(rig);
  if (clips) for (const [name, clip] of clips) bundle.clips.set(name, clip);
  return new RigSkin(rig, bundle);
}

/** Like `makeSkin`, but with an explicit `bodyFill` — the fraction of its declared `bodyR` a
 *  bundle's art actually paints. `makeSkin` leaves it at the default of 1, which makes
 *  `bodyR * bodyFill` and `bodyR` indistinguishable; the held mount is defined in terms of the
 *  former, so a fill of exactly 1 cannot tell the two apart (the mutation battery walked
 *  through a `drawnBodyR()` -> `bodyR` edit for precisely that reason). */
function makeSkinWithFill(def: RigDef, bodyFill: number, clips?: Map<string, AnimationClip>): RigSkin {
  const rig = new Rig(def);
  const bundle = fakeBundle(rig);
  if (clips) for (const [name, clip] of clips) bundle.clips.set(name, clip);
  return new RigSkin(rig, bundle, bodyFill);
}

function spritesOf(skin: RigSkin): Map<string, { x: number; y: number; rotation: number }> {
  return (skin as unknown as { sprites: Map<string, { x: number; y: number; rotation: number }> }).sprites;
}

function socketRRotation(skin: RigSkin): number {
  skin.update();
  const sprites = (skin as unknown as { sprites: Map<string, { rotation: number }> }).sprites;
  return sprites.get('socket_r')!.rotation;
}

describe('RigSkin — body facing drives the flip, independently of aim', () => {
  it('setBodyFacing alone flips the rig by ITS OWN horizontal sign', () => {
    const skin = makeSkin();
    skin.setBodyFacing(Math.PI); // facing left
    expect(skin.view.scale.x).toBe(-1);
    skin.setBodyFacing(0); // facing right
    expect(skin.view.scale.x).toBe(1);
  });

  it('setAim never changes the body flip, even when it disagrees with body facing', () => {
    const skin = makeSkin();
    skin.setBodyFacing(0); // body faces right → unflipped
    skin.setAim(Math.PI); // but aiming left
    expect(skin.view.scale.x).toBe(1); // still unflipped — flip is body-only

    skin.setBodyFacing(Math.PI); // body now faces left → flipped
    skin.setAim(0); // aiming right
    expect(skin.view.scale.x).toBe(-1); // still flipped — unaffected by aim
  });
});

describe('RigSkin — weapon-socket rotation tracks aim, independent of body flip', () => {
  it('unflipped body: the socket rotates straight to the aim angle', () => {
    const skin = makeSkin();
    skin.setBodyFacing(0); // unflipped
    skin.setAim(Math.PI / 3);
    expect(socketRRotation(skin)).toBeCloseTo(Math.PI / 3, 10);
  });

  it('flipped body: the socket still renders at the true aim angle (mirror-compensated)', () => {
    // This is the exact case an upper/lower split needs to get right: the body is
    // flipped by ITS OWN (movement) direction, not the aim, so the local rotation fed
    // to a mirrored socket must be the mirror image of the aim for the flip to cancel
    // out and land on the real aim angle — see RigSkin.canonicalSocketAngleRad.
    const skin = makeSkin();
    skin.setBodyFacing(Math.PI); // body faces left → flipped
    skin.setAim(0); // but still shooting due right
    // canonical local rotation = PI - aim = PI; mirrored by scale.x=-1 it renders as
    // 0 (the true aim) — this test only pins the LOCAL rotation RigSkin computes
    // (documented contract), not Pixi's full transform composition.
    expect(socketRRotation(skin)).toBeCloseTo(Math.PI, 10);
  });

  it('aim keeps tracking through a body flip change (independent state)', () => {
    const skin = makeSkin();
    skin.setBodyFacing(0);
    skin.setAim(Math.PI / 4); // NOT the π - x fixed point (π/2 mirrors onto itself)
    const before = socketRRotation(skin);
    skin.setBodyFacing(Math.PI); // only the body direction changes
    // With the body now flipped, the same aim needs the mirrored local angle again —
    // the socket rotation is expected to CHANGE (still correctly tracking aim), while
    // the raw aim angle itself (what setAim was called with) never did.
    const after = socketRRotation(skin);
    expect(after).not.toBeCloseTo(before, 5);
    expect(after).toBeCloseTo(Math.PI - Math.PI / 4, 10);
  });
});

/**
 * Placement model (RigSkin's "Placement model" doc block). These pin the exact two
 * mistakes that shipped a visibly disassembled hero for three weeks — art drawn at the
 * bone PIVOT instead of its TIP, and rotated by the bone's raw world angle instead of
 * its angle relative to rest. Both were invisible to every pre-existing test, since all
 * of them asserted the socket's aim rotation and nothing else.
 */
describe('RigSkin — a bone\'s art sits on its TIP, in its authored orientation', () => {
  it('the body bone draws its art on the tip (the hover height), not at the ground pivot', () => {
    const skin = makeSkin();
    skin.update();
    const shell = spritesOf(skin).get('shell')!;
    // ORB_CORE_RIG: shell is len 46 straight up (rwa -90) from the root at (0,0).
    expect(shell.x).toBeCloseTo(0, 6);
    expect(shell.y).toBeCloseTo(-46, 6);
  });

  it('the decorative bones spread across the body instead of piling up on one point', () => {
    const skin = makeSkin();
    skin.update();
    const s = spritesOf(skin);
    const at = (id: string) => [s.get(id)!.x, s.get(id)!.y].map(n => Math.round(n));
    // The eye is centred on the shell (-46) but slid along the default aim (east, so
    // +EYE_TRACK_R in x and nothing in y) by the eye-tracking pass — see its own describe
    // block below. Every other bone sits exactly on its bone tip.
    expect(at('eye')).toEqual([14, -46]);
    expect(at('belly')).toEqual([0, -26]); // 20 down from centre → the shell's lower half
    expect(at('socket_l')).toEqual([-52, -46]); // orbiting left of the core...
    expect(at('socket_r')).toEqual([52, -46]); // ...and right — 104 apart, not co-located
  });

  it('art authored upright renders upright, despite the bone pointing up (rwa -90)', () => {
    const skin = makeSkin();
    skin.update();
    const s = spritesOf(skin);
    expect(s.get('shell')!.rotation).toBeCloseTo(0, 6);
    expect(s.get('belly')!.rotation).toBeCloseTo(0, 6); // rwa +90, also cancelled
  });

  it('holds for an enemy rig too — one bone, same convention', () => {
    const skin = makeSkin(CRITTER_CORE_RIG);
    skin.update();
    const body = spritesOf(skin).get('body')!;
    expect(body.y).toBeCloseTo(-40, 6); // CRITTER_CORE_RIG's body len
    expect(body.rotation).toBeCloseTo(0, 6);
  });

  it('a clip\'s bone rotation is applied ONCE, not twice', () => {
    // Rig.computeFK already folds a bone's animated rotation into pose.wa; adding the
    // same keyframe value again on top of it doubled every authored rotation.
    const clip: AnimationClip = {
      duration: 1,
      loop: false,
      keyframes: [{ time: 0, bones: new Map([['belly', { rotation: 30 }]]) }],
    };
    const skin = makeSkin(ORB_CORE_RIG, new Map([['idle', clip]]));
    skin.playClip('idle', 0);
    skin.update();
    expect(spritesOf(skin).get('belly')!.rotation).toBeCloseTo((30 * Math.PI) / 180, 6);
  });
});

describe('RigSkin — orbiting bones get a drawn energy tether', () => {
  const tetherOf = (skin: RigSkin) => (skin as unknown as { tethers: Container | null }).tethers;

  it('orb-core gets one (its sockets declare tether widths), painted behind the body', () => {
    const skin = makeSkin();
    const tethers = tetherOf(skin);
    expect(tethers).not.toBeNull();
    expect(tethers!.zIndex).toBeLessThan(0);
    expect(skin.view.children).toContain(tethers);
  });

  it('a rig with no orbiting bones builds no tether graphics at all', () => {
    expect(tetherOf(makeSkin(CRITTER_CORE_RIG))).toBeNull();
  });

  it('the geometry signature is reused frame to frame, so an idle hover skips the rebuild', () => {
    const skin = makeSkin();
    skin.update();
    const signature = (skin as unknown as { tetherGeometry: string }).tetherGeometry;
    expect(signature).not.toBe('');
    // Both socket bones, each contributing one pivot→tip pair.
    expect(signature.split(';').filter(Boolean)).toHaveLength(2);
    skin.update();
    expect((skin as unknown as { tetherGeometry: string }).tetherGeometry).toBe(signature);
  });
});

/**
 * Both arms carry a module (design/13's "two weapon modules that orbit it"; the concept
 * turnaround draws both) — the active one tracks aim, the idle one points outward along its
 * own tether. `weaponSkins` is mocked because the real one loads textures over the network:
 * `getWeaponTexture` returning undefined would hide both modules and make these vacuous.
 */
vi.mock('./weaponSkins', () => ({
  getWeaponTexture: () => Texture.WHITE,
  getWeaponAnchor: () => ({ x: 0.2, y: 0.44 }),
  getWeaponScale: () => 0.25,
  getWeaponRotationOffset: () => 0,
}));

describe('RigSkin — two orbiting weapon modules, one active, one idle', () => {
  const modulesOf = (skin: RigSkin) =>
    skin as unknown as {
      weaponSprite: { x: number; y: number; rotation: number; visible: boolean } | null;
      idleModuleSprite: { x: number; y: number; rotation: number; visible: boolean } | null;
    };

  function armed(): RigSkin {
    const skin = makeSkin();
    skin.setWeaponKind('ranged', 'repeater');
    skin.setBodyFacing(0);
    skin.setAim(0);
    skin.update();
    return skin;
  }

  it('each module sits on its own socket\'s tip — 104 authoring-px apart, not stacked on the core', () => {
    const m = modulesOf(armed());
    expect(m.weaponSprite!.x).toBeCloseTo(52, 6);
    expect(m.weaponSprite!.y).toBeCloseTo(-46, 6);
    expect(m.idleModuleSprite!.x).toBeCloseTo(-52, 6);
    expect(m.idleModuleSprite!.y).toBeCloseTo(-46, 6);
  });

  it('the active module tracks aim; the idle one points outward along its tether instead', () => {
    const skin = armed();
    skin.setAim(Math.PI / 3);
    skin.update();
    const m = modulesOf(skin);
    expect(m.weaponSprite!.rotation).toBeCloseTo(Math.PI / 3, 10);
    expect(m.idleModuleSprite!.rotation).toBeCloseTo(Math.PI, 10); // socket_l's rest angle: away from the core
    expect(m.idleModuleSprite!.visible).toBe(true);
  });

  it('unarmed hides BOTH modules, not just the active one', () => {
    const skin = armed();
    skin.setWeaponKind(null);
    skin.update();
    const m = modulesOf(skin);
    expect(m.weaponSprite!.visible).toBe(false);
    expect(m.idleModuleSprite!.visible).toBe(false);
  });

  // muzzleLocal (2026-08-17): where the bullet view is spawned so shots leave the barrel
  // tip rather than mid-housing. The mocked weaponSkins above give a 1x1 Texture.WHITE at
  // anchor.x 0.2, scale 0.25 and rotationOffset 0 — so the reach past the socket tip is
  // (1 - 0.2) * 1 * 0.25 = 0.2 authoring-px. Small, but it is the same arithmetic the
  // real 320px textures go through, and `barrelReach` is covered on its own below.
  it('the muzzle sits past the ACTIVE socket tip, along the aim direction', () => {
    const skin = armed();
    skin.setAim(0);
    skin.update();
    expect(skin.muzzleLocal()).toEqual({ x: expect.closeTo(52.2, 6), y: expect.closeTo(-46, 6) });

    skin.setAim(Math.PI / 2); // straight down-screen: the reach goes into +y, not +x
    skin.update();
    expect(skin.muzzleLocal()).toEqual({ x: expect.closeTo(52, 6), y: expect.closeTo(-45.8, 6) });
  });

  it('mirrors with the rig — a left-facing body puts the muzzle on the left, still ahead of the socket', () => {
    const skin = armed();
    skin.setBodyFacing(Math.PI);
    skin.setAim(Math.PI);
    skin.update();
    const m = skin.muzzleLocal()!;
    expect(skin.view.scale.x).toBe(-1);
    expect(m.x).toBeCloseTo(-52.2, 6); // past the socket tip on the mirrored side
    expect(m.y).toBeCloseTo(-46, 6);
  });

  it('is null with no module mounted — nothing for a caller to correct toward', () => {
    const skin = armed();
    skin.setWeaponKind(null);
    skin.update();
    expect(skin.muzzleLocal()).toBeNull();
  });

  it("is null on a rig that mounts nothing at all (boss-core's weaponMount: 'none')", () => {
    const skin = makeSkin(BOSS_CORE_RIG);
    skin.setWeaponKind('ranged', 'enemygun');
    skin.update();
    expect(skin.muzzleLocal()).toBeNull();
  });

  // Was asserted as `toBeNull()` until 2026-08-21, which is the defect this pass fixed: an
  // enemy having no muzzle followed from an enemy never mounting a weapon at all. Now that
  // the held path mounts one, a mob's bullets get the same barrel-tip spawn correction the
  // hero's have (Scene.reconcile), so the muzzle has to be real.
  it('is NOT null on a held-mount rig — an enemy has a barrel tip to correct toward', () => {
    const skin = makeSkin(CRITTER_CORE_RIG);
    skin.setWeaponKind('ranged', 'enemygun');
    skin.setAim(0);
    skin.update();
    const m = skin.muzzleLocal();
    expect(m).not.toBeNull();
    // body tip (0,-40) + drawnBodyR 50 along +x, then barrelReach 0.2 past that.
    expect(m!.x).toBeCloseTo(50.2, 6);
    expect(m!.y).toBeCloseTo(-40, 6);
  });
});

/**
 * The held mount, WIRED — `rigWeaponMount.test.ts` covers the geometry as a pure function;
 * these cover RigSkin actually feeding it the right inputs, which is a separate failure
 * surface and the one the mutation battery found uncovered.
 */
describe('RigSkin — the held weapon mount (the enemy body forms, 2026-08-21)', () => {
  const moduleOf = (skin: RigSkin) =>
    (skin as unknown as { weaponSprite: { x: number; y: number; visible: boolean } | null }).weaponSprite;
  const idleOf = (skin: RigSkin) =>
    (skin as unknown as { idleModuleSprite: { visible: boolean } | null }).idleModuleSprite;

  // critter-core's own measured fill. The mount has to follow the ART, so this number moving
  // has to move the gun — that is what makes one rule fit critter (0.70) and brute/floater
  // (1.00) off a single shared rig.
  it("scales the mount by the bundle's measured bodyFill, not by the declared bodyR", () => {
    const armedAt = (bodyFill: number) => {
      const skin = makeSkinWithFill(CRITTER_CORE_RIG, bodyFill);
      skin.setWeaponKind('ranged', 'enemygun');
      skin.setAim(0);
      skin.update();
      return moduleOf(skin)!.x;
    };
    const partial = armedAt(0.7);
    const full = armedAt(1);
    expect(partial).toBeLessThan(full);
    expect(full / partial).toBeCloseTo(1 / 0.7, 6);
    // And concretely: critter-core's body bone declares bodyR 50, so 0.70 of it is 35.
    expect(partial).toBeCloseTo(35, 6);
  });

  it("mounts exactly one module — a mob does not get the hero's decorative second arm", () => {
    const skin = makeSkinWithFill(CRITTER_CORE_RIG, 0.7);
    skin.setWeaponKind('ranged', 'enemygun');
    skin.update();
    expect(moduleOf(skin)!.visible).toBe(true);
    // Either never created, or created and hidden — both are "not drawn"; what must not
    // happen is a second gun appearing on a creature with one.
    expect(idleOf(skin)?.visible ?? false).toBe(false);
  });

  it('rides the body bone through a clip translation — the gun does not hang in the air', () => {
    // `computeFK` folds a clip's rotation into a bone's tip but NOT its translation, so this
    // is the plumbing that keeps a held module attached through the idle bob. Asserted here
    // and not just in the pure-function test because RigSkin has to pass `transforms` down at
    // all — dropping that argument is invisible to any fixture whose bundle has no clips.
    const clip: AnimationClip = {
      duration: 1,
      loop: false,
      keyframes: [{ time: 0, bones: new Map([['body', { translateX: 4, translateY: -9 }]]) }],
    };
    const still = makeSkinWithFill(CRITTER_CORE_RIG, 0.7);
    still.setWeaponKind('ranged', 'enemygun');
    still.setAim(0);
    still.update();
    const restX = moduleOf(still)!.x;
    const restY = moduleOf(still)!.y;

    const bobbing = makeSkinWithFill(CRITTER_CORE_RIG, 0.7, new Map([['idle', clip]]));
    bobbing.setWeaponKind('ranged', 'enemygun');
    bobbing.setAim(0);
    bobbing.playClip('idle', 0);
    bobbing.update();
    expect(moduleOf(bobbing)!.x).toBeCloseTo(restX + 4, 6);
    expect(moduleOf(bobbing)!.y).toBeCloseTo(restY - 9, 6);
  });

  it("mounts nothing on a 'none' rig, however it is armed", () => {
    const skin = makeSkin(BOSS_CORE_RIG);
    skin.setWeaponKind('ranged', 'enemygun');
    skin.update();
    expect(moduleOf(skin)?.visible ?? false).toBe(false);
    expect(idleOf(skin)?.visible ?? false).toBe(false);
  });

  it('mirrors with the body, so a left-facing mob holds its gun on its left', () => {
    const skin = makeSkinWithFill(CRITTER_CORE_RIG, 0.7);
    skin.setWeaponKind('ranged', 'enemygun');
    skin.setBodyFacing(Math.PI);
    skin.setAim(Math.PI);
    skin.update();
    expect(skin.view.scale.x).toBe(-1);
    // Canonical (pre-mirror) space puts it at +x; the whole-rig flip renders that on the left.
    expect(moduleOf(skin)!.x).toBeCloseTo(35, 6);
  });
});

describe('barrelReach — how far a weapon texture extends from its anchor', () => {
  const anchor = { x: 0.25, y: 0.5 };

  it('measures to the far edge for canonical art (socket left, business end right)', () => {
    // rotationOffset 0 = already pointing +x, so the ray leaves through the right edge.
    expect(barrelReach(320, 160, anchor, 0)).toBeCloseTo(240, 6); // (1 - 0.25) * 320
  });

  it('measures the OTHER way for art baked pointing backwards', () => {
    // A 180° offset is what cancels art drawn "socket right, business end trailing left"
    // (the GPT Image 2 composition habit weaponSkins.ts documents) — the reach is then
    // the anchor's own short side, not the long one.
    expect(barrelReach(320, 160, anchor, Math.PI)).toBeCloseTo(80, 6); // 0.25 * 320
  });

  it('leaves through whichever edge the ray hits first, not always a horizontal one', () => {
    // Straight up in texture space: the vertical edge is much nearer than either
    // horizontal one, so a naive "(1 - anchor.x) * width" would overshoot ~3x.
    expect(barrelReach(320, 160, anchor, Math.PI / 2)).toBeCloseTo(80, 6); // 0.5 * 160
  });
});

describe('RigSkin — front/back hemisphere follows body facing, not aim', () => {
  it('showBack is driven by setBodyFacing only', () => {
    const skin = makeSkin();
    skin.setBodyFacing(-Math.PI / 2); // body facing away from camera (up-screen)
    skin.setAim(Math.PI / 2); // aiming toward the camera — would flip showBack if aim drove it
    expect((skin as unknown as { showBack: boolean }).showBack).toBe(true);
  });
});

// Eye tracking (2026-08-18): the two-hemisphere billboard gives four discrete body poses,
// which is not enough direction read for a body plan that is mostly one eye (design/13).
// The eye slot slides inside the shell along the aim, turning those four into a continuum
// — with no new art, which is the whole point.
describe('RigSkin — the eye slides inside the shell along the aim', () => {
  function eyePos(skin: RigSkin): { x: number; y: number } {
    skin.update();
    const s = spritesOf(skin).get('eye')!;
    return { x: s.x, y: s.y };
  }

  it('moves right when aiming right and left when aiming left, around the same rest point', () => {
    const skin = makeSkin();
    skin.setBodyFacing(0); // unflipped, so canonical space IS screen space
    skin.setAim(0);
    const right = eyePos(skin);
    skin.setAim(Math.PI);
    const left = eyePos(skin);
    expect(right.x).toBeGreaterThan(left.x);
    // Symmetric about the authored rest position — no net drift in either direction.
    expect((right.x + left.x) / 2).toBeCloseTo(0, 5);
  });

  it('moves DOWN (toward the camera) when aiming down, by a squashed amount — this is a tilted view', () => {
    const skin = makeSkin();
    skin.setBodyFacing(0);
    skin.setAim(Math.PI / 2); // straight down-screen
    const down = eyePos(skin);
    skin.setAim(-Math.PI / 2); // straight up-screen
    const up = eyePos(skin);
    expect(down.y).toBeGreaterThan(up.y);
    // The vertical TRAVEL (up↔down) is deliberately smaller than the horizontal one.
    skin.setAim(0);
    const right = eyePos(skin);
    skin.setAim(Math.PI);
    const left = eyePos(skin);
    expect(down.y - up.y).toBeLessThan(right.x - left.x);
  });

  it('mirrors with the rig: a flipped body aiming left still looks left on screen', () => {
    const flipped = makeSkin();
    flipped.setBodyFacing(Math.PI); // body faces left → view.scale.x = -1
    flipped.setAim(Math.PI); // aiming left
    const local = eyePos(flipped);
    // Local +x renders as screen -x under the flip, so the local offset must be POSITIVE
    // for the eye to appear on the left. (Computing it in screen space instead would put
    // the eye on the wrong side of the shell for every left-facing pose.)
    expect(local.x).toBeGreaterThan(0);
    expect(flipped.view.scale.x).toBe(-1);
  });

  it('shrinks the eye as the aim turns away from the camera, and not when it turns toward it', () => {
    const skin = makeSkin();
    const scaleOf = (aim: number): number => {
      skin.setAim(aim);
      skin.update();
      return (spritesOf(skin).get('eye') as unknown as { scale: { x: number } }).scale.x;
    };
    const toward = scaleOf(Math.PI / 2); // aiming at the camera
    const away = scaleOf(-Math.PI / 2); // aiming away
    const side = scaleOf(0);
    expect(away).toBeLessThan(side);
    expect(toward).toBeCloseTo(side, 5); // no growth on the near side, only shrink on the far
  });

  it('leaves every other bone on its authored position (only the eye tracks)', () => {
    const skin = makeSkin();
    skin.setBodyFacing(0);
    skin.setAim(0);
    skin.update();
    const b = spritesOf(skin).get('belly')!;
    const bellyRight = { x: b.x, y: b.y }; // read the accessors; spreading a Pixi Sprite copies neither
    skin.setAim(Math.PI);
    skin.update();
    const bellyLeft = spritesOf(skin).get('belly')!;
    expect(bellyLeft.x).toBeCloseTo(bellyRight.x, 5);
    expect(bellyLeft.y).toBeCloseTo(bellyRight.y, 5);
  });
});

// design/01's "Per-weapon local z-order" — documented since the rendering doc was written,
// but the mounted module was pinned in front until 2026-08-18.
describe('RigSkin — the mounted module draws behind the body when facing away', () => {
  function moduleZ(skin: RigSkin): number {
    skin.update();
    return (skin as unknown as { weaponSprite: { zIndex: number } }).weaponSprite.zIndex;
  }

  it('is in front while facing the camera and behind while facing away', () => {
    const skin = makeSkin();
    skin.setWeaponKind('ranged', 'blaster');
    skin.setBodyFacing(Math.PI / 2); // toward the camera
    expect(moduleZ(skin)).toBeGreaterThan(0);
    skin.setBodyFacing(-Math.PI / 2); // away from the camera
    expect(moduleZ(skin)).toBeLessThan(0);
  });

  it('re-evaluates every frame, so turning around mid-play actually restacks it', () => {
    const skin = makeSkin();
    skin.setWeaponKind('ranged', 'blaster');
    skin.setBodyFacing(-Math.PI / 2);
    const behind = moduleZ(skin); // sprite is CREATED while facing away
    skin.setBodyFacing(Math.PI / 2);
    expect(moduleZ(skin)).toBeGreaterThan(behind); // and moves back in front on the next update
  });

  it('puts it behind the tether too, not between tether and body', () => {
    const skin = makeSkin();
    skin.setWeaponKind('ranged', 'blaster');
    skin.setBodyFacing(-Math.PI / 2);
    const tethers = (skin as unknown as { tethers: Container | null }).tethers;
    expect(tethers).not.toBeNull();
    expect(moduleZ(skin)).toBeLessThan(tethers!.zIndex);
  });
});

// Sphere shading (2026-08-18 depth pass). `rigShading.test.ts` covers the marks themselves;
// this block covers how RigSkin wires them onto a rig — which bone, which z, and the one
// thing that is easy to get backwards: the key light must NOT mirror with the body.
describe('RigSkin — sphere shading over the body bone', () => {
  function shadeOf(skin: RigSkin): Graphics | null {
    return (skin as unknown as { sphereShade: Graphics | null }).sphereShade;
  }
  function shadeBoneOf(skin: RigSkin): string | null {
    return (skin as unknown as { shadeBoneId: string | null }).shadeBoneId;
  }

  it('picks the rig\'s body bone, not a decorative one', () => {
    // orb-core: shell (bodyR 40) is shaded; eye (16) and the sockets (13) are not.
    expect(shadeBoneOf(makeSkin(ORB_CORE_RIG))).toBe('shell');
    expect(shadeOf(makeSkin(ORB_CORE_RIG))).not.toBeNull();
  });

  it('shades a one-bone enemy body too — the whole roster gets the same light', () => {
    const skin = makeSkin(CRITTER_CORE_RIG);
    expect(shadeBoneOf(skin)).toBe('body');
    expect(shadeOf(skin)).not.toBeNull();
  });

  it('rides the body bone\'s drawn position, including whatever the clip translates it to', () => {
    // The idle clip bobs this bone; the shading has to follow it or it detaches from the art.
    const clips = new Map<string, AnimationClip>([
      ['bob', {
        duration: 1,
        loop: false,
        keyframes: [{ time: 0, bones: new Map([['shell', { translateY: -20 }]]) }],
      }],
    ]);
    const skin = makeSkin(ORB_CORE_RIG, clips);
    skin.update();
    const rest = shadeOf(skin)!.y;
    skin.playClip('bob', 0);
    skin.update();
    expect(shadeOf(skin)!.y).toBeCloseTo(rest - 20, 5);
  });

  it('sits immediately over the body art and under everything drawn after it', () => {
    const rig = new Rig(ORB_CORE_RIG);
    const bundle = fakeBundle(rig);
    // Give the bones distinct zOrders, as a real animation.json does (orb-core: 0..4).
    let z = 0;
    for (const boneId of rig.drawOrder) bundle.bindings.get(boneId)!.zOrder = z++;
    const skin = new RigSkin(rig, bundle);
    const shade = (skin as unknown as { sphereShade: Graphics }).sphereShade;
    expect(shade.zIndex).toBeGreaterThan(bundle.bindings.get('shell')!.zOrder);
    expect(shade.zIndex).toBeLessThan(bundle.bindings.get('belly')!.zOrder);
  });

  it('counter-flips so the key light stays put while the body mirrors', () => {
    // The single thing this could get wrong: the light is fixed in SCREEN space. If the
    // shading mirrored with the rig, the highlight would jump sides every time the player
    // turned around — which reads as the light source teleporting, not as a body turning.
    const skin = makeSkin(ORB_CORE_RIG);
    skin.setBodyFacing(0); // facing right, no flip
    expect(skin.view.scale.x * shadeOf(skin)!.scale.x).toBe(1);
    skin.setBodyFacing(Math.PI); // facing left, whole rig flips
    expect(skin.view.scale.x).toBe(-1);
    expect(skin.view.scale.x * shadeOf(skin)!.scale.x).toBe(1); // net transform unchanged
  });
});

// The far-side depth cues stacked on top of the z-flip covered above (2026-08-18).
describe('RigSkin — a far-side module is drawn smaller and darker, not just behind', () => {
  function activeModule(skin: RigSkin): { scale: { x: number }; tint: number; zIndex: number } {
    skin.update();
    return (skin as unknown as { weaponSprite: { scale: { x: number }; tint: number; zIndex: number } }).weaponSprite;
  }

  it('shrinks and darkens it when the body faces away, and restores both when it turns back', () => {
    const skin = makeSkin();
    skin.setWeaponKind('ranged', 'blaster');
    skin.setBodyFacing(Math.PI / 2); // toward the camera
    const front = { scale: activeModule(skin).scale.x, tint: activeModule(skin).tint };

    skin.setBodyFacing(-Math.PI / 2); // away
    expect(activeModule(skin).scale.x).toBeLessThan(front.scale);
    expect(activeModule(skin).tint).toBeLessThan(front.tint);

    skin.setBodyFacing(Math.PI / 2);
    expect(activeModule(skin).scale.x).toBeCloseTo(front.scale, 6);
    expect(activeModule(skin).tint).toBe(front.tint);
  });

  it('re-derives the depth tint from the CURRENT element colour, not a stale one', () => {
    // setWeaponTint only knows the element hue; the depth shade has to be recombined with it
    // every frame, or swapping to a fire weapon while aiming north keeps the old colour.
    const skin = makeSkin();
    skin.setWeaponKind('ranged', 'blaster');
    skin.setBodyFacing(-Math.PI / 2); // away — the shaded branch
    skin.setWeaponTint(0xffffff);
    const light = activeModule(skin).tint;
    skin.setWeaponTint(0x808080);
    expect(activeModule(skin).tint).toBeLessThan(light);
  });

  it('applies the same treatment to the decorative idle module, so the pair reads as one assembly', () => {
    const skin = makeSkin();
    skin.setWeaponKind('ranged', 'blaster');
    skin.setBodyFacing(Math.PI / 2);
    skin.update();
    const idle = (skin as unknown as { idleModuleSprite: { scale: { x: number }; tint: number } }).idleModuleSprite;
    const frontScale = idle.scale.x;
    skin.setBodyFacing(-Math.PI / 2);
    skin.update();
    expect(idle.scale.x).toBeLessThan(frontScale);
  });
});

describe('RigSkin — rigs that get no sphere shading, and rigs whose body moves', () => {
  function shadeOf(skin: RigSkin): Graphics | null {
    return (skin as unknown as { sphereShade: Graphics | null }).sphereShade;
  }

  it('skips a rig whose largest body is only a decorative nub, and still updates cleanly', () => {
    // Below SHADE_MIN_BODY_R the marks would be sub-pixel noise on screen. The important half of
    // this is the second assertion: `update()` reads `sphereShade`/`shadeBoneId` every frame, so
    // the null path has to be exercised, not just constructed.
    const tinyRig: RigDef = {
      id: 'tiny',
      label: 'Tiny',
      bones: [
        { id: 'root', parent: null, len: 0, rwa: 0, label: 'Root' },
        { id: 'body', parent: 'root', len: 10, rwa: -90, bodyR: 8, label: 'Body' },
      ],
      drawOrder: ['body'],
    };
    const skin = makeSkin(tinyRig);
    expect(shadeOf(skin)).toBeNull();
    expect(() => skin.update()).not.toThrow();
    expect(() => skin.setBodyFacing(Math.PI)).not.toThrow(); // the counter-flip path too
  });

  it('skips a body bone with no bound art, since there is nothing to shade', () => {
    const rig = new Rig(ORB_CORE_RIG);
    const bundle = fakeBundle(rig);
    bundle.textures.delete('shell');
    bundle.bindings.delete('shell');
    const skin = new RigSkin(rig, bundle);
    expect(shadeOf(skin)).toBeNull();
    expect(() => skin.update()).not.toThrow();
  });

  it('shades the boss core too — the whole roster shares one light', () => {
    const skin = makeSkin(BOSS_CORE_RIG);
    expect((skin as unknown as { shadeBoneId: string | null }).shadeBoneId).toBe('core');
    expect(shadeOf(skin)).not.toBeNull();
  });

  it('scales the marks to each rig\'s own body radius', () => {
    // orb-core's shell is 40 authoring px, boss-core's core is 70; the shading is drawn in the
    // rig's own space, so it has to be sized per rig rather than from one constant.
    const orb = shadeOf(makeSkin(ORB_CORE_RIG))!;
    const boss = shadeOf(makeSkin(BOSS_CORE_RIG))!;
    expect(boss.bounds.width / orb.bounds.width).toBeCloseTo(70 / 40, 1);
  });

  it('follows the body bone\'s clip alpha, so it fades out with the body it sits on', () => {
    const clips = new Map<string, AnimationClip>([
      ['fade', { duration: 1, loop: false, keyframes: [{ time: 0, bones: new Map([['shell', { alpha: 0.25 }]]) }] }],
    ]);
    const skin = makeSkin(ORB_CORE_RIG, clips);
    skin.playClip('fade', 0);
    skin.update();
    expect(shadeOf(skin)!.alpha).toBeCloseTo(0.25, 6);
  });

  it('hides itself when the body bone has no pose at all', () => {
    const skin = makeSkin(ORB_CORE_RIG);
    skin.update();
    expect(shadeOf(skin)!.visible).toBe(true);
    // Force the FK result to omit the shaded bone, the way a malformed clip/rig pair could.
    const rig = (skin as unknown as { rig: { computeFK: unknown } }).rig;
    rig.computeFK = () => new Map();
    skin.update();
    expect(shadeOf(skin)!.visible).toBe(false);
  });
});

// The 2026-08-19 volume pass. Two things landed here, and both are the kind of relationship
// that reads as fine in the source of either file on its own:
//
//   1. Everything drawn ON the body — the sphere shading, the module contacts — must be sized
//      against what the ART PAINTS, not against the bone's declared `bodyR`. Nothing in this
//      renderer is masked (deliberately: a mask per actor would be 30 stencil passes in a busy
//      room), so a mark sized to a radius the art does not reach paints straight onto the
//      transparent background. That is what put a hard-edged dark disc around `critter-core`,
//      whose art fills 0.70 of its bodyR.
//   2. The orbiting modules had nothing seating them against the core, so at play scale they
//      read as decals floating in front of the body.
describe('RigSkin — the body art\'s drawn radius, not its declared one', () => {
  function shadeOf(skin: RigSkin): Graphics {
    return (skin as unknown as { sphereShade: Graphics }).sphereShade;
  }
  function makeFilled(fill: number, def = ORB_CORE_RIG): RigSkin {
    const rig = new Rig(def);
    return new RigSkin(rig, fakeBundle(rig), fill);
  }
  /** The shading's own reach from the body centre, in authoring px. */
  function reach(skin: RigSkin): number {
    const b = shadeOf(skin).bounds;
    return Math.max(-b.minX, b.maxX, -b.minY, b.maxY);
  }

  it('defaults to 1, so a caller that knows nothing about fill behaves as before', () => {
    const rig = new Rig(ORB_CORE_RIG);
    const withDefault = new RigSkin(rig, fakeBundle(rig));
    const withExplicitOne = makeFilled(1);
    expect(reach(withDefault)).toBeCloseTo(reach(withExplicitOne), 6);
  });

  it('scales the shading marks by the fill, so they land ON the art', () => {
    // orb-core's shell declares bodyR 40; `char_vanguard`'s shell PNG paints 0.81 of it. Strictly
    // INSIDE, not flush: none of this art is a circle (`critter-core`'s crystal cluster is 35 wide
    // by 38 tall with gaps at its corners), so a ramp sized flush to the painted half-width still
    // shows an arc of shading on the background diagonally out from it.
    expect(reach(makeFilled(0.81))).toBeLessThan(40 * 0.81);
    expect(reach(makeFilled(0.7, CRITTER_CORE_RIG))).toBeLessThan(50 * 0.7);
  });

  it('keeps NOTHING outside the painted radius — the defect this fixes', () => {
    // `critter-core` at 0.70 is the worst case in the shipped roster: at fill 1 the ramp
    // reached 35 authoring px past its own crystal and painted a dark disc on the background.
    const painted = 50 * 0.7;
    expect(reach(makeFilled(0.7, CRITTER_CORE_RIG))).toBeLessThan(painted);
    expect(reach(makeFilled(1, CRITTER_CORE_RIG))).toBeGreaterThan(painted); // ...and would again
  });

  it('is proportional, so the whole roster gets the same treatment', () => {
    expect(reach(makeFilled(0.5)) / reach(makeFilled(1))).toBeCloseTo(0.5, 6);
  });
});

describe('RigSkin — contact shades seat an orbiting module against the core', () => {
  function aoOf(skin: RigSkin): Graphics | null {
    return (skin as unknown as { moduleAO: Graphics | null }).moduleAO;
  }
  function fillCount(g: Graphics): number {
    return (g.context.instructions as Array<{ action: string }>).filter((i) => i.action === 'fill').length;
  }

  it('exists for a rig with orbiting modules, and not for a rig without them', () => {
    // orb-core has two tethered sockets; critter-core is one bone with no module at all, so
    // there is nothing to seat and no Graphics to pay for.
    expect(aoOf(makeSkin(ORB_CORE_RIG))).not.toBeNull();
    expect(aoOf(makeSkin(CRITTER_CORE_RIG))).toBeNull();
  });

  it('sits over the body art and the shading, and UNDER the module it belongs to', () => {
    // If it drew over the module, it would be a dark smear on the gun rather than a shade
    // under it. orb-core's real zOrders are shell 0, belly 1, eye 2, sockets 3/4.
    const rig = new Rig(ORB_CORE_RIG);
    const bundle = fakeBundle(rig);
    let z = 0;
    for (const boneId of rig.drawOrder) bundle.bindings.get(boneId)!.zOrder = z++;
    const skin = new RigSkin(rig, bundle);
    const ao = aoOf(skin)!;
    const shade = (skin as unknown as { sphereShade: Graphics }).sphereShade;
    expect(ao.zIndex).toBeGreaterThan(shade.zIndex);
    expect(ao.zIndex).toBeLessThan(bundle.bindings.get('socket_l')!.zOrder);
    expect(ao.zIndex).toBeLessThan(bundle.bindings.get('socket_r')!.zOrder);
  });

  it('draws one contact per orbiting module, positioned on the body bone\'s tip', () => {
    const skin = makeSkin(ORB_CORE_RIG);
    skin.update();
    const ao = aoOf(skin)!;
    const shade = (skin as unknown as { sphereShade: Graphics }).sphereShade;
    expect(ao.x).toBeCloseTo(shade.x, 6); // same origin as the shading it sits on
    expect(ao.y).toBeCloseTo(shade.y, 6);
    expect(fillCount(ao)).toBeGreaterThanOrEqual(2); // socket_l and socket_r, nested passes each
  });

  it('clears before redrawing, so a per-frame repaint cannot accumulate', () => {
    // It IS repainted every frame (the mounts orbit), which makes this the difference between
    // a contact shade and an ever-darkening blob.
    const skin = makeSkin(ORB_CORE_RIG);
    skin.update();
    const first = fillCount(aoOf(skin)!);
    for (let i = 0; i < 5; i++) skin.update();
    expect(fillCount(aoOf(skin)!)).toBe(first);
  });

  it('stays inside the painted body, wherever the socket tip actually is', () => {
    // The socket bones are LONGER than the shell's radius (orb-core: len 52 vs bodyR 40), so an
    // unclamped contact would sit mostly on transparent background — a dark smudge beside the
    // character instead of a shade on it. This is the same invariant the shading holds.
    for (const fill of [1, 0.81, 0.5]) {
      const rig = new Rig(ORB_CORE_RIG);
      const skin = new RigSkin(rig, fakeBundle(rig), fill);
      skin.update();
      const b = aoOf(skin)!.bounds;
      const painted = 40 * fill;
      expect(Math.max(-b.minX, b.maxX, -b.minY, b.maxY)).toBeLessThanOrEqual(painted);
    }
  });

  it('follows the body bone\'s clip alpha, so it fades with the body it sits on', () => {
    const clips = new Map<string, AnimationClip>([
      ['fade', { duration: 1, loop: false, keyframes: [{ time: 0, bones: new Map([['shell', { alpha: 0.25 }]]) }] }],
    ]);
    const skin = makeSkin(ORB_CORE_RIG, clips);
    skin.playClip('fade', 0);
    skin.update();
    expect(aoOf(skin)!.alpha).toBeCloseTo(0.25, 5);
  });

  it('hides itself when the body bone has no pose at all', () => {
    const skin = makeSkin(ORB_CORE_RIG);
    skin.update();
    expect(aoOf(skin)!.visible).toBe(true);
    // Force the FK result to omit the body bone, the way a malformed clip/rig pair could —
    // same trick the sphere-shading suite above uses for the same branch.
    const rig = (skin as unknown as { rig: { computeFK: unknown } }).rig;
    rig.computeFK = () => new Map();
    skin.update();
    expect(aoOf(skin)!.visible).toBe(false);
  });

  it('tracks a module the clip TRANSLATES, not only one it rotates', () => {
    // `computeFK` folds a clip's rotation into a bone's tip but not its translation — the sprite
    // loop adds that separately. A contact that read only the pose would sit still while the
    // module recoiled away from it, which is precisely the "decal floating in front" look this
    // whole mark exists to remove.
    const clips = new Map<string, AnimationClip>([
      // -44 pulls the module's tip in from 52 to 8 authoring px, i.e. INSIDE the contact's own
      // clamp radius, which is where a distance change is observable at all: past the clamp every
      // mount lands on the same circle by construction (see `drawModuleContacts`).
      ['kick', { duration: 1, loop: false, keyframes: [{ time: 0, bones: new Map([['socket_r', { translateX: -44 }]]) }] }],
    ]);
    const skin = makeSkin(ORB_CORE_RIG, clips);
    const centres = (): number[] => (aoOf(skin)!.context.instructions as Array<{ action: string; data: { path?: { instructions: Array<{ action: string; data: number[] }> } } }>)
      .flatMap((i) => (i.data.path?.instructions ?? []).filter((pi) => pi.action === 'ellipse').map((pi) => pi.data[0]!));
    skin.update();
    const rest = centres();
    skin.playClip('kick', 0);
    skin.update();
    expect(centres()).not.toEqual(rest);
  });

  it('re-derives the mounts every frame, so a module that orbits drags its contact along', () => {
    const clips = new Map<string, AnimationClip>([
      ['swing', { duration: 1, loop: false, keyframes: [{ time: 0, bones: new Map([['socket_r', { rotation: 90 }]]) }] }],
    ]);
    const skin = makeSkin(ORB_CORE_RIG, clips);
    // Snapshot the NUMBERS, not the Bounds object — Pixi mutates one instance in place, so
    // holding the reference across a redraw would compare it against itself and pass on nothing.
    const snap = (): number[] => {
      const b = aoOf(skin)!.bounds;
      return [b.minX, b.minY, b.maxX, b.maxY];
    };
    skin.update();
    const before = snap();
    skin.playClip('swing', 0);
    skin.update();
    expect(snap()).not.toEqual(before);
  });
});
