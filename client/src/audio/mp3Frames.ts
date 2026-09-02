// An MPEG-audio frame walker — format, channel count, sample rate and audible duration from
// the bitstream, with no decoder involved.
//
// TEST SUPPORT, not runtime code. It exists because the two asset gates that need it —
// `platform/audioAssets.test.ts` (the shipped cue set) and `audio/musicAssets.test.ts` (the
// music loops) — must not each own a copy: the parser's whole job is to be the independent
// second opinion on what a shipped file IS, and two copies of an independent opinion is one
// copy of it. It lives under src/ rather than beside a test for the same reason
// `game/screens/fakeTextCanvas.ts` does: shared by more than one test file, and importable
// without a build step.
//
// Layer III only, which is all this project ships. It walks EVERY frame header rather than
// trusting the first, so a truncated file, a re-encode that changes rate mid-stream, or a
// container with garbage appended fails as itself instead of passing on its first 4 bytes.
//
// Truncation is caught by a frame that declares more bytes than the file has left, plus a
// trailing stub too short to be a header. Until 2026-09-01 it was caught by NEITHER: frames are
// a fixed length at a constant bitrate, so a cut always leaves an intact header at the last
// boundary, and the walk stepped straight past the end of the buffer and reported the stub as a
// whole frame. All 52 shipped files end on an exact frame boundary (measured, both masters too),
// so the strict rule costs nothing. One shape stays invisible on purpose: a cut AT a boundary is
// a valid shorter file and nothing in the bitstream can say otherwise — the byte-size
// cross-check against `credits.json` is what owns that.
//
// The reason `durationMs` is exact rather than frame-rounded: the first frame is usually a
// Xing/Info tag carrying LAME's encoder delay and end padding, and those are READ here.
// Rounding to whole frames instead would sit up to 64 ms high — meaningless slack on a 69 s
// loop, and larger than several of the cues it is applied to.

const BITRATES_V1 = [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 0];
const BITRATES_V2 = [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160, 0];
const RATES = {
  3: [44100, 48000, 32000, 0], // MPEG 1
  2: [22050, 24000, 16000, 0], // MPEG 2
  0: [11025, 12000, 8000, 0], // MPEG 2.5
} as const;

export interface Mp3Info {
  sampleRate: number;
  channels: number;
  frames: number;
  /** Audible length: frame samples less the LAME encoder delay and end padding. */
  durationMs: number;
  /** Every frame's worth, delay and padding included — what a naive frame count gives. */
  rawDurationMs: number;
}

/** Walk every frame header. Throws with a byte offset on anything that is not a clean Layer III
 *  stream — a thrown error naming where it stopped is far more useful here than a null. */
export function parseMp3(bytes: Uint8Array): Mp3Info {
  let i = 0;
  if (bytes[0] === 0x49 && bytes[1] === 0x44 && bytes[2] === 0x33) {
    // ID3v2: 10-byte header plus a syncsafe size.
    i = 10 + ((bytes[6] << 21) | (bytes[7] << 14) | (bytes[8] << 7) | bytes[9]);
  }
  let sampleRate = 0;
  let channels = 0;
  let frames = 0;
  let samples = 0;
  let delay = 0;
  let padding = 0;
  while (i + 4 <= bytes.length) {
    if (bytes[i] !== 0xff || (bytes[i + 1] & 0xe0) !== 0xe0) {
      throw new Error(`lost frame sync at byte ${i}`);
    }
    const version = (bytes[i + 1] >> 3) & 0x03;
    const layer = (bytes[i + 1] >> 1) & 0x03;
    if (layer !== 0x01) throw new Error(`not Layer III (layer bits ${layer}) at byte ${i}`);
    const rate = RATES[version as keyof typeof RATES]?.[(bytes[i + 2] >> 2) & 0x03] ?? 0;
    const kbps = (version === 3 ? BITRATES_V1 : BITRATES_V2)[(bytes[i + 2] >> 4) & 0x0f];
    if (!rate || !kbps) throw new Error(`reserved rate/bitrate at byte ${i}`);
    const mode = (bytes[i + 3] >> 6) & 0x03;
    const ch = mode === 0x03 ? 1 : 2;
    if (sampleRate && (rate !== sampleRate || ch !== channels)) {
      throw new Error(`sample rate or channel count changes mid-stream at byte ${i}`);
    }
    sampleRate = rate;
    channels = ch;

    const perFrame = version === 3 ? 1152 : 576;
    // The frame header's own padding BIT (one extra byte on this frame), not to be confused
    // with `padding` above, which is the LAME tag's end padding in samples.
    const padBit = (bytes[i + 2] >> 1) & 0x01;
    const len = Math.floor(((perFrame / 8) * kbps * 1000) / rate) + padBit;
    // A frame declaring more bytes than remain. THE truncation check — see this file's header
    // for why nothing else here can be one.
    if (i + len > bytes.length) {
      throw new Error(
        `truncated: frame at byte ${i} declares ${len} bytes, ${bytes.length - i} remain`,
      );
    }
    // A frame length that would not advance the walk. No test can reach this — the shortest
    // frame any combination this parser accepts can describe is 24 bytes (MPEG 2, 8 kbps,
    // 24 kHz), pinned over the whole table in `mp3Frames.test.ts` — and it STAYS anyway, which
    // was settled by evidence rather than taste: it was briefly deleted as unreachable on
    // 2026-09-01, and the mutation that disables the reserved-index check above then turned a
    // failing test into an INFINITE LOOP (a free-format bitrate index gives `len` 0, so `i += len`
    // never moves). A hang is a far worse failure than a branch no test covers, and the guard
    // costs one comparison per frame.
    //
    // Written `!(len > 4)` rather than `len <= 4`: both reserved indices together make `len` NaN,
    // and `NaN <= 4` is false, so the original form let NaN through to `i += NaN` — which exits
    // the walk quietly and reports a frame count and a duration computed from a zero sample rate.
    if (!(len > 4)) throw new Error(`degenerate frame length ${len} at byte ${i}`);

    // The first frame may be a Xing/Info tag: structurally a frame, but carrying no audio —
    // and, in its LAME extension, the encoder delay and end padding a gapless-aware decoder
    // removes. See this file's header for why reading those matters.
    if (frames === 0) {
      const head = Buffer.from(bytes.buffer, bytes.byteOffset + i, len).toString('latin1');
      if (head.includes('Xing') || head.includes('Info')) {
        const lame = head.indexOf('LAME');
        if (lame >= 0 && i + lame + 24 <= bytes.length) {
          const b = bytes;
          const o = i + lame;
          delay = (b[o + 21]! << 4) | (b[o + 22]! >> 4);
          padding = ((b[o + 22]! & 0x0f) << 8) | b[o + 23]!;
        }
        frames++;
        i += len;
        continue;
      }
    }
    samples += perFrame;
    frames++;
    i += len;
  }
  if (!frames) throw new Error('no frames found');
  // The other half of the truncation check: the loop can only stop with 0-3 bytes left, so
  // anything at all here is a stub that is neither a frame nor the end of the file.
  if (i !== bytes.length) {
    throw new Error(`${bytes.length - i} trailing byte(s) after the last frame at byte ${i}`);
  }
  const audible = Math.max(samples - delay - padding, 0);
  return {
    sampleRate,
    channels,
    frames,
    durationMs: (audible / sampleRate) * 1000,
    rawDurationMs: (samples / sampleRate) * 1000,
  };
}
