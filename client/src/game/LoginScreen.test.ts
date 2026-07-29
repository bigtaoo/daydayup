/**
 * LoginScreen (design/16-accounts.md). Driven with a fake `AuthApi` (no network) —
 * mirrors PartyScreen.test.ts's style, reaching private do-action state via the same
 * escape hatch. Session state is global (net/session.ts), so each test resets it.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { LoginScreen, type AuthApi } from './LoginScreen';
import { resetSessionCacheForTests, getSession } from '../net/session';
import type { AuthResult } from '../net/auth';

function fakeApi(overrides: Partial<AuthApi> = {}): AuthApi {
  return {
    register: vi.fn(),
    login: vi.fn(),
    logout: vi.fn(),
    changePassword: vi.fn(),
    ...overrides,
  };
}

const SESSION: AuthResult = { accountId: 'acct-1', username: 'alice', token: 'tok-1' };

function makeScreen(api: AuthApi) {
  const screen = new LoginScreen({ matchBaseUrl: 'http://mm', api });
  screen.show(800, 600);
  return screen;
}

/** A controllable pending promise, for pinning "still in flight" re-entrancy behavior. */
function deferred<T>(): { promise: Promise<T>; resolve: (v: T) => void } {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

function privateOf(s: LoginScreen) {
  return s as unknown as {
    loginBtn: { view: { visible: boolean } };
    registerBtn: { view: { visible: boolean } };
    logoutBtn: { view: { visible: boolean } };
    changePasswordBtn: { view: { visible: boolean } };
    whoText: { text: string };
    statusText: { text: string };
    doLogin(username: string, password: string): Promise<void>;
    doRegister(username: string, password: string): Promise<void>;
    doChangePassword(oldPassword: string, newPassword: string): Promise<void>;
    doLogout(): Promise<void>;
  };
}

beforeEach(() => resetSessionCacheForTests());

describe('LoginScreen — guest (no session)', () => {
  it('shows login/register, hides logout/change-password', () => {
    const s = makeScreen(fakeApi());
    const p = privateOf(s);
    expect(p.loginBtn.view.visible).toBe(true);
    expect(p.registerBtn.view.visible).toBe(true);
    expect(p.logoutBtn.view.visible).toBe(false);
    expect(p.changePasswordBtn.view.visible).toBe(false);
    expect(p.whoText.text).toMatch(/guest/i);
  });
});

describe('LoginScreen — login', () => {
  it('a successful login stores the session and flips to the logged-in state', async () => {
    const api = fakeApi({ login: vi.fn().mockResolvedValue(SESSION) });
    const s = makeScreen(api);
    const p = privateOf(s);
    await p.doLogin('alice', 'hunter22');
    expect(api.login).toHaveBeenCalledWith('http://mm', 'alice', 'hunter22');
    expect(getSession()).toEqual(SESSION);
    expect(p.whoText.text).toContain('alice');
    expect(p.logoutBtn.view.visible).toBe(true);
    expect(p.loginBtn.view.visible).toBe(false);
  });

  it('a failed login surfaces the server error and stays logged out', async () => {
    const api = fakeApi({ login: vi.fn().mockRejectedValue(new Error('invalid username or password')) });
    const s = makeScreen(api);
    const p = privateOf(s);
    await p.doLogin('alice', 'wrong');
    expect(p.statusText.text).toMatch(/invalid/i);
    expect(getSession()).toBeNull();
    expect(p.loginBtn.view.visible).toBe(true);
  });

  it('fires onSessionChange after a successful login', async () => {
    const api = fakeApi({ login: vi.fn().mockResolvedValue(SESSION) });
    const s = makeScreen(api);
    const onChange = vi.fn();
    s.onSessionChange = onChange;
    await privateOf(s).doLogin('alice', 'hunter22');
    expect(onChange).toHaveBeenCalledTimes(1);
  });
});

describe('LoginScreen — register', () => {
  it('a successful register stores the session and flips to the logged-in state', async () => {
    const api = fakeApi({ register: vi.fn().mockResolvedValue(SESSION) });
    const s = makeScreen(api);
    const p = privateOf(s);
    await p.doRegister('alice', 'hunter22');
    expect(api.register).toHaveBeenCalledWith('http://mm', 'alice', 'hunter22');
    expect(getSession()).toEqual(SESSION);
    expect(p.logoutBtn.view.visible).toBe(true);
  });

  it('a failed register (duplicate username) surfaces the server error', async () => {
    const api = fakeApi({ register: vi.fn().mockRejectedValue(new Error('username already taken')) });
    const s = makeScreen(api);
    const p = privateOf(s);
    await p.doRegister('alice', 'hunter22');
    expect(p.statusText.text).toMatch(/already taken/i);
    expect(getSession()).toBeNull();
  });
});

describe('LoginScreen — logout', () => {
  it('logging out clears the session and reverts to guest state', async () => {
    const api = fakeApi({ login: vi.fn().mockResolvedValue(SESSION), logout: vi.fn().mockResolvedValue(undefined) });
    const s = makeScreen(api);
    const p = privateOf(s);
    await p.doLogin('alice', 'hunter22');
    await p.doLogout();
    expect(api.logout).toHaveBeenCalledWith('http://mm', 'tok-1');
    expect(getSession()).toBeNull();
    expect(p.loginBtn.view.visible).toBe(true);
  });
});

describe('LoginScreen — change password', () => {
  it('changing the password while logged in reports success', async () => {
    const api = fakeApi({
      login: vi.fn().mockResolvedValue(SESSION),
      changePassword: vi.fn().mockResolvedValue(undefined),
    });
    const s = makeScreen(api);
    const p = privateOf(s);
    await p.doLogin('alice', 'hunter22');
    await p.doChangePassword('hunter22', 'newpassword1');
    expect(api.changePassword).toHaveBeenCalledWith('http://mm', 'tok-1', 'hunter22', 'newpassword1');
    expect(p.statusText.text).toMatch(/changed/i);
  });
});

describe('LoginScreen — re-entrant guard (edge case: a double-fire while a call is in flight)', () => {
  it('a second doLogin call while the first is still pending does not re-invoke the API', async () => {
    const d = deferred<AuthResult>();
    const login = vi.fn().mockReturnValue(d.promise);
    const s = makeScreen(fakeApi({ login }));
    const p = privateOf(s);

    const first = p.doLogin('alice', 'hunter22');
    const second = p.doLogin('alice', 'hunter22'); // fired before `first` resolves
    d.resolve(SESSION);
    await Promise.all([first, second]);

    expect(login).toHaveBeenCalledTimes(1);
  });

  it('a second doRegister call while the first is still pending does not re-invoke the API', async () => {
    const d = deferred<AuthResult>();
    const register = vi.fn().mockReturnValue(d.promise);
    const s = makeScreen(fakeApi({ register }));
    const p = privateOf(s);

    const first = p.doRegister('alice', 'hunter22');
    const second = p.doRegister('alice', 'hunter22');
    d.resolve(SESSION);
    await Promise.all([first, second]);

    expect(register).toHaveBeenCalledTimes(1);
  });

  it('a second doChangePassword call while the first is still pending does not re-invoke the API', async () => {
    const d = deferred<void>();
    const changePassword = vi.fn().mockReturnValue(d.promise);
    const s = makeScreen(fakeApi({ login: vi.fn().mockResolvedValue(SESSION), changePassword }));
    const p = privateOf(s);
    await p.doLogin('alice', 'hunter22');

    const first = p.doChangePassword('hunter22', 'newpassword1');
    const second = p.doChangePassword('hunter22', 'newpassword1');
    d.resolve();
    await Promise.all([first, second]);

    expect(changePassword).toHaveBeenCalledTimes(1);
  });

  it('once the in-flight call settles, a fresh doLogin call is allowed through again', async () => {
    const login = vi.fn().mockResolvedValue(SESSION);
    const s = makeScreen(fakeApi({ login }));
    const p = privateOf(s);
    await p.doLogin('alice', 'hunter22');
    await p.doLogin('alice', 'hunter22');
    expect(login).toHaveBeenCalledTimes(2); // NOT re-entrant — two genuinely sequential calls
  });
});

describe('LoginScreen — hide()', () => {
  it('hides the view without throwing even with no open input overlay', () => {
    const s = makeScreen(fakeApi());
    expect(() => s.hide()).not.toThrow();
  });
});
