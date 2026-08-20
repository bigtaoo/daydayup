#!/usr/bin/env node
/**
 * CLI: scale a PNG's RGB by a factor chosen from each pixel's OWN luma — a two-point curve, so
 * one range of tones can be pulled down while another is left alone. Alpha is never touched.
 *
 * Why this exists (2026-08-20, the pillar art pass). A generated sprite can land on the right
 * value for one of its surfaces and the wrong value for another, and a uniform multiply cannot
 * fix that: `biome/pillar_neutral.png` came back with its TOP surface already on design/01's
 * tonal target (101 pre-tint, ~88 on screen against a wall cap's 76-88) and its SHAFT roughly
 * twice as bright as the wall FACE beside it (a lit limb of 84 against a wall face's 31-41).
 * A pillar and a wall are the same stone under the same key light, so a vertical surface on one
 * cannot read at double the other. The fold between a bright top and a much darker face is
 * exactly what `wallTone.ts` already does to the wall swatches — this applies the same idea to
 * a sprite, once, offline, instead of paying a per-object filter for it at run time.
 *
 * Usage:
 *   node tools/png-pipeline/lumaCurve.mjs --lo=85 --hi=95 --lo-gain=0.68 --hi-gain=1 file.png
 *
 *   luma <= lo        -> RGB * loGain
 *   luma >= hi        -> RGB * hiGain
 *   in between        -> linearly interpolated gain (so an antialiased edge ramps, not steps)
 *
 * Writes in place, round-trip through `pngCodec.mjs` like `compress.mjs` does. Run it on a copy
 * (the `_raw.png` in `art/` stays the untouched source of truth), before `compress.mjs`.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { decodePNG, encodePNG } from './pngCodec.mjs';

/**
 * Scale an image's RGB in place by a gain interpolated from each pixel's own luma, and return how
 * many pixels were changed. Exported (and the CLI below only runs when this file IS the entry
 * point) so `lumaCurve.test.mjs` can exercise the curve without going through the filesystem.
 *
 * Fully transparent pixels are skipped — their RGB is invisible and a keyed background often
 * leaves stale colour under alpha 0, which there is no reason to rewrite. Alpha itself is never
 * touched by this tool at all.
 */
export function applyLumaCurve(img, { lo = 85, hi = 95, loGain = 0.68, hiGain = 1 } = {}) {
  if (hi <= lo) throw new Error(`--hi (${hi}) must be greater than --lo (${lo})`);
  const d = img.data;
  let touched = 0;
  for (let i = 0; i < d.length; i += 4) {
    if (d[i + 3] === 0) continue;
    const luma = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
    const t = luma <= lo ? 0 : luma >= hi ? 1 : (luma - lo) / (hi - lo);
    const gain = loGain + (hiGain - loGain) * t;
    if (gain === 1) continue;
    d[i] = Math.max(0, Math.min(255, Math.round(d[i] * gain)));
    d[i + 1] = Math.max(0, Math.min(255, Math.round(d[i + 1] * gain)));
    d[i + 2] = Math.max(0, Math.min(255, Math.round(d[i + 2] * gain)));
    touched++;
  }
  return touched;
}

const invokedDirectly =
  process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) runCli();

function runCli() {
  const args = process.argv.slice(2);
  const opts = { lo: 85, hi: 95, loGain: 0.68, hiGain: 1 };
  const files = [];
  for (const arg of args) {
    const m = arg.match(/^--(lo|hi|lo-gain|hi-gain)=([\d.]+)$/);
    if (!m) {
      files.push(arg);
      continue;
    }
    const key = { lo: 'lo', hi: 'hi', 'lo-gain': 'loGain', 'hi-gain': 'hiGain' }[m[1]];
    opts[key] = Number(m[2]);
  }

  if (files.length === 0) {
    console.error('Usage: node lumaCurve.mjs [--lo=85 --hi=95 --lo-gain=0.68 --hi-gain=1] file.png ...');
    process.exit(1);
  }
  if (opts.hi <= opts.lo) {
    console.error(`--hi (${opts.hi}) must be greater than --lo (${opts.lo})`);
    process.exit(1);
  }

  for (const file of files) {
    const img = decodePNG(fs.readFileSync(file));
    const touched = applyLumaCurve(img, opts);
    fs.writeFileSync(file, encodePNG(img));
    console.log(
      `${file}: ${img.width}x${img.height}, ${touched} px scaled ` +
        `(luma<=${opts.lo} by ${opts.loGain}, luma>=${opts.hi} by ${opts.hiGain})`,
    );
  }
}
