import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { applyLumaCurve } from './lumaCurve.mjs';
import { decodePNG, encodePNG } from './pngCodec.mjs';

/**
 * `lumaCurve.applyLumaCurve` — the luma-keyed gain the pillar art pass needed (2026-08-20). Same
 * synthetic-fixture discipline as `pngCodec.test.mjs`: every test builds its own known image, so
 * nothing here depends on a checked-in binary.
 *
 * The reason this tool exists is worth restating, because it is what the tests are protecting: a
 * generated sprite came back with its TOP surface already on target and its SHAFT at twice the
 * value of the wall face beside it. A uniform multiply cannot fix that — it drags the on-target
 * surface down with the wrong one. So the one property that matters is that the curve is
 * SELECTIVE: highlights above `hi` come out untouched at `hiGain: 1`, tones below `lo` are scaled,
 * and the band between ramps rather than steps.
 */
function makeImage(pixels) {
  const data = new Uint8Array(pixels.length * 4);
  pixels.forEach(([r, g, b, a], i) => {
    data[i * 4] = r;
    data[i * 4 + 1] = g;
    data[i * 4 + 2] = b;
    data[i * 4 + 3] = a;
  });
  return { width: pixels.length, height: 1, data };
}

function pixel(img, i) {
  return [img.data[i * 4], img.data[i * 4 + 1], img.data[i * 4 + 2], img.data[i * 4 + 3]];
}

const GREY = (v) => [v, v, v, 255];

describe('applyLumaCurve — a gain chosen per pixel from its own luma', () => {
  it('leaves everything at or above `hi` untouched when hiGain is 1', () => {
    // The whole point: the pillar's top surface (luma 101) must come out of this unchanged while
    // its shaft is pulled down. A uniform multiply is what this test rules out.
    const img = makeImage([GREY(101), GREY(120), GREY(255)]);
    applyLumaCurve(img, { lo: 85, hi: 95, loGain: 0.68, hiGain: 1 });
    expect(pixel(img, 0)).toEqual([101, 101, 101, 255]);
    expect(pixel(img, 1)).toEqual([120, 120, 120, 255]);
    expect(pixel(img, 2)).toEqual([255, 255, 255, 255]);
  });

  it('scales everything at or below `lo` by loGain', () => {
    // The shipped call's real numbers: the shaft's three bands, 84 / 59 / 30 -> 57 / 40 / 20.
    const img = makeImage([GREY(84), GREY(59), GREY(30)]);
    applyLumaCurve(img, { lo: 85, hi: 95, loGain: 0.68, hiGain: 1 });
    expect(pixel(img, 0)[0]).toBe(57);
    expect(pixel(img, 1)[0]).toBe(40);
    expect(pixel(img, 2)[0]).toBe(20);
  });

  it('ramps across the lo..hi band instead of stepping', () => {
    // An antialiased fold between two surfaces passes through this band; a hard step there would
    // draw a visible line of its own along every joint in the art.
    const img = makeImage([GREY(85), GREY(88), GREY(90), GREY(92), GREY(95)]);
    applyLumaCurve(img, { lo: 85, hi: 95, loGain: 0.68, hiGain: 1 });
    const out = [0, 1, 2, 3, 4].map((i) => pixel(img, i)[0]);
    // Exact interpolated values, not just "increasing": a hard step at `lo` also comes out
    // monotonic (88/90/92 pass straight through at hiGain 1), which is how a stepping mutant
    // survived the first version of this test.
    const expected = [85, 88, 90, 92, 95].map((v) => {
      const t = (v - 85) / (95 - 85);
      return Math.round(v * (0.68 + (1 - 0.68) * t));
    });
    expect(out).toEqual(expected);
    expect(out[0]).toBe(Math.round(85 * 0.68)); // exactly at lo -> full loGain
    expect(out[4]).toBe(95); // exactly at hi -> untouched
    expect(out[2]).toBeLessThan(90); // mid-band really is pulled down, not passed through
  });

  it('keys off LUMA, not off each channel independently', () => {
    // A per-channel threshold would treat a saturated pixel as three unrelated tones and shift its
    // hue. Two pixels of the same luma but different hue must take the same gain, and a scaled
    // pixel must keep its channel ratios.
    // The fixture that matters: pure red is luma 76 (below `lo`, so it must be scaled) but its RED
    // CHANNEL is 250 (above `hi`, so a channel-keyed version would leave it alone). A same-luma
    // blue-ish pixel has to take the identical gain.
    const img = makeImage([[250, 0, 0, 255], [90, 90, 30, 255]]);
    const before = [pixel(img, 0), pixel(img, 1)];
    applyLumaCurve(img, { lo: 85, hi: 95, loGain: 0.5, hiGain: 1 });
    for (const i of [0, 1]) {
      const [r, g, b] = pixel(img, i);
      expect([r, g, b]).toEqual(before[i].slice(0, 3).map((c) => Math.round(c * 0.5)));
    }
    expect(pixel(img, 0)[0]).toBe(125); // scaled despite a red channel of 250
  });

  it('never touches alpha, and skips fully transparent pixels entirely', () => {
    // Keyed art leaves stale colour under alpha 0 (the pillar's own background was keyed, not
    // erased); rewriting it would be pointless work, and touching alpha would undo the keying.
    // A DARK transparent pixel on purpose: a bright one would be above `hi` and skipped by the
    // gain check anyway, which is how a mutant with the alpha guard removed survived the first
    // version of this test.
    const img = makeImage([[40, 40, 40, 0], GREY(60), [10, 10, 10, 128]]);
    const touched = applyLumaCurve(img, { lo: 85, hi: 95, loGain: 0.68, hiGain: 1 });
    expect(pixel(img, 0)).toEqual([40, 40, 40, 0]); // untouched, alpha 0
    expect(pixel(img, 1)[3]).toBe(255);
    expect(pixel(img, 2)[3]).toBe(128); // a partially transparent pixel IS scaled, alpha intact
    expect(pixel(img, 2)[0]).toBe(Math.round(10 * 0.68));
    expect(touched).toBe(2);
  });

  it('reports how many pixels it changed, and counts none for an identity curve', () => {
    // `gain === 1` short-circuits, so a no-op run is measurable rather than silently "done" —
    // which is what tells you a curve was configured wrongly instead of applied.
    const img = makeImage([GREY(10), GREY(60), GREY(200)]);
    expect(applyLumaCurve(img, { lo: 85, hi: 95, loGain: 1, hiGain: 1 })).toBe(0);
    expect(pixel(img, 1)).toEqual([60, 60, 60, 255]);
  });

  it('clamps rather than wrapping when a gain would overshoot', () => {
    const img = makeImage([GREY(200)]);
    applyLumaCurve(img, { lo: 10, hi: 20, loGain: 1, hiGain: 4 });
    expect(pixel(img, 0)).toEqual([255, 255, 255, 255]);
  });

  it('refuses a curve whose band is inverted or empty', () => {
    const img = makeImage([GREY(60)]);
    expect(() => applyLumaCurve(img, { lo: 95, hi: 85 })).toThrow();
    expect(() => applyLumaCurve(img, { lo: 90, hi: 90 })).toThrow();
    expect(pixel(img, 0)).toEqual([60, 60, 60, 255]); // and changes nothing on the way out
  });
});

