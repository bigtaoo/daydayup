/**
 * Client auth calls (design/16-accounts.md) — thin wrapper over matchsvc's `/auth/*`
 * and `/account/*` routes, same injected-fetch shape as `net/party.ts`/`matchmaking.ts`
 * so this is unit-testable without a network.
 */
export interface AuthResult {
  accountId: string;
  username: string;
  token: string;
}

export interface AuthCallOptions {
  /** Injected for tests; defaults to the global fetch. */
  fetch?: typeof fetch;
}

async function call<T>(
  baseUrl: string,
  path: string,
  init: RequestInit,
  opts: AuthCallOptions,
): Promise<T> {
  const doFetch = opts.fetch ?? fetch;
  const res = await doFetch(`${baseUrl}${path}`, init);
  const json = (await res.json().catch(() => null)) as (T & { error?: string }) | null;
  if (!res.ok || json?.error) throw new Error(json?.error ?? `auth request failed (${res.status})`);
  return json as T;
}

function post<T>(baseUrl: string, path: string, body: unknown, opts: AuthCallOptions): Promise<T> {
  return call(baseUrl, path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }, opts);
}

export function register(baseUrl: string, username: string, password: string, opts: AuthCallOptions = {}): Promise<AuthResult> {
  return post(baseUrl, '/auth/register', { username, password }, opts);
}

export function login(baseUrl: string, username: string, password: string, opts: AuthCallOptions = {}): Promise<AuthResult> {
  return post(baseUrl, '/auth/login', { username, password }, opts);
}

export async function logout(baseUrl: string, token: string, opts: AuthCallOptions = {}): Promise<void> {
  await post<{ ok: true }>(baseUrl, '/auth/logout', { token }, opts);
}

export async function changePassword(
  baseUrl: string,
  token: string,
  oldPassword: string,
  newPassword: string,
  opts: AuthCallOptions = {},
): Promise<void> {
  await post<{ ok: true }>(baseUrl, '/auth/change-password', { token, oldPassword, newPassword }, opts);
}

/** `null` on an invalid/expired token (401) — distinct from a thrown error, which
 * means the request itself failed. */
export async function fetchMe(
  baseUrl: string,
  token: string,
  opts: AuthCallOptions = {},
): Promise<{ accountId: string; username: string } | null> {
  const doFetch = opts.fetch ?? fetch;
  const res = await doFetch(`${baseUrl}/auth/me`, { headers: { authorization: `Bearer ${token}` } });
  if (res.status === 401) return null;
  const json = (await res.json()) as { accountId: string; username: string; error?: string };
  if (!res.ok || json.error) throw new Error(json.error ?? `auth request failed (${res.status})`);
  return json;
}

export type MetaCallOptions = AuthCallOptions;

/** `null` when the account has never saved meta state (a brand-new account). */
export async function fetchAccountMeta(baseUrl: string, token: string, opts: MetaCallOptions = {}): Promise<unknown | null> {
  const doFetch = opts.fetch ?? fetch;
  const res = await doFetch(`${baseUrl}/account/meta`, { headers: { authorization: `Bearer ${token}` } });
  const json = (await res.json()) as { data: unknown; error?: string };
  if (!res.ok || json.error) throw new Error(json.error ?? `auth request failed (${res.status})`);
  return json.data;
}

export async function saveAccountMeta(baseUrl: string, token: string, data: unknown, opts: MetaCallOptions = {}): Promise<void> {
  await call<{ ok: true }>(
    baseUrl,
    '/account/meta',
    {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify({ data }),
    },
    opts,
  );
}
