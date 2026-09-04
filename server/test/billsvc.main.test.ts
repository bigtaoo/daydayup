/**
 * billsvc's process entry point. Two things live only here:
 *
 *   - `main` refuses to start under a production environment with a dev-only flag set,
 *     and refuses BEFORE binding a port or creating a database file. design/19's second
 *     fail-closed defence is worth nothing if the process comes up first and throws after.
 *   - The listen/log/shutdown sequence itself, which `matchsvc.http.test.ts`-style route
 *     tests never touch because they call `createBillsvcServer` and bind their own port.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { main, DEFAULT_BILL_PORT, OTHER_PLANE_PORTS } from '../src/billsvc/main';
import type { BillsvcServer } from '../src/billsvc/server';
import { BillingStartupError } from '../src/billsvc/startupGuard';

const handles: BillsvcServer[] = [];
const dirs: string[] = [];

function tmpDbPath(): string {
  const dir = mkdtempSync(join(tmpdir(), 'ddu-billsvc-main-'));
  dirs.push(dir);
  return join(dir, 'billing.db');
}

/** Binds on port 0 so the suite never collides with a real 8789 or with itself. */
async function listen(env: Record<string, string | undefined>): Promise<BillsvcServer> {
  const handle = main(env, 0, '127.0.0.1');
  handles.push(handle);
  await new Promise<void>((resolve) => handle.server.once('listening', resolve));
  return handle;
}

afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  while (handles.length) {
    const { server, db } = handles.pop()!;
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    // Must close BEFORE the rmSync below: Windows keeps a lock on an open SQLite file and
    // the directory removal fails with EPERM.
    db.close();
  }
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

describe('main — the startup refusal', () => {
  it('DEFENCE 2: throws under production with the dev stub flag set', () => {
    const dbPath = tmpDbPath();
    vi.stubEnv('DDU_BILLING_DB_PATH', dbPath);
    expect(() => main({ NODE_ENV: 'production', DDU_BILLING_DEV_STUB: '1' }, 0, '127.0.0.1')).toThrow(
      BillingStartupError,
    );
    // Nothing was opened before the throw: no port bound, no database file created. A
    // guard that fires after `listen()` leaves a live billing process behind.
    expect(existsSync(dbPath)).toBe(false);
  });

  it('starts under production when nothing dev-only is set', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.stubEnv('DDU_BILLING_DB_PATH', tmpDbPath());
    const { server } = await listen({ NODE_ENV: 'production', DDU_INTERNAL_KEY: 'k' });
    expect((server.address() as AddressInfo).port).toBeGreaterThan(0);
    expect(log).toHaveBeenCalledOnce();
    expect(log.mock.calls[0]![0]).not.toContain('DEV RECEIPT STUB');
  });
});

describe('main — the listening process', () => {
  it('serves /health on the port it was given', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.stubEnv('DDU_BILLING_DB_PATH', tmpDbPath());
    const { server } = await listen({ NODE_ENV: 'test', DDU_INTERNAL_KEY: 'k' });
    const { port } = server.address() as AddressInfo;
    const res = await fetch(`http://127.0.0.1:${port}/health`);
    expect(await res.json()).toEqual({ ok: true, service: 'daydayup-billsvc' });
  });

  it('creates its database at DDU_BILLING_DB_PATH, not at the account DB path', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const billingPath = tmpDbPath();
    const accountPath = join(dirs[dirs.length - 1]!, 'daydayup.db');
    vi.stubEnv('DDU_BILLING_DB_PATH', billingPath);
    vi.stubEnv('DDU_DB_PATH', accountPath);
    await listen({ NODE_ENV: 'test' });
    expect(existsSync(billingPath)).toBe(true);
    expect(existsSync(accountPath)).toBe(false);
  });

  it('says so LOUDLY in the startup line when the dev receipt stub is live', async () => {
    // The one banner an operator needs on a box they were not expecting to be a dev box.
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.stubEnv('DDU_BILLING_DB_PATH', tmpDbPath());
    await listen({ NODE_ENV: 'test', DDU_BILLING_DEV_STUB: '1' });
    expect(log.mock.calls[0]![0]).toContain('DEV RECEIPT STUB ENABLED');
  });

  it('logs the database path, so two planes pointed at one file are visible at a glance', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const path = tmpDbPath();
    vi.stubEnv('DDU_BILLING_DB_PATH', path);
    await listen({ NODE_ENV: 'test' });
    expect(log.mock.calls[0]![0]).toContain(path);
  });

  it('closes cleanly, so a deploy does not leave the process hanging', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.stubEnv('DDU_BILLING_DB_PATH', tmpDbPath());
    const { server, db } = await listen({ NODE_ENV: 'test' });
    handles.pop(); // this case owns the shutdown, so afterEach must not double-close
    await new Promise<void>((resolve) => server.close(() => resolve()));
    db.close();
    expect(server.listening).toBe(false);
  });

  it('reads BILL_PORT/HOST defaults when called with no port', () => {
    // Not bound — just that the signature's defaults exist, so `main()` from the CLI
    // guard needs no arguments. Binding 8789 in a test would fight a real dev process.
    expect(main.length).toBe(0);
  });

  it('defaults to 8789, the port design/19 assigns the billing plane', () => {
    expect(DEFAULT_BILL_PORT).toBe(8789);
  });

  it('does not default onto either of the other two planes', () => {
    // The half that matters. Three processes on one box: 8787 data plane (`index.ts`),
    // 8788 control plane (`matchsvc.ts`), 8789 billing. Defaulting onto 8788 makes billsvc
    // either refuse to bind or shadow the process it was deliberately split away from —
    // and every other case in this file binds port 0, so nothing else can see it.
    expect(DEFAULT_BILL_PORT).not.toBe(OTHER_PLANE_PORTS.dataPlane);
    expect(DEFAULT_BILL_PORT).not.toBe(OTHER_PLANE_PORTS.controlPlane);
  });
});
