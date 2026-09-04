/**
 * Split of `matchsvc.ts` (P0, 2026-09-04, prep for ROADMAP Phase 8) — the `/auth/*` route
 * group (design/16-accounts.md): register, login, logout, session lookup, password change.
 * Also owns `requireAuth`, the `Authorization: Bearer <token>` reader, because that header
 * is the account layer's trust boundary and every other group that needs it (currently
 * `routes/account.ts`) is a sibling that may import it from here.
 */
import type { IncomingMessage } from 'node:http';
import type { AuthService } from '../AuthService';
import { readJson, send, type RouteHandler } from './http';

export interface AuthRouteDeps {
  auth: AuthService;
}

/** Parses `Authorization: Bearer <token>` and resolves it to a live session, or `null`. */
export function requireAuth(req: IncomingMessage, auth: AuthService): { accountId: string; username: string } | null {
  const header = req.headers.authorization;
  if (!header || !header.startsWith('Bearer ')) return null;
  return auth.verifySession(header.slice('Bearer '.length));
}

export const postRegister: RouteHandler<AuthRouteDeps> = (req, res, _url, deps) => {
  readJson(req, (body) => {
    const { username, password } = (body as { username?: unknown; password?: unknown }) ?? {};
    const result = deps.auth.register(username, password);
    send(res, 'error' in result ? 400 : 200, result);
  });
};

export const postLogin: RouteHandler<AuthRouteDeps> = (req, res, _url, deps) => {
  readJson(req, (body) => {
    const { username, password } = (body as { username?: unknown; password?: unknown }) ?? {};
    const result = deps.auth.login(username, password);
    send(res, 'error' in result ? 401 : 200, result);
  });
};

export const postLogout: RouteHandler<AuthRouteDeps> = (req, res, _url, deps) => {
  readJson(req, (body) => {
    const token = (body as { token?: unknown })?.token;
    if (typeof token === 'string') deps.auth.logout(token);
    send(res, 200, { ok: true });
  });
};

export const getMe: RouteHandler<AuthRouteDeps> = (req, res, _url, deps) => {
  const session = requireAuth(req, deps.auth);
  if (!session) return send(res, 401, { error: 'invalid or expired session' });
  send(res, 200, session);
};

export const postChangePassword: RouteHandler<AuthRouteDeps> = (req, res, _url, deps) => {
  readJson(req, (body) => {
    const { token, oldPassword, newPassword } =
      (body as { token?: unknown; oldPassword?: unknown; newPassword?: unknown }) ?? {};
    const session = deps.auth.verifySession(token);
    if (!session) return send(res, 401, { error: 'invalid or expired session' });
    const result = deps.auth.changePassword(session.accountId, oldPassword, newPassword);
    send(res, 'error' in result ? 400 : 200, result);
  });
};
