/**
 * `mp3Frames.ts`'s own contract, against synthetic streams whose answers are known by
 * construction.
 *
 * Written because the frame walker had no test of its own (2026-09-01). It is the independent
 * second opinion behind three gates — `platform/audioAssets.test.ts` (50 cues),
 * `audio/musicAssets.test.ts` (the loops) and one case in `audio/musicPipeline.test.ts` — and
 * every one of them feeds it the 52 files that are already CORRECT. That leaves two whole
 * halves of the parser unexercised:
 *
 *   1. **Every rejection branch.** The header comment claims a truncated file, a mid-stream
 *      re-encode or appended garbage "fails as itself". Nothing tested that, because a valid
 *      file never reaches those lines — so any of them could have been inverted, or deleted,
 *      with the whole suite still green and a malformed asset shipping quietly.
 *   2. **The delay/padding arithmetic.** `durationMs` is the number `musicAssets` compares the
 *      catalogue's `lengthS` against to 50 ms, and that number is where the crossfade is placed.
 *      Against a real file the only cross-check is a catalogue value produced by the Python
 *      pipeline — close enough to catch a gross error, but the LAME tag decode itself (a 12-bit
 *      delay and a 12-bit padding packed across three bytes) has never been fed a value it was
 *      asked to reproduce exactly.
 *
 * The same practice as `tools/audio-pipeline/selftest.py` and the reason it exists: four
 * measurement bugs in that file were caught by synthetic signals with known answers and none by
 * reading the code (daydayup-audio-pipeline-conventions memory).
 *
 * The spec tables and the frame-length formula are restated here rather than imported. That is
 * the point, not duplication to be tidied away: the builder lays bytes out at ITS offsets, and
 * a parser that computes a different frame length lands on a byte that is not 0xFF and fails the
 * sync check. A shared constant would make both sides wrong together.
 */
import { describe, it, expect } from 'vitest';
import { parseMp3 } from './mp3Frames';

const BITRATES_V1 = [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 0];
const BITRATES_V2 = [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160, 0];
const RATES: Record<number, readonly number[]> = {
  3: [44100, 48000, 32000, 0], // MPEG 1
  2: [22050, 24000, 16000, 0], // MPEG 2
  0: [11025, 12000, 8000, 0], // MPEG 2.5
};

/** MPEG 2 / 24 kHz / 80 kbps / joint stereo — what this project's music loops actually are, so
 *  the default frame is the shipped shape and a case that varies from it says why. */
const V2 = 2;
const RATE_24K = 1;
const KBPS_80 = 9;
const JOINT_STEREO = 1;
const MONO = 3;
const LAYER_III = 1;

interface FrameOpts {
  version?: number;
  /** Header layer bits. 1 is Layer III; 3 is Layer I and 2 is Layer II, both rejected. */
  layer?: number;
  rateIndex?: number;
  bitrateIndex?: number;
  padBit?: 0 | 1;
  mode?: number;
  /** Forced byte length, for the reserved-table cases where the formula divides by zero. */
  len?: number;
  /** Written at offset 4, ahead of where a real stream keeps its side info. */
  payload?: string;
}

function frameLength(version: number, rateIndex: number, bitrateIndex: number, padBit: number) {
  const rate = RATES[version]![rateIndex]!;
  const kbps = (version === 3 ? BITRATES_V1 : BITRATES_V2)[bitrateIndex]!;
  const samplesPerFrame = version === 3 ? 1152 : 576;
  return Math.floor(((samplesPerFrame / 8) * kbps * 1000) / rate) + padBit;
}

function frame(o: FrameOpts = {}): Uint8Array {
  const version = o.version ?? V2;
  const layer = o.layer ?? LAYER_III;
  const rateIndex = o.rateIndex ?? RATE_24K;
  const bitrateIndex = o.bitrateIndex ?? KBPS_80;
  const padBit = o.padBit ?? 0;
  const mode = o.mode ?? JOINT_STEREO;
  const len = o.len ?? frameLength(version, rateIndex, bitrateIndex, padBit);
  const b = new Uint8Array(len);
  b[0] = 0xff;
  // Sync (3 bits) | version (2) | layer (2) | protection bit — 1 meaning NO CRC, which is what
  // leaves the next byte where the parser expects it.
  b[1] = 0xe0 | (version << 3) | (layer << 1) | 1;
  b[2] = (bitrateIndex << 4) | (rateIndex << 2) | (padBit << 1);
  b[3] = mode << 6;
  if (o.payload) write(b, 4, o.payload);
  return b;
}

