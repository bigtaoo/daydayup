# audio-pipeline

Two Python scripts behind the audio assets under `client/public/audio/`. The counterpart to
`tools/png-pipeline/` — same discipline (measure, then convert), different medium.

- **`audit.py`** — objective audit + gate. Measures duration, leading/trailing silence,
  attack, peak/RMS/crest, spectral centroid and rolloff, clipping, DC offset, L/R
  correlation, and loop-seam discontinuity; then fails the file against per-class limits
  (`--class sfx|ui|loop`) drawn from `design/11-audio.md`. Run it on any incoming batch
  instead of trusting how a file sounds — it is what found the dual-mono defect across all
  130 files of the Kenney pack.

      python audit.py <file-or-dir>... [--class sfx|ui|loop] [--json out.json]

- **`process.py`** — the one-time conversion that produced the shipped set: mono, trim,
  per-family resample, peak-match to the synth cue being replaced, MP3 encode. Reads
  `synth.json` (an audit of the synth cues) to know what peak to match.

- **`selftest.py`** — 15 cases over the measurement and gating layer, plain asserts, no
  pytest. Measurement is checked against synthetic signals with known ground truth (a 1 kHz
  sine must read as a 1 kHz centroid; 50 ms of leading zeros must read as 50 ms of lead), and
  the two bugs that actually shipped in `audit.py` are pinned so they cannot come back: the
  `sfx` peak floor that failed 40 of 46 correctly peak-matched files, and the `class_for`
  separator bug that held every `pickup.*` asset to the combat gate.

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
