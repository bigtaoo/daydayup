import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { applyAlphaClamp } from './alphaClamp.mjs';
import { decodePNG, encodePNG, trimAlphaBoundingBox } from './pngCodec.mjs';

/**
 * `alphaClamp.applyAlphaClamp` — the plateau cleanup the room-prop art pass needed
 * (2026-08-24). Same synthetic-fixture discipline as `lumaCurve.test.mjs`: every test builds
 * its own known image, so nothing here depends on a checked-in binary.
 *
 * The reason this tool exists is what the tests are protecting. Three generations came back
 * with an alpha histogram that reads bimodal and is not: a body at 252-253 instead of 255,
 * inside a veil of 1-10 reaching 50-140 px past the object. So the properties that matter are
 * that each end is a THRESHOLD and not a rescale (real edge values must survive untouched),
 * that RGB is never read or written, and — the one that actually caused the bug — that
 * running it before a trim recovers the object's true bounding box.
 */
function makeImage(width, height, alphaAt) {
  const data = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      data[i] = 200;
      data[i + 1] = 100;
      data[i + 2] = 50;
      data[i + 3] = alphaAt(x, y);
    }
  }
  return { width, height, data };
}

function alphaRow(img) {
  const out = [];
  for (let x = 0; x < img.width; x++) out.push(img.data[x * 4 + 3]);
  return out;
}

describe('applyAlphaClamp — snapping both alpha plateaus', () => {
  it('clears the low plateau and solidifies the high one, leaving the middle alone', () => {
    const img = makeImage(9, 1, (x) => [0, 1, 8, 9, 40, 200, 249, 253, 255][x]);
    applyAlphaClamp(img, { floor: 8, ceiling: 250 });
    expect(alphaRow(img)).toEqual([0, 0, 0, 9, 40, 200, 249, 255, 255]);
  });

  it('is a pair of thresholds, not a rescale — a surviving value keeps its exact alpha', () => {
    const img = makeImage(5, 1, (x) => [9, 10, 128, 240, 249][x]);
    applyAlphaClamp(img, { floor: 8, ceiling: 250 });
    // The bug this guards: "normalize the alpha range" implemented as a linear remap would
    // shift every one of these, and a shipped file's real antialiasing would change shape.
    expect(alphaRow(img)).toEqual([9, 10, 128, 240, 249]);
  });

  it('never touches RGB, on either the cleared or the solidified side', () => {
    const img = makeImage(2, 1, (x) => [4, 253][x]);
    applyAlphaClamp(img);
    for (let x = 0; x < 2; x++) {
      expect([img.data[x * 4], img.data[x * 4 + 1], img.data[x * 4 + 2]]).toEqual([200, 100, 50]);
    }
  });

  it('reports each side separately, and counts nothing on an already-clean image', () => {
    const img = makeImage(6, 1, (x) => [0, 3, 7, 128, 252, 255][x]);
    expect(applyAlphaClamp(img, { floor: 8, ceiling: 250 })).toEqual({ cleared: 2, solidified: 1 });
    // Pixels already at 0/255 are not work done, or an idempotent second run would report
    // the same numbers again and the count would stop meaning anything.
    expect(applyAlphaClamp(img, { floor: 8, ceiling: 250 })).toEqual({ cleared: 0, solidified: 0 });
  });

  it('defaults to floor 8 / ceiling 250 — the measured gap, not round numbers', () => {
    const img = makeImage(4, 1, (x) => [8, 9, 249, 250][x]);
    applyAlphaClamp(img);
    expect(alphaRow(img)).toEqual([0, 9, 249, 255]);
  });

  it('refuses a floor or ceiling out of range, or a band that is inverted', () => {
    const one = () => makeImage(1, 1, () => 5);
    expect(() => applyAlphaClamp(one(), { floor: 255 })).toThrow(/--floor/);
    expect(() => applyAlphaClamp(one(), { floor: -1 })).toThrow(/--floor/);
    expect(() => applyAlphaClamp(one(), { floor: 2.5 })).toThrow(/--floor/);
    expect(() => applyAlphaClamp(one(), { ceiling: 0 })).toThrow(/--ceiling/);
    expect(() => applyAlphaClamp(one(), { ceiling: 256 })).toThrow(/--ceiling/);
    expect(() => applyAlphaClamp(one(), { floor: 200, ceiling: 100 })).toThrow(/greater than/);
  });

  it('recovers the true bounding box a veil had corrupted — the bug it was written for', () => {
    // A 4x2 solid object centred in a 12x8 canvas, wrapped in a 2 px veil of alpha 4. That
    // veil is what the generator actually produced; it reaches past the object on every side.
    const solid = { x0: 4, x1: 7, y0: 3, y1: 4 };
    const img = makeImage(12, 8, (x, y) => {
      const inSolid = x >= solid.x0 && x <= solid.x1 && y >= solid.y0 && y <= solid.y1;
      if (inSolid) return 253;
      const inVeil = x >= solid.x0 - 2 && x <= solid.x1 + 2 && y >= solid.y0 - 2 && y <= solid.y1 + 2;
      return inVeil ? 4 : 0;
    });

    const veiled = trimAlphaBoundingBox({ ...img, data: Uint8Array.from(img.data) });
    expect([veiled.width, veiled.height]).toEqual([8, 6]);
    // Aspect and bottom margin are the two things the prop pipeline reads off a trim, and
    // the veil wrecks both: 8/6 instead of 4/2, and two empty rows under a bottom anchor.
    expect(veiled.width / veiled.height).toBeCloseTo(1.333, 3);

    applyAlphaClamp(img);
    const cleaned = trimAlphaBoundingBox(img);
    expect([cleaned.width, cleaned.height]).toEqual([4, 2]);
    expect(cleaned.width / cleaned.height).toBeCloseTo(2, 3);
    // ...and the body is genuinely opaque now, which is what `alpha-audit.mjs` classifies on.
    expect(cleaned.data[3]).toBe(255);
  });
});

describe('the CLI around it', () => {
  const script = fileURLToPath(new URL('./alphaClamp.mjs', import.meta.url));
  let dir;

  function writeFixture(name, img) {
    const file = path.join(dir, name);
    fs.writeFileSync(file, encodePNG(img));
    return file;
  }

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'alphaclamp-'));
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('applies both clamps in place, with the flags parsed off argv', () => {
    const file = writeFixture('a.png', makeImage(5, 1, (x) => [3, 12, 30, 240, 255][x]));
    execFileSync(process.execPath, [script, '--floor=15', '--ceiling=235', file], { encoding: 'utf8' });
    expect(alphaRow(decodePNG(fs.readFileSync(file)))).toEqual([0, 0, 30, 255, 255]);
  });

  it('fails loudly with no file argument rather than exiting 0 having done nothing', () => {
    expect(() => execFileSync(process.execPath, [script], { encoding: 'utf8', stdio: 'pipe' })).toThrow();
  });
});
