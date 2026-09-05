/**
 * report.ts — the level simulator's aggregation + text rendering. Pure functions over
 * `RunMetrics`, so the fixtures below are hand-written metric rows rather than real
 * runs: what matters here is that the numbers the balance decisions are read off
 * (median reaction window, peak shooters, clear rate, death-room histogram) are
 * computed correctly, independently of whether a run happens to produce them.
 */
import { describe, expect, it } from 'vitest';
import { floorDropStats, formatDropTable, formatRoomTable, formatSummary, median, roomStats, summarize } from './report';
import type { DropRecord, RoomEncounter, RunMetrics } from './levelSim';

function enc(over: Partial<RoomEncounter> = {}): RoomEncounter {
  return {
    floorIndex: 0,
    roomId: 'r1',
    activatedTick: 100,
    clearedTick: 400,
    garrison: 8,
    reactionTicks: 40,
    peakShooters: 2,
    damageTaken: 5,
    ...over,
  };
}

function run(over: Partial<RunMetrics> = {}): RunMetrics {
  return {
    seed: 1,
    profileName: 'careful',
    skinId: 'vanguard',
    outcome: 'died',
    ticks: 1000,
    floorReached: 0,
    endRoom: 'r1',
    encounters: [enc()],
    enemiesKilled: 8,
    damageTaken: 9,
    peakBurstDamage: 5,
    effectiveHp: 9.2,
    lowestHpFrac: 0.1,
    drops: [],
    killsByFloor: { 0: 8 },
    checkpointFloors: [],
    ...over,
  };
}

/** A drop record; `kind` and `floorIndex` are what every assertion below turns on. */
function drop(over: Partial<DropRecord> = {}): DropRecord {
  return { floorIndex: 0, roomId: 'r1', kind: 'material', tick: 200, ...over };
}

describe('median', () => {
  it('is null for an empty sample', () => {
    expect(median([])).toBeNull();
  });

  it('takes the middle of an odd count and the mean of the two middles of an even count', () => {
    expect(median([5, 1, 3])).toBe(3);
    expect(median([4, 1, 3, 2])).toBe(2.5);
  });

  it('does not mutate its input', () => {
    const input = [3, 1, 2];
    median(input);
    expect(input).toEqual([3, 1, 2]);
  });
});

describe('summarize', () => {
  it('counts outcomes and averages progress', () => {
    const s = summarize([
      run({ outcome: 'extracted', floorReached: 4, ticks: 5000 }),
      run({ outcome: 'died', floorReached: 2, ticks: 3000 }),
      run({ outcome: 'timeout', floorReached: 1, ticks: 40000 }),
    ]);
    expect([s.runs, s.extracted, s.died, s.timedOut]).toEqual([3, 1, 1, 1]);
    expect(s.avgFloorReached).toBeCloseTo(2.3, 1);
    expect(s.avgTicks).toBe(16000);
  });

  it('buckets where runs ENDED by floor:room, and never counts an extraction as a death', () => {
    const s = summarize([
      run({ outcome: 'died', floorReached: 0, endRoom: 'r1' }),
      run({ outcome: 'died', floorReached: 0, endRoom: 'r1' }),
      run({ outcome: 'timeout', floorReached: 2, endRoom: 'r5' }),
      run({ outcome: 'extracted', floorReached: 4, endRoom: 'r5' }),
    ]);
    expect(s.deathsByRoom).toEqual({ '0:r1': 2, '2:r5': 1 });
  });

  it('reports the worst burst window across runs alongside the effective HP it must be read against', () => {
    const s = summarize([run({ peakBurstDamage: 4 }), run({ peakBurstDamage: 11 })]);
    expect(s.maxPeakBurstDamage).toBe(11);
    expect(s.avgPeakBurstDamage).toBe(7.5);
    expect(s.effectiveHp).toBe(9.2);
  });

  it('survives an empty sweep instead of dividing by zero', () => {
    const s = summarize([]);
    expect(s.runs).toBe(0);
    expect(s.avgFloorReached).toBe(0);
    expect(s.maxPeakBurstDamage).toBe(0);
    expect(s.deathsByRoom).toEqual({});
  });
});

