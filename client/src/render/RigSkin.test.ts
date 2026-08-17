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
import { Container, Texture } from 'pixi.js';
import { Rig } from './Rig';
import { ORB_CORE_RIG } from './orbCoreRig';
import { CRITTER_CORE_RIG } from './critterCoreRig';
import { RigSkin } from './RigSkin';
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
    expect(at('eye')).toEqual([0, -46]); // centred on the shell
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
});

describe('RigSkin — front/back hemisphere follows body facing, not aim', () => {
  it('showBack is driven by setBodyFacing only', () => {
    const skin = makeSkin();
    skin.setBodyFacing(-Math.PI / 2); // body facing away from camera (up-screen)
    skin.setAim(Math.PI / 2); // aiming toward the camera — would flip showBack if aim drove it
    expect((skin as unknown as { showBack: boolean }).showBack).toBe(true);
  });
});
