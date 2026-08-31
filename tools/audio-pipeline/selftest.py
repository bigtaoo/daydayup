"""Self-test for the audio pipeline's measurement and gating layer.

Plain asserts, no pytest — the repo has no Python test infrastructure and this does not
justify adding one. Run it directly:

    ./venv/Scripts/python selftest.py

Every case here exists because something was actually wrong. Two real bugs shipped in
`audit.py` during the first asset pass and both are pinned below:

  * a -12 dBFS peak floor in the `sfx` gate, written for raw library files, which failed 40
    of 46 assets that had been deliberately peak-matched DOWN to the quiet synth cues they
    replace (`quiet_peak_matched_file_passes`);
  * `class_for` matching only a `.` separator, while shipped filenames flatten the cue id's
    dot to a dash — so every `pickup.weapon` asset was held to the combat gate and a correct
    84 ms knife-draw attack was reported as a defect (`cue_class_handles_dash_separator`).

The measurement cases use synthetic signals with known ground truth, because the one thing
that cannot be checked against a real asset is whether the measurement itself is right.
"""
import os
import sys
import tempfile

import numpy as np
import soundfile as sf

import audit
import process_all

SR = 22050
FAILURES: list[str] = []


def check(cond: bool, msg: str) -> None:
    if not cond:
        raise AssertionError(msg)


def write_tmp(y: np.ndarray, sr: int = SR, subtype: str = 'PCM_16') -> str:
    fd, path = tempfile.mkstemp(suffix='.wav')
    os.close(fd)
    sf.write(path, y, sr, format='WAV', subtype=subtype)
    return path


def measure(y: np.ndarray, sr: int = SR, subtype: str = 'PCM_16') -> dict:
    path = write_tmp(y, sr, subtype)
    try:
        return audit.analyse(path)
    finally:
        os.remove(path)


def measure_mp3(y: np.ndarray, sr: int = SR) -> dict:
    """Measure through a real MP3 round-trip.

    The `music` gate includes a `kbps <= 128` limit, which is a statement about the file
    that ships. A 25 s stereo WAV fixture reads 705.6 kbps and can never pass it -- the
    first version of the stereo case below failed on exactly that, and the fixture was
    wrong, not the gate.
    """
    fd, path = tempfile.mkstemp(suffix='.mp3')
    os.close(fd)
    sf.write(path, y, sr, format='MP3', subtype='MPEG_LAYER_III',
             bitrate_mode='VARIABLE', compression_level=0.6)
    try:
        return audit.analyse(path)
    finally:
        os.remove(path)


# --------------------------------------------------------------------------------------
# The two shipped bugs
# --------------------------------------------------------------------------------------

def quiet_peak_matched_file_passes() -> None:
    """A cue peak-matched down to a quiet synth voice is correct, not defective."""
    y = np.sin(2 * np.pi * 1000 * np.arange(int(SR * 0.1)) / SR) * 10 ** (-20 / 20)
    m = measure(y)
    check(-21 < m['peak_dbfs'] < -19, 'peak should be near -20 dBFS, got %s' % m['peak_dbfs'])
    check(not audit.gate(m, 'sfx'), 'a -20 dBFS cue must pass sfx: %s' % audit.gate(m, 'sfx'))
    # The floor still has to catch something genuinely inaudible.
    faint = measure(y * 10 ** (-20 / 20))
    check(any('peak_dbfs' in f for f in audit.gate(faint, 'sfx')),
          'a -40 dBFS file should fail the peak floor')


