/**
 * NetInputSource — the confirmed frame-stream half of the netcode (design/06, ROADMAP
 * 3.1). Verifies the watermark / jitter-cushion / stall contract in isolation, then
 * the payoff: driving the engine through a NetInputSource fed server batches produces a
 * BYTE-IDENTICAL end state to a ReplayInputSource on the same commands — the design/06
 * "single logic path, byte-identical regardless of source" guarantee.
 */
import { describe, it, expect } from 'vitest';
import { NetInputSource, type CmdSink } from '@dd/engine/net/NetInputSource';
import type { ClientMsg, FrameCmds, ServerMsg } from '@dd/engine/net/protocol';
import { makeCommand } from '@dd/engine/state/input';
import { Button, type PlayerCommand } from '@dd/engine/state/commands';
import type { Brad } from '@dd/engine/math/trig';
import { toReplay, runReplay, runHeadless, hashState } from '@dd/engine/replay';
import type { EngineConfig } from '@dd/engine/state/GameState';

function collectingSink(): CmdSink & { sent: PlayerCommand[] } {
  const sent: PlayerCommand[] = [];
  return { sent, submit: (cmd) => sent.push(cmd) };
}

const START: ServerMsg = { type: 'match_start', seed: 1, startFrame: 0, localOwner: 0, playerCount: 2 };
const cmd = (owner: number, frame: number, buttons = 0) =>
  makeCommand({ owner, tick: frame, moveBrad: 0 as Brad, moveMag: 0, aimBrad: 0 as Brad, buttons });

describe('NetInputSource — stall / watermark / cushion contract', () => {
  it('stalls (null) until match_start, then the start frame is immediately playable', () => {
    const net = new NetInputSource(collectingSink(), { bufferFrames: 0 });
    expect(net.take(0)).toBeNull(); // no match yet
    net.handleServerMsg(START);
    expect(net.take(0)).toEqual([]); // startFrame is playable (empty command set)
    expect(net.take(1)).toBeNull(); // nothing confirmed beyond the start yet
  });

  it('releases a frame only once the watermark (minus the cushion) reaches it', () => {
    const net = new NetInputSource(collectingSink(), { bufferFrames: 2 });
    net.handleServerMsg(START);
    net.handleServerMsg({ type: 'frame_batch', toFrame: 5, frames: [] });
    // playHead = confirmedTo(5) - buffer(2) = 3 → frames ≤3 release, 4+ still stall.
    expect(net.take(3)).toEqual([]);
    expect(net.take(4)).toBeNull();
    expect(net.confirmedLead(1)).toBe(2); // frames 2 and 3 sit ahead of frame 1
    // A later batch lifts the watermark and unblocks more frames.
    net.handleServerMsg({ type: 'frame_batch', toFrame: 8, frames: [] });
    expect(net.take(6)).toEqual([]); // playHead now 6
    expect(net.take(7)).toBeNull();
  });

  it('returns a confirmed frame\'s commands, and EMPTY for a confirmed idle frame', () => {
    const net = new NetInputSource(collectingSink(), { bufferFrames: 0 });
    net.handleServerMsg(START);
    const c0 = cmd(0, 2, Button.FIRE);
    const c1 = cmd(1, 2);
    net.handleServerMsg({ type: 'frame_batch', toFrame: 3, frames: [{ frame: 2, cmds: [c0, c1] }] });
    expect(net.take(1)).toEqual([]); // confirmed but no commands → idle-hold
    expect(net.take(2)).toEqual([c0, c1]); // the frame with commands
    expect(net.take(3)).toEqual([]); // confirmed idle
  });

  it('the watermark never retracts (a stale/re-ordered batch cannot un-confirm)', () => {
    const net = new NetInputSource(collectingSink(), { bufferFrames: 0 });
    net.handleServerMsg(START);
    net.handleServerMsg({ type: 'frame_batch', toFrame: 10, frames: [] });
    net.handleServerMsg({ type: 'frame_batch', toFrame: 4, frames: [] }); // arrives late/out of order
    expect(net.take(10)).toEqual([]); // still confirmed
  });

  it('submit() relays the local command to the sink verbatim', () => {
    const sink = collectingSink();
    const net = new NetInputSource(sink);
    const c = cmd(0, 1, Button.FIRE);
    net.submit(c);
    expect(sink.sent).toEqual([c]);
  });

  it('conn_resync merges the replayed log and jumps the watermark (reconnect)', () => {
    const net = new NetInputSource(collectingSink(), { bufferFrames: 0 });
    net.handleServerMsg(START);
    const c = cmd(1, 7, Button.INTERACT);
    net.handleServerMsg({ type: 'conn_resync', startFrame: 0, curFrame: 9, log: [{ frame: 7, cmds: [c] }] });
    expect(net.take(7)).toEqual([c]);
    expect(net.take(9)).toEqual([]);
    expect(net.resumeFrame()).toBe(9);
  });
});

describe('NetInputSource drives the engine identically to a replay (design/06 one path)', () => {
  it('same seed + same commands via NetInputSource → byte-equal end state to a ReplayInputSource', () => {
    const N = 180;
    const config: EngineConfig = {
      seed: 4242, worldW: 800, worldH: 800, playerStart: [400, 400],
      waves: [[[500, 400], [300, 400]], [[400, 300]]],
    };
    // A deterministic, varied single-seat command stream (owner 0), one command per frame.
    const commands: PlayerCommand[] = [];
    for (let f = 1; f <= N; f++) {
      commands.push(makeCommand({
        owner: 0, tick: f,
        moveBrad: ((f * 337) & 0xffff) as Brad, moveMag: (f * 7) % 256,
        aimBrad: ((f * 911) & 0xffff) as Brad, buttons: Button.FIRE,
      }));
    }

    // Reference: the recorded-replay path.
    const replayEngine = runReplay(toReplay(config, commands), N);

    // Net path: hand every command to the server as ONE fully-confirmed batch, then let
    // runHeadless pull them frame-by-frame through the NetInputSource.
    const net = new NetInputSource(collectingSink(), { bufferFrames: 0 });
    net.handleServerMsg({ type: 'match_start', seed: config.seed, startFrame: 0, localOwner: 0, playerCount: 1 });
    const frames: FrameCmds[] = commands.map((c) => ({ frame: c.tick, cmds: [c] }));
    net.handleServerMsg({ type: 'frame_batch', toFrame: N, frames });
    const netEngine = runHeadless(config, net, N);

    expect(netEngine.state.tick).toBe(replayEngine.state.tick);
    expect(hashState(netEngine.state)).toBe(hashState(replayEngine.state));
  });

  it('an unconfirmed frame stalls runHeadless exactly at the watermark', () => {
    const config: EngineConfig = { seed: 7, worldW: 800, worldH: 800, playerStart: [400, 400], waves: [[[500, 400]]] };
    const net = new NetInputSource(collectingSink(), { bufferFrames: 0 });
    net.handleServerMsg({ type: 'match_start', seed: config.seed, startFrame: 0, localOwner: 0, playerCount: 1 });
    net.handleServerMsg({ type: 'frame_batch', toFrame: 20, frames: [] }); // only 20 frames confirmed
    const engine = runHeadless(config, net, 100); // asked for 100, but the source stalls at 20
    expect(engine.state.tick).toBe(20);
    expect(engine.state.phase).not.toBe('gameover'); // stopped by the stall, not an outcome
  });
});

// Keeps the ClientMsg protocol type exercised (compile-time shape check for the server side).
const _joinExample: ClientMsg = { type: 'join', roomId: 'r1', owner: 0, seed: 1, playerCount: 2 };
void _joinExample;
