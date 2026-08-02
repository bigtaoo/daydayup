/**
 * RigSkin — the `.tao` runtime renderer's facing model (design/12), extended with
 * the upper/lower body split: `setBodyFacing` drives the whole-rig L/R flip + front/
 * back hemisphere, `setAim` drives ONLY the weapon-socket aim-tracking rotation, and
 * the two must stay independent of each other. Uses a minimal fake bundle over the
 * real `ORB_CORE_RIG` (has both weapon sockets) — Pixi Sprite/Container construct
 * fine under plain vitest with no renderer attached (same finding Forge.test.ts/
 * Screens.test.ts made), so no real texture asset is needed, just `Texture.WHITE`.
 */
import { describe, it, expect } from 'vitest';
import { Texture } from 'pixi.js';
import { Rig } from './Rig';
import { ORB_CORE_RIG } from './orbCoreRig';
import { RigSkin } from './RigSkin';
import type { RigSkinBundle } from './taoBundle';
import type { SpriteBinding } from './types';

function fakeBundle(rig: Rig): RigSkinBundle {
  const bindings = new Map<string, SpriteBinding>();
  const textures = new Map<string, Texture>();
  for (const boneId of rig.drawOrder) {
    bindings.set(boneId, { anchorX: 0.5, anchorY: 0.5, flipX: false, zOrder: 0, rotation: 0, scaleX: 1, scaleY: 1 });
    textures.set(boneId, Texture.WHITE);
  }
  return { bindings, clips: new Map(), textures };
}

function makeSkin(): RigSkin {
  const rig = new Rig(ORB_CORE_RIG);
  return new RigSkin(rig, fakeBundle(rig));
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

describe('RigSkin — front/back hemisphere follows body facing, not aim', () => {
  it('showBack is driven by setBodyFacing only', () => {
    const skin = makeSkin();
    skin.setBodyFacing(-Math.PI / 2); // body facing away from camera (up-screen)
    skin.setAim(Math.PI / 2); // aiming toward the camera — would flip showBack if aim drove it
    expect((skin as unknown as { showBack: boolean }).showBack).toBe(true);
  });
});
