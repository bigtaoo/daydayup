/**
 * The replay analysis (`inspect.ts`) — in the DEFAULT suite even though the harness that
 * uses it (`sim/replayInspect.sim.ts`) is not, because the harness will be pointed at a
 * real bug report exactly once and has to be right the first time. The important test
 * here is the control: a detector that has never been shown to FIRE, on a case where the
 * answer is known, is not evidence (design/18, and this repo's recurring
 * "the gate could not see the constant it was built for" failure).
 */
import { describe, it, expect } from 'vitest';
import {
  Button,
  LocalInputSource,
  createGameEngine,
  hashState,
  makeCommand,
  packReplayFile,
  pxToFp,
  quantizeMove,
  runHeadless,
  type Fp,
  type GameState,
  type PickupItem,
} from '@dd/engine';
import { buildDungeonRunConfig } from '../../src/game/match/offlineConfig';
import {
  APPARENT_CONTACT_PX,
  inspectReplay,
  observePickups,
  selectSuspects,
  type PickupTrace,
} from './inspect';

// Just enough state for `pickupDebugGate` + `observePickups`: the player's ground point
// and radius, and the drops. `radius` 16 px is PLAYER_BASE's own solidRadius, so the
// auto-collect gate here is the real ~31 px.
function stateAt(playerPx: [number, number], pickups: Partial<PickupItem>[], tick = 1): GameState {
  return {
    tick,
    players: [{ id: 1, alive: true, gx: pxToFp(playerPx[0]), gy: pxToFp(playerPx[1]), radius: pxToFp(16) }],
    pickups: pickups.map((p, i) => ({ id: i + 1, alive: true, kind: 'heal', gx: 0 as Fp, gy: 0 as Fp, ...p })),
  } as unknown as GameState;
}

const trace = (states: GameState[]): PickupTrace[] => {
  const traces = new Map<number, PickupTrace>();
  // One shared map across the sequence, exactly as inspectReplay does — that is what
  // makes each observation see the segment the player just walked.
  const prev = new Map<number, [number, number]>();
  for (const s of states) observePickups(s, traces, prev);
  return [...traces.values()];
};

describe('the suspect rule fires on the case it exists for, and only on it', () => {
  it('a heal 50px away is a SUSPECT: inside apparent contact, outside its own gate', () => {
    // 50 px is the shape of the whole report — visibly at the character's feet, and
    // 19 px outside the 31 px the sim actually requires.
    expect(APPARENT_CONTACT_PX).toBeGreaterThan(50);
    const t = trace([stateAt([100, 100], [{ kind: 'heal', gx: pxToFp(150), gy: pxToFp(100) }])]);
    expect(t[0]!.closestPx).toBeCloseTo(50, 1);
    expect(t[0]!.everCollectible).toBe(false);
    expect(selectSuspects(t)).toHaveLength(1);
  });

  it('a heal 20px away is not: the sim would have collected it', () => {
    const t = trace([stateAt([100, 100], [{ kind: 'heal', gx: pxToFp(120), gy: pxToFp(100) }])]);
    expect(t[0]!.everCollectible).toBe(true);
    expect(selectSuspects(t)).toHaveLength(0);
  });

  it('a WEAPON 50px away is not, and that asymmetry is the thing to look at', () => {
    // Same distance, different verdict: a weapon is claimable from the panel's 80 px
    // ring while a heal at the identical apparent distance is refused. Two drops that
    // look equally underfoot behave differently — which is a legibility defect whether
    // or not it turns out to be THE report.
    const t = trace([stateAt([100, 100], [{ kind: 'weapon', gx: pxToFp(150), gy: pxToFp(100) }])]);
    expect(t[0]!.everCollectible).toBe(true);
    expect(selectSuspects(t)).toHaveLength(0);
  });

  it('a drop the player never approached is not a suspect either — it was never claimed to be underfoot', () => {
    const t = trace([stateAt([100, 100], [{ kind: 'heal', gx: pxToFp(900), gy: pxToFp(900) }])]);
    expect(t[0]!.everCollectible).toBe(false);
    expect(selectSuspects(t)).toHaveLength(0);
  });

  it('remembers the CLOSEST approach and its tick, not the last one', () => {
    const t = trace([
      stateAt([300, 100], [{ gx: pxToFp(100), gy: pxToFp(100) }], 1),
      stateAt([150, 100], [{ gx: pxToFp(100), gy: pxToFp(100) }], 2),
      stateAt([500, 100], [{ gx: pxToFp(100), gy: pxToFp(100) }], 3),
    ]);
    expect(t[0]!.closestPx).toBeCloseTo(50, 1);
    expect(t[0]!.closestTick).toBe(2);
    expect(t[0]!.firstTick).toBe(1);
    expect(t[0]!.lastTick).toBe(3);
  });

  it('one collectible tick clears a drop for good, however far it was the rest of the time', () => {
    const t = trace([
      stateAt([900, 900], [{ gx: pxToFp(100), gy: pxToFp(100) }], 1),
      stateAt([110, 100], [{ gx: pxToFp(100), gy: pxToFp(100) }], 2), // within 31 px
      stateAt([900, 900], [{ gx: pxToFp(100), gy: pxToFp(100) }], 3),
    ]);
    expect(t[0]!.everCollectible).toBe(true);
    expect(selectSuspects(t)).toHaveLength(0);
  });

  it('ignores crates and dead drops — neither has a collect gate of its own', () => {
    const t = trace([
      stateAt([100, 100], [
        { kind: 'crate', gx: pxToFp(140), gy: pxToFp(100) },
        { kind: 'heal', gx: pxToFp(140), gy: pxToFp(100), alive: false },
      ]),
    ]);
    expect(t).toHaveLength(0);
  });
});

