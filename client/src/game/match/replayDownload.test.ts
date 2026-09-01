/**
 * `downloadReplayFile` — the one part of the replay feature that touches the HOST, and
 * until now the one part with no test of its own.
 *
 * `MatchRecorder.test.ts` covers `saveMarkedReplay` with an injected `download`, and
 * `gameReplaySave.test.ts` drives the real function through a fake browser to capture the
 * bytes — but neither one asserts anything about the two host-shaped decisions this file
 * actually makes: WHEN the object URL is released, and what happens when the host says no.
 * Both are invisible in a passing save (the bytes are identical either way), which is
 * exactly the shape of defect that ships.
 *
 * The client suite runs on vitest's `node` environment, where `Blob` and
 * `URL.createObjectURL` both genuinely exist and `document` does not — so every capability
 * case here has to be staged explicitly rather than assumed from the environment.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { packReplayFile, type EngineConfig } from '@dd/engine';
import { downloadReplayFile } from './replayDownload';

const FILE = packReplayFile({
  config: { seed: 7, worldW: 800, worldH: 800, waves: [] } as unknown as EngineConfig,
  commands: [],
  ticks: 0,
  label: 'dungeon',
  recordedAtMs: 1_700_000_000_000,
});
const EXPECTED_NAME = 'ddreplay-dungeon-1700000000000.json';

interface FakeAnchor {
  href: string;
  download: string;
  clicks: number;
}

interface Host {
  /** Every tag `createElement` was asked for, in order. */
  created: string[];
  anchors: FakeAnchor[];
  /** Every object URL handed out, in order. */
  objectUrls: string[];
  /** Every revoke, in order — duplicates deliberately KEPT, so "exactly once" is provable. */
  revoked: string[];
  /** Anything mounted into the page. The function documents a DETACHED anchor. */
  appended: unknown[];
  restore(): void;
}

/**
 * Stage a host with exactly the capabilities under test. Each `no*` option removes ONE of
 * the three things the function feature-detects, so a deleted guard shows up as a
 * different failure per case rather than as one test covering all three.
 *
 * Removal is by assigning `undefined` rather than `delete`: `typeof x` on a global bound
 * to undefined already answers `'undefined'`, which is what the guards read, and the
 * original value stays restorable.
 */
function installHost(
  opts: {
    noDocument?: boolean;
    noBlob?: boolean;
    noCreateObjectURL?: boolean;
    createElementThrows?: boolean;
  } = {},
): Host {
  const g = globalThis as Record<string, unknown>;
  const before = { document: g.document, Blob: g.Blob, URL: g.URL };
  const host: Host = {
    created: [], anchors: [], objectUrls: [], revoked: [], appended: [],
    restore: () => { g.document = before.document; g.Blob = before.Blob; g.URL = before.URL; },
  };

  class FakeBlob {
    constructor(readonly parts: string[]) {}
  }
  g.Blob = opts.noBlob ? undefined : FakeBlob;

  let n = 0;
  g.URL = {
    createObjectURL: opts.noCreateObjectURL
      ? undefined
      : () => { const u = `blob:fake/${n++}`; host.objectUrls.push(u); return u; },
    revokeObjectURL: (u: string) => { host.revoked.push(u); },
  };

  g.document = opts.noDocument
    ? undefined
    : {
        createElement: (tag: string) => {
          host.created.push(tag);
          if (opts.createElementThrows) throw new Error('createElement is blocked here');
          const anchor: FakeAnchor & { click(): void } = {
            href: '', download: '', clicks: 0, click: () => { anchor.clicks++; },
          };
          host.anchors.push(anchor);
          return anchor;
        },
        body: { appendChild: (c: unknown) => { host.appended.push(c); } },
      };

  return host;
}

const hosts: Host[] = [];
beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { while (hosts.length) hosts.pop()!.restore(); vi.useRealTimers(); });
const host = (opts: Parameters<typeof installHost>[0] = {}) => {
  const h = installHost(opts);
  hosts.push(h);
  return h;
};