describe('roomStats', () => {
  it('groups encounters across runs by floor:room and counts samples', () => {
    const rows = roomStats([
      run({ encounters: [enc({ roomId: 'r1' }), enc({ roomId: 'r2' })] }),
      run({ encounters: [enc({ roomId: 'r1' })] }),
    ]);
    expect(rows.map((r) => [r.key, r.samples])).toEqual([
      ['0:r1', 2],
      ['0:r2', 1],
    ]);
  });

  it('keys by FLOOR as well as room — the same piece on two floors is two different fights', () => {
    const rows = roomStats([run({ encounters: [enc({ floorIndex: 0, roomId: 'r1' }), enc({ floorIndex: 1, roomId: 'r1' })] })]);
    expect(rows.map((r) => r.key)).toEqual(['0:r1', '1:r1']);
  });

  it('medians the reaction window, ignoring samples where the room never landed a hit', () => {
    const rows = roomStats([
      run({ encounters: [enc({ reactionTicks: 30 })] }),
      run({ encounters: [enc({ reactionTicks: 90 })] }),
      run({ encounters: [enc({ reactionTicks: null })] }),
    ]);
    expect(rows[0]!.medianReactionTicks).toBe(60);
  });

  it('reports null reaction when no sample of the room ever hit the player', () => {
    const rows = roomStats([run({ encounters: [enc({ reactionTicks: null })] })]);
    expect(rows[0]!.medianReactionTicks).toBeNull();
  });

  it('takes the max garrison and max peak shooters, but averages the rest', () => {
    const rows = roomStats([
      run({ encounters: [enc({ garrison: 8, peakShooters: 1, damageTaken: 4 })] }),
      run({ encounters: [enc({ garrison: 9, peakShooters: 3, damageTaken: 6 })] }),
    ]);
    expect(rows[0]!.garrison).toBe(9);
    expect(rows[0]!.maxPeakShooters).toBe(3);
    expect(rows[0]!.avgPeakShooters).toBe(2);
    expect(rows[0]!.avgDamageTaken).toBe(5);
  });

  it('computes clear rate and averages clear time over CLEARED samples only', () => {
    const rows = roomStats([
      run({ encounters: [enc({ activatedTick: 100, clearedTick: 300 })] }),
      run({ encounters: [enc({ activatedTick: 100, clearedTick: 500 })] }),
      run({ encounters: [enc({ clearedTick: null })] }),
    ]);
    expect(rows[0]!.clearRate).toBeCloseTo(0.67, 2);
    expect(rows[0]!.avgClearTicks).toBe(300); // (200 + 400) / 2 — the uncleared one is excluded
  });

  it('reports a null clear time for a room nothing ever cleared', () => {
    const rows = roomStats([run({ encounters: [enc({ clearedTick: null })] })]);
    expect(rows[0]!.clearRate).toBe(0);
    expect(rows[0]!.avgClearTicks).toBeNull();
  });

  it('sorts by floor, then room id — the order a descent is actually played in', () => {
    const rows = roomStats([
      run({
        encounters: [
          enc({ floorIndex: 1, roomId: 'r2' }),
          enc({ floorIndex: 0, roomId: 'r9' }),
          enc({ floorIndex: 1, roomId: 'r1' }),
        ],
      }),
    ]);
    expect(rows.map((r) => r.key)).toEqual(['0:r9', '1:r1', '1:r2']);
  });
});

describe('formatSummary / formatRoomTable', () => {
  it('renders the burst window against the HP pool, and names the label it was given', () => {
    const text = formatSummary('profile=careful', summarize([run({ peakBurstDamage: 5 })]));
    expect(text).toContain('profile=careful');
    expect(text).toContain('5');
    expect(text).toContain('9.2 effective HP');
  });

  it('says so explicitly when every run extracted, rather than printing an empty object', () => {
    const text = formatSummary('x', summarize([run({ outcome: 'extracted', endRoom: 'r5' })]));
    expect(text).toContain('every run extracted');
  });

  it('renders one table row per room plus a header, with a dash for missing values', () => {
    const text = formatRoomTable(roomStats([run({ encounters: [enc({ reactionTicks: null, clearedTick: null })] })]));
    const lines = text.split('\n');
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain('garrison');
    expect(lines[1]).toContain('r1');
    expect(lines[1]).toContain('-');
  });
});

