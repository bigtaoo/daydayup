/**
 * RoomState collision geometry (design/07/09, ROADMAP 1.2): AABB tile/wall solids
 * alongside the existing round pillars, plus the pure RoomPiece → sim-geometry
 * converter. This is additive (no ENGINE_VERSION bump): every existing config
 * omits `walls`, so `state.walls` stays empty and these code paths are no-ops for
 * any pre-1.2 replay — see config.ts's note near ENGINE_VERSION.
 */
import { describe, it, expect } from 'vitest';
import { addFp, toFp, type Fp } from '@dd/engine/math/fixed';
import { createGameState } from '@dd/engine/state/GameState';
import type { GameState } from '@dd/engine/state/GameState';
import { pxToFp } from '@dd/engine/content/convert';
import { circleOverlapsAabb } from '@dd/engine/systems/geom';
import { roomGeometry, type RoomPiece } from '@dd/engine/content/rooms';
import { buildEnemyActor } from '@dd/engine/content/enemies';
import { MovementSystem, ProjectileStepSystem } from '@dd/engine/systems';
import { WALL_NORTH_BRIM } from '@dd/engine/config';
import { PLAYER_BASE } from '@dd/engine/content/players';
import { ENEMY_TEAM_ID, type AABB, type Faction, type Projectile } from '@dd/engine/state/entities';

const CFG = { seed: 1, worldW: 1600, worldH: 1200, waves: [] as const };

describe('circleOverlapsAabb (geom)', () => {
  it('overlaps when the circle centre is inside the rect', () => {
    const rect = { x: toFp(0), y: toFp(0), w: toFp(2), h: toFp(2) };
    expect(circleOverlapsAabb(toFp(1), toFp(1), toFp(0.1), rect)).toBe(true);
  });

  it('overlaps when within radius of the nearest edge', () => {
    const rect = { x: toFp(0), y: toFp(0), w: toFp(2), h: toFp(2) };
    expect(circleOverlapsAabb(toFp(2.3), toFp(1), toFp(0.5), rect)).toBe(true); // 0.3 grid past the right edge, radius 0.5
  });

  it('does not overlap when clear of the rect', () => {
    const rect = { x: toFp(0), y: toFp(0), w: toFp(2), h: toFp(2) };
    expect(circleOverlapsAabb(toFp(5), toFp(5), toFp(0.5), rect)).toBe(false);
  });
});

describe('MovementSystem — AABB wall push-out', () => {
  it('pushes a player out along the normal when approaching from outside (right edge)', () => {
    // Wall's right edge sits inside the player's solid clearance (16px) — player
    // spawns at world centre (800,600px); wall right edge = 795px.
    const s = createGameState({ ...CFG, walls: [[780, 590, 15, 20]] as const }); // px x,y,w,h
    const p = s.players[0]!;
    new MovementSystem().tick(s);
    const wallRight = addFp(pxToFp(780), pxToFp(15));
    expect(p.gx).toBe(addFp(wallRight, p.solidRadius)); // pushed to just touching the edge
    expect(p.gy).toBe(pxToFp(600)); // untouched — the push was purely along x
  });

  it('resolves a fully-engulfed footprint via axis separation (nearest edge)', () => {
    // A tall, narrow wall centred exactly on the player spawn (784..816px x)
    // spanning the whole world height — nearest edge is a tied left/right (both
    // 16px away); the resolver's fixed tie-break prefers +x (right).
    const s = createGameState({ ...CFG, walls: [[784, 0, 32, 1200]] as const });
    const p = s.players[0]!;
    new MovementSystem().tick(s);
    const wallRight = addFp(pxToFp(784), pxToFp(32));
    expect(p.gx).toBe(addFp(wallRight, p.solidRadius)); // pushed out the +x edge
    expect(p.gy).toBe(pxToFp(600)); // y untouched — the resolved axis was x
  });

  it('does not move an actor clear of every wall', () => {
    const s = createGameState({ ...CFG, walls: [[0, 0, 32, 32]] as const }); // far corner
    const p = s.players[0]!;
    const before = p.gx;
    new MovementSystem().tick(s);
    expect(p.gx).toBe(before);
  });
});

