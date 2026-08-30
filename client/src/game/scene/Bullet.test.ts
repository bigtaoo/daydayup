/**
 * Bullet view (design/03/07 per-element polish): a coloured dot + shadow, plus an
 * additive glow halo for elemental rounds only. Children are appended glow-then-core
 * in the constructor (glow.blendMode='add') — same index-by-construction-order
 * convention as Pickup.test.ts/TouchControlsView.test.ts, no public accessor for
 * either child.
 */
import { describe, it, expect } from 'vitest';
import type { Graphics } from 'pixi.js';
import { TICK_RATE, fromFp, WEAPON_SIM_BY_ID, type RangedSimSpec } from '@dd/engine';
import { THEME } from '../theme';
import { PX_PER_GRID } from '../coords';
import { Bullet } from './Bullet';
import { SHADOW_SLANT_X, SHADOW_SLANT_Y } from './Entity';

const enum Child { Glow, Core, Flare }
function glowOf(b: Bullet): Graphics {
  return b.children[Child.Glow] as Graphics;
}
function coreOf(b: Bullet): Graphics {
  return b.children[Child.Core] as Graphics;
}

describe('Bullet — construction', () => {
  it('builds exactly glow + core + spawn flare (3 children) plus a soft shadow', () => {
    const b = new Bullet(6);
    expect(b.children.length).toBe(3);
    expect(glowOf(b).blendMode).toBe('add');
    expect(b.children[Child.Flare]!.blendMode).toBe('add');
    expect(b.shadow).not.toBeNull();
  });
});

describe('Bullet.color — element hue vs faction fallback', () => {
  it('defaults to the player bullet colour before any faction/element is set (physical, faction null)', () => {
    const b = new Bullet(6);
    expect(b.color).toBe(THEME.colors.bulletPlayer);
  });

  it('a physical bullet takes its faction colour', () => {
    const b = new Bullet(6);
    b.setFaction('player');
    expect(b.color).toBe(THEME.colors.bulletPlayer);
    b.setFaction('enemy');
    expect(b.color).toBe(THEME.colors.bulletEnemy);
  });

  it('an elemental bullet takes its element hue regardless of faction', () => {
    const b = new Bullet(6);
    b.setFaction('enemy');
    b.setElement('fire');
    expect(b.color).toBe(THEME.colors.statusBurn);
    // Faction still colours nothing once elemental — even flipping faction (melee
    // deflect) doesn't change the element-hue read.
    b.setFaction('player');
    expect(b.color).toBe(THEME.colors.statusBurn);
  });

  it.each([
    ['ice', 'statusChill'],
    ['lightning', 'statusShock'],
    ['poison', 'statusPoison'],
  ] as const)('%s bullets read as %s', (element, key) => {
    const b = new Bullet(6);
    b.setElement(element);
    expect(b.color).toBe(THEME.colors[key]);
  });
});

describe('Bullet redraw — glow-halo branch', () => {
  it('a physical round gets no glow geometry (clean dot, halo cleared)', () => {
    const b = new Bullet(6);
    b.setFaction('player');
    expect(glowOf(b).getLocalBounds().width).toBe(0);
    expect(coreOf(b).getLocalBounds().width).toBeGreaterThan(0);
  });

  it('an elemental round draws additive halo geometry around the core', () => {
    const b = new Bullet(6);
    b.setElement('fire');
    const glowBounds = glowOf(b).getLocalBounds();
    const coreBounds = coreOf(b).getLocalBounds();
    expect(glowBounds.width).toBeGreaterThan(0);
    // The halo is drawn as concentric rings OUTSIDE the core radius (i * 0.5 bigger).
    expect(glowBounds.width).toBeGreaterThan(coreBounds.width);
  });

  it('switching from elemental back to physical (faction flip via deflect) clears the halo again', () => {
    const b = new Bullet(6);
    b.setElement('fire');
    expect(glowOf(b).getLocalBounds().width).toBeGreaterThan(0);
    b.setElement('physical');
    expect(glowOf(b).getLocalBounds().width).toBe(0);
  });
});