describe('the CLI around it', () => {
  // The module exports `applyLumaCurve` AND runs a CLI, gated on being the entry point — so the
  // gate itself needs exercising: invert it and every unit test above still passes while the
  // pipeline step in `art/biome/prompts.md` silently does nothing.
  const script = fileURLToPath(new URL('./lumaCurve.mjs', import.meta.url));

  function writeTempPng(pixels) {
    const data = new Uint8Array(pixels.length * 4);
    pixels.forEach(([r, g, b, a], i) => {
      data[i * 4] = r; data[i * 4 + 1] = g; data[i * 4 + 2] = b; data[i * 4 + 3] = a;
    });
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'lumacurve-')), 'x.png');
    fs.writeFileSync(file, encodePNG({ width: pixels.length, height: 1, data }));
    return file;
  }

  it('applies the curve in place, with the flags parsed off argv', () => {
    const file = writeTempPng([[84, 84, 84, 255], [120, 120, 120, 255]]);
    const out = execFileSync(process.execPath, [script, '--lo=85', '--hi=95', '--lo-gain=0.68', '--hi-gain=1', file], {
      encoding: 'utf8',
    });
    expect(out).toMatch(/1 px scaled/);
    const img = decodePNG(fs.readFileSync(file));
    expect(img.data[0]).toBe(57); // the 84 came down
    expect(img.data[4]).toBe(120); // the 120 did not
    fs.rmSync(path.dirname(file), { recursive: true, force: true });
  });

  it('fails loudly with no file argument rather than exiting 0 having done nothing', () => {
    expect(() => execFileSync(process.execPath, [script], { encoding: 'utf8', stdio: 'pipe' })).toThrow();
  });
});
