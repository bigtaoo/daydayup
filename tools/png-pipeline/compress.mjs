#!/usr/bin/env node
/**
 * CLI: trim alpha bbox + box-downsample + re-encode one or more PNGs in place,
 * using pngCodec.mjs. Round-trip-verified before writing (see processPNG).
 *
 * Usage: node tools/png-pipeline/compress.mjs [--long-axis=320] file1.png file2.png ...
 */
import fs from 'node:fs';
import { processPNG } from './pngCodec.mjs';

const args = process.argv.slice(2);
let longAxis = 320;
const files = [];
for (const arg of args) {
  const m = arg.match(/^--long-axis=(\d+)$/);
  if (m) longAxis = Number(m[1]);
  else files.push(arg);
}

if (files.length === 0) {
  console.error('Usage: node compress.mjs [--long-axis=320] file1.png [file2.png ...]');
  process.exit(1);
}

for (const file of files) {
  const before = fs.statSync(file).size;
  const buf = fs.readFileSync(file);
  const result = processPNG(buf, { targetLongAxis: longAxis });
  fs.writeFileSync(file, result.buffer);
  const pct = ((1 - result.buffer.length / before) * 100).toFixed(1);
  console.log(`${file}: ${before}B -> ${result.buffer.length}B (-${pct}%), ${result.originalWidth}x${result.originalHeight} -> ${result.width}x${result.height}`);
}