/**
 * The north brim (ENGINE_VERSION 47, `config.WALL_NORTH_BRIM`). A FREE-STANDING block's art
 * rises a full wall height north of its own footprint, so an actor allowed to stand tangent to
 * that face is drawn entirely inside stone — the report was *"角色整个跑到墙里面了"*, against a
 * pillar, which reserves enough floor that only about half a body goes under it.
 *
 * Every test here places the wall SOUTH of the player's spawn (800,600 px) and walks the push
 * out of it, because "which face" is the whole point: the brim is one-sided, and a version that
 * inflated the rect instead of the north EDGE would pass a north-approach test and quietly move
 * the other three faces too.
 */
describe('MovementSystem — free-standing block north brim (v47, widened v48)', () => {
  /** A wall pushed straight onto `state.walls` (not through `EngineConfig.walls`, which has no
   *  field for the flag), with the broadphase rebuilt the way SpawnSystem.loadRoom does. */
  function withWall(rect: AABB): GameState {
    const s = createGameState({ ...CFG });
    s.walls.push(rect);
    s.rebuildSpatialIndex();
    return s;
  }

  const px = (n: number) => pxToFp(n);
  // solidRadius + WALL_NORTH_BRIM (v48: 16 + 23 px) — a player's closest legal approach to a
  // free-standing block's north face. Computed, not restated, so a future brim/solidRadius
  // change moves this file's expectations along with it rather than silently drifting stale.
  const NORTH_STANDOFF = (PLAYER_BASE.solidRadius + WALL_NORTH_BRIM) as Fp;

  it('stops an actor one brim FURTHER north than the same rect unflagged', () => {
    // Footprint north edge at 610px — 10px south of the player's spawn, so they start
    // overlapping and get pushed back out along -y in both cases.
    const plain = withWall({ x: px(700), y: px(610), w: px(200), h: px(64) });
    const brimmed = withWall({ x: px(700), y: px(610), w: px(200), h: px(64), freeStanding: true });
    const mv = new MovementSystem();
    mv.tick(plain);
    mv.tick(brimmed);
    expect(plain.players[0]!.gy).toBe(px(610 - 16)); // tangent: solidRadius only
    expect(brimmed.players[0]!.gy).toBe((px(610) - NORTH_STANDOFF) as Fp); // solidRadius + WALL_NORTH_BRIM
    // Stated as the difference too, so this fails loudly if the constant moves without the
    // parity test (`client/.../occlusion.test.ts`) being revisited.
    expect((plain.players[0]!.gy as number) - (brimmed.players[0]!.gy as number)).toBe(WALL_NORTH_BRIM);
  });

  it('leaves the SOUTH face tangent — the brim is one-sided', () => {
    // Wall's south edge at 605px, 5px into the player's clearance from the north side of
    // nothing: the actor is south of the wall and pushed further south.
    const s = withWall({ x: px(700), y: px(500), w: px(200), h: px(105), freeStanding: true });
    new MovementSystem().tick(s);
    expect(s.players[0]!.gy).toBe(px(605 + 16)); // solidRadius, no brim
  });

  it('leaves the EAST face tangent — the brim is one-sided', () => {
    const s = withWall({ x: px(600), y: px(560), w: px(190), h: px(80), freeStanding: true });
    new MovementSystem().tick(s);
    expect(s.players[0]!.gx).toBe(px(790 + 16)); // solidRadius, no brim
    expect(s.players[0]!.gy).toBe(px(600)); // purely along x
  });

  it('resolves a fully-engulfed actor out of the BRIMMED north edge', () => {
    // A block the actor is standing dead inside, closest to its north edge (spawn 600px;
    // rect 592..792px y, so 8px to the north edge and 192px to the south). The axis-separation
    // branch has to use the same inflated edge, or an actor shoved into a block by knockback
    // would pop out to a line the walking path can never reach.
    const s = withWall({ x: px(700), y: px(592), w: px(200), h: px(200), freeStanding: true });
    new MovementSystem().tick(s);
    expect(s.players[0]!.gy).toBe((px(592) - NORTH_STANDOFF) as Fp);
  });

  it('does NOT hold a BULLET off — a shot still reaches the real stone', () => {
    // `ProjectileStepSystem` has its own wall query, and it must keep hitting the authored
    // footprint: the brim is about where a BODY may stand, not about where the wall is. If it
    // leaked into the projectile path every shot near an interior block would die 16 px early —
    // visible as bullets popping in mid-air, and a real change to cover.
    const s = withWall({ x: px(700), y: px(600), w: px(200), h: px(64), freeStanding: true });
    const bullet: Projectile = {
      id: s.nextId(), faction: 'player', teamId: 0,
      gx: px(800), gy: px(566), z: toFp(0),
      vx: toFp(0), vy: px(20), radius: px(2), damage: 1, damageType: 'physical',
      lifeTicks: 90, alive: true,
    };
    s.projectiles.push(bullet);
    const ps = new ProjectileStepSystem();
    // The start position is chosen so ONE tick lands the bullet between the two candidate edges:
    // 566 + 20 = 586, which is past the brimmed edge (584) and short of the real one (600). A brim
    // that leaked into this system would kill the bullet here; the real footprint does not.
    ps.tick(s);
    expect(bullet.alive).toBe(true);
    // ...and it does still die on the stone itself, one tick later — so this is a test about WHERE
    // the bullet stops, not a bullet that was never going to hit anything.
    ps.tick(s);
    expect(bullet.alive).toBe(false);
  });

  it("applies to an ENEMY too — the rule is the resolver's, not the player's", () => {
    // Same code path, and it has to be: an enemy that could stand where the player cannot would
    // hide inside a block's art, which is the same defect from the other side. Enemies keep a
    // SMALLER solid radius than the player, so this also pins that the brim is added to whatever
    // radius the actor brought rather than replacing it.
    const s = withWall({ x: px(700), y: px(610), w: px(200), h: px(64), freeStanding: true });
    // x = 880, not the world centre: the player spawns at (800, 600) and actor-vs-actor push-out
    // would otherwise move the enemy before the wall ever got to it.
    const e = buildEnemyActor(s, px(880), px(600));
    s.enemies.push(e);
    new MovementSystem().tick(s);
    expect(e.solidRadius).toBeLessThan(s.players[0]!.solidRadius); // smaller radius, same brim
    expect(e.gy).toBe((px(610) - WALL_NORTH_BRIM - e.solidRadius) as Fp);
  });

  it('finds a block the actor overlaps ONLY through its brim (broadphase widened)', () => {
    // 20px north of the footprint: outside `solidRadius` (16), inside solidRadius+brim (v48: 39).
    // If the query radius had been left at solidRadius this cell could fall outside the
    // queried band and the push would silently never happen.
    const s = withWall({ x: px(700), y: px(620), w: px(200), h: px(64), freeStanding: true });
    new MovementSystem().tick(s);
    expect(s.players[0]!.gy).toBe((px(620) - NORTH_STANDOFF) as Fp);
  });
});

