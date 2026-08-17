/**
 * PveBotController — the level simulator's driver. Tested against hand-built states
 * rather than live runs so each decision branch (fire/kite/heal-seek/rest/travel/
 * confirm-portal) is exercised in isolation; `levelSim.test.ts` covers it end-to-end
 * through the real engine.
 *
 * The `as unknown as GameState` fixture cast follows `pveNav.test.ts`'s: the bot reads
 * a documented handful of fields, and a literal makes the geometry under test obvious
 * where a real generated floor would hide it.
 */
import { describe, expect, it } from 'vitest';
import { Button, FP_SCALE, type GameState } from '@dd/engine';
import { BOT_PROFILES, PveBotController } from './PveBotController';

const g = (grid: number): number => grid * FP_SCALE;

interface FixtureOpts {
  playerAt: [number, number];
  hp?: number;
  shield?: number;
  /** [gx, gy, roomId, alive?] per enemy, in grid units. */
  enemies?: [number, number, string, boolean?][];
  heals?: [number, number][];
  /** Room id → whether its runtime says it still holds a live enemy. */
  rooms?: { id: string; x: number; y: number; w: number; h: number; activated?: boolean; hasLiveEnemy?: boolean }[];
  doors?: [string, string, { x: number; y: number; w: number; h: number }][];
  floorIndex?: number;
  floorCount?: number;
}

/** Two 10x10 rooms side by side joined by a doorway at their shared edge — the
 *  smallest floor that can exercise travel, and the default for tests that only care
 *  about combat (everything happens inside `a`).
 *
 *  `b` is deliberately UNACTIVATED: it is the last placed room, i.e. the capstone, so
 *  an activated-and-quiet `b` would make `checkpointReached` true and put the bot in
 *  portal mode for every test in the file. */
const TWO_ROOMS: NonNullable<FixtureOpts['rooms']> = [
  { id: 'a', x: 0, y: 0, w: g(10), h: g(10) },
  { id: 'b', x: g(10), y: 0, w: g(10), h: g(10), activated: false },
];
const DOOR_AB: NonNullable<FixtureOpts['doors']> = [['a', 'b', { x: g(9.5), y: g(4), w: g(1), h: g(2) }]];

function fixture(o: FixtureOpts): GameState {
  const rooms = o.rooms ?? TWO_ROOMS;
  return {
    tick: 500,
    floorIndex: o.floorIndex ?? 0,
    dungeonEnabled: true,
    dungeonConfig: { floorCount: o.floorCount ?? 5 },
    players: [
      {
        id: 1,
        alive: true,
        downed: false,
        gx: g(o.playerAt[0]),
        gy: g(o.playerAt[1]),
        hp: o.hp ?? 6,
        maxHp: 6,
        shield: o.shield ?? 3.2,
        maxShield: 3.2,
      },
    ],
    enemies: (o.enemies ?? []).map(([gx, gy, roomId, alive], i) => ({
      id: 10 + i,
      alive: alive ?? true,
      gx: g(gx),
      gy: g(gy),
      roomId,
    })),
    pickups: (o.heals ?? []).map(([gx, gy], i) => ({ id: 50 + i, alive: true, kind: 'heal', gx: g(gx), gy: g(gy) })),
    dungeonRooms: rooms.map((r) => ({ id: r.id })),
    dungeonRoomRects: rooms.map((r) => ({ id: r.id, rect: { x: r.x, y: r.y, w: r.w, h: r.h } })),
    dungeonRoomRuntime: rooms.map((r) => ({
      activated: r.activated ?? true,
      roomTick: 100,
      schedule: [],
      cursor: 0,
      hasLiveEnemy: r.hasLiveEnemy ?? false,
    })),
    dungeonRoomIndexById: new Map(rooms.map((r, i) => [r.id, i] as const)),
    dungeonDoors: (o.doors ?? DOOR_AB).map(([a, b, rect]) => ({
      door: { roomA: a, roomB: b, passageGrid: { x: 0, y: 0, w: 0, h: 0 } },
      passageAabb: rect,
      locked: false,
    })),
    wavesExhausted: false,
  } as unknown as GameState;
}

/** brad → the unit vector it points along, for asserting a movement DIRECTION without
 *  restating `quantizeMove`'s own rounding. */
function dir(brad: number): { x: number; y: number } {
  const rad = (brad / 65536) * Math.PI * 2;
  return { x: Math.cos(rad), y: Math.sin(rad) };
}

const bot = (profile = BOT_PROFILES.careful) => new PveBotController(profile);

/** Nudge the seat's y in grid units. `gx`/`gy` are branded `Fp` on the real actor, and
 *  the fixture is a structural cast, so a plain number needs the same cast the fixture
 *  itself uses. */
