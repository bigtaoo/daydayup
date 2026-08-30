/**
 * The occlusion x-ray (`occlusion.ts`), the fix for the live report *"角色跑到墙下面去了"* — the
 * character walked to the north side of an interior wall block and was drawn entirely behind it.
 *
 * Two kinds of test here, and the second kind is the one that would have caught the bug:
 *
 *  - unit coverage of the rule itself (`occludes`/`stepFade`/`updateOcclusion`/`xrayLayers`);
 *  - **geometry invariants across three layers** — the ENGINE's wall clearance
 *    (`PLAYER_BASE.solidRadius`), the RENDERER's wall heights (`wallGeometry.WALL_H_*`), and the
 *    drawn body's own size. The bug was not in any one of those: each was individually correct,
 *    and their combination happened to hide the player completely. Restating any of the three as
 *    a literal here would defeat the point, so they are all imported.
 */
import { describe, it, expect } from 'vitest';
import { PLAYER_BASE, WALL_NORTH_BRIM } from '@dd/engine';
import { fpToPx } from '../coords';
import {
  deepFadeReach,
  fadeableBlock,
  needsDeepFade,
  occludes,
  stepFade,
  updateOcclusion,
  xrayLayers,
  XRAY_FADE,
  XRAY_LABEL,
  type FadeLayer,
  type Occluder,
} from './occlusion';
import { WALL_H_INTERIOR, WALL_H_KERB, WALL_H_PERIMETER } from './wallGeometry';
import { pillarArtExtent } from './pillarRender';
import { Texture, TextureSource } from 'pixi.js';

/** How wide/tall the character is DRAWN, in world px. A band rather than a point: the shipped
 *  rig measures 32 px tall at the player's gameplay radius and the Graphics placeholder 39, and
 *  every claim below has to hold across the whole band (`Actor.test.ts` pins the real
 *  measurements into it, which is the seam that keeps this file honest as the art changes).
 *
 *  The LOW end is load-bearing, not padding: the kerb claim below holds because a 22 px lip
 *  covers less than `MIN_COVER_FRACTION` of the body, and that stops being true for a character
 *  drawn much shorter than this. */
const BODY_H_MIN = 20;
const BODY_H_MAX = 48;
const BODY_HALF_W = 13;

/** The player's closest legal approach to a wall, in world px — the engine's own number. */
const CLEARANCE = fpToPx(PLAYER_BASE.solidRadius);
/** The EXTRA clearance a free-standing block's north face gets on top of it (ENGINE_VERSION 47,
 *  `config.WALL_NORTH_BRIM`). Zero on a perimeter wall and on a kerb, which is why these stay two
 *  constants and not one merged number: every claim below has to say which of the two it uses. */
const BRIM = fpToPx(WALL_NORTH_BRIM);
/** ...so this is the closest legal approach to the north face of an interior block. */
const NORTH_STANDOFF = CLEARANCE + BRIM;

/** The pillar the interior blocks are calibrated against. `roomDressing` builds one per
 *  `state.obstacles` circle at `bodyW = radius * 2 + 16`, and every shipped kit authors
 *  `radius: 1` grid = 32 px; the art is scaled by WIDTH, so the shipped file's aspect is what
 *  decides how far north of the ground point it paints (`pillarRender.test.ts` owns those
 *  dimensions and asserts the art still matches the shape it was drawn for). */
const PILLAR_RADIUS_PX = 32;
const PILLAR_BODY_W = PILLAR_RADIUS_PX * 2 + 16;
const SHIPPED_PILLAR_TEX = new Texture({ source: new TextureSource({ width: 326, height: 384 }) });
/** How deep a standing shape buries a character at their closest legal approach: the px of art
 *  painted above their feet. THE number a block and a pillar have to agree on. */
const pillarSink = (): number =>
  -pillarArtExtent(PILLAR_BODY_W, WALL_H_INTERIOR, SHIPPED_PILLAR_TEX).top - (PILLAR_RADIUS_PX + CLEARANCE);