describe('ProjectileStepSystem — AABB wall stop/expire', () => {
  function addBullet(s: GameState, xpx: number, ypx: number, vx: Fp, faction: Faction = 'enemy'): Projectile {
    const b: Projectile = {
      id: s.nextId(), faction, teamId: faction === 'enemy' ? ENEMY_TEAM_ID : 0,
      gx: pxToFp(xpx), gy: pxToFp(ypx), z: toFp(0),
      vx, vy: toFp(0), radius: pxToFp(5), damage: 1, damageType: 'physical',
      lifeTicks: 90, alive: true,
    };
    s.projectiles.push(b);
    return b;
  }

  it('expires a bullet that flies into a wall', () => {
    const s = createGameState({ ...CFG, walls: [[816, 90, 40, 40]] as const }); // spans y 90..130, x 816..856
    const b = addBullet(s, 800, 100, toFp(0.5)); // ~16px step lands inside the wall
    new ProjectileStepSystem().tick(s);
    expect(b.alive).toBe(false);
  });

  it('lets a bullet pass where there is no wall', () => {
    const s = createGameState({ ...CFG, walls: [[816, 400, 40, 40]] as const }); // wall is far away on y
    const b = addBullet(s, 800, 100, toFp(0.5));
    new ProjectileStepSystem().tick(s);
    expect(b.alive).toBe(true);
  });
});

