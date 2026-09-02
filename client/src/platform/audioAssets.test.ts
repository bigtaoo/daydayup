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
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { ALL_CUES } from '../audio/cueCatalogue';
// The frame walker moved to `audio/mp3Frames.ts` when the music gate needed the same parser
// (2026-08-31). One copy on purpose: it is this file's independent second opinion on what a
// shipped mp3 actually is, and two copies of an independent opinion is one copy of it.
import { parseMp3, type Mp3Info } from '../audio/mp3Frames';

const AUDIO_DIR = new URL('../../public/audio/', import.meta.url);
const ART_AUDIO = new URL('../../../art/audio/', import.meta.url);

// Total budget for the SFX set. It sits inside the WeChat main package (design/04's 4 MB),
// which `build/checkWeChatPackage.mjs` gates as a whole; this is the finer drift check, so
// audio creeping upward shows up here as itself rather than as an anonymous package overrun.
// The set is 122.7 kB at the time of writing (46 engine + 4 UI + the 11 character-reaction
// files of 2026-09-02). The budget has NOT moved with it: it was set at 160 KiB against a
// 101.9 kB set and there is still room, which is the point — a budget that is raised to fit
// whatever just landed is not a budget.
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
  // The character-reaction cues (2026-09-02) split across the two classes rather than
  // arriving as a block, and which side each falls on is the decision worth pinning:
  // `swing` and `hurt` are combat CONTACTS, so a tail that outlives the moment piles up the
  // same way a long `muzzle` would, while `spawn` and `death.player` announce a lifecycle
  // step and belong with `death.enemy`/`pickup.*` on the looser gate.
  'swing', 'hurt',
]);

// The third class, added with the UI cues (2026-08-30). It is the tightest of the three on
// length and the loosest on peak: a button click is the one cue the player triggers directly,
// so a tail that outlasts the press reads as lag, while the level is a mix decision made in
// the voice table rather than something an asset gate should second-guess.
// `ui.*` is a prefix rule, not a list, so a fifth UI cue inherits it.
const isUiCue = (cue: string): boolean => cue.startsWith('ui.');

const MAX_MS = { sfx: 500, feedback: 800, ui: 350 } as const;

interface CreditsFile {
  file: string;
  source: string;
  source_pack: string;
  /** Only for a `per_sound` pack — see `Packs` below. */
  source_sha256?: string;
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
  // `sha256` is the upstream ZIP's, and it is absent exactly when `per_sound` is set: a
  // source that serves one sound at a time has no archive to hash, so its integrity record
  // moves to `credits.json`, where each file from it carries its own `source_sha256`. The
  // test below holds both shapes to the same standard rather than exempting either.
  packs: {
    id: string; license: string; license_text: string; download: string;
    sha256?: string; per_sound?: boolean;
  }[];
}

const json = <T>(base: URL, name: string): T =>
  JSON.parse(readFileSync(new URL(name, base), 'utf8')) as T;

const credits = json<Credits>(ART_AUDIO, 'credits.json');
const packs = json<Packs>(ART_AUDIO, 'packs.json');
const creditFiles = credits.cues.flatMap((c) => c.files);
const onDisk = readdirSync(fileURLToPath(AUDIO_DIR)).filter((f) => f.endsWith('.mp3')).sort();

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

  it('holds combat cues to the voice cap, and feedback and UI cues to their own', () => {
    // design/11 caps simultaneous voices, so a long tail on a cue that fires constantly is
    // the expensive kind of mistake. `muzzle` and `death` are capped by the pipeline for
    // exactly this reason.
    for (const c of credits.cues) {
      const expected = isUiCue(c.cue) ? 'ui' : COMBAT_CUES.has(c.cue) ? 'sfx' : 'feedback';
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
      expect(p.download).toMatch(/^https:\/\//);
      if (p.per_sound) {
        // No archive exists to hash, so the guarantee is per FILE and has to actually be
        // there for every one of them — a `per_sound` flag with no hashes behind it would be
        // an exemption rather than a different way of keeping the same promise.
        expect(p.sha256).toBeUndefined();
        const fromPack = creditFiles.filter((f) => f.source_pack === p.id);
        expect(fromPack.length, `${p.id} declared but unused`).toBeGreaterThan(0);
        for (const f of fromPack) {
          expect(f.source_sha256, `${f.file} source hash`).toMatch(/^[0-9a-f]{64}$/);
          // ...and it has to be the hash OF the archived bytes. A well-formed hash that
          // describes nothing is the failure mode a shape check cannot see, and it is the
          // whole reason this pack is allowed to ship without a zip hash.
          const src = readFileSync(new URL(`sources/${f.source}`, ART_AUDIO));
          expect(createHash('sha256').update(src).digest('hex'), `${f.source} bytes`)
            .toBe(f.source_sha256);
        }
      } else {
        // sha256 of the upstream zip, so the full pack stays re-fetchable and verifiable.
        expect(p.sha256).toMatch(/^[0-9a-f]{64}$/);
      }
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
