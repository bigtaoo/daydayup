"""Produce the full shipped SFX set: 15 cues, 46 files, from six CC0 Kenney packs.

Same pipeline as the first pass, with two additions the wider corpus needed:
  * sample rate is derived per file from its own measured 95% rolloff, rather than set
    per family by hand -- these packs mix 44.1k and 48k sources with wildly different
    bandwidth (178 Hz to 12 kHz centroids).
  * each cue carries a duration cap matched to how often it fires. A 279 ms laser tail is
    fine once; on `muzzle`, the most-emitted cue in the game, it turns into mud. Capping
    fades out at the cap rather than cutting, so nothing clicks.

Variant counts scale with emission frequency too (design/11 gives every cue a
variation-count): 5 for muzzle, 1 for `win`, which fires once per run.
"""
import json, os, shutil
import numpy as np
import soundfile as sf

OUT = 'out'
FLOOR_DB = -40.0
RATE_LADDER = [16000, 22050, 24000, 32000, 44100, 48000]

# cue -> (source files, duration cap in ms or None, why this family)
PICKS = {
    'impact': (['impact-sounds/impactGeneric_light_%03d.ogg' % i for i in range(5)], None,
               'Tightest length match to the 70 ms synth voice; most consistent set.'),
    'deflect': (['impact-sounds/impactMetal_light_%03d.ogg' % i for i in range(5)], None,
                'Bright and sharp, closest to the 700-1400 Hz triangle shipping now.'),
    'shield.break': (['impact-sounds/impactGlass_heavy_%03d.ogg' % i for i in range(5)], None,
                     'Best objective fit in the pack; glass is the enemy material.'),
    'muzzle': (['sci-fi-sounds/laserRetro_%03d.ogg' % i for i in range(5)], 140,
               'A laser shot is the right semantics for orb-core weapon fire. Capped hard: '
               'the pack has no 60 ms shot, and this is the most-emitted cue in the game.'),
    'clash': (['interface-sounds/tick_001.ogg', 'interface-sounds/tick_002.ogg',
               'interface-sounds/tick_004.ogg'], None,
              '23-55 ms against a 50 ms target, centroid 3786-7920 vs 4894 - the tightest '
              'match found for any cue. Two bullets annihilating is a sharp tick.'),
    'status.shock': (['digital-audio/glitch_%03d.ogg' % i for i in (1, 2, 3, 4)], None,
                     '10-30 ms electric ticks. The semantically obvious zap runs 1019-1228 ms '
                     'and clips - far too long for a status tick that repeats.'),
    'status.chill': (['interface-sounds/glass_%03d.ogg' % i for i in (2, 3, 5, 6)], None,
                     '111-125 ms against a 120 ms target. Glass is both the right timbre for '
                     'ice and the world\'s own material.'),
    'status.poison': (['digital-audio/lowRandom.ogg', 'digital-audio/lowDown.ogg'], 260,
                      'Centroid 249 and 178 Hz against a 236 Hz target - the closest spectral '
                      'match in the whole corpus. Only two files exist at this pitch.'),
    'death': (['sci-fi-sounds/explosionCrunch_%03d.ogg' % i for i in (0, 1, 2)], 600,
              'Centroid 2223-3386 vs 3556. Capped: an unbounded 2 s tail times many '
              'simultaneous deaths is mud.'),
    'pickup.heal': (['digital-audio/pepSound3.ogg', 'digital-audio/pepSound5.ogg'], 300,
                    'Centroid 643 and 808 Hz bracket the 823 Hz target.'),
    'pickup.weapon': (['rpg-audio/drawKnife3.ogg', 'rpg-audio/drawKnife2.ogg'], 300,
                      'Chosen on semantics - it is a weapon pickup. Brighter than the chime '
                      'it replaces, which suits the moment.'),
    'pickup.material': (['rpg-audio/handleCoins2.ogg', 'interface-sounds/pluck_002.ogg'], 260,
                        'handleCoins at 7194 Hz against a 6573 Hz target, and it is literally '
                        'the sound of handling loot. Its sibling file clips; this one does not.'),
    'pickup.buff': (['digital-audio/phaserUp7.ogg', 'digital-audio/phaserUp6.ogg'], 320,
                    'Centroid 1316 and 1230 Hz against a 1427 Hz target.'),
    'wave-clear': (['interface-sounds/confirmation_004.ogg'], 420,
                   'Centroid 1536 vs 1278 Hz. Fires once per wave, so one variant.'),
    'win': (['music-jingles/jingles_PIZZI00.ogg'], None,
            'Centroid 1356 Hz against a 1318 Hz target - near exact. Pizzicato strings over '
            'the chiptune and sax alternatives, which fight the flat-cel world.'),
}