// setMuzzleOrigin (2026-08-17, retuned 2026-08-30 to spend by DISTANCE TRAVELLED rather than
// wall-clock time — user report *"子弹的弹道，现在会从枪口曲线跑到角色身前再继续飞向目标"*, a slow
// weapon's fixed 120ms budget covered so little ground that the correction dominated its early
// flight and read as a visible bend). The render-only correction makes a shot leave the
// shooter's drawn barrel tip instead of the engine's ground-plane muzzle point. See the
// method's own doc for the geometry; Scene.test.ts covers the wiring, this covers the curve
// itself. `MUZZLE_EASE_DISTANCE_PX` is 40 (not exported — pinned here by behaviour instead).
describe('Bullet.setMuzzleOrigin — easing from the barrel tip onto the sim line', () => {
  /** A bullet parked at a fixed sim position, so every drawn offset below is the ease. */
  function parked(x = 100, y = 200, z = 0): Bullet {
    const b = new Bullet(4);
    b.place(x, y, z);
    return b;
  }

  it('draws exactly at the sim position when no origin was ever set (every enemy)', () => {
    const b = parked();
    b.interpolate(1, 16);
    expect(b.x).toBe(100);
    expect(b.y).toBe(200);
  });

  it('starts fully at the muzzle and lands exactly on the sim position once 40px is travelled', () => {
    const b = parked();
    b.setMuzzleOrigin(30, -18);

    b.interpolate(1, 0); // first drawn frame, no travel yet
    expect(b.x).toBeCloseTo(130, 6);
    expect(b.y).toBeCloseTo(182, 6);

    b.pushState(140, 200, 0, 0); // the sim moved the bullet 40 world px — the whole budget
    b.interpolate(1, 16);
    expect(b.x).toBeCloseTo(140, 6);
    expect(b.y).toBeCloseTo(200, 6);
  });

  it('a slow bullet that covers little ground per frame keeps most of its offset early on — ' +
     'the exact complaint this retune fixes', () => {
    const b = parked();
    b.setMuzzleOrigin(30, -18);
    b.interpolate(1, 0); // full offset at spawn, as always

    // A slow weapon: only 5 world px of travel this tick (vs. the 40px budget) — nowhere near
    // enough to have meaningfully left the muzzle under the old fixed-time budget either, but
    // the OLD implementation would still have drained a fixed fraction of 120ms regardless.
    b.pushState(105, 200, 0, 0);
    b.interpolate(1, 16);
    // Still most of the way toward the muzzle — this is what "curving in front of the
    // character" used to look like before the correction had covered real ground.
    expect(b.x - 105).toBeGreaterThan(20);
  });

  it('decays monotonically, front-loaded (ease-out) rather than linearly, as travel accrues', () => {
    const b = parked();
    b.setMuzzleOrigin(120, 0);
    b.interpolate(1, 0); // spend the "no travel yet" frame first
    const offsets: number[] = [];
    let traveled = 0;
    for (let i = 0; i < 4; i++) {
      traveled += 10; // 4 x 10 world px = the full 40px budget
      b.pushState(100 + traveled, 200, 0, 0);
      b.interpolate(1, 16);
      offsets.push(b.x - (100 + traveled));
    }
    // Strictly shrinking...
    for (let i = 1; i < offsets.length; i++) expect(offsets[i]!).toBeLessThan(offsets[i - 1]!);
    // ...and past halfway in distance, well past halfway of the offset itself (k² not k).
    expect(offsets[1]!).toBeLessThan(120 * 0.5);
    expect(offsets[offsets.length - 1]!).toBe(0);
  });

  it('never overshoots past the sim position, however far the bullet jumps in one tick', () => {
    const b = parked();
    b.setMuzzleOrigin(30, -18);
    b.pushState(10100, 200, 0, 0); // a tab that was backgrounded and fast-forwarded on resume
    b.interpolate(1, 16);
    expect(b.x).toBe(10100);
    expect(b.y).toBe(200);
  });

  it('offsets only the sprite — the muzzle correction never moves the shadow', () => {
    const b = parked(100, 200, 40); // lifted, so shadow.y and b.y already differ
    b.setMuzzleOrigin(30, -18);
    b.interpolate(1, 0);
    expect(b.x).toBeCloseTo(130, 6); // sprite pulled to the muzzle
    // The shadow tracks the bullet's real ground point, displaced only by its own HEIGHT
    // (2026-08-18: every shadow now slides away from the fixed upper-left key light in
    // proportion to lift, `Entity.SHADOW_SLANT_*`). The muzzle correction contributes
    // nothing to it — which is what this test is really about.
    expect(b.shadow!.x).toBeCloseTo(100 + 40 * SHADOW_SLANT_X, 6);
    expect(b.shadow!.y).toBeCloseTo(200 + 40 * SHADOW_SLANT_Y, 6);
  });

  it('keeps easing across a pushState, not just within one interpolate() call', () => {
    // The correction outlives a single pushState: the budget is TRAVEL, not per-call, so a
    // bullet that gets a fresh sim position mid-ease keeps the remainder of its curve.
    const b = parked();
    b.setMuzzleOrigin(60, 0);
    b.interpolate(1, 16); // no travel yet — full offset

    b.pushState(120, 200, 0, 0); // 20 of the 40px budget spent
    b.interpolate(1, 16);
    const midEase = b.x - 120;
    expect(midEase).toBeGreaterThan(0);
    expect(midEase).toBeLessThan(60);

    b.pushState(140, 200, 0, 0); // another 20px — the whole budget now spent
    b.interpolate(1, 16);
    expect(b.x - 140).toBeGreaterThanOrEqual(0);
    expect(b.x - 140).toBeLessThan(midEase); // ...strictly less than before
  });

  it('measures travel as true 2D distance (hypot), not axis-summed drift', () => {
    const b = parked();
    b.setMuzzleOrigin(80, 0);
    b.interpolate(1, 0); // no travel yet

    // A 12/16/20 right triangle: the real distance travelled is 20 world px (half the
    // 40px budget), but |dx| + |dy| is 28 — an axis-summed implementation would (wrongly)
    // drain more of the budget than the bullet actually covered.
    b.pushState(112, 216, 0, 0);
    b.interpolate(1, 16);
    // remaining = 40 - 20 = 20 -> k = 0.5 -> ease = 0.25 -> offset = 80 * 0.25 = 20
    expect(b.x - 112).toBeCloseTo(20, 5);
  });

  it("measures travel along the bullet's own path, independent of the offset's direction", () => {
    const b = parked();
    b.setMuzzleOrigin(0, 50); // pure vertical offset — perpendicular to the travel below
    b.interpolate(1, 0);

    b.pushState(120, 200, 0, 0); // 20 world px of purely HORIZONTAL travel
    b.interpolate(1, 16);
    // If "travel" were measured as a projection onto the offset's own direction instead of
    // the bullet's actual path, this horizontal move would look like ~0 progress (it is
    // perpendicular to the vertical offset) and the correction would still be fully applied.
    // remaining = 40 - 20 = 20 -> k = 0.5 -> ease = 0.25 -> offset = 50 * 0.25 = 12.5
    expect(b.y - 200).toBeCloseTo(12.5, 5);
  });

  // Ties the distance-based budget to a REAL shipped weapon (design/07 elemental frame),
  // rather than only to synthetic numbers — so a future change to either the correction's
  // 40px budget or this weapon's own pace shows up here as a concrete before/after, not just
  // as an abstract "the math still works" pass.
  it('frostseeker (the slowest ranged weapon in the roster) still shows most of its offset ' +
     'after one real 30Hz sim tick — the exact case this retune targets', () => {
    const frostseeker = WEAPON_SIM_BY_ID.frostseeker as RangedSimSpec;
    // `bulletSpeed` on the SIM spec is already fp-displacement-PER-TICK (weapons.ts'
    // `toFpPerTick`), not the authored grid/s — fromFp() undoes the fp scale, `PX_PER_GRID`
    // the grid-to-px one, and TICK_RATE plays no part since the conversion already is per-tick.
    const pxPerTick = fromFp(frostseeker.bulletSpeed) * PX_PER_GRID;

    const b = parked();
    b.setMuzzleOrigin(30, -18); // the real drawn-muzzle offset measured on live shots (18582fa)
    b.interpolate(1, 0);

    b.pushState(100 + pxPerTick, 200, 0, 0); // exactly one sim tick of this weapon's own travel
    b.interpolate(1, 1000 / TICK_RATE);
    const remainingFraction = (b.x - (100 + pxPerTick)) / 30;
    // A weapon this slow only dents the 40px budget by ~6px in one tick — most of the offset
    // (well over half) is still visible, by design: it finishes over several ticks rather than
    // vanishing in one, which is what keeps the correction reading as a departure rather than a
    // snap. What the OLD, time-based budget got wrong wasn't "still visible after tick one" —
    // it's that this same fraction used to persist for the SAME 120ms regardless of how little
    // ground a slow bullet had actually covered by then.
    expect(remainingFraction).toBeGreaterThan(0.6);
  });
});

