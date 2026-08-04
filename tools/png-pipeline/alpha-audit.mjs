#!/usr/bin/env node
/**
 * Alpha-channel audit for shipped art assets. Decodes every PNG under the given
 * directories and classifies the alpha channel into:
 *  - opaque: no transparent pixels at all (background never removed — the
 *    "opaque-grey" bug from the art pipeline).
 *  - clean: alpha is essentially bimodal (0 or 255), typical antialiasing-only
 *    edge noise in between.
 *  - haze: a substantial cluster of midtone alpha away from both 0 and 255 —
 *    the "translucent haze" bug (a partial background alpha instead of a clean
 *    chroma-key removal).
 *
 * Usage: node tools/png-pipeline/alpha-audit.mjs [--expect-opaque=glob,...] dir1 dir2 ...
 */
import fs from 'node:fs';
import path from 'node:path';
import { decodePNG } from './pngCodec.mjs';

const args = process.argv.slice(2);
const dirs = args.filter((a) => !a.startsWith('--'));

function walk(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(p));
    else if (entry.name.toLowerCase().endsWith('.png')) out.push(p);
  }
  return out;
}

function classify(data) {
  const hist = new Uint32Array(256);
  let total = 0;
  for (let i = 3; i < data.length; i += 4) {
    hist[data[i]]++;
    total++;
  }
  const at0 = hist[0];
  const at255 = hist[255];
  let partial = 0;
  for (let a = 1; a < 255; a++) partial += hist[a];

  // Look for a midtone cluster: bins 10..245 excluding a thin band right next
  // to 0/255 (antialiasing edge falloff), summed as a fraction of all pixels.
  let midtone = 0;
  for (let a = 10; a <= 245; a++) midtone += hist[a];

  const pctAt0 = at0 / total;
  const pctAt255 = at255 / total;
  const pctPartial = partial / total;
  const pctMidtone = midtone / total;

  let verdict = 'clean';
  if (pctAt0 === 0) verdict = 'OPAQUE (no transparent pixel at all)';
  else if (pctMidtone > 0.10) verdict = 'HAZE (large midtone alpha cluster)';
  else if (pctPartial > 0.35) verdict = 'suspicious (unusually high partial-alpha fraction)';

  return { total, pctAt0, pctAt255, pctPartial, pctMidtone, verdict };
}

const files = dirs.flatMap((d) => (fs.statSync(d).isDirectory() ? walk(d) : [d]));
console.log(`Auditing ${files.length} PNG files...\n`);

const flagged = [];
for (const f of files) {
  const buf = fs.readFileSync(f);
  let stats;
  try {
    const img = decodePNG(buf);
    stats = classify(img.data);
  } catch (e) {
    flagged.push({ f, verdict: `DECODE ERROR: ${e.message}` });
    continue;
  }
  if (stats.verdict !== 'clean') flagged.push({ f, ...stats });
}

if (flagged.length === 0) {
  console.log('All files clean: bimodal alpha (transparent background + opaque subject), no opaque-background or translucent-haze bug detected.');
} else {
  console.log(`${flagged.length} file(s) flagged:\n`);
  for (const item of flagged) {
    console.log(`${item.f}`);
    console.log(`  verdict: ${item.verdict}`);
    if (item.total) {
      console.log(`  alpha==0: ${(item.pctAt0 * 100).toFixed(1)}%  alpha==255: ${(item.pctAt255 * 100).toFixed(1)}%  partial: ${(item.pctPartial * 100).toFixed(1)}%  midtone(10-245): ${(item.pctMidtone * 100).toFixed(1)}%`);
    }
    console.log('');
  }
}
console.log(`\n${files.length - flagged.length}/${files.length} clean.`);