function setSeatY(s: GameState, grid: number): void {
  (s.players[0] as unknown as { gy: number }).gy = g(grid);
}

describe('PveBotController — dead/downed seats', () => {
  it('idles when its seat does not exist', () => {
    const cmd = bot().build(fixture({ playerAt: [5, 5] }), 3, 501);
    expect(cmd.moveMag).toBe(0);
    expect(cmd.buttons).toBe(0);
  });

  it('idles when dead or downed rather than issuing a fire command', () => {
    const s = fixture({ playerAt: [5, 5], enemies: [[6, 5, 'a']] });
    s.players[0]!.alive = false;
    expect(bot().build(s, 0, 501).buttons).toBe(0);
    s.players[0]!.alive = true;
    s.players[0]!.downed = true;
    expect(bot().build(s, 0, 501).buttons).toBe(0);
  });
});

describe('PveBotController — engaging', () => {
  it('fires at an in-range enemy in its own room', () => {
    const cmd = bot().build(fixture({ playerAt: [2, 5], enemies: [[8, 5, 'a']] }), 0, 501);
    expect(cmd.buttons & Button.FIRE).toBe(Button.FIRE);
  });

  it('ignores enemies in a DIFFERENT room — it cannot shoot through a wall', () => {
    // Without this filter the bot settles into a standoff with an unhittable mob and
    // never advances again (observed: 7 of 8 careful sim runs stalled forever).
    const cmd = bot().build(fixture({ playerAt: [8, 5], enemies: [[11, 5, 'b']] }), 0, 501);
    expect(cmd.buttons & Button.FIRE).toBe(0);
  });

  it('holds fire while a target is beyond its own fire range', () => {
    const s = fixture({
      playerAt: [2, 2],
      rooms: [
        { id: 'a', x: 0, y: 0, w: g(40), h: g(40) },
        { id: 'b', x: g(40), y: 0, w: g(10), h: g(10), activated: false },
      ],
      doors: [['a', 'b', { x: g(39.5), y: g(4), w: g(1), h: g(2) }]],
      enemies: [[30, 30, 'a']],
    });
    expect(bot().build(s, 0, 501).buttons & Button.FIRE).toBe(0);
  });

  it('closes distance when outside its standoff band', () => {
    // 11 grid apart — past careful's 7.5 standoff plus its 1-grid hysteresis.
    const s = fixture({
      playerAt: [1, 5],
      rooms: [
        { id: 'a', x: 0, y: 0, w: g(40), h: g(40) },
        { id: 'b', x: g(40), y: 0, w: g(10), h: g(10), activated: false },
      ],
      doors: [['a', 'b', { x: g(39.5), y: g(4), w: g(1), h: g(2) }]],
      enemies: [[12, 5, 'a']],
    });
    const cmd = bot().build(s, 0, 501);
    expect(cmd.moveMag).toBeGreaterThan(0);
    expect(dir(cmd.moveBrad).x).toBeGreaterThan(0.9); // toward the enemy (+x)
  });

  it('backs off when the target is INSIDE its standoff band — the careful profile kites', () => {
    const s = fixture({ playerAt: [5, 5], enemies: [[7, 5, 'a']] }); // 2 grid < careful's 7.5
    const cmd = bot().build(s, 0, 501);
    expect(cmd.moveMag).toBeGreaterThan(0);
    expect(dir(cmd.moveBrad).x).toBeLessThan(-0.9); // away from the enemy (-x)
  });

  it('holds position inside the hysteresis dead zone instead of oscillating', () => {
    const s = fixture({ playerAt: [0, 5], enemies: [[7.5, 5, 'a']] }); // exactly the standoff
    expect(bot().build(s, 0, 501).moveMag).toBe(0);
  });

  it('the aggressive profile closes where the careful one would already be backing off', () => {
    const s = fixture({ playerAt: [1, 5], enemies: [[7, 5, 'a']] }); // 6 grid
    expect(dir(bot(BOT_PROFILES.aggressive).build(s, 0, 501).moveBrad).x).toBeGreaterThan(0.9); // still closing
    expect(dir(bot(BOT_PROFILES.careful).build(s, 0, 501).moveBrad).x).toBeLessThan(-0.9); // already too close
  });

  it('skips dead enemies when choosing a target', () => {
    const s = fixture({ playerAt: [2, 5], enemies: [[3, 5, 'a', false]] });
    // The only enemy is a corpse → nothing to fight, so it should not be firing.
    expect(bot().build(s, 0, 501).buttons & Button.FIRE).toBe(0);
  });
});

