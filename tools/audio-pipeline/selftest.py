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