# Cues deliberately left on the synth voice, with the measured reason.
KEPT = {
    'status.burn': 'No fire crackle exists in any of the six packs. The closest family '
                   '(scratch) centres at 6401-12076 Hz against a 2389 Hz target - a high '
                   'scrape, not a burn - and every other candidate is a 5-second engine '
                   'loop. The synth voice is a filtered noise burst at 1800 Hz, which is '
                   'already the right shape.',
}


def rolloff95(x: np.ndarray, sr: int) -> float:
    n = min(len(x), 1 << 15)
    if n < 64:
        return sr / 4
    mag = np.abs(np.fft.rfft(x[:n] * np.hanning(n)))
    freqs = np.fft.rfftfreq(n, 1.0 / sr)
    tot = mag.sum()
    if tot <= 1e-12:
        return sr / 4
    return float(freqs[np.searchsorted(np.cumsum(mag) / tot, 0.95)])


def allowed_rates(roll: float) -> list[int]:
    """Ladder rates that keep ~10% headroom above the 95% rolloff."""
    need = roll * 2.2
    ok = [r for r in RATE_LADDER if r >= need]
    return ok or [RATE_LADDER[-1]]


def encode_smallest(y: np.ndarray, sr_in: int, rates: list[int], path: str) -> tuple[int, int]:
    """Encode at every bandwidth-legal rate and keep the smallest file.

    libsndfile's MP3 encoder picks its own VBR quality per sample rate, so bytes are NOT
    monotonic in rate -- one file is smallest at 16 kHz, another at 24 kHz. Measured
    rather than guessed; the search is 4-6 encodes.
    """
    best = None
    for r in rates:
        z = resample(y, sr_in, r)
        tmp = path + '.%d.tmp' % r
        sf.write(tmp, z, r, format='MP3', subtype='MPEG_LAYER_III')
        n = os.path.getsize(tmp)
        if best is None or n < best[0]:
            if best:
                os.remove(best[2])
            best = (n, r, tmp)
        else:
            os.remove(tmp)
    shutil.move(best[2], path)
    return best[1], best[0]


def resample(x: np.ndarray, sr_in: int, sr_out: int) -> np.ndarray:
    if sr_in == sr_out:
        return x
    n_out = int(round(len(x) * sr_out / sr_in))
    spec = np.fft.rfft(x)
    out_bins = n_out // 2 + 1
    new = np.zeros(out_bins, dtype=complex)
    keep = min(len(spec), out_bins)
    new[:keep] = spec[:keep]
    return np.fft.irfft(new, n_out) * (n_out / len(x))


def trim(x: np.ndarray, sr: int) -> tuple[np.ndarray, float, float]:
    peak = np.max(np.abs(x))
    if peak <= 0:
        return x, 0.0, 0.0
    loud = np.flatnonzero(np.abs(x) > 10 ** (FLOOR_DB / 20) * peak)
    if not loud.size:
        return x, 0.0, 0.0
    pre = int(0.001 * sr)
    a = max(int(loud[0]) - pre, 0)
    b = min(int(loud[-1]) + pre, len(x) - 1)
    cut_h, cut_t = a / sr * 1000, (len(x) - 1 - b) / sr * 1000
    y = x[a:b + 1].copy()
    if cut_h > 0.5:
        n = min(int(0.004 * sr), len(y))
        y[:n] *= np.linspace(0, 1, n)
    if cut_t > 0.5:
        n = min(int(0.008 * sr), len(y))
        y[-n:] *= np.linspace(1, 0, n)
    return y, cut_h, cut_t