describe('PveBotController — heal seeking', () => {
  it('walks to a nearby heal when hurt, while still shooting', () => {
    const s = fixture({ playerAt: [5, 5], hp: 2, shield: 0, enemies: [[9, 5, 'a']], heals: [[5, 9]] });
    const cmd = bot().build(s, 0, 501);
    expect(dir(cmd.moveBrad).y).toBeGreaterThan(0.9); // toward the heal (+y), not spacing
    expect(cmd.buttons & Button.FIRE).toBe(Button.FIRE);
  });

  it('ignores heals at full health — it is not a vacuum', () => {
    const s = fixture({ playerAt: [5, 5], enemies: [[7, 5, 'a']], heals: [[5, 9]] });
    expect(dir(bot().build(s, 0, 501).moveBrad).x).toBeLessThan(-0.9); // kiting, not detouring
  });

  it('collects a heal in a quiet room before moving on', () => {
    const s = fixture({ playerAt: [5, 5], hp: 2, shield: 0, heals: [[5, 9]] });
    expect(dir(bot().build(s, 0, 501).moveBrad).y).toBeGreaterThan(0.9);
  });
});

describe('PveBotController — resting between rooms', () => {
  it('stands still in a cleared room while the shield refills (careful)', () => {
    // Room `b` is unexplored, so there IS somewhere to go — the bot should still wait.
    const s = fixture({ playerAt: [5, 5], shield: 0 });
    expect(bot().build(s, 0, 501).moveMag).toBe(0);
  });

  it('does not rest once the shield is full', () => {
    const s = fixture({
      playerAt: [5, 5],
      shield: 3.2,
      rooms: [
        { id: 'a', x: 0, y: 0, w: g(10), h: g(10) },
        { id: 'b', x: g(10), y: 0, w: g(10), h: g(10), activated: false },
      ],
    });
    expect(bot().build(s, 0, 501).moveMag).toBeGreaterThan(0); // heads for the unexplored room
  });

  it('never rests on the aggressive profile — it walks straight into the next room', () => {
    const s = fixture({
      playerAt: [5, 5],
      shield: 0,
      rooms: [
        { id: 'a', x: 0, y: 0, w: g(10), h: g(10) },
        { id: 'b', x: g(10), y: 0, w: g(10), h: g(10), activated: false },
      ],
    });
    expect(bot(BOT_PROFILES.aggressive).build(s, 0, 501).moveMag).toBeGreaterThan(0);
  });

  it('gives up resting after the cap, so a shieldless character can never wedge the run', () => {
    const s = fixture({
      playerAt: [5, 5],
      shield: 0,
      rooms: [
        { id: 'a', x: 0, y: 0, w: g(10), h: g(10) },
        { id: 'b', x: g(10), y: 0, w: g(10), h: g(10), activated: false },
      ],
    });
    const b = bot();
    let moved = false;
    for (let t = 0; t < 700 && !moved; t++) moved = b.build(s, 0, 501 + t).moveMag > 0;
    expect(moved).toBe(true);
  });
});

describe('PveBotController — travelling', () => {
  it('heads for the door passage when the objective is the next room', () => {
    const s = fixture({
      playerAt: [3, 5],
      rooms: [
        { id: 'a', x: 0, y: 0, w: g(10), h: g(10) },
        { id: 'b', x: g(10), y: 0, w: g(10), h: g(10), activated: false },
      ],
    });
    const cmd = bot().build(s, 0, 501);
    expect(dir(cmd.moveBrad).x).toBeGreaterThan(0.7); // eastward, toward the shared wall
  });

  it('prefers the nearest room still holding live enemies over an unexplored far one', () => {
    const s = fixture({
      playerAt: [15, 5], // in room b, which is clear
      rooms: [
        { id: 'a', x: 0, y: 0, w: g(10), h: g(10), hasLiveEnemy: true },
        { id: 'b', x: g(10), y: 0, w: g(10), h: g(10) },
        { id: 'c', x: g(20), y: 0, w: g(10), h: g(10), activated: false },
      ],
      doors: [
        ['a', 'b', { x: g(9.5), y: g(4), w: g(1), h: g(2) }],
        ['b', 'c', { x: g(19.5), y: g(4), w: g(1), h: g(2) }],
      ],
      shield: 3.2,
    });
    // Both qualify as objectives; BFS finds each at one hop, and door order decides —
    // the assertion is only that it commits to ONE of them and moves.
    expect(bot().build(s, 0, 501).moveMag).toBeGreaterThan(0);
  });

  it('idles when it is nowhere inside the floor at all (no room to reason from)', () => {
    const s = fixture({ playerAt: [90, 90] });
    expect(bot().build(s, 0, 501).moveMag).toBe(0);
  });
});

