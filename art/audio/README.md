# Audio (source)

> **Loading (2026-08-27):** these files are read at boot by `client/src/audio/SampleBank.ts`,
> driven by the cue catalogue in `client/src/audio/cueCatalogue.ts` (design/11, "The cue
> catalogue & the loading path"). The catalogue derives each path from a cue id + variant
> count, and `client/src/audio/cueCatalogue.test.ts` checks the generated set against both
> this directory and `credits.json` — so renaming or dropping a shipped file fails a test
> rather than going quiet.

Mirrors the `art/` convention: this directory holds the **source** audio and its licence
paperwork. Nothing here is loaded at runtime — what the game ships is the processed copy
under `client/public/audio/`.

> **Status (2026-08-27): the SFX pass is complete — 15 of 16 cues have assets; nothing
> loads them yet.** `client/public/audio/` holds **46 processed MP3s, 95.0 kB total**,
> covering every cue in `platform/audioSynth.ts`'s voice table except `status.burn`, which
> deliberately stays on its synth voice (reason below). No code references any of them:
> `audioSynth.ts` still generates every cue live. Wiring them up needs the cue catalogue
> that `design/11-audio.md` still lists under "To design" (where cue ids → files live: a
> `content/audio.ts` map, or the `12` manifest). Until that exists these files are staged,
> not shipped. Music and ambience remain untouched.

## Provenance

Six CC0 packs from Kenney. **Only the 46 files actually used are archived here**, under
`sources/<pack>/` — the full zips come to 10.7 MB against 447 kB of used source, so
`packs.json` records each pack's download URL and **sha256** instead, making the whole pack
re-fetchable and verifiable. Every `licenses/<pack>-LICENSE.txt` was read out of the pack
itself and checked to contain CC0.

| Pack | Files | Used for |
|---|---|---|
| Impact Sounds | 130 | `impact`, `deflect`, `shield.break` |
| Interface Sounds | 100 | `clash`, `status.shock`, `status.chill`, `pickup.material`, `wave-clear` |
| Sci-Fi Sounds | 73 | `muzzle`, `death` |
| Digital Audio | 63 | `status.poison`, `pickup.heal`, `pickup.buff` |
| RPG Audio | 52 | `pickup.weapon`, `pickup.material` |
| Music Jingles | 86 | `win` |

**Licence: CC0 1.0** for all six — commercial use allowed, attribution not required.
Per-file provenance (source file, sample rate, gain applied, bytes) is in `credits.json`.

## What was measured

All **556 files** were audited with `tools/audio-pipeline/audit.py` before anything was
picked. The corpus is far dirtier than the first pack suggested:

- **43 files clip**, with peaks up to **+3.51 dBFS** — above full scale. Excluded from
  selection; clipping already baked into a source cannot be undone.
- **233 files carry >5 ms of leading silence** — pure added latency. Recoverable, and the
  pipeline trims it.
- **247 files are bit-identical dual-mono**; 186 are genuinely mono. Half the bytes of the
  former are a duplicate channel.
- Mixed 44.1 kHz and 48 kHz sources, centroids spanning 178 Hz to 12 kHz.

## What was picked, and why

Chosen on measured fit against the synth voice each cue replaces, plus the material the
world already specifies (`design/13`: crystal-mirror enemies). Variant counts scale with how
often a cue fires — `design/11` gives every cue a variation-count, and one sample on a cue
that fires many times per second machine-guns.

**Nobody has listened to any of these files.** The selection rules out defects and matches
each synth voice; it cannot judge whether a sound is *right*. That sign-off is still open,
and the game is designed to be fully playable silent (`design/11`), so nothing depends on it.
The weakest pick on that basis is `win` — choosing pizzicato strings over sax, steel drum, or
chiptune is a style judgement made from spectra alone.

| Cue | Source family | Variants | Why |
|---|---|---|---|
| `impact` | `impactGeneric_light` | 5 | Tightest length match to the 70 ms synth voice (118–140 ms); most consistent set at 16 % centroid spread. Fires many times per second, so density beats variety. |
| `muzzle` | `laserRetro` | 5 | A laser shot is the right semantics for orb-core weapon fire. **Capped at 140 ms** — the corpus has no 60 ms shot, and this is the most-emitted cue in the game. |
| `deflect` | `impactMetal_light` | 5 | Bright and sharp (2440–3172 Hz), closest to the 700→1400 Hz triangle shipping now; 27 % spread keeps the set coherent. |
| `shield.break` | `impactGlass_heavy` | 5 | Best objective fit in the corpus (0.18). Glass is the literal material of a crystal-mirror enemy; 46 % spread means the variants genuinely differ. |
| `status.shock` | `glitch` | 4 | 10–30 ms electric ticks. The semantically obvious `zap` runs 1019–1228 ms and clips — far too long for a status tick that repeats. |
| `status.chill` | `glass` | 4 | 111–125 ms against a 120 ms target. Glass is both the right timbre for ice and the world's own material. |
| `clash` | `tick` | 3 | 23–55 ms against a 50 ms target, centroid 3786–7920 vs 4894 — the tightest match found for any cue. |
| `death` | `explosionCrunch` | 3 | Centroid 2223–3386 vs 3556. **Capped at 600 ms**: an unbounded 2 s tail times many simultaneous deaths is mud. Still the most expensive cue at 19.5 kB. |
| `status.poison` | `lowRandom`, `lowDown` | 2 | Centroid 249 and 178 Hz against a 236 Hz target — the closest spectral match in the corpus. Only two files exist at this pitch. |
| `pickup.heal` | `pepSound` | 2 | Centroid 643 and 808 Hz bracket the 823 Hz target. |
| `pickup.weapon` | `drawKnife` | 2 | Chosen on semantics — it *is* a weapon pickup. Brighter than the chime it replaces. |
| `pickup.material` | `handleCoins`, `pluck` | 2 | handleCoins at 7194 Hz against a 6573 Hz target, and literally the sound of handling loot. Its sibling file clips; this one does not. |
| `pickup.buff` | `phaserUp` | 2 | Centroid 1316 and 1230 Hz against a 1427 Hz target. |
| `wave-clear` | `confirmation` | 1 | Centroid 1536 vs 1278 Hz. Fires once per wave. |
| `win` | `jingles_PIZZI` | 1 | Centroid 1356 Hz against 1318 Hz — near exact. Pizzicato over the chiptune and sax alternatives, which fight the flat-cel world. |

### Kept on the synth voice

- **`status.burn`** — no fire crackle exists in any of the six packs. The closest family
  (`scratch`) centres at 6401–12076 Hz against a 2389 Hz target — a high scrape, not a burn —
  and every other candidate is a 5-second engine loop. The synth voice is a filtered noise
  burst at 1800 Hz, which is already the right shape.
- **`footstep`** — appears in `design/11`'s event map but has no synth voice, so an asset
  would be an addition rather than a replacement. Whether a top-down bullet-hell wants
  footsteps at all is a design call, not a sourcing problem.

## Processing applied

Run via `tools/audio-pipeline/process_all.py`. Every step fixes a measured defect:

1. **Mono** — collapse channels (verified bit-identical on the dual-mono sources).
2. **Trim** — drop head/tail below −40 dBFS with 4 ms/8 ms fades so the new edges cannot
   click. Removed up to 224 ms of inaudible material from individual files.
3. **Cap** — per-cue duration ceiling matched to how often the cue fires, applied as a 20 ms
   fade-out rather than a cut. Only `muzzle`, `status.poison`, `death`, `pickup.*` and
   `wave-clear` needed one.
4. **Encode** — MP3 at the **smallest** output among all sample rates that still clear
   2.2 × the file's own measured 95 % rolloff. Bytes are *not* monotonic in sample rate
   (libsndfile picks its own VBR quality per rate — one file is smallest at 16 kHz, another
   at 24 kHz), so this is a measured search, not a heuristic. It found 95.0 kB where a
   plausible per-family guess gave 99.1 kB.
5. **Peak-normalise** to the peak of the synth cue being replaced, so swapping an asset in
   does not change perceived loudness and the `AudioBus` calibration still holds. Gains
   range from −20.2 dB to +6.5 dB; the one positive gain (`drawKnife2`, a quiet −22.95 dBFS
   recording) raises its noise floor with it.

### Verification

- `audit.py --by-cue`: **46 / 46 pass**, routed 33 to the strict `sfx` gate and 13 to
  `feedback`. Zero clipping, zero dual-mono, zero stereo, zero DC offset.
- Decoded in a real browser: **46 / 46**, duration error ≤ 0.1 ms (mean 0.01 ms), all mono,
  peaks −23.5…−9.7 dBFS.
- WeChat main package: 3.31 → **3.41 MB / 4.00 MB**.

Two gate bugs surfaced during this pass and were fixed in `audit.py`: a −12 dBFS peak floor
that spuriously failed 40 of 46 peak-matched files, and a cue-class matcher that missed the
`.`→`-` flattening in shipped filenames, routing every `pickup.*` asset to the combat gate.

## Why MP3 and not OGG

Measured, not assumed. OGG/Vorbis carries a **~3.6 kB fixed setup header** (the codebooks)
per file, which dwarfs a short SFX payload — a 5 ms clip costs 3685 bytes as Vorbis against
703 as MP3, and the two formats only converge around 2 s of audio. Decoded in a real browser,
MP3 also came back sample-exact where Vorbis added up to 30 ms of padding; both showed 0 ms
leading silence, so MP3's encoder delay is not a latency problem here. This agrees with
`design/11`, which already prefers MP3 as universally decoded on WeChat.

**Still unverified:** MP3 decoding on a real WeChat device at the lowest base library — the
same open checklist item as `design/04` item 2. OGG/Vorbis remains the right choice for music
loops, where the fixed header amortises away.