def cue_class_handles_dash_separator() -> None:
    """Shipped names flatten `pickup.weapon` to `pickup-weapon_00.mp3`."""
    cases = {
        'deflect_02.mp3': 'sfx',
        'muzzle_04.mp3': 'sfx',
        'shield-break_00.mp3': 'sfx',
        'status-poison_01.mp3': 'sfx',
        'status.poison_01.mp3': 'sfx',
        'pickup-weapon_00.mp3': 'feedback',
        'pickup-material_01.mp3': 'feedback',
        'death_02.mp3': 'feedback',
        'wave-clear_00.mp3': 'feedback',
        'win_00.mp3': 'feedback',
        # The UI cues route by the same prefix rule (2026-08-30). Worth a case of its own:
        # a UI click is held to a SHORTER length than a combat cue, so a `ui.*` file that
        # fell through to the default would be gated by the loosest rule that applies to it.
        'ui-tap_00.mp3': 'ui',
        'ui-denied_00.mp3': 'ui',
        'ui.toggle_00.mp3': 'ui',
    }
    for name, want in cases.items():
        got = audit.class_for(name, 'sfx')
        check(got == want, '%s should route to %s, got %s' % (name, want, got))
    # An unknown name falls back to the caller's default rather than guessing.
    check(audit.class_for('mystery_00.mp3', 'loop') == 'loop', 'unknown name must use default')


# --------------------------------------------------------------------------------------
# Measurement against known ground truth
# --------------------------------------------------------------------------------------

def centroid_tracks_a_known_tone() -> None:
    for freq in (400, 1000, 4000):
        y = np.sin(2 * np.pi * freq * np.arange(int(SR * 0.2)) / SR) * 0.5
        c = measure(y)['spectral_centroid_hz']
        check(abs(c - freq) / freq < 0.1,
              'centroid of a %d Hz sine read as %d Hz' % (freq, c))


def lead_silence_measures_real_onset() -> None:
    gap_ms = 50
    gap = np.zeros(int(SR * gap_ms / 1000))
    tone = np.sin(2 * np.pi * 1000 * np.arange(int(SR * 0.05)) / SR) * 0.5
    m = measure(np.concatenate([gap, tone]))
    check(abs(m['lead_silence_ms'] - gap_ms) < 2,
          'expected ~%d ms of lead, measured %s' % (gap_ms, m['lead_silence_ms']))
    check(any('lead_silence' in f for f in audit.gate(m, 'sfx')),
          '50 ms of leading silence must fail the combat gate')
    # The same file is acceptable as a pickup, which is the whole point of the two classes.
    check(not any('lead_silence' in f for f in audit.gate(measure(
        np.concatenate([np.zeros(int(SR * 0.01)), tone])), 'feedback')),
        '10 ms of lead should pass the feedback gate')


def attack_separates_a_hit_from_a_swell() -> None:
    n = int(SR * 0.2)
    t = np.arange(n) / SR
    hit = np.sin(2 * np.pi * 800 * t) * np.exp(-t * 60) * 0.6
    swell = np.sin(2 * np.pi * 800 * t) * np.linspace(0, 0.6, n)
    check(measure(hit)['attack_ms'] < 5, 'a decaying hit should have a near-zero attack')
    check(measure(swell)['attack_ms'] > 100, 'a linear swell should have a long attack')


def clipping_is_detected() -> None:
    clean = np.sin(2 * np.pi * 500 * np.arange(int(SR * 0.1)) / SR) * 0.5
    check(measure(clean)['clipped_samples'] == 0, 'a 0.5 peak sine is not clipped')
    hot = np.clip(np.sin(2 * np.pi * 500 * np.arange(int(SR * 0.1)) / SR) * 2.0, -1, 1)
    m = measure(hot)
    check(m['clipped_samples'] > 0, 'a squared-off sine must report clipped samples')
    check(any('clipped' in f for f in audit.gate(m, 'sfx')), 'clipping must fail the gate')


def dc_offset_is_detected() -> None:
    y = np.sin(2 * np.pi * 500 * np.arange(int(SR * 0.1)) / SR) * 0.3 + 0.2
    m = measure(y)
    check(abs(m['dc_offset'] - 0.2) < 0.01, 'dc offset read as %s' % m['dc_offset'])
    check(any('dc_offset' in f for f in audit.gate(m, 'sfx')), 'DC bias must fail the gate')


