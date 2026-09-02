/**
 * The WeChat audio-loading path, driven end to end against a WeChat-SHAPED runtime and the
 * REAL shipped mp3s. The audio counterpart of `render/wechatAssetLoad.test.ts`, and it exists
 * for the same reason that file does: this target has no automation API, design/04's
 * verification is screenshot-and-log by hand, and the simulator is not on every machine — so
 * without this, the mini-game's audio has exactly one form of evidence, "it sounded right in
 * DevTools once", which nobody can re-run on a commit.
 *
 * The gap is sharper for audio than it was for art. A missing texture is a visible
 * placeholder rectangle; a sample that fails to load is *inaudible* — the procedural voice
 * plays instead and the game sounds fine. Every WeChat-specific difference in the path is
 * therefore a way to ship 95 kB of dead weight and never notice:
 *
 *   - bytes come from `FileSystemManager.readFileSync` with NO encoding (an ArrayBuffer),
 *     not from `fetch`, which this runtime does not have at all;
 *   - the path must be package-relative — a leading '/' or a stale filename names nothing;
 *   - `readFileSync` signals failure by THROWING synchronously, where a `fetch` rejects;
 *   - `decodeAudioData` here is documented as the callback form, not the browser's promise.
 *
 * So: strip the browser globals, install a `wx` fake backed by the real files, and run the
 * REAL `WeChatAudio.preload()`. Nothing here is a re-implementation — the only fakes are `wx`
 * and the audio context itself.
 *
 * What it CANNOT pin, and still needs a device (design/04's checklist): that a real base
 * library HAS `wx.createWebAudioContext`, which of the two `decodeAudioData` shapes it
 * actually implements, that its decoder accepts these mp3s at all, and anything about
 * latency. This is a strong regression net, not a substitute for running it.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { WeChatAudio } from '../platform/wechat/WeChatAudio';
import { weChatAssetHost } from '../platform/wechat/weChatAssetHost';
import { setAssetHost, resetAssetHost } from '../render/assetHost';
import { PACKS, packedPathFor } from '../render/assetManifest';
import { ALL_CUES, CUE_CATALOGUE, allSfxPaths, variantPaths } from './cueCatalogue';
import { setUiAudio, playUiCue } from './uiSound';
import type { AudioCue } from '../platform/types';

// Derived rather than written down: what these cases are about is "the whole shipped set",
// and the exact-path assertions below already pin WHICH files. The literal drifted twice
// (46 -> 50 with the UI cues, 50 -> 61 with the character reactions) without the behaviour
// under test changing once.
const SHIPPED_VARIANTS = allSfxPaths().length;

const PUBLIC = new URL('../../public/', import.meta.url);

/** Undo `packedPathFor`: map a code-package path back to the file on disk it must name. */
function diskPathFor(packed: string): URL {
  const roots = PACKS.map((p) => p.root).filter((r) => r !== '').sort((a, b) => b.length - a.length);
  const root = roots.find((r) => packed.startsWith(`${r}/`));
  return new URL(root ? packed.slice(root.length + 1) : packed, PUBLIC);
}

/** Reads the fake runtime saw, and what it handed back — so the assertions can talk about
 *  what actually happened, not only about what came out the other end. */
const reads: string[] = [];
const decoded: { path: string; bytes: Uint8Array }[] = [];
/** The exact ArrayBuffer handed to the runtime → the path it came from. Keyed by IDENTITY on
 *  purpose: an earlier version of this fake matched on (byteLength, first byte) and mis-tagged
 *  buffers, because every ID3 file starts 0x49 and several shipped files are the same size. */
const pathOfBytes = new Map<ArrayBuffer, string>();

type Decoded = AudioBuffer & { fromPath?: string };

// ---------------------------------------------------------------------------------------
// A `wx.createWebAudioContext()`-shaped fake. `decodeAudioData` is the CALLBACK form on
// purpose: it is the shape WeChat documents, and the browser's promise form is what every
// other test in the repo exercises. If `audio/decodeAudio.ts` ever stopped passing the
// callbacks, this file is where the mini-game's silence would show up.
// ---------------------------------------------------------------------------------------
const param = (value = 0) => ({ value, setValueAtTime: vi.fn(), linearRampToValueAtTime: vi.fn() });
const node = () => ({ connect: vi.fn((dest: unknown) => dest) });

