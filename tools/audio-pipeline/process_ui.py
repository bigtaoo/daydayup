"""Produce the UI cue set: 4 cues, 4 files, from the Kenney Interface Sounds CC0 pack.

The counterpart to `process_all.py` for the cues that come from `10`'s screens rather than
from the engine's event queue (design/11, "UI-side cues (button tap, screen transition,
extract/descend commit) come from 10's ScreenManager, not the engine"). It reuses that
script's measurement and encoding helpers unchanged -- mono, trim, bandwidth-driven rate
search, MP3 encode -- and differs in exactly one step, which is why it is a separate driver:

**Where the peak-match reference comes from.** `process_all.py` reads `synth.json`, an audit
of RE-RENDERED synth voices, because those voices stack several `tone()` calls and their peak
is not knowable by reading the table. Every UI voice in `platform/audioSynth.ts` is a SINGLE
`tone()`, whose gain envelope ramps 0 -> `gain` -> 0 over a unit-amplitude oscillator, so its
peak IS its `gain` argument, exactly. No render, no measurement, no scratch input that has to
survive between sessions -- the number below is derived from the voice table and moves only
when that table moves.

**Direction of imitation is reversed here, on purpose.** For the combat set the synth voice
came first and the sample was chosen to match it. There was no UI voice before this pass, so
the SAMPLE was picked first (on the gates in audit.py's `ui` class plus what the pack's own
family names mean), and the synth voice was then written to imitate the picked sample's
measured duration and centroid. Recording it here because "closest match to the incumbent" is
not the rationale for these four files and should not be read into them.
"""
import json, os, shutil
import numpy as np
import soundfile as sf

from process_all import allowed_rates, cap, encode_smallest, rolloff95, trim

OUT = 'out-ui'

# cue -> (source file, duration cap in ms or None, why this file)
PICKS = {
    'ui.tap': ('interface-sounds/select_002.ogg', None,
               '43 ms, centroid 2629 Hz, the shortest clean file in the pack that still has a '
               'body: the 10 ms click_00x pair carries measurable DC bias (0.004-0.005) and, '
               'peak-matched against a 190 ms buzz, a 10 ms transient reads far quieter than '
               'its peak claims. "select" is the pack\'s own name for a selection blip.'),
    'ui.back': ('interface-sounds/back_002.ogg', None,
                '70 ms at 1833 Hz -- the lowest centroid among the clean short files, so the '
                'cue for leaving a screen sits UNDER the cue for entering one. Named for the '
                'job by the pack itself.'),
    'ui.toggle': ('interface-sounds/toggle_004.ogg', None,
                  '66 ms at 6399 Hz with a 0.1 ms attack: the brightest and by far the '
                  'shortest of the four toggle files (the others run 139 ms, which outlasts a '
                  'settings tap). Brightest of the set because a state change is the one UI '
                  'event that should read as "something happened", not just "noted".'),
    'ui.denied': ('interface-sounds/error_007.ogg', 260,
                  '192 ms at 4270 Hz, crest 12.2 -- a sustained buzz rather than a transient, '
                  'which is what separates "refused" from "pressed" even though it sits above '
                  'the tap in pitch. The only error file that is both mono and clean: '
                  'error_002 peaks at +0.6 dBFS (clipped), error_003/005/006 run 500 ms behind '
                  '10-35 ms of lead, and error_001/004 are dual-mono.'),
}

# Peak to match each cue to, in dBFS: 20*log10(the `gain` argument of that cue's voice in
# platform/audioSynth.ts). See the module docstring for why this is exact rather than measured.
# The four sit at roughly -21 dBFS, below every combat cue (impact -14.9, muzzle -18.4) and
# level with the status stings -- a button must be heard, never startle.
VOICE_GAIN = {'ui.tap': 0.09, 'ui.back': 0.09, 'ui.toggle': 0.08, 'ui.denied': 0.10}


def main() -> None:
    """Drive the conversion. Guarded so the module stays importable for tests."""
    if os.path.isdir(OUT):
        shutil.rmtree(OUT)
    os.makedirs(OUT)

    report = []
    for cue, (rel, cap_ms, why) in PICKS.items():
        src = os.path.join('src', rel)
        src_bytes = os.path.getsize(src)
        data, sr = sf.read(src, always_2d=True, dtype='float64')
        mono = data.mean(axis=1)

        y, cut_h, cut_t = trim(mono, sr)
        y, capped = cap(y, sr, cap_ms)
        rates = allowed_rates(rolloff95(y, sr))
        peak = np.max(np.abs(y))
        ref_peak = 20 * np.log10(VOICE_GAIN[cue])
        gain = 10 ** (ref_peak / 20) / peak if peak > 0 else 1.0
        y = np.clip(y * gain, -1.0, 1.0)

        # Variant 00 only. A combat cue needs several files or it machine-guns; a UI cue is a
        # response to the player's OWN finger and has to read as the same affordance every
        # time, so the set is one file per cue plus CueMixer's +/-3% pitch jitter.
        stem = '%s_00' % cue.replace('.', '-')
        path = os.path.join(OUT, stem + '.mp3')
        target_sr, out_bytes = encode_smallest(y, sr, rates, path)
        report.append({
            'cue': cue, 'source': rel, 'out': stem, 'sr': target_sr,
            'duration_ms': round(len(y) / sr * 1000, 1),
            'rates_tried': rates,
            'trimmed_ms': round(cut_h + cut_t, 1), 'capped_ms': round(capped, 1),
            'gain_db': round(20 * np.log10(gain), 2), 'ref_peak_dbfs': round(ref_peak, 2),
            'src_bytes': src_bytes, 'mp3_bytes': out_bytes,
            'src_channels': data.shape[1], 'why': why,
        })

    json.dump({'shipped': report}, open('process-ui.json', 'w'), indent=1)

    print('%-12s %-34s %6s %8s %7s %7s %8s %8s' % (
        'cue', 'source', 'sr', 'dur ms', 'trim', 'cap', 'gain dB', 'bytes'))
    print('-' * 100)
    for r in report:
        print('%-12s %-34s %6d %8.0f %7.0f %7.0f %8.2f %8d' % (
            r['cue'], r['source'], r['sr'], r['duration_ms'], r['trimmed_ms'],
            r['capped_ms'], r['gain_db'], r['mp3_bytes']))
    print('-' * 100)
    tot = sum(r['mp3_bytes'] for r in report)
    print('%d files across %d cues: %.1f kB (from %.1f kB of source)'
          % (len(report), len(PICKS), tot / 1024, sum(r['src_bytes'] for r in report) / 1024))


if __name__ == '__main__':
    main()
