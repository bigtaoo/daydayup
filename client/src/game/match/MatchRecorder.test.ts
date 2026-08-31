import { describe, it, expect } from 'vitest';
import {
  Button,
  createGameEngine,
  hashState,
  makeCommand,
  parseReplayFileText,
  quantizeMove,
  runReplay,
  type EngineConfig,
  type ReplayFile,
} from '@dd/engine';
import { MatchRecorder } from './MatchRecorder';
import { saveMarkedReplay } from './replayDownload';
import { buildDungeonRunConfig } from './offlineConfig';

const DUNGEON = buildDungeonRunConfig({
  seed: 0xda1d,
  coop: false,
  localSeat: { skinId: 'vanguard', loadout: [] },
  allySkinId: 'skirmisher',
});

/**
 * Drive an engine the way GameLoop does — `engine.submit(...)` then `engine.advance(f)`
 * — so what these tests exercise is the real submit path, not a hand-fed source.
 */
function play(config: EngineConfig, recorder: MatchRecorder, ticks: number) {
  const engine = createGameEngine(config, recorder.begin('dungeon', config));
  for (let f = 1; f <= ticks; f++) {
    const { moveBrad, moveMag } = quantizeMove(Math.sin(f * 0.11), Math.cos(f * 0.07));
    engine.submit(makeCommand({ owner: 0, tick: f, moveBrad, moveMag, buttons: f % 5 ? Button.FIRE : 0 }));
    engine.advance(f);
  }
  return engine;
}

describe('MatchRecorder (an offline run records itself, for free)', () => {
  it('packs a file that replays the live run exactly', () => {
    const recorder = new MatchRecorder();
    const live = play(DUNGEON, recorder, 400);

    const file = recorder.pack(live.state.tick, 1_700_000_000_000)!;
    expect(file).not.toBeNull();

    // Through text, like the download: a client-side regression (a config the recorder
    // holds by reference and the run then mutates, say) shows up as a hash mismatch.
    const replayed = runReplay(parseReplayFileText(JSON.stringify(file)).replay, 400);
    expect(hashState(replayed.state)).toBe(hashState(live.state));
    expect(live.state.tick).toBe(400);
  });

  it('records the commands the engine was actually driven with', () => {
    const recorder = new MatchRecorder();
    play(DUNGEON, recorder, 120);
    const file = recorder.pack(120, 0)!;
    expect(file.replay.commands).toHaveLength(120);
    expect(file.label).toBe('dungeon');
    expect(file.ticks).toBe(120);
  });

  it('has nothing to pack before a run, or after one is dropped', () => {
    const recorder = new MatchRecorder();
    expect(recorder.recording).toBe(false);
    expect(recorder.pack(10, 0)).toBeNull();
    expect(recorder.mark(10, 'x')).toBe(false);

    play(DUNGEON, recorder, 10);
    expect(recorder.recording).toBe(true);

    recorder.end();
    expect(recorder.recording).toBe(false);
    expect(recorder.pack(10, 0)).toBeNull();
  });

  it('a fresh run drops the previous one entirely', () => {
    const recorder = new MatchRecorder();
    play(DUNGEON, recorder, 200);
    recorder.mark(50, 'first run');
    play(DUNGEON, recorder, 30);

    const file = recorder.pack(30, 0)!;
    expect(file.replay.commands).toHaveLength(30);
    expect(file.marks).toEqual([]); // the first run's mark did not survive
  });

  it('accumulates marks in the order they were made', () => {
    const recorder = new MatchRecorder();
    play(DUNGEON, recorder, 100);
    expect(recorder.mark(30, 'a')).toBe(true);
    expect(recorder.mark(90, 'b')).toBe(true);
    expect(recorder.pack(100, 0)!.marks).toEqual([
      { tick: 30, note: 'a' },
      { tick: 90, note: 'b' },
    ]);
  });
});

describe('saveMarkedReplay (the F9 flow, without a host)', () => {
  it('marks the tick, saves the file, and names it in the message', () => {
    const recorder = new MatchRecorder();
    play(DUNGEON, recorder, 250);

    let saved: ReplayFile | null = null;
    const msg = saveMarkedReplay(recorder, 250, 1_700_000_000_000, (f) => {
      saved = f;
      return 'ddreplay-dungeon-1700000000000.json';
    });

    expect(msg).toContain('ddreplay-dungeon-1700000000000.json');
    expect(msg).toContain('tick 250');
    // The mark is what tells the harness where to look — the whole point of the key.
    expect(saved!.marks).toEqual([{ tick: 250, note: 'hotkey at tick 250' }]);
    expect(saved!.ticks).toBe(250);
  });

  it('says so when there is no offline run, instead of doing nothing', () => {
    const recorder = new MatchRecorder();
    let called = false;
    const msg = saveMarkedReplay(recorder, 10, 0, () => {
      called = true;
      return 'x';
    });
    expect(msg).toBe('No offline run to save');
    expect(called).toBe(false);
  });

  it('says so when the host cannot download (WeChat: no Blob, no anchor)', () => {
    const recorder = new MatchRecorder();
    play(DUNGEON, recorder, 20);
    expect(saveMarkedReplay(recorder, 20, 0, () => null)).toBe('Cannot save a replay on this platform');
  });
});