interface Voice {
  buffer: Decoded | null;
}
const voicesPlayed: Voice[] = [];
let synthVoices = 0;

const fakeCtx = {
  state: 'suspended' as 'suspended' | 'running',
  destination: {},
  currentTime: 0,
  sampleRate: 44100,
  resume: vi.fn(async () => {
    fakeCtx.state = 'running';
  }),
  createGain: vi.fn(() => ({ ...node(), gain: param(1) })),
  createOscillator: vi.fn(() => {
    synthVoices++;
    return { ...node(), type: 'sine', frequency: param(), start: vi.fn(), stop: vi.fn() };
  }),
  createBufferSource: vi.fn(() => {
    const rec: Voice = { buffer: null };
    return {
      ...node(),
      playbackRate: { value: 1 },
      start: vi.fn(() => voicesPlayed.push(rec)),
      stop: vi.fn(),
      set buffer(b: Decoded | null) {
        rec.buffer = b;
      },
      get buffer() {
        return rec.buffer;
      },
    };
  }),
  createBuffer: vi.fn((_c: number, length: number) => {
    synthVoices++; // the synth's noise burst builds its own buffer
    return { duration: length / 44100, getChannelData: () => new Float32Array(length) };
  }),
  createBiquadFilter: vi.fn(() => ({ ...node(), type: 'lowpass', frequency: { value: 0 } })),
  decodeAudioData: (
    data: ArrayBuffer,
    success?: (b: AudioBuffer) => void,
    error?: (e: unknown) => void,
  ): void => {
    const path = pathOfBytes.get(data);
    if (!path) {
      error?.(new Error('bytes were not one of the shipped files'));
      return;
    }
    // Asynchronous, like a real decoder — a synchronous fake would let a loader that never
    // awaited anything pass.
    queueMicrotask(() => success?.({ duration: 0.12, fromPath: path } as Decoded));
  },
};

const originals: Record<string, unknown> = {};
function stashAndDelete(name: string): void {
  originals[name] = (globalThis as Record<string, unknown>)[name];
  delete (globalThis as Record<string, unknown>)[name];
}

/** The `wx` a mini-game actually provides, backed by the real files under public/audio/. */
function installWx(readFile: (path: string, encoding?: string) => string | ArrayBuffer): void {
  (globalThis as Record<string, unknown>).wx = {
    createWebAudioContext: () => fakeCtx,
    getFileSystemManager: () => ({ readFileSync: readFile }),
  };
}

function realRead(path: string, encoding?: string): string | ArrayBuffer {
  reads.push(path);
  const disk = diskPathFor(path);
  if (!existsSync(disk)) throw new Error(`no such file: ${path}`);
  // The documented API, honoured rather than approximated: WITH an encoding the result is a
  // string, without one an ArrayBuffer. The first version of this fake ignored the argument,
  // and a mutation that read the mp3s as utf8 — which on a device hands a string to the
  // decoder and loses every sample — passed the suite.
  if (encoding) return readFileSync(disk, 'utf8');
  const buf = readFileSync(disk);
  // A COPY, so byteLength is exactly the file's size (a Node Buffer's underlying pool is
  // bigger, and handing that through would hide a truncated read).
  const bytes = new Uint8Array(buf);
  decoded.push({ path, bytes });
  pathOfBytes.set(bytes.buffer, path);
  return bytes.buffer;
}

let audio: WeChatAudio;

beforeAll(async () => {
  // A mini-game has none of these. `fetch` in particular exists in Node, so a loader that
  // still reached for it would pass a naive version of this test and fail on a device.
  for (const g of ['fetch', 'document', 'window', 'XMLHttpRequest', 'AudioContext', 'Image']) {
    stashAndDelete(g);
  }
  installWx(realRead);
  setAssetHost(weChatAssetHost);
  audio = new WeChatAudio();
  await audio.preload();
  audio.resume();
  await Promise.resolve();
});

afterAll(() => {
  for (const [name, value] of Object.entries(originals)) {
    if (value !== undefined) (globalThis as Record<string, unknown>)[name] = value;
  }
  delete (globalThis as Record<string, unknown>).wx;
  resetAssetHost();
});