/**
 * The spawn pop (2026-08-30, user report *"子弹出现的也很突兀"*). A round used to be drawn
 * identically on the frame it came into existence and on every frame after — nothing in the
 * picture separated "fired" from "in flight", so it read as popping into the air. These pin
 * that the two temporal cues exist, and — the part that actually matters — that both END,
 * exactly, at the round's true drawn size: a pop that settles at anything but scale 1 is a
 * bullet permanently the wrong size relative to its own hitbox.
 */
describe('Bullet — the spawn pop', () => {
  function flareOf(b: Bullet): Graphics {
    return b.children[Child.Flare] as Graphics;
  }

  it('starts oversize with a bright flare', () => {
    const b = new Bullet(4);
    b.place(0, 0, 0);
    b.interpolate(1, 0); // first drawn frame, nothing elapsed
    expect(coreOf(b).scale.x).toBeGreaterThan(1);
    expect(flareOf(b).visible).toBe(true);
    expect(flareOf(b).alpha).toBeCloseTo(1, 6);
  });

  // The test above samples at dt = 0, where the DURATION cancels out of the ease entirely — so
  // it passed unchanged against a 0.0001 ms pop, i.e. against no pop at all. That mutant
  // survived the 2026-08-30 battery, and this is what kills it: the cue has to still be there
  // after a real frame has elapsed, on a 60 Hz display and on a 30 Hz one, or nobody ever sees
  // a single frame of it.
  it('is still plainly oversize after a REAL frame — a pop shorter than one frame is no pop', () => {
    for (const frameMs of [16.7, 33.3]) {
      const b = new Bullet(4);
      b.place(0, 0, 0);
      b.interpolate(1, frameMs);
      expect(coreOf(b).scale.x, `${frameMs}ms frame`).toBeGreaterThan(1.2);
      expect(flareOf(b).visible).toBe(true);
      expect(flareOf(b).alpha).toBeGreaterThan(0.25);
    }
  });

  it('spans several frames rather than resolving inside one', () => {
    const b = new Bullet(4);
    b.place(0, 0, 0);
    // A do-while, not a while: the constructor leaves `scale.x` at its default 1 and the first
    // `interpolate` is what sets the oversize, so a pre-checked loop reads "already settled" and
    // counts zero frames — which is what the first version of this test did.
    let frames = 0;
    do {
      b.interpolate(1, 16.7);
      frames++;
    } while (coreOf(b).scale.x !== 1 && frames < 60);
    // Enough frames to read as motion. Two would be a flicker; 60 would mean it never ends.
    expect(frames).toBeGreaterThanOrEqual(4);
    expect(frames).toBeLessThan(12);
  });

  it('settles to EXACTLY its true size, with the flare gone', () => {
    const b = new Bullet(4);
    b.place(0, 0, 0);
    b.interpolate(1, 90); // the whole pop in one frame
    expect(coreOf(b).scale.x).toBe(1);
    expect(coreOf(b).scale.y).toBe(1);
    expect(glowOf(b).scale.x).toBe(1);
    expect(flareOf(b).visible).toBe(false);
  });

  it('never re-grows once settled, however long the bullet lives', () => {
    const b = new Bullet(4);
    b.place(0, 0, 0);
    b.interpolate(1, 90);
    for (let i = 0; i < 20; i++) b.interpolate(1, 16);
    expect(coreOf(b).scale.x).toBe(1);
    expect(flareOf(b).visible).toBe(false);
  });

  it('shrinks monotonically, and is over well inside the muzzle ease', () => {
    const b = new Bullet(4);
    b.place(0, 0, 0);
    const scales: number[] = [];
    for (let i = 0; i < 6; i++) {
      b.interpolate(1, 16);
      scales.push(coreOf(b).scale.x);
    }
    for (let i = 1; i < scales.length; i++) expect(scales[i]!).toBeLessThanOrEqual(scales[i - 1]!);
    // 6 x 16 = 96ms > SPAWN_POP_MS (90): the pop is finished on its own fixed clock regardless
    // of how the (now distance-based) barrel-tip correction is progressing, which is what keeps
    // the two from fighting — this test never even fires that correction (no setMuzzleOrigin).
    expect(scales[scales.length - 1]!).toBe(1);
  });

  it('does not survive a backgrounded tab as a stuck oversize round', () => {
    const b = new Bullet(4);
    b.place(0, 0, 0);
    b.interpolate(1, 5000);
    expect(coreOf(b).scale.x).toBe(1);
    expect(flareOf(b).visible).toBe(false);
  });
});
