/**
 * The ONLY place the golden-hash gate touches Node. Deliberately `.mjs`, so `tsc` never looks
 * at it (`engine/tsconfig.json` sets `"types": []` on purpose — "the sim core may resolve only
 * itself", and a test's need for `readFileSync` is not a reason to weaken that). Its types are
 * hand-written next door in `goldenFile.d.mts`, which declares only the three signatures below
 * and pulls in no Node typings at all.
 *
 * See design/18-test-strategy.md (Layer 0).
 */
import { readFileSync, writeFileSync } from 'node:fs';

const GOLDEN_URL = new URL('./golden.json', import.meta.url);

/** Absolute path to the fixture, for failure messages that a human can act on. */
export function goldenPath() {
  return GOLDEN_URL.pathname;
}

export function readGolden() {
  return JSON.parse(readFileSync(GOLDEN_URL, 'utf8'));
}

export function writeGolden(value) {
  writeFileSync(GOLDEN_URL, `${JSON.stringify(value, null, 2)}\n`);
}

/** True when driven by `npm run record:golden`, which re-records instead of asserting. */
export function isRecording() {
  return process.env.RECORD_GOLDEN === '1';
}
