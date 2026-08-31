"""Objective audio-asset audit: measures what can be measured, gates on design/11's
constraints, and stays silent about taste. The counterpart to tools/png-pipeline's
alpha-audit.mjs -- a defect finder, not a critic.

Usage: python audit.py <file-or-dir>... [--class sfx|ui|loop] [--json out.json]
"""
import argparse, json, os, sys
import numpy as np
import soundfile as sf

FLOOR_DB = -40.0          # "signal starts here" threshold for silence trimming
CLIP_LEVEL = 0.9995


def db(x: float) -> float:
    return -np.inf if x <= 1e-12 else 20.0 * np.log10(x)


def spectral(mono: np.ndarray, sr: int) -> tuple[float, float]:
    """Spectral centroid and 95% rolloff over the whole (windowed) signal, in Hz."""
    n = min(len(mono), 1 << 15)
    if n < 64:
        return 0.0, 0.0
    seg = mono[:n] * np.hanning(n)
    mag = np.abs(np.fft.rfft(seg))
    freqs = np.fft.rfftfreq(n, 1.0 / sr)
    total = mag.sum()
    if total <= 1e-12:
        return 0.0, 0.0
    centroid = float((freqs * mag).sum() / total)
    cdf = np.cumsum(mag) / total
    rolloff = float(freqs[np.searchsorted(cdf, 0.95)])
    return centroid, rolloff


# Log-band analysis, added 2026-08-31 for the music loops. A single spectral CENTROID
# (spectral() above) is enough to compare two 100 ms cues, and far too coarse to say whether
# two 2 s windows of a 69 s bed will wrap without lurching -- on a real candidate it read
# 0.945 where the per-band measure read 2.4 dB.
BAND_N, BAND_LO, BAND_HI = 30, 40.0, 16000.0
BAND_FLOOR_DB = -120.0     # an EMPTY band must read a number: -inf - -inf = nan downstream
XFADE_S = 2.0              # MusicPlayer's crossfade length; the window this measure compares


def band_edges() -> np.ndarray:
    return np.geomspace(BAND_LO, BAND_HI, BAND_N + 1)


def band_profile(x: np.ndarray, sr: int) -> np.ndarray:
    """Per-band RMS in dBFS over BAND_N log-spaced bands, floored at BAND_FLOOR_DB.

    Accepts mono or (n, ch) -- `process_music.py` measures stereo regions with these.
    """
    mono = x.mean(axis=1) if x.ndim > 1 else x
    spec = np.fft.rfft(mono)
    freqs = np.fft.rfftfreq(len(mono), 1.0 / sr)
    edges = band_edges()
    out = np.full(BAND_N, BAND_FLOOR_DB)
    n = len(mono)
    # Parseval, one-sided: 2*sum|X_k|^2 / n^2 is the mean square of the band-limited signal.
    for b in range(BAND_N):
        sel = (freqs >= edges[b]) & (freqs < edges[b + 1])
        if sel.any():
            ms = 2.0 * float(np.sum(np.abs(spec[sel]) ** 2)) / (n * n)
            out[b] = max(db(np.sqrt(ms)), BAND_FLOOR_DB)
    return out


def band_rms(x: np.ndarray, sr: int, lo: float, hi: float) -> float:
    """RMS of the signal restricted to [lo, hi), in dBFS, over the whole signal."""
    mono = x.mean(axis=1) if x.ndim > 1 else x
    spec = np.fft.rfft(mono)
    freqs = np.fft.rfftfreq(len(mono), 1.0 / sr)
    spec[(freqs < lo) | (freqs >= min(hi, sr / 2.0))] = 0
    y = np.fft.irfft(spec, len(mono))
    return db(float(np.sqrt(np.mean(y ** 2))))


def profile_diff(a: np.ndarray, b: np.ndarray) -> float:
    """Energy-weighted mean |dB| difference between two band profiles.

    ONE function, because this quantity is used twice: to rank candidate loop regions
    (`process_music.py --search`) and to accept the shipped file (the `music` gate). Both
    times it drifted apart from the other when they each computed it -- first at different
    window resolutions (a region ranked 3.01 dB measured 5.61 dB), then with and without
    this weighting (a region ranked 2.44 dB measured 3.39 dB). A search whose metric is not
    literally the acceptance metric keeps handing back candidates that do not survive.
    """
    weight = 10.0 ** (np.maximum(a, b) / 10.0)
    total = float(weight.sum())
    if total <= 0.0:
        return 0.0
    return float(np.sum(weight * np.abs(b - a)) / total)


