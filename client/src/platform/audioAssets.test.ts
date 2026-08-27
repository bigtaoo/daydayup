/**
 * The shipped SFX set's own rules, read from the SHIPPED files under `public/audio/` and the
 * provenance records in `art/audio/` rather than from a fixture.
 *
 * A fixture would defeat the point. What can actually go wrong here is drift between three
 * things that no compiler ties together: the mp3 files on disk, `credits.json`'s per-file
 * licence and processing record, and the `AudioCue` union that names every cue the game can
 * fire. A cue added to the union with no audio decision, an asset swapped for a stereo
 * re-encode that silently doubles its bytes, or a file whose attribution entry was deleted
 * are all invisible until someone looks — and on a monetised title the last one is a licence
 * problem, not a cosmetic one.
 *
 * Nothing here decodes audio. The mp3s are parsed at the MPEG frame level, which is enough
 * to confirm format, channel count, sample rate and duration without a decoder. Timbre is
 * not testable and is not tested; see `art/audio/README.md` for what measurement can and
 * cannot say about these files.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { ALL_CUES } from '../audio/cueCatalogue';

const AUDIO_DIR = new URL('../../public/audio/', import.meta.url);
const ART_AUDIO = new URL('../../../art/audio/', import.meta.url);

// Total budget for the SFX set. It sits inside the WeChat main package (design/04's 4 MB),
// which `build/checkWeChatPackage.mjs` gates as a whole; this is the finer drift check, so
// audio creeping upward shows up here as itself rather than as an anonymous package overrun.
// The set is 95.0 kB at the time of writing.
const AUDIO_BUDGET_BYTES = 160 * 1024;

// Every cue the game can fire, from `audio/cueCatalogue.ts` — which the compiler holds
// exhaustive over `AudioCue` (it is a `Record`), so adding a cue to the union cannot reach
// this file without an audio decision existing for it. Until 2026-08-27 this was a
// hand-maintained literal here AND in two other test files; the catalogue makes all three
// one table.
// Which gate class each cue belongs to. Pinned here because the distinction is easy to lose:
// a combat cue must feel instant (design/11's tight deflect/hit), a pickup can afford tens of
// ms of natural onset. `tools/audio-pipeline/audit.py` once routed every `pickup.*` asset to
// the combat gate through a filename-separator bug, flagging a correct 84 ms knife-draw
// attack as a defect.
const COMBAT_CUES = new Set<string>([
  'muzzle', 'impact', 'deflect', 'clash', 'shield.break',
  'status.burn', 'status.chill', 'status.shock', 'status.poison',
]);

const MAX_MS = { sfx: 500, feedback: 800 } as const;

interface CreditsFile {
  file: string;
  source: string;
  source_pack: string;
  sample_rate: number;
  duration_ms: number;
  bytes: number;
}
interface CreditsCue {
  cue: string;
  variants: number;
  total_bytes: number;
  gate_class: keyof typeof MAX_MS;
  files: CreditsFile[];
}
interface Credits {
  cues: CreditsCue[];
  kept_on_synth: Record<string, string>;
}
interface Packs {
  packs: { id: string; license: string; license_text: string; sha256: string; download: string }[];
}

const json = <T>(base: URL, name: string): T =>
  JSON.parse(readFileSync(new URL(name, base), 'utf8')) as T;

const credits = json<Credits>(ART_AUDIO, 'credits.json');
const packs = json<Packs>(ART_AUDIO, 'packs.json');
const creditFiles = credits.cues.flatMap((c) => c.files);
const onDisk = readdirSync(fileURLToPath(AUDIO_DIR)).filter((f) => f.endsWith('.mp3')).sort();

// ---------------------------------------------------------------------------------------
// A minimal MPEG-audio frame walker. Layer III only, which is all we ship.
// ---------------------------------------------------------------------------------------

const BITRATES_V1 = [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 0];
const BITRATES_V2 = [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160, 0];
const RATES = {
  3: [44100, 48000, 32000, 0], // MPEG 1
  2: [22050, 24000, 16000, 0], // MPEG 2
  0: [11025, 12000, 8000, 0], // MPEG 2.5
} as const;

interface Mp3Info {
  sampleRate: number;
  channels: number;
  frames: number;
  /** Audible length: frame samples less the LAME encoder delay and end padding. */
  durationMs: number;
  /** Every frame's worth, delay and padding included — what a naive frame count gives. */
  rawDurationMs: number;
}