/** One standing block's occluder box, from the geometry `wallRender` actually draws it at: the
 *  container sits on the south edge and paints `height + depth` px northward from there, with the
 *  cap/face fold one height above it. */
function block(southY: number, height: number, depth: number, left = 0, right = 96): Occluder {
  return { left, right, top: southY - height - depth, sortY: southY, foldY: southY - height };
}

const focus = (x: number, y: number, bodyH = BODY_H_MIN): { x: number; y: number; halfW: number; bodyH: number } => ({
  x,
  y,
  halfW: BODY_HALF_W,
  bodyH,
});

describe('occludes — which block is drawing over the character', () => {
  const b = block(224, WALL_H_INTERIOR, 64); // level 1's real interior block: 96 x 64, 70 tall

  it('fires for a character standing in the band the block\'s art covers', () => {
    expect(occludes(b, focus(1, 150))).toBe(true);
  });

  it('does not fire for a character SOUTH of the block — the Y-sort already draws them in front', () => {
    expect(occludes(b, focus(1, 224))).toBe(false);
    expect(occludes(b, focus(1, 300))).toBe(false);
  });

  it('does not fire for a character north of everything the block paints', () => {
    // Its art tops out at `top`; a body is drawn UPWARD from its ground point, so a character
    // standing above that line cannot be covered even though the block sorts in front of them.
    expect(occludes(b, focus(1, b.top - 1))).toBe(false);
  });

  it('does not fire when the drawn body is clear of the block in x', () => {
    expect(occludes(b, focus(b.left - BODY_HALF_W - 1, 150))).toBe(false);
    expect(occludes(b, focus(b.right + BODY_HALF_W + 1, 150))).toBe(false);
  });

  it('fires when only the EDGE of the drawn body overlaps — the silhouette is what matters', () => {
    expect(occludes(b, focus(b.left - BODY_HALF_W + 1, 150))).toBe(true);
    expect(occludes(b, focus(b.right + BODY_HALF_W - 1, 150))).toBe(true);
  });

  it('needs a real bite out of the body, not one covered row', () => {
    // Just inside the art's top edge: the block covers 2 px of a 24 px body. Not worth
    // x-raying — and this threshold is exactly what keeps the room's south kerb solid (below).
    expect(occludes(b, focus(1, b.top + 2))).toBe(false);
  });
});