def dual_mono_is_detected() -> None:
    mono = np.sin(2 * np.pi * 700 * np.arange(int(SR * 0.1)) / SR) * 0.4
    m = measure(np.stack([mono, mono], axis=1))
    check(m['lr_identical'] is True, 'identical channels must be reported as dual-mono')
    check(m['lr_correlation'] == 1.0, 'identical channels correlate at 1.0')
    check(any('lr_identical' in f for f in audit.gate(m, 'sfx')),
          'dual-mono must be flagged -- it is half the bytes for nothing')
    # Genuinely different channels are stereo, not dual-mono.
    other = np.sin(2 * np.pi * 300 * np.arange(int(SR * 0.1)) / SR) * 0.4
    check(measure(np.stack([mono, other], axis=1))['lr_identical'] is False,
          'different channels must not be called dual-mono')


def loop_seam_finds_a_discontinuity() -> None:
    n = int(SR * 1.0)
    t = np.arange(n) / SR
    # A whole number of cycles wraps cleanly. A quarter cycle short leaves the tail at full
    # amplitude against a zero head -- 10.5 cycles does NOT: it also ends near zero, which is
    # why an earlier version of this case measured almost no step at all.
    clean = np.sin(2 * np.pi * 10 * t) * 0.5
    broken = np.sin(2 * np.pi * 10.25 * t) * 0.5
    a, b = measure(clean), measure(broken)
    check(a['step_db'] < b['step_db'],
          'the discontinuous loop should show the larger step (%s vs %s)'
          % (a['step_db'], b['step_db']))
    check(any('step_db' in f for f in audit.gate(b, 'loop')),
          'a clicking wrap point must fail the loop gate')


def silence_is_reported_rather_than_passed() -> None:
    m = measure(np.zeros(int(SR * 0.1)))
    check(m.get('silent') is True, 'an all-zero file must be reported as silent')
    check(any('silent' in f for f in audit.gate(m, 'sfx')), 'silence must fail the gate')


# --------------------------------------------------------------------------------------
# The conversion side
# --------------------------------------------------------------------------------------

def allowed_rates_respects_bandwidth() -> None:
    """The rate search may only consider rates that preserve the measured rolloff."""
    low = process_all.allowed_rates(1000.0)
    check(16000 in low, 'a 1 kHz rolloff should permit 16 kHz')
    # 10.8 kHz is impactGlass_heavy_003's real rolloff -- 2.2x it is 23.8 kHz, so both 16 and
    # 22.05 are out. (An earlier version of this case used 10 kHz and wrongly expected 22.05
    # to be excluded: 2.2 x 10 kHz is 22 kHz, which 22.05 clears.)
    high = process_all.allowed_rates(10800.0)
    check(16000 not in high and 22050 not in high,
          'a 10.8 kHz rolloff must exclude 16/22.05 kHz, got %s' % high)
    for roll in (500.0, 1000.0, 4600.0, 10800.0):
        for r in process_all.allowed_rates(roll):
            check(r >= roll * 2.2,
                  'rate %d does not clear 2.2x a %.0f Hz rolloff' % (r, roll))
    # Nothing legal still returns something, rather than an empty search.
    check(process_all.allowed_rates(1e6) == [max(process_all.RATE_LADDER)],
          'an impossible rolloff should fall back to the top rate')


def rolloff_tracks_bandwidth() -> None:
    lo = np.sin(2 * np.pi * 500 * np.arange(SR) / SR) * 0.5
    hi = np.sin(2 * np.pi * 8000 * np.arange(SR) / SR) * 0.5
    r_lo = process_all.rolloff95(lo, SR)
    r_hi = process_all.rolloff95(hi, SR)
    check(r_lo < 1500, '500 Hz tone rolloff read as %.0f Hz' % r_lo)
    check(r_hi > 7000, '8 kHz tone rolloff read as %.0f Hz' % r_hi)