function write(b: Uint8Array, at: number, s: string): void {
  for (let k = 0; k < s.length; k++) b[at + k] = s.charCodeAt(k);
}

/** A first frame carrying a Xing/Info tag: structurally a frame, audibly nothing, and the only
 *  place the encoder delay and end padding are recorded. */
function xingFrame(o: { tag?: 'Xing' | 'Info'; delay?: number; padding?: number; lame?: boolean } = {}) {
  const f = frame();
  write(f, 4, o.tag ?? 'Xing');
  if (o.lame !== false) {
    // The LAME extension. Its delay/padding live 21..23 bytes past the 'L', packed as
    // 12 bits each across three bytes — the layout the parser has to reproduce.
    const at = 40;
    write(f, at, 'LAME3.100');
    const delay = o.delay ?? 0;
    const padding = o.padding ?? 0;
    f[at + 21] = delay >> 4;
    f[at + 22] = ((delay & 0x0f) << 4) | ((padding >> 8) & 0x0f);
    f[at + 23] = padding & 0xff;
  }
  return f;
}

function stream(...parts: (Uint8Array | number[])[]): Uint8Array {
  const chunks = parts.map((p) => (Array.isArray(p) ? new Uint8Array(p) : p));
  const total = chunks.reduce((n, c) => n + c.length, 0);
  const out = new Uint8Array(total);
  let at = 0;
  for (const c of chunks) {
    out.set(c, at);
    at += c.length;
  }
  return out;
}

/** An ID3v2 header: 'ID3', version, flags, then a SYNCSAFE size (7 bits per byte) — chosen
 *  above 127 so a parser reading it as a plain big-endian integer skips the wrong distance and
 *  loses sync, rather than passing by luck. */
function id3(sizeBytes: number): Uint8Array {
  const header = new Uint8Array(10 + sizeBytes);
  write(header, 0, 'ID3');
  header[3] = 3;
  header[4] = 0;
  header[5] = 0;
  header[6] = (sizeBytes >> 21) & 0x7f;
  header[7] = (sizeBytes >> 14) & 0x7f;
  header[8] = (sizeBytes >> 7) & 0x7f;
  header[9] = sizeBytes & 0x7f;
  header.fill(0x5a, 10); // junk that is not frame sync
  return header;
}

const audioFrames = (n: number, o: FrameOpts = {}) =>
  stream(...Array.from({ length: n }, () => frame(o)));

/** MPEG 2 carries 576 samples per frame. Restated, like the tables above. */
const msFor = (frames: number, rate = 24000) => (frames * 576 * 1000) / rate;

describe('parseMp3 — what a clean stream is', () => {
  it('reports the rate, channel count and length the header bits actually say', () => {
    const info = parseMp3(audioFrames(10));
    expect(info).toMatchObject({ sampleRate: 24000, channels: 2, frames: 10 });
    expect(info.rawDurationMs).toBeCloseTo(msFor(10), 6);
    // No Xing tag, so there is nothing to subtract and the two lengths agree.
    expect(info.durationMs).toBe(info.rawDurationMs);
  });

  it('reads mono from the channel-mode bits, and everything else as stereo', () => {
    expect(parseMp3(audioFrames(4, { mode: MONO })).channels).toBe(1);
    for (const mode of [0, 1, 2]) {
      expect(parseMp3(audioFrames(4, { mode })).channels).toBe(2);
    }
  });

  it('walks a padded frame, which is one byte longer than the formula alone', () => {
    // If the padding BIT were ignored, frame 2 would be looked for one byte early — at a byte
    // that is not 0xFF — so this case is the whole guard against silently dropping it.
    const info = parseMp3(audioFrames(6, { padBit: 1 }));
    expect(info.frames).toBe(6);
    expect(info.sampleRate).toBe(24000);
  });

  it.each([
    ['MPEG 1 at 44.1 kHz', { version: 3, rateIndex: 0, bitrateIndex: 9 }, 44100, 1152],
    ['MPEG 1 at 48 kHz', { version: 3, rateIndex: 1, bitrateIndex: 11 }, 48000, 1152],
    ['MPEG 2 at 22.05 kHz', { version: 2, rateIndex: 0, bitrateIndex: 6 }, 22050, 576],
    ['MPEG 2.5 at 8 kHz', { version: 0, rateIndex: 2, bitrateIndex: 3 }, 8000, 576],
  ] as const)('reads %s, at that version’s samples-per-frame', (_name, opts, rate, perFrame) => {
    const info = parseMp3(audioFrames(8, opts));
    expect(info.sampleRate).toBe(rate);
    expect(info.rawDurationMs).toBeCloseTo((8 * perFrame * 1000) / rate, 6);
  });

  it('skips an ID3v2 tag by its syncsafe size', () => {
    const info = parseMp3(stream(id3(300), audioFrames(5)));
    expect(info.frames).toBe(5);
    expect(info.rawDurationMs).toBeCloseTo(msFor(5), 6);
  });
});