def xfade_band_diff(x: np.ndarray, sr: int, xfade_s: float = XFADE_S) -> float:
    """Per-band dB difference between the head and tail crossfade windows, ENERGY-WEIGHTED.

    The weighting is not a refinement, it is what makes the measure mean anything. An
    unweighted mean over 30 bands gives a band sitting at -100 dBFS the same vote as the
    one carrying the music, and in a band that holds no signal the only thing left is FFT
    leakage whose phase differs between the two windows. Measured: a two-sine bed whose head
    and tail are *identical by construction* read 6.12 dB unweighted -- enough to fail a
    3.5 dB gate on nothing at all.

    Weighting each band by the louder of its two windows' energy makes the number mean
    "how different are the parts you can hear", which is the question the crossfade poses.
    """
    w = int(xfade_s * sr)
    if len(x) < 4 * w:
        return float("nan")
    return profile_diff(band_profile(x[:w], sr), band_profile(x[-w:], sr))


def music_measures(mono: np.ndarray, sr: int) -> dict:
    """The two numbers the `music` gate is about, or Nones when the file is too short.

    `xfade_band_diff` replaces `step_db` for music: MusicPlayer fades a second deck in over
    the tail, so head and tail are heard TOGETHER and only have to be tonally compatible --
    sample continuity is neither required nor achievable, since MP3 frame padding denies it.

    `mid_band_dbfs` is the mix decision made measurable. The shipped cues sit at -14..-21
    dBFS peak, an AI master arrives at 0, and this is the band impact/muzzle/ui.tap all peak
    in -- so it is the one number that decides whether combat still reads over the bed.
    """
    w = int(XFADE_S * sr)
    if len(mono) < 4 * w:
        return {"xfade_band_diff": None, "mid_band_dbfs": None}
    return {
        "xfade_band_diff": round(xfade_band_diff(mono, sr), 2),
        "mid_band_dbfs": round(band_rms(mono, sr, 250.0, 2000.0), 2),
    }