/** Walk every frame header, so a truncated or re-encoded file cannot pass on its first one. */
function parseMp3(bytes: Uint8Array): Mp3Info {
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
    const len = Math.floor((perFrame / 8) * kbps * 1000 / rate) + padBit;
    if (len <= 4) throw new Error(`degenerate frame length ${len} at byte ${i}`);

    // The first frame may be a Xing/Info tag: structurally a frame, but carrying no audio —
    // and, in its LAME extension, the encoder delay and end padding a gapless-aware decoder
    // removes. Reading those is what makes the duration check below exact rather than a
    // frame-rounded approximation: raw frames run up to ~64 ms long here.
    if (frames === 0) {
      const head = Buffer.from(bytes.buffer, bytes.byteOffset + i, len).toString('latin1');
      if (head.includes('Xing') || head.includes('Info')) {
        const lame = head.indexOf('LAME');
        if (lame >= 0 && i + lame + 24 <= bytes.length) {
          const b = bytes;
          const o = i + lame;
          delay = (b[o + 21] << 4) | (b[o + 22] >> 4);
          padding = ((b[o + 22] & 0x0f) << 8) | b[o + 23];
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
  const audible = Math.max(samples - delay - padding, 0);
  return {
    sampleRate,
    channels,
    frames,
    durationMs: (audible / sampleRate) * 1000,
    rawDurationMs: (samples / sampleRate) * 1000,
  };
}

const parsed = new Map<string, Mp3Info>(
  onDisk.map((f) => [f, parseMp3(new Uint8Array(readFileSync(new URL(f, AUDIO_DIR))))]),
);

describe('the shipped SFX set', () => {
  it('is described by credits.json exactly — no orphan files, no missing entries', () => {
    // Drift either way is a real defect: an orphan mp3 ships bytes nothing accounts for, and
    // a missing entry means a file whose licence and provenance are no longer recorded.
    expect(creditFiles.map((f) => f.file.replace(/^audio\//, '')).sort()).toEqual(onDisk);
  });

  it('accounts for every AudioCue, with assets or as a deliberate synth keep', () => {
    // The gate that matters most. A cue added to the union with no audio decision recorded
    // would otherwise stay silent-by-accident, indistinguishable from silent-on-purpose.
    const withAssets = new Set(credits.cues.map((c) => c.cue));
    const keptOnSynth = new Set(Object.keys(credits.kept_on_synth));
    for (const cue of ALL_CUES) {
      expect(withAssets.has(cue) || keptOnSynth.has(cue), `${cue} has no audio decision`).toBe(true);
    }
    // And nothing is claimed twice, which would make the record ambiguous about what plays.
    for (const cue of withAssets) expect(keptOnSynth.has(cue)).toBe(false);
    // Every named cue is a real cue — catches a typo in the record itself.
    for (const cue of [...withAssets, ...keptOnSynth]) {
      expect(ALL_CUES as readonly string[]).toContain(cue);
    }
  });

  it('ships every file as a mono Layer III stream at its recorded sample rate', () => {
    // Mono is the byte-halving decision from the audit: all the dual-mono sources had
    // bit-identical channels. A stereo re-encode would silently double the set's bytes.
    for (const f of creditFiles) {
      const name = f.file.replace(/^audio\//, '');
      const info = parsed.get(name)!;
      expect(info.channels, `${name} channel count`).toBe(1);
      expect(info.sampleRate, `${name} sample rate`).toBe(f.sample_rate);
    }
  });

  it('agrees with each file on its audible duration', () => {
    // credits.json's durations are what the per-cue length limits below are judged against, so
    // they have to describe the actual audio rather than whatever the pipeline believed. The
    // tolerance is tight because the LAME delay/padding fields are read rather than guessed —
    // a naive frame count would sit up to 64 ms high and need a meaningless slack.
    for (const f of creditFiles) {
      const name = f.file.replace(/^audio\//, '');
      const info = parsed.get(name)!;
      expect(Math.abs(info.durationMs - f.duration_ms), `${name} duration`).toBeLessThan(2);
    }
  });

  it('carries the gapless metadata every cue depends on', () => {
    // Without the Xing/LAME tag a decoder cannot know how much encoder delay to drop, and
    // every cue picks up tens of ms of leading silence — the one thing design/11 will not
    // tolerate on a deflect or hit. This is also what made MP3 beat OGG on duration accuracy,
    // so a re-encode that loses the tag silently undoes that.
    for (const name of onDisk) {
      const info = parsed.get(name)!;
      expect(info.rawDurationMs, `${name} has no padding to trim`)
        .toBeGreaterThan(info.durationMs);
    }
  });

  it('records each file at its real size on disk', () => {
    for (const f of creditFiles) {
      const name = f.file.replace(/^audio\//, '');
      const actual = readFileSync(new URL(name, AUDIO_DIR)).byteLength;
      expect(actual, `${name} bytes`).toBe(f.bytes);
    }
  });

  it('stays inside the audio byte budget', () => {
    const total = onDisk.reduce(
      (n, f) => n + readFileSync(new URL(f, AUDIO_DIR)).byteLength, 0,
    );
    expect(total).toBeLessThanOrEqual(AUDIO_BUDGET_BYTES);
  });

  it('holds combat cues to the voice cap and feedback cues to their own', () => {
    // design/11 caps simultaneous voices, so a long tail on a cue that fires constantly is
    // the expensive kind of mistake. `muzzle` and `death` are capped by the pipeline for
    // exactly this reason.
    for (const c of credits.cues) {
      const expected = COMBAT_CUES.has(c.cue) ? 'sfx' : 'feedback';
      expect(c.gate_class, `${c.cue} gate class`).toBe(expected);
      for (const f of c.files) {
        expect(f.duration_ms, `${f.file} duration`).toBeLessThanOrEqual(MAX_MS[expected]);
      }
    }
  });

  it('gives the cues that fire most often the most variants', () => {
    // A single sample on a cue that fires many times per second machine-guns; design/11 gives
    // every cue a variation-count for this. `win` fires once per run and needs only one.
    const variants = new Map(credits.cues.map((c) => [c.cue, c.variants]));
    for (const cue of ['muzzle', 'impact', 'deflect', 'shield.break']) {
      expect(variants.get(cue), `${cue} variants`).toBeGreaterThanOrEqual(3);
    }
    for (const c of credits.cues) {
      expect(c.variants, `${c.cue} variants`).toBe(c.files.length);
      expect(c.total_bytes).toBe(c.files.reduce((n, f) => n + f.bytes, 0));
    }
  });
});

describe('licence provenance', () => {
  it('declares the upstream pack every shipped file came from', () => {
    const declared = new Set(packs.packs.map((p) => p.id));
    for (const f of creditFiles) {
      expect(declared.has(f.source_pack), `${f.file} from undeclared pack ${f.source_pack}`)
        .toBe(true);
      // The recorded source path has to agree with the pack it is attributed to.
      expect(f.source.startsWith(`${f.source_pack}/`)).toBe(true);
    }
  });

  it('keeps a licence text for every pack, and every one of them is CC0', () => {
    // This is the test that earns its place on a monetised title (design/14): an asset from a
    // "free for non-commercial" or no-redistribution source is a legal problem, not a bug.
    // The licence text is checked as shipped, not as summarised in the JSON field.
    expect(packs.packs.length).toBeGreaterThan(0);
    for (const p of packs.packs) {
      expect(p.license).toBe('CC0-1.0');
      const path = new URL(`../../../${p.license_text}`, import.meta.url);
      expect(existsSync(fileURLToPath(path)), `${p.id} licence text missing`).toBe(true);
      expect(readFileSync(path, 'utf8')).toMatch(/CC0/);
      // sha256 of the upstream zip, so the full pack stays re-fetchable and verifiable.
      expect(p.sha256).toMatch(/^[0-9a-f]{64}$/);
      expect(p.download).toMatch(/^https:\/\//);
    }
  });

  it('archives the source file behind every shipped asset', () => {
    // art/ holds source, public/ holds shipped (the convention art/README.md sets). Without
    // the source, a re-encode at different settings cannot be reproduced.
    for (const f of creditFiles) {
      const src = new URL(`sources/${f.source}`, ART_AUDIO);
      expect(existsSync(fileURLToPath(src)), `${f.source} not archived`).toBe(true);
    }
  });
});
