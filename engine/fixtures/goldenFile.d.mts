/**
 * Types for `goldenFile.mjs`. Hand-written precisely so the engine workspace keeps its
 * `"types": []` posture — nothing here references a Node global, so importing this does not
 * quietly give the sim core access to `fs`/`process` anywhere else.
 */
import type { Witness } from './goldenScenarios';

export interface GoldenEntry {
  name: string;
  pins: string;
  ticks: number;
  hash: number;
  witness: Witness;
}

/**
 * No timestamp field on purpose: it would churn the diff on every re-record and tell a reviewer
 * nothing `git log` does not. `engineVersion` is the field that carries meaning — it is what
 * `versionContract.test.ts` cross-checks so a re-record without a bump cannot slip through.
 */
export interface GoldenFile {
  engineVersion: number;
  scenarios: GoldenEntry[];
}

export function goldenPath(): string;
export function readGolden(): GoldenFile;
export function writeGolden(value: GoldenFile): void;
export function isRecording(): boolean;