describe('the swept path answers "I walked right over it"', () => {
  it('records the segment minimum, not just the per-tick samples', () => {
    // Two ticks, the drop off to one side of the line walked between them: both sampled
    // distances are 50 px, the path passed at 40.
    const t = trace([
      stateAt([100, 60], [{ gx: pxToFp(130), gy: pxToFp(100) }], 1),
      stateAt([160, 60], [{ gx: pxToFp(130), gy: pxToFp(100) }], 2),
    ]);
    expect(t[0]!.closestPx).toBeCloseTo(50, 1);
    expect(t[0]!.sweptClosestPx).toBeCloseTo(40, 1);
  });

  it('flags the case where the PATH crossed the gate but no sample did', () => {
    // Sampled 42.4 px from both ends, gate 31 px, and the path passed at 30 px. Nothing
    // the sim can see — PickupSystem only runs at tick boundaries — so a player who
    // walked straight over the drop is told nothing happened.
    const t = trace([
      stateAt([100, 60], [{ gx: pxToFp(130), gy: pxToFp(90) }], 1),
      stateAt([160, 60], [{ gx: pxToFp(130), gy: pxToFp(90) }], 2),
    ]);
    expect(t[0]!.everCollectible).toBe(false);
    expect(t[0]!.closestPx).toBeCloseTo(42.4, 1);
    expect(t[0]!.gatePx).toBeCloseTo(31, 1);
    expect(t[0]!.sweptClosestPx).toBeCloseTo(30, 1);
    expect(t[0]!.sweptClosestPx).toBeLessThan(t[0]!.gatePx); // the flagged condition
  });

  it("degenerates to the sampled distance on a drop's first tick", () => {
    const t = trace([stateAt([100, 100], [{ gx: pxToFp(150), gy: pxToFp(100) }], 1)]);
    expect(t[0]!.sweptClosestPx).toBeCloseTo(t[0]!.closestPx, 5);
  });

  it('records the gate the drop was actually judged against, per kind', () => {
    const t = trace([
      stateAt([100, 100], [
        { kind: 'heal', gx: pxToFp(400), gy: pxToFp(100) },
        { kind: 'weapon', gx: pxToFp(400), gy: pxToFp(140) },
      ]),
    ]);
    expect(t[0]!.gatePx).toBeCloseTo(31, 1);
    expect(t[1]!.gatePx).toBeCloseTo(80, 1);
  });
});

