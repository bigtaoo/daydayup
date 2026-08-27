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
}

# Which gate a shipped cue asset is held to, keyed by the cue-name prefix of its filename.
CUE_CLASS = {
    "muzzle": "sfx", "impact": "sfx", "deflect": "sfx", "clash": "sfx",
    "shield-break": "sfx", "status": "sfx",
    "pickup": "feedback", "death": "feedback", "wave-clear": "feedback", "win": "feedback",
}


def class_for(filename: str, default: str) -> str:
    """Pick the gate from a shipped asset's cue name (`deflect_02.mp3` -> sfx).

    Shipped filenames flatten the cue id's dot to a dash (`pickup.weapon` ->
    `pickup-weapon_00.mp3`), so both separators have to match a prefix.
    """
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