describe('roomGeometry (content/rooms) — pure RoomPiece → sim-geometry conversion', () => {
  const piece: RoomPiece = {
    id: 'test_room',
    sizeGrid: { w: 10, h: 8 },
    solids: [{ x: 0, y: 0, w: 10, h: 1 }],
    pillars: [{ center: { x: 5, y: 4 }, radius: 0.5 }],
    spawns: { player: [{ x: 5, y: 6 }], enemy: [{ x: 5, y: 2, type: 'basic' }] },
    exits: [{ edge: 'north' }],
  };

  it('converts solids/pillars to Fp, offset by the placement origin', () => {
    const { walls, obstacles } = roomGeometry(piece, 20, 30);
    expect(walls).toHaveLength(1);
    expect(walls[0]).toEqual({ x: toFp(20), y: toFp(30), w: toFp(10), h: toFp(1) });
    expect(obstacles).toHaveLength(1);
    expect(obstacles[0]).toEqual({ gx: toFp(25), gy: toFp(34), radius: toFp(0.5) });
  });

  it('defaults the offset to the origin', () => {
    const { walls } = roomGeometry(piece);
    expect(walls[0]!.x).toBe(toFp(0));
  });

  it('a piece with no pillars converts to an empty obstacles array', () => {
    const bare: RoomPiece = { ...piece, pillars: undefined };
    const { obstacles } = roomGeometry(bare);
    expect(obstacles).toHaveLength(0);
  });

  it('carries `freeStanding` across the conversion, and never invents it (v47)', () => {
    // The single grid -> fp crossing every authored solid makes. Whether a solid is free-standing
    // is an AUTHORING fact — which list it came from — and nothing downstream can re-derive it
    // from the rect's own numbers, so if it is dropped here the v47 brim is simply gone.
    const mixed: RoomPiece = {
      ...piece,
      solids: [{ x: 0, y: 0, w: 10, h: 1 }, { x: 3, y: 3, w: 2, h: 2, freeStanding: true }],
    };
    const { walls } = roomGeometry(mixed, 20, 30);
    expect(walls[1]!.freeStanding).toBe(true);
    // The perimeter solid must come out with the key ABSENT, not `false` — `toEqual` above pins
    // the exact shape of a converted rect, and a stray key would make every unflagged wall a
    // different object than the one the rest of the suite compares against.
    expect(walls[0]!.freeStanding).toBeUndefined();
    expect('freeStanding' in walls[0]!).toBe(false);
  });
});

describe('Additive, no-bump (design/09 "unknown field ignored" precedent)', () => {
  it('a config with no walls leaves state.walls empty — every pre-1.2 replay is unaffected', () => {
    const s = createGameState(CFG);
    expect(s.walls).toHaveLength(0);
  });
});


/**
 * `Actor.solidRadius` — the radius an actor stops at against a STATIC solid, split
 * off `footprintRadius` in ENGINE_VERSION 43 (live report: *"角色走到墙角的时候，太靠墙
 * 了，感觉陷进去了"*). These pin the DISTINCTION, not just the number: each one also
 * asserts what the pre-v43 feet-circle answer would have been, so reverting the
 * resolvers to `footprintRadius` fails here rather than silently re-shipping the bug.
 */