describe('parseMp3 — the Xing/LAME frame, which is where durationMs comes from', () => {
  it('counts the tag frame as a frame but not as audio', () => {
    const info = parseMp3(stream(xingFrame(), audioFrames(10)));
    expect(info.frames).toBe(11); // the tag IS a frame on disk
    expect(info.rawDurationMs).toBeCloseTo(msFor(10), 6); // ...carrying none of the audio
  });

  it.each(['Xing', 'Info'] as const)('recognises a %s tag (VBR and CBR write different ones)', (tag) => {
    expect(parseMp3(stream(xingFrame({ tag }), audioFrames(10))).frames).toBe(11);
    expect(parseMp3(stream(xingFrame({ tag }), audioFrames(10))).rawDurationMs).toBeCloseTo(msFor(10), 6);
  });

  it('subtracts the encoder delay and end padding to the sample', () => {
    // 12 bits each, packed across three bytes — values chosen so a shift or mask error in
    // either field shows up as a different number rather than a rounding difference.
    const delay = 1105;
    const padding = 2823;
    const info = parseMp3(stream(xingFrame({ delay, padding }), audioFrames(200)));
    expect(info.rawDurationMs).toBeCloseTo(msFor(200), 6);
    expect(info.durationMs).toBeCloseTo(((200 * 576 - delay - padding) * 1000) / 24000, 6);
    // The gap between the two IS the trim, and it is ~163 ms here: larger than several of the
    // cues this parser is applied to, which is why the header refuses to round to whole frames.
    expect(info.rawDurationMs - info.durationMs).toBeCloseTo(((delay + padding) * 1000) / 24000, 6);
  });

  it.each([
    ['delay only', 576, 0],
    ['padding only', 0, 576],
    ['neither recorded', 0, 0],
  ])('reads %s without borrowing bits from the other field', (_name, delay, padding) => {
    const info = parseMp3(stream(xingFrame({ delay, padding }), audioFrames(50)));
    expect(info.durationMs).toBeCloseTo(((50 * 576 - delay - padding) * 1000) / 24000, 6);
  });

  it('leaves the length untrimmed when the tag carries no LAME extension', () => {
    const info = parseMp3(stream(xingFrame({ lame: false }), audioFrames(10)));
    expect(info.durationMs).toBe(info.rawDurationMs);
    expect(info.durationMs).toBeCloseTo(msFor(10), 6);
  });

  it('clamps to zero rather than reporting a negative length', () => {
    // A tag claiming more trim than the file has audio. Nonsense, but it is one corrupt byte
    // away from any real file, and a negative duration would sail through every `<=` gate that
    // reads this number.
    const info = parseMp3(stream(xingFrame({ delay: 4000, padding: 4000 }), audioFrames(2)));
    expect(info.durationMs).toBe(0);
    expect(info.rawDurationMs).toBeGreaterThan(0);
  });

  it('only looks for the tag in the FIRST frame', () => {
    // Audio data that happens to contain the ASCII 'Xing' is audio. Treating a later frame as a
    // tag would silently drop its samples from every duration this parser reports.
    const info = parseMp3(stream(frame(), frame({ payload: 'XingLAME3.100' }), frame()));
    expect(info.frames).toBe(3);
    expect(info.rawDurationMs).toBeCloseTo(msFor(3), 6);
  });
});