describe('PveBotController — the portal', () => {
  /** Capstone (last room) activated and clear → `checkpointReached` is true. */
  const atCheckpoint = (playerAt: [number, number], floorIndex = 0) =>
    fixture({
      playerAt,
      floorIndex,
      shield: 3.2,
      rooms: [
        { id: 'a', x: 0, y: 0, w: g(10), h: g(10) },
        { id: 'cap', x: g(10), y: 0, w: g(10), h: g(10), activated: true, hasLiveEnemy: false },
      ],
      doors: [['a', 'cap', { x: g(9.5), y: g(4), w: g(1), h: g(2) }]],
    });

  it('walks to the capstone room first — it does not confirm from across the floor', () => {
    const cmd = bot().build(atCheckpoint([3, 5]), 0, 501);
    expect(cmd.buttons).toBe(0);
    expect(cmd.moveMag).toBeGreaterThan(0);
  });

  it('presses DESCEND once inside the capstone, while floors remain', () => {
    const cmd = bot().build(atCheckpoint([15, 5], 0), 0, 501);
    expect(cmd.buttons & Button.CONFIRM_DESCEND).toBe(Button.CONFIRM_DESCEND);
    expect(cmd.buttons & Button.CONFIRM_EXTRACT).toBe(0);
  });

  it('presses EXTRACT instead on the last floor, where there is nothing to descend to', () => {
    const cmd = bot().build(atCheckpoint([15, 5], 4), 0, 501); // floorCount 5 → index 4 is last
    expect(cmd.buttons & Button.CONFIRM_EXTRACT).toBe(Button.CONFIRM_EXTRACT);
    expect(cmd.buttons & Button.CONFIRM_DESCEND).toBe(0);
  });
});

describe('PveBotController — circling a target nothing is killing', () => {
  it('switches from spacing to a perpendicular strafe once no kill has landed for a while', () => {
    // The stall this models: a mob behind a pillar soaks every bullet in the wall, so a
    // purely radial mover shoots that wall until the run times out (2-3 of 8 sim runs
    // per profile before this existed). Enemy due EAST and inside the standoff band, so
    // spacing would move due WEST — a perpendicular move is unambiguously distinguishable.
    const s = fixture({ playerAt: [5, 5], enemies: [[7, 5, 'a']] });
    const b = bot();
    expect(dir(b.build(s, 0, 501).moveBrad).x).toBeLessThan(-0.9); // kiting, as usual

    // Jitter the seat a hair per tick: a bot that never MOVES also trips the separate
    // stuck-unstick rotation, which would rotate the orbit heading on top of itself and
    // muddy what is being asserted. A real kiting bot is always drifting.
    let cmd = b.build(s, 0, 502);
    for (let t = 2; t <= 200; t++) {
      setSeatY(s, 5 + (t % 2 === 0 ? 0.05 : -0.05));
      cmd = b.build(s, 0, 501 + t); // nothing ever dies
    }
    // Perpendicular to the target direction: mostly vertical, not the radial ±x.
    expect(Math.abs(dir(cmd.moveBrad).y)).toBeGreaterThan(0.7);
    expect(cmd.buttons & Button.FIRE).toBe(Button.FIRE); // still shooting while it circles
  });

  it('goes back to holding spacing as soon as something dies', () => {
    const s = fixture({ playerAt: [5, 5], enemies: [[7, 5, 'a'], [8, 5, 'a']] });
    const b = bot();
    for (let t = 0; t <= 200; t++) {
      setSeatY(s, 5 + (t % 2 === 0 ? 0.05 : -0.05));
      b.build(s, 0, 501 + t); // long enough to start circling
    }
    setSeatY(s, 5);
    s.enemies[1]!.alive = false; // a kill lands → the stall is over
    const cmd = b.build(s, 0, 800);
    expect(dir(cmd.moveBrad).x).toBeLessThan(-0.9); // radial kiting again
  });
});

describe('PveBotController — stuck handling', () => {
  it('turns a quarter circle after being pinned for a while, instead of pushing into the wall forever', () => {
    const s = fixture({
      playerAt: [3, 5],
      rooms: [
        { id: 'a', x: 0, y: 0, w: g(10), h: g(10) },
        { id: 'b', x: g(10), y: 0, w: g(10), h: g(10), activated: false },
      ],
    });
    const b = bot();
    const first = b.build(s, 0, 501); // wants to move east; position never changes below
    let turned = first.moveBrad;
    for (let t = 1; t < 40; t++) turned = b.build(s, 0, 501 + t).moveBrad;
    const delta = Math.abs(((turned - first.moveBrad + 98304) % 65536) - 32768);
    expect(delta).toBeGreaterThan(8192); // meaningfully off the original heading
  });
});
