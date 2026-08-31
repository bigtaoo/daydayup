/**
 * Read one recorded run and report what happened to every drop in it. Run it with:
 *
 *     DD_REPLAY=path/to/ddreplay-dungeon-123.json npm run replay:inspect
 *
 * (repo root, or `-w client`). This is the offline half of the recorder shipped
 * 2026-08-31: a player hits F9 the moment a drop refuses to be collected, hands over the
 * file, and this turns it into the exact geometry at that tick — no re-reproduction, no
 * "which seed was it", no sweep over content that was already swept clean (ROADMAP v50).
 *
 * The other half is `?replay=<url>&pickupDebug=1` in the client, which puts the same
 * moment in front of the real renderer. Use both: this one says whether the SIM refused,
 * that one says what the frame was showing while it did.
 *
 * Kept out of the default `npm test` glob because it needs a file that only exists when
 * somebody has recorded one. The analysis itself IS in the default suite
 * (`sim/replay/inspect.test.ts`), including the control that proves its suspect
 * detector fires.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { ENGINE_VERSION, parseReplayFileText } from '@dd/engine';
import { formatInspectReport, inspectReplay } from './replay/inspect';

const path = process.env.DD_REPLAY ?? '';

describe('replay inspect', () => {
  it('reports every drop in the recorded run', () => {
    // Fail loud on a missing path rather than passing vacuously: a harness that reports
    // "no suspects" because it never opened a file is worse than one that does not run.
    expect(path, 'set DD_REPLAY=<path to a ddreplay-*.json>').not.toBe('');

    const file = parseReplayFileText(readFileSync(path, 'utf8'));
    if (file.engineVersion !== ENGINE_VERSION) {
      // ReplayInputSource would throw on this anyway; say WHY first, since a stale file
      // is the normal way this fails once the engine has moved on.
      throw new Error(
        `Replay was recorded on ENGINE_VERSION ${file.engineVersion}, this engine is ${ENGINE_VERSION}. ` +
          `Sim math has changed since — check out the matching commit to replay it.`,
      );
    }

    const report = inspectReplay(file);
    console.log(`\n${formatInspectReport(report)}\n`);

    // The one thing worth asserting: the file actually replayed. Everything else is a
    // report, and a report that fails a threshold nobody agreed on is just noise.
    expect(report.ticks).toBeGreaterThan(0);
  });
});
