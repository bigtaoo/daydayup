/**
 * Party service (design/05/15's PvP squad follow-up) — pure pre-match grouping so
 * friends can queue together as one squad instead of matchmaking pairing strangers.
 * Mirrors `Matchmaker`'s shape exactly: a pure class, all non-determinism injected
 * (`nowMs`/`newPartyId`/`newCode`), in-memory `Map` state (this repo's standing
 * convention — no DB anywhere yet, see `RatingStore`).
 *
 * No account system backs this (none exists anywhere in this project — see
 * `rating.ts`'s own note). A "player" here is just whatever opaque id string the
 * client sends; nothing is verified. This is the same trust level `Matchmaker.enqueue`
 * already gives a bare `playerCount`/`mode` — a party gets no more.
 *
 * Two lookup keys per party: an internal `partyId` (what the client polls) and a
 * short, human-typeable `code` (what a leader reads out / pastes to a friend) — the
 * same `roomId`-vs-`queueId` separation `Matchmaker`/`ticket.ts` already use.
 */
import { SQUAD_SIZE } from './config';

export interface PartyServiceDeps {
  nowMs(): number;
  newPartyId(): string;
  /** A fresh short join code. Injected so tests are deterministic and collisions are
   * trivially forceable (real: a random alphanumeric generator). */
  newCode(): string;
}

export interface PartyInfo {
  partyId: string;
  code: string;
  leaderId: string;
  members: readonly string[];
  /** Set once the leader calls `startMatching` — other members' polls observe this
   * flip and each independently call their own `POST /find` with this `partyId`. */
  matching: boolean;
}

/** The squad-size ceiling (design/05/15) — re-exported from the same `SQUAD_SIZE`
 * `Matchmaker`'s per-squad chunking uses (via `@dd/game/pvpConfig`), so a party can
 * never grow larger than the squad it's meant to fill. */
export const MAX_PARTY_SIZE = SQUAD_SIZE;

const DEFAULT_TTL_MS = 10 * 60_000; // 10 min idle — generous; a lobby isn't a hot loop

interface Party {
  code: string;
  leaderId: string;
  members: string[];
  matching: boolean;
  updatedAt: number;
}

export class PartyService {
  private readonly parties = new Map<string, Party>();
  private readonly codeToPartyId = new Map<string, string>();
  private readonly ttlMs: number;

  constructor(
    private readonly deps: PartyServiceDeps,
    ttlMs = DEFAULT_TTL_MS,
  ) {
    this.ttlMs = ttlMs;
  }

  /** Create a new party with `playerId` as its sole member and leader. */
  create(playerId: string): PartyInfo {
    this.sweepExpired();
    const partyId = this.deps.newPartyId();
    let code = this.deps.newCode();
    while (this.codeToPartyId.has(code)) code = this.deps.newCode(); // vanishingly rare
    const party: Party = { code, leaderId: playerId, members: [playerId], matching: false, updatedAt: this.deps.nowMs() };
    this.parties.set(partyId, party);
    this.codeToPartyId.set(code, partyId);
    return this.toInfo(partyId, party);
  }

  /** Join the party behind `code`. Idempotent for an already-joined `playerId`.
   * `null` on an unknown/expired code or a full party. */
  join(code: string, playerId: string): PartyInfo | null {
    this.sweepExpired();
    const partyId = this.codeToPartyId.get(code);
    const party = partyId ? this.parties.get(partyId) : undefined;
    if (!partyId || !party) return null;
    if (!party.members.includes(playerId)) {
      if (party.members.length >= MAX_PARTY_SIZE) return null;
      party.members.push(playerId);
    }
    party.updatedAt = this.deps.nowMs();
    return this.toInfo(partyId, party);
  }

  /** Leave a party. The party dissolves once empty; the leader slot passes to the
   * next-oldest member if the leader leaves (never to nobody while members remain). */
  leave(partyId: string, playerId: string): PartyInfo | null {
    this.sweepExpired();
    const party = this.parties.get(partyId);
    if (!party) return null;
    party.members = party.members.filter((m) => m !== playerId);
    if (party.members.length === 0) {
      this.parties.delete(partyId);
      this.codeToPartyId.delete(party.code);
      return null;
    }
    if (party.leaderId === playerId) party.leaderId = party.members[0]!;
    party.updatedAt = this.deps.nowMs();
    return this.toInfo(partyId, party);
  }

  /** Current party state (for polling). `null` if unknown/expired. */
  get(partyId: string): PartyInfo | null {
    this.sweepExpired();
    const party = this.parties.get(partyId);
    return party ? this.toInfo(partyId, party) : null;
  }

  /** Only the leader may start matching. Returns `null` on an unknown party or a
   * non-leader caller (the shell maps either to a 4xx, not a crash). */
  startMatching(partyId: string, playerId: string): PartyInfo | null {
    this.sweepExpired();
    const party = this.parties.get(partyId);
    if (!party || party.leaderId !== playerId) return null;
    party.matching = true;
    party.updatedAt = this.deps.nowMs();
    return this.toInfo(partyId, party);
  }

  private toInfo(partyId: string, party: Party): PartyInfo {
    return { partyId, code: party.code, leaderId: party.leaderId, members: [...party.members], matching: party.matching };
  }

  private sweepExpired(): void {
    const now = this.deps.nowMs();
    for (const [id, party] of this.parties) {
      if (now - party.updatedAt > this.ttlMs) {
        this.parties.delete(id);
        this.codeToPartyId.delete(party.code);
      }
    }
  }
}