def trim_removes_silence_without_clicking() -> None:
    gap = np.zeros(int(SR * 0.1))
    tone = np.sin(2 * np.pi * 800 * np.arange(int(SR * 0.05)) / SR) * 0.5
    y, cut_h, cut_t = process_all.trim(np.concatenate([gap, tone, gap]), SR)
    check(abs(cut_h - 100) < 3, 'expected ~100 ms trimmed from the head, got %.1f' % cut_h)
    check(abs(cut_t - 100) < 3, 'expected ~100 ms trimmed from the tail, got %.1f' % cut_t)
    # Faded edges: a hard cut would leave the first sample at full amplitude.
    check(abs(y[0]) < 0.01, 'trimmed head must start from silence, got %.3f' % y[0])
    check(abs(y[-1]) < 0.01, 'trimmed tail must end in silence, got %.3f' % y[-1])


def cap_shortens_with_a_fade() -> None:
    y = np.sin(2 * np.pi * 400 * np.arange(int(SR * 1.0)) / SR) * 0.5
    z, removed = process_all.cap(y, SR, 200)
    check(abs(len(z) / SR * 1000 - 200) < 2, 'cap should leave ~200 ms, got %d' % len(z))
    check(abs(removed - 800) < 5, 'cap should report ~800 ms removed, got %.0f' % removed)
    check(abs(z[-1]) < 0.01, 'a capped cue must fade out, not cut (last sample %.3f)' % z[-1])
    # A cue already under the cap is returned untouched.
    same, none = process_all.cap(y, SR, 5000)
    check(len(same) == len(y) and none == 0, 'a short cue must pass through the cap unchanged')


def resample_preserves_duration_and_pitch() -> None:
    y = np.sin(2 * np.pi * 1000 * np.arange(int(SR * 0.5)) / SR) * 0.5
    for target in (16000, 32000, 44100):
        z = process_all.resample(y, SR, target)
        check(abs(len(z) / target - 0.5) < 0.005,
              'resample to %d changed the duration' % target)
        m = measure(z, target)
        check(abs(m['spectral_centroid_hz'] - 1000) / 1000 < 0.1,
              'resample to %d moved the 1 kHz tone to %d Hz'
              % (target, m['spectral_centroid_hz']))


# --------------------------------------------------------------------------------------
# The music loops (2026-08-31). Every case below is a bug that actually happened while the
# music gate was being written, not a hypothetical.
# --------------------------------------------------------------------------------------


def cue_class_routes_music_by_directory() -> None:
    """A 69 s stereo bed must not inherit the COMBAT gate by having no cue prefix.

    Music ships as `audio/music/<track>.mp3`. Names like `menu.mp3` match no prefix in
    CUE_CLASS, so before the directory rule they fell through to the caller's default and
    `--by-cue` reported the two shipped beds as "too long" and "stereo wastes bytes".
    """
    paths = ['music/menu.mp3', 'client/public/audio/music/boss.mp3',
             'client\\public\\audio\\music\\boss.mp3']
    for path in paths:
        got = audit.class_for(path, 'sfx')
        check(got == 'music', '%s should route to music, got %s' % (path, got))
    # The directory rule must not swallow the cue set that lives one level up, and a bare
    # name with no directory is NOT music -- it is unknown, so it takes the default.
    check(audit.class_for('client/public/audio/deflect_00.mp3', 'sfx') == 'sfx',
          'a combat cue beside the music directory must stay sfx')
    check(audit.class_for('menu.mp3', 'sfx') == 'sfx',
          'a bare name is unknown, not music -- the directory is the signal')


def band_profile_floors_empty_bands() -> None:
    """An empty band read -inf, and (-inf) - (-inf) is nan, which silently poisoned the
    crossfade measure into `nan` -- a value that fails `< limit` AND fails `> limit`."""
    sr = 48000
    t = np.arange(sr) / sr
    tone = 0.3 * np.sin(2 * np.pi * 400 * t)
    prof = audit.band_profile(tone, sr)
    check(bool(np.all(np.isfinite(prof))), 'no band may read -inf: %s' % prof[:4])
    check(prof.min() >= audit.BAND_FLOOR_DB - 1e-9,
          'bands must be floored, got %s' % prof.min())
    check(np.isfinite(float(np.abs(prof - prof).mean())),
          'profile differences must be finite')