describe('occludes — the three-layer geometry, and what the north brim did to it', () => {
  // The repro, in numbers: a 96 x 64 interior block, and a player pressed as far north as the
  // engine lets them stand.
  const DEPTH = 64;
  const SOUTH = 224;
  const b = block(SOUTH, WALL_H_INTERIOR, DEPTH);
  const closestY = SOUTH - DEPTH - NORTH_STANDOFF;

  it('buries a character LESS than a pillar does — the v48 widening, deliberately no longer parity', () => {
    // The v47 report this used to pin: *"柱子...只有半个身子被覆盖"* against *"角色整个跑到墙里面了"*,
    // closed by making a wall's sink match a pillar's (both ~38-41 px). v48 is a SECOND report,
    // against the v47 result itself: *"角色被挡住的部分...大概当前角色的一半可以进入墙...改为1/4的
    // 位置"* — even the matched amount still read as "sunk in," not "standing behind." `WALL_NORTH_BRIM`
    // widened from 16 to 23 px in response (`config.ts` — 23, not the naive double to 32, is the
    // most `launchArena.test.ts`'s tightest shipped corridor tolerates before a route seals), which
    // this time deliberately reopens the wall/pillar gap rather than closing it: nothing here
    // touched the pillar's own reservation, so a wall now covers noticeably LESS of a character
    // than a pillar standing beside it does. Left as a known, intentional asymmetry rather than
    // chased further — pulling the pillar down to match would be a separate change to
    // `pillarArtExtent`/`PILLAR_BASE_PX`, on a shape nobody has filed this report about.
    const wallSink = closestY - b.top;
    expect(wallSink).toBeCloseTo(WALL_H_INTERIOR - NORTH_STANDOFF, 6);
    expect(wallSink).toBeLessThan(pillarSink() - 4);
  });

  it('...and no longer covers the WHOLE drawn body, which is what the brim bought', () => {
    // Pre-v47 this read `> BODY_H_MAX`: the art reached further above the player's feet than the
    // character was tall, at every size in the band, so per-object Y-sorting left nothing of them
    // on screen and the x-ray was the only thing standing between the player and invisibility.
    // Now the tallest body in the band keeps a real margin out in the open.
    expect(closestY - b.top).toBeLessThan(BODY_H_MAX);
  });

  it('...but the x-ray still fires there, for every body size in the band', () => {
    // Deliberately unchanged. Half a body behind stone is still worth dissolving the cap for — it
    // is what a pillar already does at the same sink — so `MIN_COVER_FRACTION` was left alone and
    // the brim stays ONE change. What moved is where the character may stand, not when the fade
    // decides to help them.
    for (const bodyH of [BODY_H_MIN, 24, 32, 39, BODY_H_MAX]) {
      expect(occludes(b, focus(1, closestY, bodyH))).toBe(true);
    }
  });

  it('a KERB never triggers it — the south lip only ever clips the character\'s soles', () => {
    // The room's south boundary is deliberately short (`WALL_H_KERB`) precisely because it
    // stands between the camera and the player. Fading the whole southern lip of the room
    // every time the player walks along it would be a worse artifact than the few px it fixes.
    // `CLEARANCE`, not `NORTH_STANDOFF`: a kerb is part of a room's perimeter ring and so never
    // carries `AABB.freeStanding` — the v47 brim does not apply to it. That is the whole reason
    // the brim is flagged per solid rather than handed to every wall: floating the character off
    // a 22 px lip that was never covering them would re-open the v43 report from the other side.
    const kerb = block(SOUTH, WALL_H_KERB, 32);
    const flush = SOUTH - 32 - CLEARANCE;
    expect(flush - kerb.top).toBeLessThan(BODY_H_MIN * 0.45);
    for (const bodyH of [BODY_H_MIN, 24, 32, 39, BODY_H_MAX]) {
      expect(occludes(kerb, focus(1, flush, bodyH))).toBe(false);
    }
  });

  it('a PERIMETER wall never triggers it either — its blind band is outside the room', () => {
    // A room's own boundary is the tallest thing in it, but the floor its art covers is on the
    // far side of itself: a player inside the room is always SOUTH of a north wall's sort line,
    // and the strip north of it is not floor at all. True of THIS shape and not in general —
    // `occlusionCoverage.test.ts` found the counterexample on real content (a north-south run
    // whose north end is an open door passage) and holds the general claim instead: a perimeter
    // run can only ever fire from north of its own footprint, never from the room it bounds.
    const northWall = block(64, WALL_H_PERIMETER, 32); // footprint y 32..64, room floor below
    for (const y of [64 + CLEARANCE, 100, 300]) {
      expect(occludes(northWall, focus(1, y))).toBe(false);
    }
  });
});

describe('needsDeepFade — when fading the cap alone achieves nothing', () => {
  it('is false for an interior block: its own footprint keeps the body above the fold', () => {
    // 64 px deep, 70 tall, 16 px of clearance, a 20-48 px body — the body top can never get down
    // to the fold, so the cap is always what is covering it.
    const b = block(224, WALL_H_INTERIOR, 64);
    for (const bodyH of [BODY_H_MIN, 32, BODY_H_MAX]) {
      expect(needsDeepFade(b, focus(1, 224 - 64 - CLEARANCE, bodyH))).toBe(false);
    }
  });

  it('is true where a tall wall stands on a shallow footprint and the body fits under the fold', () => {
    // A room boundary: 104 tall over 32 deep. 32 + 16 + 32 <= 104, so there is a band where the
    // whole character is behind the FACE and the cap fade is a no-op.
    const b = block(224, WALL_H_PERIMETER, 32);
    expect(needsDeepFade(b, focus(1, 224 - 32 - CLEARANCE, 32))).toBe(true);
  });

  it('is false for a pillar, which has no opaque remainder to reach', () => {
    // A pillar's body is one object and fades whole, so it reports its own ground line as the
    // fold and can never ask for a second pass.
    const p: Occluder = { left: 0, right: 40, top: 100, sortY: 200, foldY: 200 };
    expect(needsDeepFade(p, focus(20, 180, 32))).toBe(false);
  });
});