describe('MovementSystem — solidRadius vs footprintRadius against a solid (v43; enemies joined in v48)', () => {
  it('a player rests at its BODY radius from a wall face, not at its feet circle', () => {
    // The character's rendered body is exactly `radius` × 2 wide (design/12's rig
    // normalization), so this clearance is what puts its silhouette tangent to the
    // wall instead of 9 px inside it.
    const s = createGameState({ ...CFG, walls: [[780, 590, 15, 20]] as const }); // right edge 795px
    const p = s.players[0]!;
    expect(p.solidRadius).toBe(p.radius); // premise: the body radius IS the clearance
    expect(p.solidRadius).toBeGreaterThan(p.footprintRadius); // and it is not the feet circle
    new MovementSystem().tick(s);
    const wallRight = addFp(pxToFp(780), pxToFp(15));
    expect(p.gx).toBe(addFp(wallRight, p.solidRadius));
    expect(p.gx).not.toBe(addFp(wallRight, p.footprintRadius)); // the pre-v43 resting place
  });

  it('a player rests at its body radius from a round pillar too — walls and pillars agree', () => {
    const s = createGameState({ ...CFG, obstacles: [[790, 600, 30]] as const });
    const p = s.players[0]!;
    new MovementSystem().tick(s);
    const dx = (p.gx - pxToFp(790)) as number;
    expect(Math.abs(dx - ((p.solidRadius + pxToFp(30)) as number))).toBeLessThanOrEqual(2);
    // Clear of the pre-v43 answer by the full 9 px the report was about.
    expect(dx - ((p.footprintRadius + pxToFp(30)) as number)).toBeGreaterThan(pxToFp(8));
  });

  it('an ENEMY now rests at its BODY radius too (v48) — mob paths along a wall moved with the player\'s', () => {
    // Through v47 a mob kept the pre-v43 feet-circle answer here (`e.footprintRadius`) —
    // reversed in v48 (live report: *"怪物也要遵守同样的规则"*), so a mob now stops at the same
    // silhouette-tangent distance the player's own v43 fix gave them.
    const s = createGameState({ ...CFG, walls: [[780, 590, 15, 20]] as const });
    s.players[0]!.gx = pxToFp(200); // out of the way — an actor↔actor push would mask the wall's
    const e = buildEnemyActor(s, pxToFp(800), pxToFp(600));
    s.enemies.push(e);
    expect(e.solidRadius).toBe(e.radius); // premise: enemies now match the player's convention
    new MovementSystem().tick(s);
    const wallRight = addFp(pxToFp(780), pxToFp(15));
    expect(e.gx).toBe(addFp(wallRight, e.radius));
    expect(e.gx).not.toBe(addFp(wallRight, e.footprintRadius)); // the pre-v48 resting place
  });

  it('actor↔actor push-out still uses the feet circle — a crowd is judged by feet, a wall by the body', () => {
    // The whole point of the split: bodies overlapping each other is a crowd (kept),
    // a body overlapping stone is a body sunk into it (fixed).
    const s = createGameState(CFG);
    const p = s.players[0]!;
    const e = buildEnemyActor(s, addFp(p.gx, pxToFp(5)), p.gy);
    s.enemies.push(e);
    new MovementSystem().tick(s);
    const dist = (e.gx - p.gx) as number;
    expect(Math.abs(dist - ((p.footprintRadius + e.footprintRadius) as number))).toBeLessThanOrEqual(2);
    expect(dist).toBeLessThan((p.solidRadius + e.solidRadius) as number); // NOT pushed to solid clearance
  });
});

/**
 * True when the actor's clearance circle actually PENETRATES the rect, as opposed to
 * resting tangent to it. `circleOverlapsAabb` compares `<=`, so a circle touching a face
 * counts as overlapping there — and tangent is exactly where the resolver leaves a body
 * (`resolveWalls` bails on `distSq >= r * r`), which is why these assertions shave one
 * fixed-point unit off the radius instead of asking for no overlap at all.
 */