describe('parseMp3 — what it refuses, and where it says the file went wrong', () => {
  it('rejects a stream that is not framed at all, naming the byte', () => {
    const bad = audioFrames(3);
    bad[240] = 0x00; // frame 2's sync word, at the offset the formula puts it
    expect(() => parseMp3(bad)).toThrow(/lost frame sync at byte 240/);
  });

  it('rejects garbage appended after the last frame', () => {
    // The header's "a container with garbage appended fails as itself" claim. An ID3v1 trailer
    // ('TAG' + 125 bytes) is the everyday form of this, and it lands here.
    const withTrailer = stream(audioFrames(4), [0x54, 0x41, 0x47], new Uint8Array(125));
    expect(() => parseMp3(withTrailer)).toThrow(/lost frame sync at byte 960/);
  });

  it.each([
    ['Layer I', 3],
    ['Layer II', 2],
    ['the reserved layer', 0],
  ])('rejects %s — this project ships Layer III only', (_name, layer) => {
    expect(() => parseMp3(audioFrames(2, { layer, len: 240 }))).toThrow(/not Layer III/);
  });

  it.each([
    ['a free-format bitrate index', { bitrateIndex: 0 }],
    ['the reserved bitrate index', { bitrateIndex: 15 }],
    ['the reserved sample-rate index', { rateIndex: 3 }],
  ])('rejects %s rather than dividing by it', (_name, opts) => {
    expect(() => parseMp3(audioFrames(2, { ...opts, len: 240 }))).toThrow(/reserved rate\/bitrate/);
  });

  it('rejects a sample rate that changes mid-stream', () => {
    // A partial re-encode, or two files concatenated. Every duration after the change would be
    // computed against the wrong divisor, and nothing downstream could tell.
    const mixed = stream(frame(), frame({ rateIndex: 0 }));
    expect(() => parseMp3(mixed)).toThrow(/changes mid-stream/);
  });

  it('rejects a channel count that changes mid-stream', () => {
    // The music gate requires stereo and the cue gate requires mono, both read from frame 1.
    // A file that switches would satisfy whichever gate asked first.
    const mixed = stream(frame({ mode: JOINT_STEREO }), frame({ mode: MONO }));
    expect(() => parseMp3(mixed)).toThrow(/changes mid-stream/);
  });

  it('rejects an empty file as having no frames, not as a zero-length one', () => {
    expect(() => parseMp3(new Uint8Array(0))).toThrow(/no frames found/);
    // An ID3 tag and nothing else: the same answer, reached down a different path.
    expect(() => parseMp3(id3(64))).toThrow(/no frames found/);
  });
});

