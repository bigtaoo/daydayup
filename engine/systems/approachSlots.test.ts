/**
 * `approachSlots.ts` on its own (ENGINE_VERSION 56) — the four rules from its header, each
 * measured as geometry rather than inferred from a settled simulation.
 *
 * `enemySpacing.test.ts` drives the same feature through the real AIDecide + Movement pair and
 * is where the behaviour lives; this file exists for the cases that composition cannot reach or
 * can only reach by luck — the second ring, the quarter-circle deviation cap, the walled-off
 * fallback, the per-room buckets — and for stating the ONE property the whole design rests on
 * as a direct measurement: a lone mob's destination is exactly the point it was already walking
 * to, so nothing about one mob against one player changed in this pass.
 */
import { describe, it, expect } from 'vitest';
import { createGameState } from '@dd/engine/state/GameState';
import type { GameState } from '@dd/engine/state/GameState';
import { buildEnemyActor, DEFAULT_ENEMY_ENGAGE_RANGE_FP } from '@dd/engine/content/enemies';
import { standoffRadius } from '@dd/engine/state/actorRadius';
import type { EnemyActor } from '@dd/engine/state/entities';
import { assignApproachSlots, type ApproachSlot } from '@dd/engine/systems/approachSlots';
import { pxToFp } from '@dd/engine/content/convert';
import type { Fp } from '@dd/engine/math/fixed';

const CFG = { seed: 3, worldW: 3200, worldH: 2400, waves: [] as const };
const TARGET: [Fp, Fp] = [pxToFp(400), pxToFp(300)];

function state(walls?: readonly (readonly [number, number, number, number])[]): GameState {
  return createGameState({ ...CFG, players: [{ start: [400, 300] }], ...(walls ? { walls } : {}) });
}

function mob(s: GameState, xpx: number, ypx: number, type = 'basic', roomId?: string): EnemyActor {
  const e = buildEnemyActor(s, pxToFp(xpx), pxToFp(ypx), type);
  e.aggroed = true;
  if (roomId !== undefined) e.roomId = roomId;
  s.enemies.push(e);
  return e;
}

function slotsFor(s: GameState, mobs: readonly EnemyActor[]): ApproachSlot[] {
  const out: ApproachSlot[] = [];
  assignApproachSlots(s, mobs, TARGET[0], TARGET[1], out);
  return out;
}

const away = (p: { x: number; y: number }): number =>
  Math.hypot(p.x - (TARGET[0] as number), p.y - (TARGET[1] as number));
const gap = (a: ApproachSlot, b: ApproachSlot): number => Math.hypot(a.x - b.x, a.y - b.y);