describe('downloadReplayFile: the object URL outlives the click', () => {
  it('hands the file over on a detached anchor named after the run', () => {
    const h = host();
    expect(downloadReplayFile(FILE)).toBe(EXPECTED_NAME);

    expect(h.created).toEqual(['a']);
    expect(h.anchors).toHaveLength(1);
    expect(h.anchors[0]!.download).toBe(EXPECTED_NAME);
    expect(h.anchors[0]!.href).toBe(h.objectUrls[0]);
    expect(h.anchors[0]!.clicks).toBe(1);
    // Detached, as the function's own comment claims: appending would mutate the page the
    // game canvas lives in for the duration of the click.
    expect(h.appended).toEqual([]);
  });

  it('does NOT revoke in the same turn as the click — the Safari bug the comment names', () => {
    // The whole point of the `setTimeout`. Safari has historically cancelled an in-flight
    // download whose object URL was revoked in the same turn as the click, and the
    // symptom is a save that reports success and produces no file — indistinguishable
    // from a working save in every other assertion in this repo, including the ones that
    // capture the bytes. So this is the only place that can pin it.
    const h = host();
    downloadReplayFile(FILE);

    expect(h.objectUrls).toHaveLength(1);
    expect(h.revoked).toEqual([]); // synchronously after the click: still alive
    vi.advanceTimersByTime(9_999);
    expect(h.revoked).toEqual([]); // and still alive just short of the delay
    vi.advanceTimersByTime(1);
    expect(h.revoked).toEqual(h.objectUrls);
  });

  it('revokes it exactly once, however long the page lives after', () => {
    // A leak and a double-revoke are both plausible refactors of the block above, and
    // neither changes the saved bytes. `revoked` keeps duplicates for this assertion.
    const h = host();
    downloadReplayFile(FILE);
    vi.advanceTimersByTime(600_000);
    expect(h.revoked).toEqual(h.objectUrls);
    expect(h.revoked).toHaveLength(1);
  });
});

describe('downloadReplayFile: each capability is detected on its own', () => {
  // Three separate guards, three separate hosts. The WeChat runtime (design/04) is missing
  // all of them at once, which is why a single combined case would pass with any two of
  // the three checks deleted.

  it('no document: returns null without even building an object URL', () => {
    const h = host({ noDocument: true });
    expect(downloadReplayFile(FILE)).toBeNull();
    expect(h.objectUrls).toEqual([]); // bailed before doing any work
  });

  it('no Blob: returns null, and creates no anchor', () => {
    const h = host({ noBlob: true });
    expect(downloadReplayFile(FILE)).toBeNull();
    expect(h.created).toEqual([]);
    expect(h.objectUrls).toEqual([]);
  });

  it('a URL with no createObjectURL: returns null, and creates no anchor', () => {
    // The narrower half of the second guard: a host can have `URL` (every JS runtime does,
    // for the parser) and still not the Blob-URL half of it.
    const h = host({ noCreateObjectURL: true });
    expect(downloadReplayFile(FILE)).toBeNull();
    expect(h.created).toEqual([]);
  });
});

describe('downloadReplayFile: a host that refuses reports null, it does not throw', () => {
  it('a createElement that throws is reported, not propagated into the keydown handler', () => {
    // The file header promises "reports failure by returning null instead of throwing, so
    // the caller can say can't save here rather than the hotkey killing the frame" — and
    // the guards above only cover the ABSENT-capability shape. A host that HAS all three
    // and still refuses (sandboxed iframe, hardened CSP, an extension that replaced
    // `createElement`) used to propagate, straight out of the F9 keydown listener. The
    // code was changed to match the doc rather than the other way round: whoever presses
    // F9 is already mid-bug, and losing the frame is the worst possible answer.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const h = host({ createElementThrows: true });

    expect(downloadReplayFile(FILE)).toBeNull();
    expect(h.created).toEqual(['a']); // it really got that far
    expect(warn).toHaveBeenCalled(); // and the failure is not silent for a dev either

    // The URL it had already handed out is still released — the `finally` runs on the
    // failure path too, so a refusing host does not leak one per press.
    vi.advanceTimersByTime(10_000);
    expect(h.revoked).toEqual(h.objectUrls);
    warn.mockRestore();
  });
});
