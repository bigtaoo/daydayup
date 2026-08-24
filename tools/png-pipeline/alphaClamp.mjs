#!/usr/bin/env node
/**
 * CLI: snap a generation's two near-flat alpha plateaus to true 0 and true 255, so neither
 * a sub-perceptual halo nor a 99%-opaque body survives into the shipped file. RGB is never
 * touched.
 *
 * Why this exists (2026-08-24, the room-prop art pass). The generator produces alpha that
 * *looks* bimodal and is not quite: a body sitting at 252-253 rather than 255, wrapped in a
 * veil of 1-10 spreading 50-140 px past the object. Both are invisible — 99% and 4% opacity
 * — and `alpha-audit.mjs` reads the pair as one "suspicious" file with no opaque pixels at
 * all. Each end causes a different real defect:
 *
 *   - **The low end wrecks the geometry.** `trimAlphaBoundingBox` keeps any pixel with
 *     `alpha !== 0`, so the veil became part of the object. The rubble's trimmed aspect came
 *     out 2.95 against its real 3.69 (**20% wrong**), and `buildPropBody` scales a prop by
 *     WIDTH and lets the art's aspect set its height — the prop would have stood 25% too
 *     tall. The trim also kept 123 empty rows under the rubble and 138 under the barrel, and
 *     a prop sprite is bottom-anchored to its ground point, so both would have hovered.
 *   - **The high end is a false positive forever.** `alpha-audit.mjs` classifies on
 *     `alpha == 255`, so a 253 plateau reports 0% opaque / 83% partial on a file that is
 *     actually clean, and the audit stops being a signal anyone reads.
 *
 * Every file shipped before this pass measures identically at `alpha > 0` and `alpha > 25`
 * (checked: pillar, portal arch, the five drops, both doors) — they were all keyed or
 * thresholded on import, so this had never yet come up. Run this BEFORE `compress.mjs`, not
 * after: compress is what trims, and the point is to fix the alpha before the trim reads it.
 *
 * Usage:
 *   node tools/png-pipeline/alphaClamp.mjs [--floor=8] [--ceiling=250] file1.png [file2.png ...]
 *
 *   alpha <= floor    -> 0
 *   alpha >= ceiling  -> 255
 *   in between        -> unchanged
 *
 * Both defaults sit in a measured gap rather than on a round number. Real antialiasing ramps
 * 0->255 across a pixel or two, so it puts only ~0.2% of a file's pixels in 246-249 and a
 * similar sliver just above 8; the plateaus themselves held 43-74% (at 252-253) and 0.3-0.6%
 * (at 1-10). Verify the same way this pass did: after the clamp, the trimmed bbox should
 * match the bbox measured at `alpha > 25` on the original, and `alpha-audit.mjs` should call
 * the file clean.
 *
 * Writes in place, round-trip through `pngCodec.mjs` like `compress.mjs`/`lumaCurve.mjs` do.
 * Run it on a copy — the `_raw.png` in `art/` stays the untouched source of truth.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { decodePNG, encodePNG } from './pngCodec.mjs';

/**
 * Snap alpha at or below `floor` to 0 and at or above `ceiling` to 255, in place, and return
 * `{ cleared, solidified }` counts. Exported (the CLI below only runs when this file IS the
 * entry point) so `alphaClamp.test.mjs` can exercise it without going through the filesystem.
 *
 * RGB is left exactly as it was, including under the pixels this zeroes: a keyed background
 * routinely leaves stale colour beneath alpha 0, and nothing reads it.
 */
export function applyAlphaClamp(img, { floor = 8, ceiling = 250 } = {}) {
  if (!Number.isInteger(floor) || floor < 0 || floor > 254) {
    throw new Error(`--floor (${floor}) must be an integer in 0..254`);
  }
  if (!Number.isInteger(ceiling) || ceiling < 1 || ceiling > 255) {
    throw new Error(`--ceiling (${ceiling}) must be an integer in 1..255`);
  }
  if (ceiling <= floor) {
    throw new Error(`--ceiling (${ceiling}) must be greater than --floor (${floor})`);
  }
  const d = img.data;
  let cleared = 0;
  let solidified = 0;
  for (let i = 3; i < d.length; i += 4) {
    if (d[i] !== 0 && d[i] <= floor) {
      d[i] = 0;
      cleared++;
    } else if (d[i] !== 255 && d[i] >= ceiling) {
      d[i] = 255;
      solidified++;
    }
  }
  return { cleared, solidified };
}

// Same entry-point guard `lumaCurve.mjs` uses — a `file://` string comparison does not
// survive Windows path separators, and getting it wrong silently disables the whole CLI.
const invokedDirectly =
  process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) runCli();

function runCli() {
  const args = process.argv.slice(2);
  let floor = 8;
  let ceiling = 250;
  const files = [];
  for (const arg of args) {
    const f = arg.match(/^--floor=(\d+)$/);
    const c = arg.match(/^--ceiling=(\d+)$/);
    if (f) floor = Number(f[1]);
    else if (c) ceiling = Number(c[1]);
    else files.push(arg);
  }
  if (files.length === 0) {
    console.error('Usage: node alphaClamp.mjs [--floor=8] [--ceiling=250] file1.png [file2.png ...]');
    process.exit(1);
  }
  for (const file of files) {
    const img = decodePNG(fs.readFileSync(file));
    const { cleared, solidified } = applyAlphaClamp(img, { floor, ceiling });
    fs.writeFileSync(file, encodePNG(img));
    const total = img.width * img.height;
    const pct = (n) => ((n / total) * 100).toFixed(3);
    console.log(
      `${file}: cleared ${cleared} px (${pct(cleared)}%) at alpha <= ${floor}, ` +
        `solidified ${solidified} px (${pct(solidified)}%) at alpha >= ${ceiling}`,
    );
  }
}