describe('WeChat runtime — how the shipped SFX were reached', () => {
  it('read every catalogued file, and asked for nothing else', () => {
    expect(reads.slice().sort()).toEqual(allSfxPaths().map(packedPathFor).sort());
    expect(reads).toHaveLength(SHIPPED_VARIANTS);
  });

  it('asked only for package-relative paths that name real files', () => {
    // WeChat resolves a package path from the project root: a leading '/' or a './' prefix
    // names nothing, and the failure is silent (the synth voice covers it).
    for (const path of reads) {
      expect(path.startsWith('/'), `${path} has a leading slash`).toBe(false);
      expect(path.startsWith('./'), `${path} is relative-dotted`).toBe(false);
      expect(existsSync(diskPathFor(path)), `${path} names no real file`).toBe(true);
    }
  });

  it('handed the decoder the REAL mp3 bytes, whole', () => {
    // The assertion that cannot be made on a device without listening: that what came out of
    // `readFileSync` is the actual audio file and not an empty buffer, a truncation, or a
    // string. Checked as bytes — an mp3 starts with an ID3 tag or a frame sync.
    expect(decoded).toHaveLength(SHIPPED_VARIANTS);
    for (const { path, bytes } of decoded) {
      const onDisk = readFileSync(fileURLToPath(diskPathFor(path)));
      expect(bytes.byteLength, `${path} byte length`).toBe(onDisk.byteLength);
      const isId3 = bytes[0] === 0x49 && bytes[1] === 0x44 && bytes[2] === 0x33;
      const isFrameSync = bytes[0] === 0xff && (bytes[1]! & 0xe0) === 0xe0;
      expect(isId3 || isFrameSync, `${path} is not an MPEG stream`).toBe(true);
    }
  });

  it('never reached for a browser global on the way', () => {
    // The globals were deleted in beforeAll, so this is a statement about the run that just
    // happened: it completed without them.
    for (const g of ['fetch', 'document', 'window', 'AudioContext']) {
      expect((globalThis as Record<string, unknown>)[g], `${g} came back`).toBeUndefined();
    }
  });

  it('decoded through the CALLBACK form of decodeAudioData', () => {
    // This fake ONLY calls back — it returns nothing at all. So a full bank is the proof that
    // `decodeAudio.ts` adopts that shape: a promise-only implementation would hang here, load
    // zero samples, and leave the mini-game on its synth voices for ever, silently.
    const bank = (audio as unknown as { bank: { loadedCues: number; loadedVariants: number } }).bank;
    expect(bank.loadedVariants).toBe(SHIPPED_VARIANTS);
    expect(bank.loadedCues).toBe(ALL_CUES.filter((c) => CUE_CATALOGUE[c].variants > 0).length);
  });
});

/** How many voices this cue has played whose buffer came from one of ITS files. Compared as
 *  PACKED paths: what reaches this runtime is `audio/muzzle_00.mp3`, not the web-relative
 *  `/audio/muzzle_00.mp3` the catalogue names — mixing the two up is what made the first
 *  version of this file look like the mini-game loaded nothing. */
function voicesFor(cue: AudioCue): number {
  const paths = variantPaths(cue).map(packedPathFor);
  return voicesPlayed.filter((v) => v.buffer?.fromPath && paths.includes(v.buffer.fromPath)).length;
}

describe('WeChat runtime — what a cue actually plays here', () => {
  it('plays a shipped sample for every cue that has one', () => {
    // Same claim as the web pipeline test, on the platform that cannot be checked live.
    voicesPlayed.length = 0;
    synthVoices = 0;
    for (const cue of ALL_CUES) {
      if (CUE_CATALOGUE[cue].variants === 0) continue;
      fakeCtx.currentTime += 1; // let the previous voice retire, so the cap is not in play
      audio.play(cue);
      expect(voicesFor(cue), `${cue} played no sample`).toBeGreaterThan(0);
    }
    expect(synthVoices).toBe(0);
  });

  it('plays the synth voice for the one cue that has no sample', () => {
    voicesPlayed.length = 0;
    synthVoices = 0;
    fakeCtx.currentTime += 1;
    audio.play('status.burn'); // no fire crackle exists in the corpus (credits.json)
    expect(synthVoices).toBeGreaterThan(0);
    expect(voicesPlayed.filter((v) => v.buffer?.fromPath)).toEqual([]);
  });
});

