# audio-pipeline

Four Python scripts behind the audio assets under `client/public/audio/`. The counterpart to
`tools/png-pipeline/` — same discipline (measure, then convert), different medium.

- **`audit.py`** — objective audit + gate. Measures duration, leading/trailing silence,
  attack, peak/RMS/crest, spectral centroid and rolloff, clipping, DC offset, L/R
  correlation, and loop-seam discontinuity; then fails the file against per-class limits
  (`--class sfx|feedback|ui|loop|music`) drawn from `design/11-audio.md`. Run it on any incoming batch
  instead of trusting how a file sounds — it is what found the dual-mono defect across all
  130 files of the Kenney pack.

      python audit.py <file-or-dir>... [--class sfx|feedback|ui|loop|music] [--json out.json]

  Two classes exist for looping audio and the difference is a design decision, not a
  duplicate. **`loop`** is the naive form: it requires `step_db <= -50`, i.e. that the last
  sample sits next to the first, which is what `el.loop = true` needs. **`music`** is for the
  player this project actually built — `MusicPlayer` crossfades a second deck over the tail,
  so head and tail are heard *together* and only have to be tonally compatible. It drops
  `step_db` (MP3 frame padding makes sample-exact looping unavailable anyway), allows stereo
  (a 69 s bed streams; the bytes amortise, unlike a 100 ms cue's second channel), and adds two
  measures of its own: `xfade_band_diff` and `mid_band_dbfs`.

  `--by-cue` routes each file to its class. Music routes **by directory** (`audio/music/*`),
  not by filename, because a track called `menu.mp3` matches no cue prefix and used to fall
  through to the combat gate — which reported both shipped beds as "too long" and "stereo
  wastes bytes".

- **`process_all.py`** — the one-time conversion that produced the shipped combat set: mono, trim,
  per-family resample, peak-match to the synth cue being replaced, MP3 encode. Reads
  `synth.json` (an audit of the synth cues) to know what peak to match.

- **`process_ui.py`** — the same conversion for the four `ui.*` cues (2026-08-30), importing
  the helpers above rather than duplicating them. It is a separate driver for one reason: it
  needs no `synth.json`. A UI voice in `platform/audioSynth.ts` is a single `tone()`, so its
  peak is exactly its `gain` argument, and the peak-match reference is derived from the voice
  table instead of measured off a re-render. Its module docstring also records the thing a
  reader would otherwise assume wrongly — for these four the *sample* was picked first and the
  synth voice written to match it, the reverse of the combat set.

- **`process_music.py`** — the music loops (2026-08-31), from AI-generated masters. A
  separate driver because every one of its inputs differs from a cue's: the input is a 4-6
  minute *song*, so a loop **region** has to be chosen; it arrives mastered to ~0 dBFS where
  the shipped cue set peaks at -14..-21, so level is set by a **band target** (the 250-2000 Hz
  RMS, the band `impact`/`muzzle`/`ui.tap` all peak in) rather than by peak-matching a synth
  voice that does not exist for music; and it stays stereo.

      ./venv/Scripts/python process_music.py --search boss     # rank loop regions
      ./venv/Scripts/python process_music.py [--track menu|boss]

  Its filters are single zero-phase multiplies over the **whole region's** spectrum. That is
  circular convolution and a loop region *is* circular, so filtering cannot introduce the
  endpoint discontinuity a windowed/overlap-add filter would.

  **The one mistake worth reading before touching this file.** The region search and the
  acceptance gate have to be the *same measurement*, and they drifted apart three times in a
  row during the first pass — each time producing a candidate that scored well and then
  failed:

  | search said | gate measured | because |
  |---|---|---|
  | 3.01 dB | 5.61 dB | the search sampled four 4096-point frames of the 2 s crossfade window instead of measuring it |
  | 2.44 dB | 3.39 dB | the gate weighted band differences by energy; the search averaged all 30 equally |
  | 1.41 dB | 3.69 dB | the search read the *raw* master, but the shelf that always applies to that track moves the energy weighting onto the mids |

  Both now call `audit.profile_diff(band_profile(...), band_profile(...))`, and `--search`
  applies the track's shelf. Search, extraction and post-encode figures now agree to within
  0.02 dB (`menu` 1.15 / 1.15 / 1.15; `boss` 1.62 / 1.64 / 1.63). If you add a processing
  step that changes a measured property, `--search` has to apply it too.

- **`selftest.py`** — 23 cases over the measurement and gating layer, plain asserts, no
  pytest. Measurement is checked against synthetic signals with known ground truth (a 1 kHz
  sine must read as a 1 kHz centroid; 50 ms of leading zeros must read as 50 ms of lead), and
  the two bugs that actually shipped in `audit.py` are pinned so they cannot come back: the
  `sfx` peak floor that failed 40 of 46 correctly peak-matched files, and the `class_for`
  separator bug that held every `pickup.*` asset to the combat gate. The `ui.*` cues route by
  the same prefix rule and have their own cases there, since a UI file that fell through to the
  default would be gated by the loosest rule that applies to it rather than the tightest.

      ./venv/Scripts/python selftest.py

  Two of its own cases were wrong on first run and are commented where they were fixed — a
  bandwidth assertion that miscalculated 2.2 x 10 kHz, and a "discontinuous" loop signal that
  wrapped cleanly after all.

The shipped set has a second, independent gate in the client's own vitest suite:
`client/src/platform/audioAssets.test.ts`. That one runs in CI via `npm run check`, parses the
mp3s at the MPEG frame level (no decoder), and holds `credits.json`, the files on disk, and
the `AudioCue` union to each other. Nine mutations were run against it — an orphan file, a
wrong duration, a dropped cue, a re-classed pickup, a wrong sample rate, wrong bytes, a
non-CC0 licence text, a truncated mp3, an undeclared pack — and all nine were caught.

## Toolchain note

These are **Python**, unlike the rest of `tools/` which is Node/`.mjs`. The reason is
`soundfile`/`libsndfile`, which decodes and encodes OGG/MP3/WAV/FLAC in one dependency;
there is no comparable single Node dependency, and this machine has no `ffmpeg`. If the
inconsistency is not worth it, `audit.py` is the half worth porting — `process.py` has
already done its job.

    python -m venv --system-site-packages venv
    ./venv/Scripts/python -m pip install numpy soundfile

None of the three is wired into `npm run check` — that would put Python in CI. The asset
invariants that *do* need to hold on every commit are covered by the vitest file above, which
needs no Python at all; these scripts are for the batch itself. `process_all.py` is importable
(its driver sits behind `main()`) so `selftest.py` can exercise it without running a
conversion, and re-running it reproduces `client/public/audio/` byte-for-byte — all 46 files
verified identical after the last refactor.

## Music sourcing (2026-08-31)

Unlike the SFX set, the music is **AI-generated** (Suno), not CC0 library material — CC0
music turned out to be almost entirely chiptune, a direct style mismatch for design/13's
flat-cel direction. Masters live in `art/audio/sources/suno/`, one directory per source
exactly like the Kenney packs. Two findings from the first two tracks, both likely to repeat:

- **Suno masters to ~0 dBFS.** The shipped cues were deliberately peak-matched *down* to the
  synth voices they replaced and sit at -14..-21 dBFS. Every AI master therefore needs 13-15
  dB of attenuation before it belongs in this mix; that is what `MID_TARGET_DBFS = -30` is,
  and `mid_band_dbfs` in the `music` gate is what stops a track shipping without it.
- **It places energy about two octaves below where the prompt asks.** Both tracks were
  prompted for crystalline bell/glass timbres. The first came back with 90% of its energy
  below 109 Hz and nothing above 2 kHz, so it became the `boss` bed rather than the menu one;
  the second, after `sub-bass`/`drone` went into the exclude list, moved up to 160 Hz-1.2 kHz
  but still produced nothing above 4 kHz. Naming instruments and registers explicitly helps;
  excluding the register you do *not* want helps more.