describe('parseMp3 — truncation', () => {
  // This block found the bug it now guards. Its first version pinned the walker's silence as a
  // known blind spot, because the header's "a truncated file fails as itself" claim did not
  // hold: frames are a fixed 240 bytes here, so a cut always leaves an intact header at the last
  // boundary and the walk stepped past the end of the buffer with the stub counted whole. Fixed
  // 2026-09-01 by the frame-overrun and trailing-stub rules; all 52 shipped files were measured
  // to end on an exact frame boundary first, so the strict rule rejects nothing real.

  it('rejects a frame that declares more bytes than the file has left', () => {
    const cut = audioFrames(4).slice(0, 240 * 3 + 100);
    expect(() => parseMp3(cut)).toThrow(
      /truncated: frame at byte 720 declares 240 bytes, 100 remain/,
    );
  });

  it('rejects a file short by a SINGLE byte, naming the shortfall', () => {
    // The boundary, and it was not covered until a mutation walked through it: the first version
    // of this block cut 140 and 238 bytes off, so relaxing the check to `> bytes.length + 1`
    // survived. One byte short is also the realistic shape of an interrupted write.
    const cut = audioFrames(4).slice(0, 240 * 4 - 1);
    expect(() => parseMp3(cut)).toThrow(
      /truncated: frame at byte 720 declares 240 bytes, 239 remain/,
    );
  });

  it('accepts a file that ends exactly on its last frame’s final byte', () => {
    // The other side of that boundary. Every shipped file is this shape, so a check written one
    // byte too strict would fail all 52 of them — and would be caught here first.
    expect(parseMp3(audioFrames(4)).frames).toBe(4);
  });

  it('rejects a last frame cut before its header completes', () => {
    // Two bytes left: too few to look at as a header, so the loop stops and the stub is caught
    // on the way out rather than not at all.
    const cut = audioFrames(4).slice(0, 240 * 3 + 2);
    expect(() => parseMp3(cut)).toThrow(/2 trailing byte\(s\) after the last frame at byte 720/);
  });

  it('rejects a truncated first frame instead of failing inside the Xing read', () => {
    // The overrun check runs BEFORE the tag is read out of the frame, which also removes the
    // one place this parser could throw something other than its own message: reading a
    // Buffer view past the end of the backing store.
    const cut = stream(xingFrame(), audioFrames(1)).slice(0, 120);
    expect(() => parseMp3(cut)).toThrow(/truncated: frame at byte 0 declares 240 bytes/);
  });

  it('still reports a file cut AT a frame boundary as simply shorter', () => {
    // The residual blind spot, and it is not closable here: this is byte-for-byte a valid
    // shorter file, and no bitstream rule can tell it from one. The byte-size cross-check
    // against `credits.json` in `audioAssets`/`musicAssets` is what owns this shape — which is
    // why that assertion is not redundant beside a parser that walks every frame.
    const info = parseMp3(audioFrames(4).slice(0, 240 * 2));
    expect(info.frames).toBe(2);
    expect(info.rawDurationMs).toBeCloseTo(msFor(2), 6);
  });
});

describe('parseMp3 — the frame length invariant that lets the walk advance', () => {
  it('never describes a frame small enough to stall the walk, over the WHOLE table', () => {
    // Why this block exists, and the correction it records. The walk carries a `!(len > 4)`
    // guard that NO test can reach, and the first attempt at "fixing" that deleted it as dead
    // code with this test standing in for it. That was wrong, and a mutation proved it inside an
    // hour: with the guard gone, disabling the reserved-index check above stopped failing a test
    // and started HANGING the suite, because a free-format bitrate index gives `len` 0 and
    // `i += len` never moves. Unreachable defensive code beats a hang, so the guard is back and
    // this test states the invariant it rests on rather than replacing it.
    //
    // If free-format (bitrate index 0) is ever admitted, this fails — and it should: a
    // free-format frame carries no length in its header, so the walk cannot advance on one.
    let min = Infinity;
    let combinations = 0;
    for (const version of [3, 2, 0]) {
      for (let bitrateIndex = 0; bitrateIndex < 16; bitrateIndex++) {
        for (let rateIndex = 0; rateIndex < 4; rateIndex++) {
          const rate = RATES[version]![rateIndex]!;
          const kbps = (version === 3 ? BITRATES_V1 : BITRATES_V2)[bitrateIndex]!;
          if (!rate || !kbps) {
            // Exactly the pair the parser rejects one line before computing a length. Asserted
            // rather than skipped, so "rejected" and "never measured" cannot quietly swap.
            expect(() => parseMp3(audioFrames(2, { version, rateIndex, bitrateIndex, len: 240 })))
              .toThrow(/reserved rate\/bitrate/);
            continue;
          }
          for (const padBit of [0, 1] as const) {
            combinations++;
            min = Math.min(min, frameLength(version, rateIndex, bitrateIndex, padBit));
          }
        }
      }
    }
    expect(combinations).toBe(252); // 3 versions x 14 bitrates x 3 rates x 2 padding bits
    expect(min).toBe(24); // MPEG 2 / 8 kbps / 24 kHz — six times the 4-byte header
    expect(min).toBeGreaterThan(4);
  });

  it('walks a stream of the shortest frames the table allows', () => {
    // The invariant above, exercised rather than only computed: 24-byte frames are the closest
    // this format comes to stalling the walk, and they parse.
    const shortest = { version: 2, rateIndex: RATE_24K, bitrateIndex: 1 };
    expect(frameLength(2, RATE_24K, 1, 0)).toBe(24);
    const info = parseMp3(audioFrames(30, shortest));
    expect(info.frames).toBe(30);
    expect(info.sampleRate).toBe(24000);
  });
});