describe('WeChat runtime — a UI press is this platform’s only autoplay gate', () => {
  it('resumes the context from a press, then plays the shipped ui.tap sample', () => {
    // On web, `WebAudio`'s constructor registers pointerdown/keydown/touchstart listeners that
    // clear the autoplay gate. This runtime has no `window` at all — it is deleted above,
    // exactly as on a device — so `uiSound.playUiCue`'s resume is the FIRST thing in a
    // mini-game session that can start the context. Before the UI cues existed, the earliest
    // sound in a session waited for a `Game.confirm()`, several screens in.
    //
    // The cue then has to arrive as a decoded sample like any other, through this platform's
    // callback-form decoder — which is the half no device check can make without listening.
    voicesPlayed.length = 0;
    synthVoices = 0;
    fakeCtx.state = 'suspended';
    fakeCtx.resume.mockClear();
    setUiAudio(audio);
    try {
      fakeCtx.currentTime += 1;
      playUiCue('ui.tap');
      expect(fakeCtx.resume, 'a press did not clear the gate').toHaveBeenCalled();
      expect(voicesFor('ui.tap')).toBe(1);
      expect(synthVoices).toBe(0);
    } finally {
      setUiAudio(null);
      fakeCtx.state = 'running';
    }
  });

  it('detaching the sink leaves this runtime silent rather than throwing', () => {
    // `setUiAudio(null)` is the state a mini-game is in between `boot()` starting and the sink
    // being attached; a button pressed in that window must do nothing at all.
    voicesPlayed.length = 0;
    synthVoices = 0;
    setUiAudio(null);
    expect(() => playUiCue('ui.tap')).not.toThrow();
    expect(voicesPlayed).toEqual([]);
    expect(synthVoices).toBe(0);
  });
});

describe('WeChat runtime — the failure shapes this platform has and web does not', () => {
  /** A fresh backend over a broken `wx`, so a failure cannot leak into the shared one. */
  async function withBrokenRead(readFile: (path: string) => string | ArrayBuffer) {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    installWx(readFile);
    const fresh = new WeChatAudio();
    await expect(fresh.preload()).resolves.toBeUndefined(); // never rejects into boot
    fresh.resume();
    await Promise.resolve();
    const before = voicesPlayed.length;
    const synthBefore = synthVoices;
    fakeCtx.currentTime += 1;
    fresh.play('impact');
    const messages = warn.mock.calls.map((c) => String(c[0]) + ' ' + String((c[1] as Error)?.message ?? ''));
    const result = {
      messages,
      // Only voices carrying a DECODED buffer count as samples: `impact`'s synth voice is a
      // noise burst, which builds a buffer source of its own, so a raw voice count would read
      // the fallback as a success.
      samples: voicesPlayed.slice(before).filter((v) => v.buffer?.fromPath).length,
      synth: synthVoices - synthBefore,
      warned: warn.mock.calls.length,
    };
    warn.mockRestore();
    installWx(realRead);
    return result;
  }

  it('survives readFileSync THROWING synchronously (its way of saying "no file")', async () => {
    // A `fetch` rejects; `readFileSync` throws where it is called. Both have to end up as the
    // same per-file failure inside SampleBank, or a missing mini-game asset takes down boot.
    const r = await withBrokenRead(() => {
      throw new Error('file not found');
    });
    expect(r.samples).toBe(0);
    expect(r.synth).toBeGreaterThan(0); // the game still makes a sound
    expect(r.warned).toBe(SHIPPED_VARIANTS);
  });

  it('survives a base library that returns a STRING for an un-encoded read', async () => {
    // The one branch that genuinely differs between base-library versions — the same reason
    // `readJson` has its own guard. Without the guard an empty buffer would simply reach
    // `decodeAudioData` and fail there, with the SAME audible outcome (synth voices) — so the
    // message is what has to be asserted, and it is the whole point of the guard: a reader
    // looking at the console learns which of the two failures they have.
    const r = await withBrokenRead(() => 'not an ArrayBuffer');
    expect(r.samples).toBe(0);
    expect(r.synth).toBeGreaterThan(0);
    expect(r.warned).toBe(SHIPPED_VARIANTS);
    expect(r.messages[0]).toContain('not an ArrayBuffer');
  });
});