describe('approach slots — where a mob is walking to (ENGINE_VERSION 56)', () => {
  it('a lone mob is sent to the point it was already walking to: straight in, no sideways step', () => {
    // The rule everything else is built on. If this drifts, every single-mob chase in the game
    // gains a wobble that no player could explain, and the v37 straight-line pursuit is gone.
    const s = state();
    const e = mob(s, 900, 300); // due east, 500 px out
    const [slot] = slotsFor(s, [e]);

    expect(slot!.y).toBe(pxToFp(300)); // dead on the line to the player
    expect(slot!.x).toBeLessThan(e.gx); // and in front of it, not behind
    // On the engage ring, a couple of walking steps inside it so that stopping one step short
    // still leaves the mob in range to shoot.
    const margin = 2 * e.moveSpeedPerTick!;
    expect(away(slot!)).toBeGreaterThan(DEFAULT_ENEMY_ENGAGE_RANGE_FP - margin - 2);
    expect(away(slot!)).toBeLessThanOrEqual(DEFAULT_ENEMY_ENGAGE_RANGE_FP - margin + 2);
  });

  it('two mobs on the same bearing are sent a standing volume apart, on the same ring', () => {
    const s = state();
    const near = mob(s, 900, 300);
    const far = mob(s, 1100, 300);
    const [a, b] = slotsFor(s, [near, far]);

    // Within half a pixel of the standoff, and short of it rather than past it: the ring
    // separation is an ARC and two centres are a CHORD apart (see BRAD_PER_RADIAN). The
    // spacing pass closes the last 14 fp — this is the destination, not the final answer.
    const want = standoffRadius(near) + standoffRadius(far);
    expect(gap(a!, b!)).toBeGreaterThan(want - pxToFp(1));
    expect(gap(a!, b!)).toBeLessThan(want + pxToFp(1));
    expect(Math.abs(away(a!) - away(b!))).toBeLessThanOrEqual(2); // same ring: spread by ANGLE
    expect(a!.y).toBe(pxToFp(300)); // the first claimer keeps the bearing it had
    expect(b!.y).not.toBe(pxToFp(300));
  });

  it('a mob already closer than the ring is never sent back out to it', () => {
    // No kiting (v37, and this is not the pass that adds it): the ring stops a mob closing, it
    // does not pull one back. A mob the player has walked up to spreads sideways at the
    // distance it already has.
    const s = state();
    const close = mob(s, 460, 300); // 60 px out, a third of the engage range
    const [slot] = slotsFor(s, [close]);

    expect(away(slot!)).toBeLessThanOrEqual(close.gx - (TARGET[0] as number));
    expect(slot!.x).toBe(close.gx); // in fact exactly where it stands: nothing to do
    expect(slot!.y).toBe(close.gy);
  });

  it('the LAST-RESORT spot obeys the no-retreat rule too, not just the ones on a ring', () => {
    // Two mobs pressed right up against the player subtend most of the circle each, so there
    // is no free angle within a quarter circle of either bearing on ANY ring and the second
    // one falls through to the last-resort spot. That spot is the one place the ring search
    // does not clamp for you, and a mutation battery found it untested: unclamped, a mob
    // standing 45 px from the player gets told to walk back out to 170 px, which is the
    // no-kiting rule broken in the one case nobody looks at.
    const s = state();
    // Four of them, because reaching the last resort takes exhausting all three rings: each
    // ring's claims are its own, so the second mob takes the free bearing on ring 1 and the
    // third on ring 2 before the fourth has nowhere left to be put.
    const mobs = [20, 25, 30, 35].map((px) => mob(s, 400 + px, 300));
    const slots = slotsFor(s, mobs);
    const last = slots[3]!;
    expect(away(last)).toBeLessThanOrEqual(mobs[3]!.gx - (TARGET[0] as number));
    expect([last.x, last.y]).toEqual([mobs[3]!.gx, mobs[3]!.gy]); // it stays exactly where it is
  });

  it('a mob standing on the target itself is sent nowhere, not flung out to the ring', () => {
    // The degenerate case the radius clamp has to cover: bearing is undefined at distance 0,
    // and "walk to your ring" there would read as a mob recoiling off the player.
    const s = state();
    const on = mob(s, 400, 300);
    const [slot] = slotsFor(s, [on]);
    expect([slot!.x, slot!.y]).toEqual([TARGET[0], TARGET[1]]);
  });

  it('a crowd on one bearing forms an arc and then a SECOND ring, rather than walking round the player', () => {
    // The deviation cap. Twelve mobs all coming from the east: the ring can seat about nine of
    // them within a quarter circle of due east, and the rest have to go somewhere. Behind the
    // player is the wrong answer — the straight line there runs through the player — so they
    // queue up on a ring one standing diameter further out.
    const s = state();
    const mobs = Array.from({ length: 12 }, (_, i) => mob(s, 900 + i * 5, 300));
    const slots = slotsFor(s, mobs);

    const ring0 = slots.filter((p) => away(p) < pxToFp(200));
    const ring1 = slots.filter((p) => away(p) >= pxToFp(200));
    expect(ring0.length).toBeGreaterThan(6);
    expect(ring1.length).toBeGreaterThan(0);
    // Nobody was sent to the far side of the player: every spot is east of it.
    for (const p of slots) expect(p.x).toBeGreaterThan(TARGET[0]);
    // And the two rings really are a standing diameter apart.
    const inner = Math.max(...ring0.map(away));
    const outer = Math.min(...ring1.map(away));
    expect(outer - inner).toBeGreaterThan(standoffRadius(mobs[0]!));
    // Every spot on a ring clears every other spot on the same ring.
    for (const ring of [ring0, ring1]) {
      for (let i = 0; i < ring.length; i++) {
        for (let j = i + 1; j < ring.length; j++) {
          expect(gap(ring[i]!, ring[j]!)).toBeGreaterThan(standoffRadius(mobs[0]!) * 2 - pxToFp(1));
        }
      }
    }
  });

  it('a spot behind a wall is refused: the mob falls back to the route it would have taken in v55', () => {
    // The v55 report's own example, as geometry. A mob standing in the mouth of a narrow slit
    // must not make the slit impassable to the mob behind it — there is no straight route from
    // out there to any spread spot, and there IS one straight at the player.
    const GAP_PX = 45; // 1.5 x a basic mob's 30 px body
    const s = state([
      [600, 0, 40, 300 - GAP_PX / 2],
      [600, 300 + GAP_PX / 2, 40, 600],
    ]);
    const stander = mob(s, 555, 300);
    stander.holding = true; // arrived: it claims the bearing first
    const behind = mob(s, 900, 300);
    const [, slot] = slotsFor(s, [stander, behind]);

    expect(slot!.y).toBe(pxToFp(300)); // straight through the slit, not around it
    // Same wall, same pair, but with the traveller already on the player's side of it: now
    // there IS a straight route to a spread spot, and it takes one.
    const open = state();
    const s2 = mob(open, 555, 300);
    s2.holding = true;
    const near = mob(open, 900, 300);
    const [, freeSlot] = slotsFor(open, [s2, near]);
    expect(freeSlot!.y).not.toBe(pxToFp(300));
  });

  it('a pillar blocks a spot the same way a wall does', () => {
    // `isInsideSolid` asks MovementSystem's own push-out, so both kinds of solid answer.
    const s = createGameState({
      ...CFG,
      players: [{ start: [400, 300] }],
      obstacles: [[560, 360, 60]] as const, // px triples, the authoring form
    });
    const stander = mob(s, 555, 300);
    stander.holding = true;
    const behind = mob(s, 900, 300);
    const [, slot] = slotsFor(s, [stander, behind]);
    // Its spread spot would be south-east of the stander, which is where the pillar is; it
    // keeps its own bearing instead of walking into stone.
    expect(slot!.y).toBe(pxToFp(300));
  });

  it('mobs crowd only the mobs of their own room — the room is the aggro unit', () => {
    const s = state();
    const a = mob(s, 900, 300, 'basic', 'r0');
    const b = mob(s, 905, 300, 'basic', 'r1');
    const [pa, pb] = slotsFor(s, [a, b]);
    expect(pa!.y).toBe(pxToFp(300));
    expect(pb!.y).toBe(pxToFp(300)); // different bucket: it never saw a's claim
  });

  it('an arrived mob claims before a travelling one, whatever order they spawned in', () => {
    // Priority, and it has to beat array order or a newcomer with a lower id evicts the mob
    // that is already standing there and the pair swap places for no reason.
    const s = state();
    const newcomer = mob(s, 900, 300); // lower id, still walking
    const arrived = mob(s, 570, 300); // higher id, already standing inside the ring
    arrived.holding = true;
    const [nSlot, aSlot] = slotsFor(s, [newcomer, arrived]);

    expect([aSlot!.x, aSlot!.y]).toEqual([arrived.gx, arrived.gy]); // it kept its spot
    expect(nSlot!.y).not.toBe(pxToFp(300)); // the newcomer went around it
  });

  it('a bigger mob claims proportionally more of the ring', () => {
    const s = state();
    const basics = [mob(s, 900, 300), mob(s, 905, 300)];
    const brutes = [mob(s, 900, 900, 'brute'), mob(s, 905, 900, 'brute')];
    // Same target, so the brutes come in on a different bearing and do not interact with the
    // basics' claims; what is compared is how far each pair ends up apart.
    const slots = slotsFor(s, [...basics, ...brutes]);
    expect(gap(slots[2]!, slots[3]!)).toBeGreaterThan(gap(slots[0]!, slots[1]!));
  });

  it('is a pure function of the inputs, and reuses the caller scratch it is handed', () => {
    const build = (): [GameState, EnemyActor[]] => {
      const s = state();
      return [s, [mob(s, 900, 300), mob(s, 905, 300), mob(s, 890, 320)]];
    };
    const [s1, m1] = build();
    const [s2, m2] = build();
    expect(slotsFor(s1, m1)).toEqual(slotsFor(s2, m2));

    // Scratch: the same array comes back, resized, with the same point objects reused.
    const out: ApproachSlot[] = [];
    assignApproachSlots(s1, m1, TARGET[0], TARGET[1], out);
    const first = out[0]!;
    assignApproachSlots(s1, m1.slice(0, 2), TARGET[0], TARGET[1], out);
    expect(out.length).toBe(2);
    expect(out[0]).toBe(first);
  });
});
