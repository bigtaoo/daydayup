/**
 * Shared server config (ROADMAP 3.3) — `ticketSecret()`'s real-secret vs. dev-fallback
 * branches, and the one-time `console.warn` guarded by config.ts's module-scope `warned`
 * flag. That flag is module state, so each case that needs a FRESH flag does
 * `vi.resetModules()` + a dynamic re-import (mirrors this repo's other module-scope-state
 * tests) — sharing one imported `ticketSecret` across cases would leak the warned state
 * between them.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';

const DEV_SECRET = 'dev-insecure-secret-do-not-use-in-prod';
const ORIGINAL_ENV = process.env.DDU_TICKET_SECRET;

afterEach(() => {
  if (ORIGINAL_ENV === undefined) delete process.env.DDU_TICKET_SECRET;
  else process.env.DDU_TICKET_SECRET = ORIGINAL_ENV;
  vi.restoreAllMocks();
});

describe('ticketSecret — real secret configured', () => {
  it('returns the env secret with isDev:false, and never warns', async () => {
    process.env.DDU_TICKET_SECRET = 'a-real-production-secret';
    vi.resetModules();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { ticketSecret } = await import('../src/config');
    expect(ticketSecret()).toEqual({ secret: 'a-real-production-secret', isDev: false });
    expect(warn).not.toHaveBeenCalled();
  });

  it('repeated calls keep returning the same real secret, still without warning', async () => {
    process.env.DDU_TICKET_SECRET = 'a-real-production-secret';
    vi.resetModules();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { ticketSecret } = await import('../src/config');
    ticketSecret();
    ticketSecret();
    expect(ticketSecret()).toEqual({ secret: 'a-real-production-secret', isDev: false });
    expect(warn).not.toHaveBeenCalled();
  });
});

describe('ticketSecret — unset (dev fallback)', () => {
  it('falls back to the hard-coded dev secret with isDev:true, and warns once', async () => {
    delete process.env.DDU_TICKET_SECRET;
    vi.resetModules();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { ticketSecret } = await import('../src/config');
    expect(ticketSecret()).toEqual({ secret: DEV_SECRET, isDev: true });
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]?.[0]).toContain('DDU_TICKET_SECRET');
  });

  it('treats an empty-string env var the same as unset', async () => {
    process.env.DDU_TICKET_SECRET = '';
    vi.resetModules();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { ticketSecret } = await import('../src/config');
    expect(ticketSecret()).toEqual({ secret: DEV_SECRET, isDev: true });
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('warns only ONCE across many repeated calls (module-scope `warned` guard)', async () => {
    delete process.env.DDU_TICKET_SECRET;
    vi.resetModules();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { ticketSecret } = await import('../src/config');
    for (let i = 0; i < 5; i++) {
      expect(ticketSecret()).toEqual({ secret: DEV_SECRET, isDev: true });
    }
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('a fresh module instance (vi.resetModules) gets its own independent warned flag', async () => {
    delete process.env.DDU_TICKET_SECRET;

    vi.resetModules();
    const warn1 = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const mod1 = await import('../src/config');
    mod1.ticketSecret();
    mod1.ticketSecret();
    expect(warn1).toHaveBeenCalledTimes(1);
    warn1.mockRestore();

    vi.resetModules();
    const warn2 = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const mod2 = await import('../src/config');
    mod2.ticketSecret();
    expect(warn2).toHaveBeenCalledTimes(1); // the second module's OWN first call, not a leftover count
  });
});