def xfade_band_diff_sees_a_tonal_lurch() -> None:
    """The measure that replaces `step_db` for music, against known ground truth.

    Also pins the short-file contract: too short returns nan rather than a small number,
    because a confident 0.0 on a file that was never measured is the worse failure.
    """
    sr = 22050
    t = np.arange(sr) / sr
    per = np.stack([0.3 * np.sin(2 * np.pi * 440 * t),
                    0.3 * np.sin(2 * np.pi * 660 * t)], axis=1)
    same = np.concatenate([per] * 10)
    got = audit.xfade_band_diff(same, sr)
    check(not np.isnan(got) and got < 0.5, 'a periodic loop should read ~0, got %s' % got)
    other = np.stack([0.3 * np.sin(2 * np.pi * 3000 * t),
                      0.3 * np.sin(2 * np.pi * 3300 * t)], axis=1)
    lurch = audit.xfade_band_diff(np.concatenate([per] * 9 + [other]), sr)
    check(lurch > 5.0, 'a tail two octaves up must read as a lurch, got %s' % lurch)
    check(np.isnan(audit.xfade_band_diff(per, sr)),
          'a file shorter than 4x the crossfade must report nan, not a number')


def profile_diff_weights_by_energy_not_by_band_count() -> None:
    """A band carrying no signal must not get an equal vote.

    Unweighted, `profile_diff` averaged 30 bands equally, so bands sitting near -100 dBFS --
    where the only content is FFT leakage whose phase differs between the head and tail
    windows -- dominated the result. A two-sine bed whose head and tail are IDENTICAL by
    construction measured 6.12 dB that way, enough to fail the gate on nothing at all.
    """
    sr = 22050
    t = np.arange(sr) / sr
    per = np.stack([0.3 * np.sin(2 * np.pi * 700 * t),
                    0.3 * np.sin(2 * np.pi * 900 * t)], axis=1)
    identical = np.concatenate([per] * 12)
    got = audit.xfade_band_diff(identical, sr)
    check(got < 0.5, 'a bed identical head-to-tail must read ~0, got %s' % got)
    # And the weighting must not flatten a real difference into nothing: a tail whose LOUD
    # bands have moved still has to register.
    prof_a = audit.band_profile(per[:, 0], sr)
    prof_b = audit.band_profile(np.sin(2 * np.pi * 3000 * t) * 0.3, sr)
    check(audit.profile_diff(prof_a, prof_b) > 5.0,
          'a genuinely different profile must still read large, got %s'
          % audit.profile_diff(prof_a, prof_b))
    # Two silent profiles are equal, not a division by zero.
    flat = np.full(audit.BAND_N, audit.BAND_FLOOR_DB)
    check(audit.profile_diff(flat, flat) == 0.0, 'two floored profiles differ by 0')


def music_gate_accepts_stereo_and_ignores_the_sample_step() -> None:
    """The two deliberate differences between `music` and `loop`, asserted as behaviour.

    A bed built to wrap under a crossfade has a large end->start sample step by
    construction, and MP3 frame padding makes `el.loop = true` unusable anyway. If someone
    reinstates `step_db` or a `channels` limit for music, this fails.
    """
    sr = 22050
    t = np.arange(sr * 25) / sr
    bed = np.stack([np.sin(2 * np.pi * 700 * t), np.sin(2 * np.pi * 900 * t)], axis=1)
    bed = bed * (10 ** ((-30.0 - audit.band_rms(bed, sr, 250.0, 2000.0)) / 20.0))
    m = measure_mp3(bed, sr)
    check(m['channels'] == 2, 'the fixture must be stereo to test the point')
    check(m['step_db'] is not None and m['step_db'] > -50,
          'the fixture must have a real end->start step, got %s' % m['step_db'])
    fails = audit.gate(m, 'music')
    check(not fails, 'a level-correct stereo bed must pass `music`: %s' % fails)
    check(any('step_db' in f for f in audit.gate(m, 'loop')),
          '`loop` must still reject it on step_db -- otherwise the two classes are the same')


