/**
 * FrameBroadcast — the server-side frame-relay core (design/06, ROADMAP 3.1). Verifies
 * the metronome/ordering/watermark/log contract in isolation, then the capstone
 * loopback: server relay → NetInputSource → engine reproduces a plain ReplayInputSource
 * run BYTE-FOR-BYTE. That closes design/06's loop — the same deterministic engine
 * consumed identically by the recorded path and the full online path.
 */
import { describe, it, expect } from 'vitest';
import { FrameBroadcast } from '@dd/engine/net/FrameBroadcast';
import { NetInputSource, type CmdSink } from '@dd/engine/net/NetInputSource';
import type { FrameBatch } from '@dd/engine/net/protocol';
import { makeCommand } from '@dd/engine/state/input';
import { Button, type PlayerCommand } from '@dd/engine/state/commands';
import type { Brad } from '@dd/engine/math/trig';
import { toReplay, runReplay, runHeadless, hashState } from '@dd/engine/replay';
import type { EngineConfig } from '@dd/engine/state/GameState';

const cmd = (owner: number, tick: number, buttons = 0) =>
  makeCommand({ owner, tick, moveBrad: 0 as Brad, moveMag: 0, buttons });
const nullSink: CmdSink = { submit: () => {} };

describe('FrameBroadcast — metronome / ordering / watermark / log', () => {
  it('advances the watermark by framesPerBatch every pulse, even with no input', () => {
    const b = new FrameBroadcast({ framesPerBatch: 3 });
    expect(b.tick()).toEqual({ toFrame: 3, frames: [] }); // pure pulse, no waiting
    expect(b.tick()).toEqual({ toFrame: 6, frames: [] });
    expect(b.frame).toBe(6);
  });

  it('flushes buffered commands onto the window toFrame, ordered by owner (arrival-stable)', () => {
    const b = new FrameBroadcast({ framesPerBatch: 3 });
    // Submitted out of owner order; owner 1's two commands must keep arrival order.
    const a1 = cmd(1, 0, Button.FIRE);
    const a0 = cmd(0, 0);
    const a1b = cmd(1, 0, Button.INTERACT);
    b.submit(a1); b.submit(a0); b.submit(a1b);
    const batch = b.tick();
    expect(batch.toFrame).toBe(3);
    expect(batch.frames).toHaveLength(1);
    expect(batch.frames[0]!.frame).toBe(3);
    // owner 0 first, then owner 1's two in arrival order (a1 before a1b).
    expect(batch.frames[0]!.cmds).toEqual([a0, a1, a1b]);
    // Buffer cleared: the next pulse is an empty metronome pulse.
    expect(b.tick()).toEqual({ toFrame: 6, frames: [] });
  });

  it('logSince returns only the non-empty frames after a given watermark (reconnect payload)', () => {
    const b = new FrameBroadcast({ framesPerBatch: 3 });
    b.tick(); // frame 3, empty
    b.submit(cmd(0, 0, Button.FIRE));
    b.tick(); // frame 6, has a command
    b.submit(cmd(1, 0));
    b.tick(); // frame 9, has a command
    expect(b.logSince(0).map((f) => f.frame)).toEqual([6, 9]);
    expect(b.logSince(6).map((f) => f.frame)).toEqual([9]); // only frames strictly after 6
    expect(b.log).toHaveLength(2); // empty frame-3 pulse was never logged
  });
});

describe('loopback: FrameBroadcast → NetInputSource → engine == plain replay (design/06)', () => {
  it('a match relayed through the server core reproduces the recorded replay byte-for-byte', () => {
    const N = 180;
    const framesPerBatch = 3;
    const config: EngineConfig = {
      seed: 4242, worldW: 800, worldH: 800, playerStart: [400, 400],
      waves: [[[500, 400], [300, 400]], [[400, 300]]],
    };

    // The player's intent, one command per SIM frame (the render loop's rate).
    const perFrame: PlayerCommand[] = [];
    for (let f = 1; f <= N; f++) {
      perFrame.push(makeCommand({
        owner: 0, tick: f,
        moveBrad: ((f * 337) & 0xffff) as Brad, moveMag: (f * 7) % 256,
        buttons: Button.FIRE,
      }));
    }

    // ── Server side: feed each frame's command into the broadcaster, pulse the
    //    metronome every `framesPerBatch` frames, and collect the batches. Commands
    //    submitted during a window land on that window's toFrame — so the effective
    //    (confirmed) command stream is the SAME commands re-tagged to the window frame. ──
    const server = new FrameBroadcast({ framesPerBatch });
    const batches: FrameBatch[] = [];
    for (let f = 1; f <= N; f++) {
      server.submit(perFrame[f - 1]!);
      if (f % framesPerBatch === 0) batches.push(server.tick());
    }

    // The reference replay must use the commands AS THE SERVER CONFIRMED THEM (re-tagged
    // to their window frame), since that is what every client actually simulates.
    const confirmed: PlayerCommand[] = server.log.flatMap((fc) =>
      fc.cmds.map((c) => ({ ...c, tick: fc.frame })),
    );
    const replayEngine = runReplay(toReplay(config, confirmed), server.frame);

    // ── Client side: replay the collected batches into a NetInputSource and drive the
    //    engine off it exactly as the live client would. ──
    const net = new NetInputSource(nullSink, { bufferFrames: 0 });
    net.handleServerMsg({ type: 'match_start', seed: config.seed, startFrame: 0, localOwner: 0, playerCount: 1 });
    for (const batch of batches) net.handleServerMsg({ type: 'frame_batch', ...batch });
    const netEngine = runHeadless(config, net, server.frame);

    expect(netEngine.state.tick).toBe(replayEngine.state.tick);
    expect(hashState(netEngine.state)).toBe(hashState(replayEngine.state));
  });
});