def cap(y: np.ndarray, sr: int, cap_ms: int | None) -> tuple[np.ndarray, float]:
    """Fade out at the cap instead of cutting, so the shortened cue cannot click."""
    if cap_ms is None:
        return y, 0.0
    n = int(sr * cap_ms / 1000)
    if len(y) <= n:
        return y, 0.0
    removed = (len(y) - n) / sr * 1000
    z = y[:n].copy()
    f = min(int(0.02 * sr), len(z))
    z[-f:] *= np.linspace(1, 0, f)
    return z, removed


def load_synth_peaks() -> dict:
    """Peaks of the synth cues being replaced, from an audit.py run over their re-renders."""
    return {r['file'].replace('.wav', ''): r for r in json.load(open('synth.json'))}


def main() -> None:
    """Drive the whole conversion. Guarded so the module stays importable for tests."""
    synth = load_synth_peaks()
    # basename -> real path, built once. The packs cross-list some family names
    # (glitch and pluck live in interface-sounds, not digital-audio), so paths are resolved
    # rather than written by hand.
    INDEX = {}
    for root, _, names in os.walk('all'):
        for n in names:
            if n.lower().endswith('.ogg'):
                INDEX.setdefault(n, os.path.join(root, n))


    def resolve(rel: str) -> str:
        base = os.path.basename(rel)
        if base not in INDEX:
            raise SystemExit('no such source file anywhere under all/: %s' % base)
        return INDEX[base]


    if os.path.isdir(OUT):
        shutil.rmtree(OUT)
    os.makedirs(OUT)

    report = []
    for cue, (files, cap_ms, why) in PICKS.items():
        ref_peak = synth[cue]['peak_dbfs']
        for i, rel in enumerate(files):
            src = resolve(rel)
            src_bytes = os.path.getsize(src)
            data, sr = sf.read(src, always_2d=True, dtype='float64')
            mono = data.mean(axis=1)

            y, cut_h, cut_t = trim(mono, sr)
            y, capped = cap(y, sr, cap_ms)
            rates = allowed_rates(rolloff95(y, sr))
            peak = np.max(np.abs(y))
            gain = 10 ** (ref_peak / 20) / peak if peak > 0 else 1.0
            y = np.clip(y * gain, -1.0, 1.0)

            stem = '%s_%02d' % (cue.replace('.', '-'), i)
            path = os.path.join(OUT, stem + '.mp3')
            target_sr, out_bytes = encode_smallest(y, sr, rates, path)
            report.append({
                'cue': cue, 'source': os.path.relpath(src, 'all').replace(os.sep, '/'), 'out': stem, 'sr': target_sr,
                'duration_ms': round(len(y) / sr * 1000, 1),
                'rates_tried': rates,
                'trimmed_ms': round(cut_h + cut_t, 1), 'capped_ms': round(capped, 1),
                'gain_db': round(20 * np.log10(gain), 2),
                'src_bytes': src_bytes, 'mp3_bytes': out_bytes,
                'src_channels': data.shape[1], 'why': why,
            })

    json.dump({'shipped': report, 'kept_synth': KEPT}, open('process.json', 'w'), indent=1)

    print('%-16s %-38s %6s %8s %7s %7s %8s %8s' % (
        'cue', 'source', 'sr', 'dur ms', 'trim', 'cap', 'gain dB', 'bytes'))
    print('-' * 112)
    for r in report:
        print('%-16s %-38s %6d %8.0f %7.0f %7.0f %8.2f %8d' % (
            r['cue'], r['source'], r['sr'], r['duration_ms'], r['trimmed_ms'],
            r['capped_ms'], r['gain_db'], r['mp3_bytes']))
    print('-' * 112)
    tot = sum(r['mp3_bytes'] for r in report)
    srcs = sum(r['src_bytes'] for r in report)
    print('%d files across %d cues: %.1f kB (from %.1f kB of source)'
          % (len(report), len(PICKS), tot / 1024, srcs / 1024))
    print('kept on synth: %s' % ', '.join(KEPT))
    by = {}
    for r in report:
        by.setdefault(r['cue'], []).append(r['mp3_bytes'])
    print('\nper cue: ' + ' | '.join('%s %d×%.1fkB' % (c, len(v), sum(v) / 1024)
                                     for c, v in by.items()))


if __name__ == '__main__':
    main()