def music_gate_holds_the_mix_level() -> None:
    """The level decision is the gate's job, not a comment in the pipeline.

    An AI master arrives near 0 dBFS; the shipped cues peak at -14..-21. A track that skips
    the level step is exactly the failure with no visible symptom until combat is inaudible
    under it, so it is measured rather than trusted.
    """
    sr = 22050
    t = np.arange(sr * 25) / sr
    bed = np.stack([np.sin(2 * np.pi * 700 * t), np.sin(2 * np.pi * 900 * t)], axis=1)
    hot = bed * (10 ** ((-12.0 - audit.band_rms(bed, sr, 250.0, 2000.0)) / 20.0))
    m = measure_mp3(hot, sr)
    check(abs(m['mid_band_dbfs'] - (-12.0)) < 0.3,
          'mid band should read -12 dBFS, got %s' % m['mid_band_dbfs'])
    check(any('mid_band_dbfs' in f for f in audit.gate(m, 'music')),
          'an unattenuated master must fail the music gate')


def music_gate_rejects_a_short_file_rather_than_skipping_it() -> None:
    """`gate()` skips a measure whose value is None, and the music measures ARE None below
    4x the crossfade window -- so a 100 ms cue mis-filed under music/ would pass every band
    check. The duration floor is what stops that being a silent pass."""
    sr = 22050
    t = np.arange(sr // 10) / sr
    one = 0.3 * np.sin(2 * np.pi * 700 * t)
    m = measure(np.stack([one, one * 0.5], axis=1), sr)
    check(m['xfade_band_diff'] is None and m['mid_band_dbfs'] is None,
          'a 100 ms file must report None for the music measures, got %s' % m)
    fails = audit.gate(m, 'music')
    check(any('duration_ms' in f for f in fails),
          'a short file under music/ must fail on duration, not slip through: %s' % fails)


def dual_mono_music_is_still_a_defect() -> None:
    """Stereo is allowed for music; a FAKE stereo file is still half wasted bytes."""
    sr = 22050
    t = np.arange(sr * 25) / sr
    one = 0.05 * np.sin(2 * np.pi * 700 * t)
    m = measure(np.stack([one, one], axis=1), sr)
    check(m['lr_identical'] is True, 'bit-identical channels must be reported')
    check(any('lr_identical' in f for f in audit.gate(m, 'music')),
          'dual-mono must fail the music gate too')


TESTS = [
    quiet_peak_matched_file_passes,
    cue_class_handles_dash_separator,
    centroid_tracks_a_known_tone,
    lead_silence_measures_real_onset,
    attack_separates_a_hit_from_a_swell,
    clipping_is_detected,
    dc_offset_is_detected,
    dual_mono_is_detected,
    loop_seam_finds_a_discontinuity,
    silence_is_reported_rather_than_passed,
    allowed_rates_respects_bandwidth,
    rolloff_tracks_bandwidth,
    trim_removes_silence_without_clicking,
    cap_shortens_with_a_fade,
    resample_preserves_duration_and_pitch,
    cue_class_routes_music_by_directory,
    band_profile_floors_empty_bands,
    xfade_band_diff_sees_a_tonal_lurch,
    profile_diff_weights_by_energy_not_by_band_count,
    music_gate_accepts_stereo_and_ignores_the_sample_step,
    music_gate_holds_the_mix_level,
    music_gate_rejects_a_short_file_rather_than_skipping_it,
    dual_mono_music_is_still_a_defect,
]

if __name__ == '__main__':
    for t in TESTS:
        try:
            t()
            print('  ok   %s' % t.__name__)
        except Exception as e:  # noqa: BLE001 - a self-test reports, it does not raise
            FAILURES.append('%s: %s' % (t.__name__, e))
            print('  FAIL %s\n         %s' % (t.__name__, e))
    print('\n%d/%d passed' % (len(TESTS) - len(FAILURES), len(TESTS)))
    sys.exit(1 if FAILURES else 0)