def loop_seam(mono: np.ndarray, sr: int) -> dict:
    """How badly a naive end->start loop would click.

    Two independent signals: the sample-level step across the wrap point (a click),
    and the spectral distance between the head and tail windows (an audible lurch
    even when no single sample jumps).
    """
    if len(mono) < sr // 4:
        return {"step_db": None, "head_tail_spectral_dist": None}
    step = abs(float(mono[0]) - float(mono[-1]))
    w = min(sr // 4, len(mono) // 4)
    head_c, _ = spectral(mono[:w], sr)
    tail_c, _ = spectral(mono[-w:], sr)
    denom = max(head_c, tail_c, 1.0)
    return {
        "step_db": round(db(step), 1),
        "head_tail_spectral_dist": round(abs(head_c - tail_c) / denom, 3),
    }


def analyse(path: str) -> dict:
    data, sr = sf.read(path, always_2d=True, dtype="float64")
    ch = data.shape[1]
    mono = data.mean(axis=1)
    n = len(mono)
    peak = float(np.max(np.abs(data))) if n else 0.0
    env = np.abs(mono)
    floor = 10 ** (FLOOR_DB / 20.0) * max(peak, 1e-9)
    loud = np.flatnonzero(env > floor)

    out = {
        "file": os.path.basename(path),
        "bytes": os.path.getsize(path),
        "sample_rate": sr,
        "channels": ch,
        "duration_ms": round(1000.0 * n / sr, 1),
        "peak_dbfs": round(db(peak), 2),
        "rms_dbfs": round(db(float(np.sqrt(np.mean(mono ** 2)))), 2) if n else None,
        "dc_offset": round(float(np.mean(mono)), 5),
        "clipped_samples": int(np.count_nonzero(np.abs(data) >= CLIP_LEVEL)),
    }
    out["kbps"] = round(out["bytes"] * 8 / max(out["duration_ms"], 1e-6), 1)

    if loud.size:
        out["lead_silence_ms"] = round(1000.0 * int(loud[0]) / sr, 1)
        out["tail_silence_ms"] = round(1000.0 * (n - 1 - int(loud[-1])) / sr, 1)
        # Attack: onset -> peak. A punchy impact is a couple of ms; a soft pad is 100+.
        pk = int(np.argmax(env))
        out["attack_ms"] = round(1000.0 * max(pk - int(loud[0]), 0) / sr, 1)
    else:
        out["lead_silence_ms"] = out["tail_silence_ms"] = out["attack_ms"] = None
        out["silent"] = True

    out["crest_db"] = (
        round(out["peak_dbfs"] - out["rms_dbfs"], 2)
        if out["rms_dbfs"] not in (None, -np.inf) else None
    )
    c, r = spectral(mono, sr)
    out["spectral_centroid_hz"], out["spectral_rolloff95_hz"] = round(c), round(r)

    if ch == 2:
        l, r_ = data[:, 0], data[:, 1]
        out["lr_identical"] = bool(np.allclose(l, r_, atol=1e-4))
        sl, sr_ = l.std(), r_.std()
        out["lr_correlation"] = (
            round(float(np.corrcoef(l, r_)[0, 1]), 3) if sl > 1e-9 and sr_ > 1e-9 else None
        )
    out.update(loop_seam(mono, sr))
    out.update(music_measures(mono, sr))
    return out


# Gates come from design/11 + design/04: tight combat cues, no clipping, mono, and a byte
# budget that survives WeChat's 4 MB main package.
#
# The peak window deliberately spans -30..-0.3 dBFS. An earlier -12 dBFS floor was wrong: it
# was written for raw library files, and spuriously failed 40 of 46 assets that had been
# peak-matched DOWN to the quiet synth cues they replace. The floor exists only to catch a
# file that is effectively inaudible.
#
# `sfx` is for combat cues that must feel instant (muzzle/impact/deflect/clash/status).
# `feedback` is for cues where a few ms of onset costs nothing (pickup/death/wave-clear/win)
# -- a knife-draw pickup with an 84 ms natural attack is correct, not defective.
GATES = {
    "sfx": [
        ("duration_ms", None, 500, "combat cue too long -- design/11 caps voices, long tails pile up"),
        ("lead_silence_ms", None, 5, "leading silence is pure added latency on a deflect/hit cue"),
        ("peak_dbfs", -30, -0.3, "peak outside usable range (inaudible / too hot to mix)"),
        ("clipped_samples", None, 0, "clipped -- will distort further once the SFX bus sums voices"),
        ("channels", None, 1, "stereo SFX doubles bytes for no positional gain (game pans in code)"),
    ],
    "feedback": [
        ("duration_ms", None, 800, "feedback cue outlasting its moment"),
        ("lead_silence_ms", None, 20, "onset late enough to feel disconnected from the event"),
        ("peak_dbfs", -30, -0.3, "peak outside usable range (inaudible / too hot to mix)"),
        ("clipped_samples", None, 0, "clipped"),
        ("channels", None, 1, "stereo cue wastes bytes"),
    ],
    "ui": [
        ("duration_ms", None, 350, "UI click should not outlast the interaction"),
        ("lead_silence_ms", None, 5, "leading silence makes a button feel unresponsive"),
        ("clipped_samples", None, 0, "clipped"),
        ("channels", None, 1, "stereo UI cue wastes bytes"),
    ],
    "loop": [
        ("duration_ms", 20000, 90000, "loop outside 20-90s -- shorter tires, longer wastes subpackage bytes"),
        ("step_db", None, -50, "end->start sample step will click audibly at the wrap point"),
        ("head_tail_spectral_dist", None, 0.35, "head and tail differ tonally -- the wrap will lurch"),
        ("clipped_samples", None, 0, "clipped"),
        ("kbps", None, 128, "over budget for a lazy-loaded music subpackage"),
    ],
    # `music` is `loop` for the player this project actually built (2026-08-31). The two
    # differences are the whole point of the class, so changing one back is a design change:
    #   * no `step_db`. That gate assumes `el.loop = true`, which MP3 frame padding makes
    #     unusable anyway; MusicPlayer crossfades a second deck over the tail instead, so
    #     `xfade_band_diff` is what decides whether the wrap is audible.
    #   * no `channels` limit. The sfx/ui gates forbid stereo because a 100 ms cue's second
    #     channel is pure overhead. A 69 s bed streams; the bytes amortise.
    # The peak window is far below the sfx one: an AI master arrives at ~0 dBFS and has to
    # come down ~15 dB before it belongs in a mix whose cues peak at -14..-21.
    "music": [
        ("duration_ms", 20000, 90000, "loop outside 20-90s -- shorter tires, longer wastes subpackage bytes"),
        ("xfade_band_diff", None, 2.5, "head and tail differ tonally across the crossfade -- the wrap will lurch"),
        ("mid_band_dbfs", -31.0, -29.0, "250-2000 Hz level off target: combat/UI cues stop reading over the bed"),
        ("peak_dbfs", -24, -3.0, "peak outside usable range (inaudible / no headroom over the cue set)"),
        ("clipped_samples", None, 0, "clipped"),
        ("kbps", None, 128, "over budget for a lazy-loaded music subpackage"),
    ],
}

# Which gate a shipped cue asset is held to, keyed by the cue-name prefix of its filename.
CUE_CLASS = {
    "muzzle": "sfx", "impact": "sfx", "deflect": "sfx", "clash": "sfx",
    "shield-break": "sfx", "status": "sfx",
    "pickup": "feedback", "death": "feedback", "wave-clear": "feedback", "win": "feedback",
    # The screen-layer cues (design/11 UI cues, 2026-08-30). One prefix covers all of them,
    # the same way "status"/"pickup" do, so a fifth `ui.*` cue inherits the gate.
    "ui": "ui",
}


def class_for(filename: str, default: str) -> str:
    """Pick the gate from a shipped asset's path (`deflect_02.mp3` -> sfx).

    Shipped filenames flatten the cue id's dot to a dash (`pickup.weapon` ->
    `pickup-weapon_00.mp3`), so both separators have to match a prefix.

    DIRECTORY FIRST, added 2026-08-31 with the music loops. Music ships as
    `audio/music/<track>.mp3` -- names with no cue prefix at all, which fell through to the
    caller's default and got a 69 s stereo bed held to the COMBAT gate ("too long", "stereo
    wastes bytes"). A music track's class is decided by where it ships, exactly as its
    WeChat package membership is (`assetPacks.json` prefix rules), and routing on the
    directory means a track added later cannot inherit the wrong gate by being named badly.
    """
    parts = os.path.normpath(filename).replace("\\", "/").split("/")
    if "music" in parts[:-1]:
        return "music"
    stem = os.path.splitext(os.path.basename(filename))[0]
    name = stem.rsplit("_", 1)[0] if "_" in stem else stem
    for prefix, cls in CUE_CLASS.items():
        if name == prefix or name.startswith(prefix + ".") or name.startswith(prefix + "-"):
            return cls
    return default


def gate(m: dict, cls: str) -> list[str]:
    fails = []
    for key, lo, hi, why in GATES[cls]:
        v = m.get(key)
        if v is None:
            continue
        if lo is not None and v < lo:
            fails.append(f"{key}={v} < {lo}: {why}")
        if hi is not None and v > hi:
            fails.append(f"{key}={v} > {hi}: {why}")
    if m.get("silent"):
        fails.append("silent: no sample above -40 dBFS")
    if abs(m.get("dc_offset") or 0) > 0.01:
        fails.append(f"dc_offset={m['dc_offset']}: DC bias, clicks on start/stop")
    if m.get("lr_identical"):
        fails.append("lr_identical: dual-mono -- halve the bytes by shipping mono")
    return fails


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("paths", nargs="+")
    ap.add_argument("--class", dest="cls", default="sfx", choices=list(GATES))
    ap.add_argument("--by-cue", action="store_true",
                    help="pick the gate per file from its cue name instead of --class")
    ap.add_argument("--json", dest="json_out")
    args = ap.parse_args()

    exts = {".wav", ".ogg", ".mp3", ".flac", ".aiff", ".aif"}
    files: list[str] = []
    for p in args.paths:
        if os.path.isdir(p):
            for root, _, names in os.walk(p):
                files += [os.path.join(root, n) for n in sorted(names)
                          if os.path.splitext(n)[1].lower() in exts]
        else:
            files.append(p)

    rows = []
    for f in files:
        try:
            m = analyse(f)
        except Exception as e:  # unreadable/corrupt is itself a finding
            rows.append({"file": os.path.basename(f), "error": str(e), "fails": ["unreadable"]})
            continue
        cls = class_for(f, args.cls) if args.by_cue else args.cls
        m["class"] = cls
        m["fails"] = gate(m, cls)
        rows.append(m)

    passed = [r for r in rows if not r["fails"]]
    print(f"{len(rows)} file(s), class={args.cls}: {len(passed)} pass, {len(rows) - len(passed)} flagged\n")
    hdr = f"{'file':<34}{'ms':>7}{'lead':>6}{'atk':>6}{'peak':>7}{'rms':>7}{'crest':>6}{'centroid':>9}{'ch':>3}{'kB':>6}"
    print(hdr)
    print("-" * len(hdr))
    for r in rows:
        if "error" in r:
            print(f"{r['file']:<34} ERROR {r['error'][:60]}")
            continue
        print(f"{r['file']:<34}{r['duration_ms']:>7.0f}{(r['lead_silence_ms'] or 0):>6.0f}"
              f"{(r['attack_ms'] or 0):>6.0f}{r['peak_dbfs']:>7.1f}{(r['rms_dbfs'] or 0):>7.1f}"
              f"{(r['crest_db'] or 0):>6.1f}{r['spectral_centroid_hz']:>9}{r['channels']:>3}"
              f"{r['bytes'] / 1024:>6.1f}")
    flagged = [r for r in rows if r["fails"]]
    if flagged:
        print("\nFlagged:")
        for r in flagged:
            print(f"  {r['file']}")
            for f_ in r["fails"]:
                print(f"    - {f_}")
    if args.json_out:
        with open(args.json_out, "w", encoding="utf8") as fh:
            json.dump(rows, fh, indent=1)
        print(f"\nwrote {args.json_out}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