describe('stepFade', () => {
  it('ramps out of the way and back, and settles exactly on both ends', () => {
    let f = 1;
    const out: number[] = [];
    for (let i = 0; i < 20; i++) out.push((f = stepFade(f, true, 16.67)));
    expect(f).toBe(XRAY_FADE);
    expect(out[0]).toBeLessThan(1); // moved on the very first frame — no dead time
    const back: number[] = [];
    for (let i = 0; i < 40; i++) back.push((f = stepFade(f, false, 16.67)));
    expect(f).toBe(1);
    // Slower back to solid than out of the way, so walking along a block cannot strobe.
    expect(back.findIndex((v) => v === 1)).toBeGreaterThan(out.findIndex((v) => v === XRAY_FADE));
  });

  it('clamps rather than overshooting on a long frame (a stall, a hit-stop)', () => {
    expect(stepFade(1, true, 10_000)).toBe(XRAY_FADE);
    expect(stepFade(XRAY_FADE, false, 10_000)).toBe(1);
  });

  it('never moves backwards on a zero or negative dt', () => {
    expect(stepFade(0.7, true, 0)).toBe(0.7);
    expect(stepFade(0.7, true, -50)).toBe(0.7);
  });
});

describe('updateOcclusion', () => {
  const layer = (alpha = 1, label: string | null = XRAY_LABEL): FadeLayer => ({ alpha, label });

  function scene() {
    const hiding = layer();
    const clear = layer();
    const occluders = [
      fadeableBlock(block(224, WALL_H_INTERIOR, 64, 0, 96), [hiding]),
      fadeableBlock(block(224, WALL_H_INTERIOR, 64, 400, 496), [clear]),
    ];
    return { hiding, clear, occluders };
  }

  /** A wall tall enough over a footprint shallow enough that the body can fit entirely below its
   *  cap/face fold — the `needsDeepFade` case. A room boundary (104 over 32) is exactly this. */
  function deepScene() {
    const cap = layer();
    const face = layer();
    const box = block(224, 104, 32);
    return { cap, face, box, occluders: [fadeableBlock(box, [cap], [face])] };
  }

  it('fades only the block that is actually covering the character', () => {
    const s = scene();
    for (let i = 0; i < 20; i++) updateOcclusion(s.occluders, [focus(50, 150)], 16.67);
    expect(s.hiding.alpha).toBe(XRAY_FADE);
    expect(s.clear.alpha).toBe(1);
  });

  it('fades a block for a monster hidden behind it even with no player anywhere near (live report *"如果只有怪物在墙下面的话，就看不到怪物了"*)', () => {
    // The bug this closes: `updateOcclusion` used to take one `focus` — the local player only —
    // so a monster standing in the exact band `c8fd4fa` fixed for the player got no x-ray at all
    // and rendered fully swallowed by the wall. A focus list with only an enemy in it, nowhere
    // near the player's own position, must still uncover the block that's hiding that enemy.
    const s = scene();
    const monster = focus(50, 150); // stands where `hiding`'s block covers it; no player focus at all
    for (let i = 0; i < 20; i++) updateOcclusion(s.occluders, [monster], 16.67);
    expect(s.hiding.alpha).toBe(XRAY_FADE);
    expect(s.clear.alpha).toBe(1);
  });

  it('uncovers a block if it hides ANY focus, even while a second focus stands clear of it', () => {
    const s = scene();
    const hiddenMonster = focus(50, 150); // behind `hiding`'s block
    const clearPlayer = focus(450, 300); // south of both blocks — not hidden by anything
    for (let i = 0; i < 20; i++) updateOcclusion(s.occluders, [hiddenMonster, clearPlayer], 16.67);
    expect(s.hiding.alpha).toBe(XRAY_FADE);
    expect(s.clear.alpha).toBe(1);
  });

  it('leaves the face alone while part of the body still shows above the fold', () => {
    // The measured reason the two groups exist: where the cap fade already reveals the head and
    // shoulders, dropping the face as well reads as a pale smear — at a room boundary the wall
    // standing in front of it has its own bright cap, and that is what shows through.
    const s = deepScene();
    const partly = focus(50, s.box.foldY + 8); // feet below the fold, head above it
    for (let i = 0; i < 40; i++) updateOcclusion(s.occluders, [partly], 16.67);
    expect(s.cap.alpha).toBe(XRAY_FADE);
    expect(s.face.alpha).toBe(1);
  });

  it('takes the face too when the whole body is below the fold and a cap fade would do nothing', () => {
    const s = deepScene();
    const buried = focus(50, s.box.foldY + BODY_H_MIN); // body top exactly at the fold
    for (let i = 0; i < 40; i++) updateOcclusion(s.occluders, [buried], 16.67);
    expect(s.cap.alpha).toBe(XRAY_FADE);
    expect(s.face.alpha).toBe(XRAY_FADE);
  });

  it('takes the face for the whole block if ANY focus needs it, even while another only needs the cap', () => {
    // Two characters behind the same tall boundary run, at different depths: neither on its own
    // should decide for the other — one focus buried below the fold is enough to drop the face,
    // even though a SECOND focus standing higher up would have settled for the cap alone.
    const s = deepScene();
    const shallow = focus(20, s.box.foldY + 8); // head still above the fold — cap-only case
    const buried = focus(70, s.box.foldY + BODY_H_MIN); // body top at the fold — needs the face too
    for (let i = 0; i < 40; i++) updateOcclusion(s.occluders, [shallow, buried], 16.67);
    expect(s.cap.alpha).toBe(XRAY_FADE);
    expect(s.face.alpha).toBe(XRAY_FADE);
  });

  it('puts the face back before the cap when the character steps back up', () => {
    const s = deepScene();
    for (let i = 0; i < 40; i++) updateOcclusion(s.occluders, [focus(50, s.box.foldY + BODY_H_MIN)], 16.67);
    for (let i = 0; i < 40; i++) updateOcclusion(s.occluders, [focus(50, s.box.foldY + 8)], 16.67);
    expect(s.face.alpha).toBe(1);
    expect(s.cap.alpha).toBe(XRAY_FADE); // still hidden, still x-rayed — only the depth changed
  });

  it('scales each layer\'s AUTHORED alpha rather than flattening them to one value', () => {
    // A cap is two layers — the swatch and its additive key light at `CAP_BOOST_ALPHA` — so a
    // fade that assigned `alpha = fade` would brighten the key light on the way down.
    const base = layer(0.4);
    const occluders = [fadeableBlock(block(224, WALL_H_INTERIOR, 64), [base])];
    for (let i = 0; i < 20; i++) updateOcclusion(occluders, [focus(50, 150)], 16.67);
    expect(base.alpha).toBeCloseTo(0.4 * XRAY_FADE, 6);
  });

  it('restores everything to solid once the character steps clear', () => {
    const s = scene();
    for (let i = 0; i < 20; i++) updateOcclusion(s.occluders, [focus(50, 150)], 16.67);
    for (let i = 0; i < 40; i++) updateOcclusion(s.occluders, [focus(50, 300)], 16.67);
    expect(s.hiding.alpha).toBe(1);
  });

  it('restores everything to solid on an empty focus list (menu, between spawns)', () => {
    const s = scene();
    for (let i = 0; i < 20; i++) updateOcclusion(s.occluders, [focus(50, 150)], 16.67);
    for (let i = 0; i < 40; i++) updateOcclusion(s.occluders, [], 16.67);
    expect(s.hiding.alpha).toBe(1);
    expect(s.occluders.every((o) => o.cap.fade === 1 && o.deep.fade === 1)).toBe(true);
  });

  it('touches nothing on a frame where no fade moved — a room is mostly at rest', () => {
    const s = scene();
    let writes = 0;
    const counted = s.occluders.map((o) => ({
      ...o,
      cap: {
        get fade() { return o.cap.fade; },
        set fade(v: number) { o.cap.fade = v; },
        apply(f: number) { writes++; o.cap.apply(f); },
      },
    }));
    for (let i = 0; i < 20; i++) updateOcclusion(counted, [focus(50, 150)], 16.67);
    const settled = writes;
    for (let i = 0; i < 20; i++) updateOcclusion(counted, [focus(50, 150)], 16.67);
    expect(writes).toBe(settled);
  });
});