describe('inspectReplay end to end, on a real recorded dungeon run', () => {
  const CONFIG = buildDungeonRunConfig({
    seed: 0xda1d,
    coop: false,
    localSeat: { skinId: 'vanguard', loadout: [] },
    allySkinId: 'skirmisher',
  });
  const TICKS = 900;

  function recorded() {
    const live = new LocalInputSource();
    for (let t = 1; t <= TICKS; t++) {
      const { moveBrad, moveMag } = quantizeMove(Math.sin(t * 0.03), Math.cos(t * 0.021));
      live.submit(makeCommand({ owner: 0, tick: t, moveBrad, moveMag, buttons: Button.FIRE }));
    }
    const engine = runHeadless(CONFIG, live, TICKS);
    const file = packReplayFile({
      config: CONFIG,
      commands: live.recorded(),
      ticks: TICKS,
      label: 'dungeon',
      marks: [{ tick: 600, note: 'hotkey at tick 600' }],
      recordedAtMs: 0,
    });
    return { engine, file };
  }

  it('replays to the same state the live run reached, and reports the marked tick', () => {
    const { engine, file } = recorded();
    const report = inspectReplay(file);

    expect(report.ticks).toBe(TICKS);
    expect(report.finalHash).toBe(hashState(engine.state));
    expect(report.marks).toHaveLength(1);
    expect(report.marks[0]!.tick).toBe(600);
    // The readout is only useful if it actually saw the player.
    expect(report.marks[0]!.players).toHaveLength(1);
  });

  it("a collected drop is attributed from the engine's own pickup event, not guessed", () => {
    // The reason this matters: PickupSystem collects DURING the tick, so the drop is
    // already gone from the post-step state — the one tick it was collectible is the one
    // tick nothing can observe it being collectible. Before the event attribution landed,
    // this harness called four collected drops "never collectible".
    const { file } = recorded();
    const report = inspectReplay(file);
    const collected = report.traces.filter((t) => t.collectedTick !== null);
    expect(collected.length).toBeGreaterThan(0);
    for (const t of collected) expect(report.suspects).not.toContain(t);
  });

  it('every drop that left the run is explained by a pickup event', () => {
    // `vanished` is the anomaly channel: a drop gone with no event behind it would be a
    // different bug entirely, and this asserts the shipped content produces none.
    const { file } = recorded();
    expect(inspectReplay(file).vanished).toEqual([]);
  });

  it('the run it inspects is a real one: enemies died and dropped things', () => {
    // Without this the suspect list being empty would be meaningless — an inspection of
    // a run with no drops in it reports "no suspects" for the wrong reason.
    const { file } = recorded();
    const report = inspectReplay(file);
    expect(report.traces.length).toBeGreaterThan(0);
  });

  it('a stream shorter than the declared tick count ends the run instead of idling on', () => {
    const { file } = recorded();
    const short = packReplayFile({
      config: CONFIG,
      commands: file.replay.commands.slice(0, 100),
      ticks: 100,
      label: 'dungeon',
      recordedAtMs: 0,
    });
    expect(inspectReplay(short).ticks).toBe(100);
  });

  it('does not consult a live input source — playback is read-only by construction', () => {
    // inspectReplay builds its own ReplayInputSource; a regression that submitted a
    // command would throw here rather than silently diverging from the recording.
    const { file } = recorded();
    expect(() => inspectReplay(file)).not.toThrow();
    const a = inspectReplay(file);
    const b = inspectReplay(file);
    expect(b.finalHash).toBe(a.finalHash); // and it is repeatable, which is the point
  });
});

describe('createGameEngine sanity for the fixture above', () => {
  it('the config used by these tests is the one the client actually ships offline', () => {
    // Guards against the fixture drifting into something synthetic: if beginRun's config
    // changes shape, this test's evidence changes with it rather than silently aging.
    const engine = createGameEngine(
      buildDungeonRunConfig({
        seed: 1,
        coop: false,
        localSeat: { skinId: 'vanguard', loadout: [] },
        allySkinId: 'skirmisher',
      }),
    );
    // The first floor loads on sim tick 1 (SpawnSystem.loadRoom), not at construction.
    engine.step([]);
    expect(engine.state.dungeonRooms.length).toBeGreaterThan(0);
  });
});
