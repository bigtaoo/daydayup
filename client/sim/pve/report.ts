/**
 * Aggregation + text rendering for the level simulator's output (CLAUDE.md form ①:
 * pure functions, no engine dependency), so the numbers the balance discussion
 * actually turns on are computed somewhere testable rather than inline in the sim
 * entry point's console.log calls.
 *
 * The unit of the report is the ROOM, not the run: "the run died on floor 1" is not
 * actionable, "the 15-enemy spawn room lands its first hit 8 ticks after waking up
 * and peaks at 6 simultaneous shooters" is.
 */
import type { RoomEncounter, RunMetrics } from './levelSim';

export interface RoomStats {
  key: string; // `${floorIndex}:${roomId}`
  floorIndex: number;
  roomId: string;
  samples: number;
  garrison: number;
  /** Median reaction window (ticks from activation to first damage), null when the
   *  room never hit anyone in any sample. Median, not mean: a single sample where
   *  the bot happened to walk in from a far corner should not move it much. */
  medianReactionTicks: number | null;
  maxPeakShooters: number;
  avgPeakShooters: number;
  avgDamageTaken: number;
  /** Share of samples where the room was cleared (its last enemy died). */
  clearRate: number;
  /** Average ticks from activation to clear, over cleared samples only. */
  avgClearTicks: number | null;
}

export interface RunSummary {
  runs: number;
  extracted: number;
  died: number;
  timedOut: number;
  avgFloorReached: number;
  /** `${floorIndex}:${roomId}` → runs that ended there. */
  deathsByRoom: Record<string, number>;
  avgTicks: number;
  effectiveHp: number;
  maxPeakBurstDamage: number;
  avgPeakBurstDamage: number;
  avgEnemiesKilled: number;
}

export function median(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 === 1 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

export function summarize(runs: readonly RunMetrics[]): RunSummary {
  const deathsByRoom: Record<string, number> = {};
  for (const r of runs) {
    if (r.outcome === 'extracted' || r.endRoom === null) continue;
    const key = `${r.floorReached}:${r.endRoom}`;
    deathsByRoom[key] = (deathsByRoom[key] ?? 0) + 1;
  }
  const n = Math.max(1, runs.length);
  return {
    runs: runs.length,
    extracted: runs.filter((r) => r.outcome === 'extracted').length,
    died: runs.filter((r) => r.outcome === 'died').length,
    timedOut: runs.filter((r) => r.outcome === 'timeout').length,
    avgFloorReached: runs.reduce((a, r) => a + r.floorReached, 0) / n,
    deathsByRoom,
    avgTicks: Math.round(runs.reduce((a, r) => a + r.ticks, 0) / n),
    effectiveHp: runs[0]?.effectiveHp ?? 0,
    maxPeakBurstDamage: Math.max(0, ...runs.map((r) => r.peakBurstDamage)),
    avgPeakBurstDamage: round1(runs.reduce((a, r) => a + r.peakBurstDamage, 0) / n),
    avgEnemiesKilled: round1(runs.reduce((a, r) => a + r.enemiesKilled, 0) / n),
  };
}

/** Per-room aggregation across every run's encounters, in first-seen order (which
 *  is authored floor order — floor 1's spawn room first, exactly where a "seconds
 *  into the run" complaint points). */
export function roomStats(runs: readonly RunMetrics[]): RoomStats[] {
  const grouped = new Map<string, RoomEncounter[]>();
  for (const r of runs) {
    for (const e of r.encounters) {
      const key = `${e.floorIndex}:${e.roomId}`;
      const list = grouped.get(key);
      if (list) list.push(e);
      else grouped.set(key, [e]);
    }
  }

  const out: RoomStats[] = [];
  for (const [key, encounters] of grouped) {
    const first = encounters[0]!;
    const reactions = encounters.map((e) => e.reactionTicks).filter((t): t is number => t !== null);
    const cleared = encounters.filter((e) => e.clearedTick !== null);
    out.push({
      key,
      floorIndex: first.floorIndex,
      roomId: first.roomId,
      samples: encounters.length,
      garrison: Math.max(...encounters.map((e) => e.garrison)),
      medianReactionTicks: median(reactions),
      maxPeakShooters: Math.max(...encounters.map((e) => e.peakShooters)),
      avgPeakShooters: round1(encounters.reduce((a, e) => a + e.peakShooters, 0) / encounters.length),
      avgDamageTaken: round1(encounters.reduce((a, e) => a + e.damageTaken, 0) / encounters.length),
      clearRate: round2(cleared.length / encounters.length),
      avgClearTicks:
        cleared.length === 0 ? null : Math.round(cleared.reduce((a, e) => a + (e.clearedTick! - e.activatedTick), 0) / cleared.length),
    });
  }
  return out.sort((a, b) => a.floorIndex - b.floorIndex || a.roomId.localeCompare(b.roomId));
}

export function formatSummary(label: string, s: RunSummary): string {
  const pct = (n: number) => `${Math.round((n / Math.max(1, s.runs)) * 100)}%`;
  return [
    `--- ${label}: ${s.runs} runs ---`,
    `outcome        extracted ${s.extracted} (${pct(s.extracted)}) · died ${s.died} (${pct(s.died)}) · timeout ${s.timedOut}`,
    `progress       avg floor reached ${round1(s.avgFloorReached)} (0-based) · avg ${s.avgTicks} ticks (${round1(s.avgTicks / 30)}s) · avg ${s.avgEnemiesKilled} kills`,
    `burst damage   worst 1s window ${s.maxPeakBurstDamage} (avg ${s.avgPeakBurstDamage}) vs ${s.effectiveHp} effective HP`,
    `run ended in   ${Object.keys(s.deathsByRoom).length === 0 ? '(nothing — every run extracted)' : JSON.stringify(s.deathsByRoom)}`,
  ].join('\n');
}

export function formatRoomTable(rows: readonly RoomStats[]): string {
  const head = 'floor room                     garrison  react  shooters(max/avg)  dmg   clear%  clearTicks';
  const body = rows.map(
    (r) =>
      `${String(r.floorIndex).padEnd(6)}${r.roomId.padEnd(25)}${String(r.garrison).padEnd(10)}` +
      `${(r.medianReactionTicks ?? '-').toString().padEnd(7)}` +
      `${`${r.maxPeakShooters}/${r.avgPeakShooters}`.padEnd(19)}` +
      `${String(r.avgDamageTaken).padEnd(6)}${String(Math.round(r.clearRate * 100)).padEnd(8)}${r.avgClearTicks ?? '-'}`,
  );
  return [head, ...body].join('\n');
}

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}
function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