describe('xrayLayers', () => {
  it('selects only the layers tagged for the x-ray', () => {
    const face = { alpha: 1, label: 'face' };
    const cap = { alpha: 1, label: XRAY_LABEL };
    const silhouette = { alpha: 1, label: null };
    expect(xrayLayers([face, cap, silhouette])).toEqual([cap]);
  });

  it('selects nothing from an untagged set rather than everything', () => {
    // The fail-safe direction: a mis-tagged block stays solid (the old bug, visible) instead of
    // silently x-raying its whole self (a new bug, and a subtler one).
    expect(xrayLayers([{ alpha: 1, label: null }])).toEqual([]);
  });
});


describe('deepFadeReach — how far down the face the deep pass may go', () => {
  // The number that stops the deep pass reading as a pane of glass. `needsDeepFade` says whether
  // the front face has to go translucent; this says how much of it, and the answer is a geometric
  // bound rather than a taste one — see the function's own doc for the derivation.

  it('is the height a body can reach: the art minus the footprint it stands off', () => {
    expect(deepFadeReach(70, 32)).toBe(38); // the shipped arena's deep case
    expect(deepFadeReach(104, 32)).toBe(72); // a room boundary over the same footprint
  });

  it('is ZERO for a face no body can reach — a kerb, and a run deeper than it is tall', () => {
    // 22 px of art over a 32 px footprint: every reachable body is above the whole elevation. Not
    // negative, because "the deep pass reaches nothing" is the answer, not "it reaches upward".
    expect(deepFadeReach(22, 32)).toBe(0);
    expect(deepFadeReach(70, 224)).toBe(0); // a north-south run, 7 cells deep
  });

  it('agrees with needsDeepFade: a focus the deep pass fires for is always inside the reach', () => {
    // The invariant the face split rests on, checked by brute force over the geometry rather than
    // argued: for every block shape and every ground point NORTH of the footprint, if the rule
    // asks for a deep fade then the body's lowest row is within the reach. One counterexample
    // would mean the split buries feet that the old whole-face fade revealed.
    const f = { x: 0, y: 0, halfW: 12, bodyH: 32 };
    let fired = 0;
    for (const height of [22, 70, 104]) {
      for (const depth of [32, 64, 96, 224]) {
        const sortY = 1000;
        const box: Occluder = {
          left: -100, right: 100, top: sortY - height - depth, sortY, foldY: sortY - height,
        };
        const reach = deepFadeReach(height, depth);
        for (let y = sortY - depth; y > sortY - depth - 40; y -= 1) {
          if (!needsDeepFade(box, { ...f, y })) continue;
          fired++;
          expect(y - box.foldY).toBeLessThanOrEqual(reach);
        }
      }
    }
    expect(fired).toBeGreaterThan(0); // the sweep really did exercise the deep case
  });

  it('leaves nothing for the deep pass to reach when the reach is zero', () => {
    // The other half of the same agreement, and the reason the clamp is load-bearing rather than
    // defensive: where the reach is 0 the whole face is tagged as never-fading, so if the rule
    // could still fire there the block would keep a body buried behind opaque stone.
    const sortY = 1000;
    const box: Occluder = { left: -100, right: 100, top: sortY - 54, sortY, foldY: sortY - 22 };
    expect(deepFadeReach(22, 32)).toBe(0);
    for (let y = sortY - 32; y > sortY - 200; y -= 1) {
      expect(needsDeepFade(box, { x: 0, y, halfW: 12, bodyH: 32 })).toBe(false);
    }
  });
});