describe('floorDropStats — the loot economy per floor (design/09 DROP_TABLE)', () => {
  it('groups a run\u2019s drops by floor and counts each kind separately', () => {
    const rows = floorDropStats([
      run({
        killsByFloor: { 0: 20, 1: 10 },
        checkpointFloors: [0],
        drops: [
          drop({ kind: 'weapon' }),
          drop({ kind: 'weapon', roomId: 'r2' }),
          drop({ kind: 'heal' }),
          drop({ kind: 'material' }),
          drop({ kind: 'buff' }),
          drop({ floorIndex: 1, kind: 'weapon' }),
        ],
      }),
    ]);
    expect(rows.map((r) => r.floorIndex)).toEqual([0, 1]); // sorted by floor
    const f0 = rows[0]!;
    expect([f0.avgWeapons, f0.avgHeals, f0.avgMaterials, f0.avgBuffs]).toEqual([2, 1, 1, 1]);
    expect(rows[1]!.avgWeapons).toBe(1);
  });

  it('reads min/max weapons over COMPLETE visits only — a died-on floor under-counts', () => {
    // Two runs on floor 0: one reached the checkpoint with 3 weapons, one died early
    // with 0. The average sees both; the spread must only see the complete one, or
    // "0 weapons this floor" gets blamed on the drop table instead of on the death.
    const rows = floorDropStats([
      run({ killsByFloor: { 0: 60 }, checkpointFloors: [0], drops: [drop({ kind: 'weapon' }), drop({ kind: 'weapon' }), drop({ kind: 'weapon' })] }),
      run({ killsByFloor: { 0: 4 }, checkpointFloors: [], drops: [] }),
    ]);
    const f0 = rows[0]!;
    expect([f0.samples, f0.complete]).toEqual([2, 1]);
    expect([f0.minWeapons, f0.maxWeapons]).toEqual([3, 3]);
    expect(f0.avgWeapons).toBe(1.5); // 3 over two visits — deliberately still diluted
  });

  it('has no weapon spread at all when no visit was complete', () => {
    const rows = floorDropStats([run({ killsByFloor: { 0: 4 }, checkpointFloors: [], drops: [drop({ kind: 'weapon' })] })]);
    expect([rows[0]!.minWeapons, rows[0]!.maxWeapons]).toEqual([null, null]);
  });

  it('reports the worst single-room weapon concentration, passage drops included', () => {
    // Three weapons on one floor, two of them in the same room, one in a passage
    // (roomId null). The per-room max is 2 — and the passage drop must not be
    // silently discarded, or a floor could dump loot into corridors unnoticed.
    const rows = floorDropStats([
      run({
        killsByFloor: { 0: 50 },
        checkpointFloors: [0],
        drops: [drop({ kind: 'weapon', roomId: 'r1' }), drop({ kind: 'weapon', roomId: 'r1' }), drop({ kind: 'weapon', roomId: null })],
      }),
    ]);
    expect(rows[0]!.maxWeaponsInOneRoom).toBe(2);
    expect(rows[0]!.avgWeapons).toBe(3); // the passage drop still counts toward the floor
  });

  it('turns counts into per-kill rates, which is what the drop table is tuned in', () => {
    const rows = floorDropStats([
      run({ killsByFloor: { 0: 50 }, checkpointFloors: [0], drops: [...Array(10)].map(() => drop({ kind: 'heal' })) }),
    ]);
    expect(rows[0]!.healsPerKill).toBe(0.2); // 10 heals / 50 kills
    expect(rows[0]!.weaponsPerKill).toBe(0);
  });

  it('never divides by zero on a floor that recorded drops but no kills', () => {
    // Reachable in principle: the pity/quota drops planned for the capstone are
    // spawned by the engine, not by a kill this tracker attributed to the floor.
    const rows = floorDropStats([run({ killsByFloor: {}, checkpointFloors: [0], drops: [drop({ kind: 'weapon' })] })]);
    expect([rows[0]!.healsPerKill, rows[0]!.weaponsPerKill]).toEqual([0, 0]);
    expect(rows[0]!.avgKills).toBe(0);
  });

  it('renders one table row per floor, headed', () => {
    const rows = floorDropStats([run({ killsByFloor: { 0: 20, 1: 20 }, checkpointFloors: [0, 1], drops: [drop({ kind: 'weapon' })] })]);
    const lines = formatDropTable(rows).split('\n');
    expect(lines).toHaveLength(3); // header + 2 floors
    expect(lines[0]).toContain('weapons(avg/min/max)');
    expect(lines[1]).toMatch(/^0 /);
  });
});