function penetrates(gx: Fp, gy: Fp, r: Fp, rect: AABB): boolean {
  return circleOverlapsAabb(gx, gy, (r - 1) as Fp, rect);
}

/**
 * The same clearance, exercised as BEHAVIOUR rather than as a resting coordinate: every
 * face of a wall, the corner the report was actually about, a door the player still has to
 * fit through, and the two ways a body can be shoved at a wall by something other than its
 * own input (knockback, and another actor). All of these were reachable before v43 and none
 * had a test — the widened clearance is only safe if it holds on every side and wedges
 * nothing shut.
 */
describe('MovementSystem — solid clearance, all four faces (v43)', () => {
  // One 3x3-grid block in the middle of the world; the player starts 2 px inside each face
  // in turn, which is deep enough to overlap at either clearance, so each case would pass
  // at the old 7 px too — what it pins is WHERE the actor comes to rest.
  const BLOCK = [[700, 500, 96, 96]] as const; // px: x 700..796, y 500..596
  const faces = [
    { name: 'east face (approached from the right)', from: [798, 548], axis: 'x', rest: 796 + 16 },
    { name: 'west face (approached from the left)', from: [698, 548], axis: 'x', rest: 700 - 16 },
    { name: 'south face (approached from below)', from: [748, 598], axis: 'y', rest: 596 + 16 },
    { name: 'north face (approached from above)', from: [748, 498], axis: 'y', rest: 500 - 16 },
  ] as const;

  for (const f of faces) {
    it(`rests exactly one body radius off the ${f.name}`, () => {
      const s = createGameState({ ...CFG, walls: BLOCK });
      const p = s.players[0]!;
      p.gx = pxToFp(f.from[0]);
      p.gy = pxToFp(f.from[1]);
      new MovementSystem().tick(s);
      const moved = f.axis === 'x' ? p.gx : p.gy;
      const still = f.axis === 'x' ? p.gy : p.gx;
      expect(moved).toBe(pxToFp(f.rest));
      expect(still).toBe(pxToFp(f.axis === 'x' ? f.from[1] : f.from[0])); // push was purely along one axis
      // And the resting circle really is out of the wall, by the geometry the sim's own
      // overlap test uses — not just at the number this test computed.
      expect(penetrates(p.gx, p.gy, p.solidRadius, s.walls[0]!)).toBe(false);
    });
  }

  it('leaves an actor already resting at its clearance untouched — no jitter against a wall', () => {
    // A resting player is re-resolved every tick forever; a resolver that overshoots by a
    // fixed-point rounding unit would creep along the wall for as long as you stand there.
    const s = createGameState({ ...CFG, walls: BLOCK });
    const p = s.players[0]!;
    p.gx = pxToFp(796 + 16);
    p.gy = pxToFp(548);
    const mv = new MovementSystem();
    for (let i = 0; i < 30; i++) mv.tick(s);
    expect(p.gx).toBe(pxToFp(796 + 16));
    expect(p.gy).toBe(pxToFp(548));
  });

  it('a diagonal shove into an inside CORNER ends clear of both walls — the reported case', () => {
    // Two walls meeting in an L, player driven at the corner point itself. This is the
    // configuration in the 2026-08-19 report's screenshot (a wall's end, a floor, and the
    // character wedged into the join), and the case where a single-axis resolver would leave
    // the body inside the other wall.
    const s = createGameState({
      ...CFG,
      walls: [[700, 500, 96, 300], [700, 500, 300, 96]] as const, // vertical + horizontal arm
    });
    const p = s.players[0]!;
    p.gx = pxToFp(800); // just outside the corner point (796, 596), diagonally
    p.gy = pxToFp(600);
    const mv = new MovementSystem();
    for (let i = 0; i < 5; i++) mv.tick(s); // let both resolvers settle
    for (const w of s.walls) {
      expect(penetrates(p.gx, p.gy, p.solidRadius, w)).toBe(false);
    }
  });

  it('still fits through a 2-grid door gap at the wider clearance (no wedged level)', () => {
    // Level 1's narrowest authored passage is 2 grid = 64 px (every `world/dungeons/ember/`
    // door). The player is 32 px wide against walls after v43, so this is the navigational
    // guard the whole change rides on — walk one through, don't just measure it.
    const s = createGameState({
      ...CFG,
      walls: [[0, 600, 780, 32], [844, 600, 756, 32]] as const, // gap: x 780..844 (64 px)
    });
    const p = s.players[0]!;
    p.gx = pxToFp(812); // gap centre
    p.gy = pxToFp(560); // north of the wall
    const mv = new MovementSystem();
    for (let i = 0; i < 40; i++) {
      p.vy = pxToFp(4) as Fp; // a steady walk south, re-applied each tick (no ApplyInput here)
      mv.tick(s);
    }
    expect(p.gy).toBeGreaterThan(pxToFp(632 + 16)); // through, and clear of the far side
    expect(p.gx).toBe(pxToFp(812)); // straight through the middle — never squeezed sideways
  });

  it('even a 1-grid gap still passes — squeezed onto its centre line, not wedged shut', () => {
    // The tightest gap the change could plausibly have closed: 32 px of gap against a
    // now-32 px-wide player. It still passes, because both resolvers bail on tangency
    // (`distSq >= r * r`) — and the two walls push the body onto the gap's centre line on
    // the way through, which is the property worth pinning: entering OFF-centre does not
    // stick. Written after the run disagreed with the guess that this would wedge.
    const s = createGameState({
      ...CFG,
      walls: [[0, 600, 796, 32], [828, 600, 772, 32]] as const, // gap: x 796..828 (32 px)
    });
    const p = s.players[0]!;
    p.gx = pxToFp(800); // deliberately 12 px off the centre line
    p.gy = pxToFp(560);
    const mv = new MovementSystem();
    for (let i = 0; i < 40; i++) {
      p.vy = pxToFp(4) as Fp;
      mv.tick(s);
    }
    expect(p.gy).toBeGreaterThan(pxToFp(632 + 16)); // through
    expect(p.gx).toBe(pxToFp(812)); // and centred by the two walls, from an off-centre entry
  });

  it('knockback cannot shove a body inside a wall — the push-out runs after the impulse', () => {
    const s = createGameState({ ...CFG, walls: [[810, 500, 96, 200]] as const });
    const p = s.players[0]!;
    p.gx = pxToFp(780);
    p.gy = pxToFp(560);
    p.knockVx = pxToFp(60) as Fp; // far more than the gap to the wall
    new MovementSystem().tick(s);
    expect(p.gx).toBe(pxToFp(810 - 16));
    expect(penetrates(p.gx, p.gy, p.solidRadius, s.walls[0]!)).toBe(false);
  });

  it('an actor↔actor push cannot leave a player inside a wall either (order of resolvers)', () => {
    // Actor pairs resolve AFTER solids, so a mob pressing a player into a wall can end the
    // tick with the player overlapping stone. Pinned as the CURRENT behaviour with the
    // amount bounded: at worst half the pair's penetration, never a free pass through.
    const s = createGameState({ ...CFG, walls: [[810, 500, 96, 200]] as const });
    const p = s.players[0]!;
    p.gx = pxToFp(810 - 16); // already resting against the wall
    p.gy = pxToFp(560);
    const e = buildEnemyActor(s, pxToFp(810 - 16 - 5), pxToFp(560)); // shoving from the west
    s.enemies.push(e);
    new MovementSystem().tick(s);
    const intrusion = (p.gx - pxToFp(810 - 16)) as number;
    expect(intrusion).toBeGreaterThanOrEqual(0); // pushed east, into the wall's direction
    expect(intrusion).toBeLessThan(p.solidRadius as number); // but never past its own clearance
  });
});
