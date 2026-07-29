/**
 * Client party calls (design/05/15's PvP squad follow-up) — thin wrapper over
 * matchsvc's /party/* routes, same injected-fetch shape as matchmaking.ts so both are
 * unit-testable without a network.
 */
export interface PartyInfo {
  partyId: string;
  code: string;
  leaderId: string;
  members: readonly string[];
  matching: boolean;
}

export interface PartyCallOptions {
  /** Injected for tests; defaults to the global fetch. */
  fetch?: typeof fetch;
}

async function post(baseUrl: string, path: string, body: unknown, opts: PartyCallOptions): Promise<PartyInfo | null> {
  const doFetch = opts.fetch ?? fetch;
  const res = await doFetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const json = (await res.json()) as (PartyInfo & { error?: string }) | null;
  if (!res.ok || json?.error) throw new Error(json?.error ?? `party request failed (${res.status})`);
  return json; // null only for /party/leave dissolving the party — a real response, not an error
}

// create/join/start never legitimately return null per the API contract (only
// /party/leave does, when it dissolves the party) — asserted here so callers that
// only ever hit these three don't have to null-check a case that can't happen.
export async function createParty(baseUrl: string, playerId: string, opts: PartyCallOptions = {}): Promise<PartyInfo> {
  return (await post(baseUrl, '/party/create', { playerId }, opts))!;
}

export async function joinParty(baseUrl: string, playerId: string, code: string, opts: PartyCallOptions = {}): Promise<PartyInfo> {
  return (await post(baseUrl, '/party/join', { playerId, code }, opts))!;
}

export function leaveParty(baseUrl: string, partyId: string, playerId: string, opts: PartyCallOptions = {}): Promise<PartyInfo | null> {
  return post(baseUrl, '/party/leave', { partyId, playerId }, opts);
}

export async function startPartyMatching(baseUrl: string, partyId: string, playerId: string, opts: PartyCallOptions = {}): Promise<PartyInfo> {
  return (await post(baseUrl, '/party/start', { partyId, playerId }, opts))!;
}

/** Poll current party state. `null` once the party is gone (dissolved/expired) —
 * distinct from a thrown error, which means the request itself failed. */
export async function getParty(baseUrl: string, partyId: string, opts: PartyCallOptions = {}): Promise<PartyInfo | null> {
  const doFetch = opts.fetch ?? fetch;
  const res = await doFetch(`${baseUrl}/party/${encodeURIComponent(partyId)}`);
  if (res.status === 404) return null;
  const json = (await res.json()) as PartyInfo & { error?: string };
  if (!res.ok || json.error) throw new Error(json.error ?? `party request failed (${res.status})`);
  return json;
}
