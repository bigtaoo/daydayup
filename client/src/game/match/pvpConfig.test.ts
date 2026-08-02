/**
 * buildPvpEngineConfig / squad helpers (design/15, ROADMAP Phase 4 closeout;
 * design/05/15's PvP squad follow-up for teamId). Pins the determinism invariant
 * `BotClient.ts` relies on (pure function of seed+playerCount, no ticket/party input)
 * and the squad-chunking math `server/src/Matchmaker.ts` mirrors via the same
 * `@dd/game/pvpConfig` import.
 */
import { describe, it, expect } from 'vitest';
import { buildPvpEngineConfig, squadSizeForPlayerCount, teamIdForOwner, SQUAD_SIZE } from './pvpConfig';

describe('squadSizeForPlayerCount / teamIdForOwner', () => {
  it('uses SQUAD_SIZE when playerCount divides evenly into at least 2 squads', () => {
    expect(squadSizeForPlayerCount(8)).toBe(SQUAD_SIZE); // 2 squads of 4
    expect(squadSizeForPlayerCount(12)).toBe(SQUAD_SIZE); // 3 squads of 4
  });

  it('falls back to 1 (free-for-all) for a playerCount that does not divide evenly', () => {
    for (const n of [1, 2, 3, 5, 6, 7]) expect(squadSizeForPlayerCount(n)).toBe(1);
  });

  it('falls back to 1 when playerCount === SQUAD_SIZE exactly — one "squad" covering everyone would be a single team that can never fight itself', () => {
    expect(squadSizeForPlayerCount(SQUAD_SIZE)).toBe(1);
    const teamIds = Array.from({ length: SQUAD_SIZE }, (_, i) => teamIdForOwner(i, SQUAD_SIZE));
    expect(new Set(teamIds).size).toBe(SQUAD_SIZE); // every seat its own team, not one shared team
  });

  it('splits an 8-seat match into two 4-seat squads', () => {
    const teamIds = Array.from({ length: 8 }, (_, i) => teamIdForOwner(i, 8));
    expect(teamIds).toEqual([0, 0, 0, 0, 1, 1, 1, 1]);
  });

  it('gives every seat its own distinct squad when playerCount does not divide evenly', () => {
    const teamIds = Array.from({ length: 3 }, (_, i) => teamIdForOwner(i, 3));
    expect(teamIds).toEqual([0, 1, 2]);
  });
});

describe('buildPvpEngineConfig', () => {
  it('is a pure function of (seed, playerCount) — identical config on every call, matching BotClient.ts\'s own independent derivation', () => {
    const a = buildPvpEngineConfig(42, 8);
    const b = buildPvpEngineConfig(42, 8);
    expect(a).toEqual(b);
  });

  it('assigns squad-derived teamIds for an 8-seat match, not one-per-seat', () => {
    const cfg = buildPvpEngineConfig(1, 8);
    const teamIds = cfg.players!.map((p) => p.teamId);
    expect(teamIds).toEqual([0, 0, 0, 0, 1, 1, 1, 1]);
  });

  it('keeps the pre-squad one-team-per-seat shape for a playerCount that does not divide by SQUAD_SIZE', () => {
    const cfg = buildPvpEngineConfig(1, 3);
    const teamIds = cfg.players!.map((p) => p.teamId);
    expect(teamIds).toEqual([0, 1, 2]);
  });
});
