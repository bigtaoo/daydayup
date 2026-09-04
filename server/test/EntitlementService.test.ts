/**
 * EntitlementService + the `entitlements` schema (design/19-server-platform.md §2,
 * ROADMAP 8.2). Runs against a real `openDb(':memory:')` rather than a stub, because half
 * of what this pass ships IS the schema: the UNIQUE constraint that makes an at-least-once
 * delivery idempotent, the foreign key `ratings` deliberately does not have, and the two
 * CHECKs that keep the column design/19 §7's audit groups by from filling with junk. A
 * mocked `DatabaseSync` would assert none of them.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { DatabaseSync } from 'node:sqlite';
import { openDb } from '../src/db';
import {
  BLUEPRINT_SKU_PREFIX,
  CHARACTER_SKU_PREFIX,
  ENTITLEMENT_SOURCES,
  EntitlementService,
  OWNERSHIP_FIELDS,
  applyOwnership,
  blueprintSku,
  characterSku,
  skusToOwnership,
  stripOwnership,
  type EntitlementSource,
} from '../src/EntitlementService';

let db: DatabaseSync;
let ents: EntitlementService;

/** A real `accounts` row — the foreign key below is enforced, so every test that grants
 * needs one. Written directly rather than through AuthService: this suite is about the
 * entitlements table, and a password hash is not part of the question. */
function makeAccount(id: string): string {
  db.prepare('INSERT INTO accounts (id, username, password_hash, created_at) VALUES (?, ?, ?, ?)').run(
    id,
    `user-${id}`,
    'hash',
    1_700_000_000_000,
  );
  return id;
}

beforeEach(() => {
  db = openDb(':memory:');
  ents = new EntitlementService(db);
});

afterEach(() => {
  db.close();
});

// --- SKU namespacing --------------------------------------------------------------------

describe('SKU namespacing', () => {
  it('builds a blueprint and a character SKU in two distinct namespaces', () => {
    expect(blueprintSku('cannon')).toBe('blueprint:cannon');
    expect(characterSku('cannon')).toBe('character:cannon');
    // The whole reason for the prefixes: the SAME id in the two namespaces must not
    // collide under UNIQUE(account_id, sku).
    expect(blueprintSku('cannon')).not.toBe(characterSku('cannon'));
  });

  it('the exported prefixes are the ones the builders actually use', () => {
    // Pins the constants the client mirrors (client/src/net/entitlements.ts) to the
    // builders, so a rename cannot silently desync the two sides of the wire.
    expect(blueprintSku('x').startsWith(BLUEPRINT_SKU_PREFIX)).toBe(true);
    expect(characterSku('x').startsWith(CHARACTER_SKU_PREFIX)).toBe(true);
  });
});

describe('skusToOwnership', () => {
  it('splits SKUs into the two MetaState ownership arrays, keeping order', () => {
    expect(skusToOwnership(['blueprint:cannon', 'character:hero', 'blueprint:seeker'])).toEqual({
      unlockedBlueprints: ['cannon', 'seeker'],
      ownedCharacters: ['hero'],
    });
  });

  it('skips a SKU in neither namespace rather than throwing', () => {
    // billsvc may later sell something that is neither — an unknown namespace must not be
    // able to break /account/meta for an account that owns one.
    expect(skusToOwnership(['bundle:season1', 'blueprint:cannon'])).toEqual({
      unlockedBlueprints: ['cannon'],
      ownedCharacters: [],
    });
  });

  it('skips a bare prefix with an empty id, in BOTH namespaces', () => {
    // `'blueprint:'` slices to `''`, which would otherwise enter the array as an empty
    // weaponId and show up in the Forge as a nameless row.
    expect(skusToOwnership(['blueprint:', 'character:'])).toEqual({ unlockedBlueprints: [], ownedCharacters: [] });
  });

  it('returns empty arrays for no SKUs at all — the case every account is in today', () => {
    expect(skusToOwnership([])).toEqual({ unlockedBlueprints: [], ownedCharacters: [] });
  });
});

// --- blob shaping -----------------------------------------------------------------------

describe('stripOwnership (the POST normalizer)', () => {
  it('drops both ownership fields and keeps everything the client legitimately authors', () => {
    const blob = {
      materialBank: { mat_fire: 3 },
      unlockedBlueprints: ['cannon'],
      ownedCharacters: ['paid-hero'],
      loadout: ['repeater'],
      selectedSkin: 'juggernaut',
      hasSeenTutorial: true,
    };
    expect(stripOwnership(blob)).toEqual({
      materialBank: { mat_fire: 3 },
      loadout: ['repeater'],
      selectedSkin: 'juggernaut',
      hasSeenTutorial: true,
    });
  });

  it('names every field it drops — the strip covers OWNERSHIP_FIELDS exactly', () => {
    // Derived from the exported list rather than hardcoded, so adding a third purchasable
    // field to OWNERSHIP_FIELDS makes this test cover it without an edit — and, more to the
    // point, so a field ADDED to the list but forgotten in `stripOwnership` fails here.
    const blob = Object.fromEntries(OWNERSHIP_FIELDS.map((f) => [f, ['smuggled']]));
    expect(stripOwnership({ ...blob, keep: 1 })).toEqual({ keep: 1 });
  });

  it('does not mutate the caller of record', () => {
    const blob = { unlockedBlueprints: ['cannon'], keep: 1 };
    stripOwnership(blob);
    expect(blob.unlockedBlueprints).toEqual(['cannon']);
  });

  it.each([
    ['null', null],
    ['a string', 'not-a-blob'],
    ['a number', 7],
    ['an array', ['a', 'b']],
  ])('returns %s verbatim — there is nothing to strip, and the route already accepts it', (_label, value) => {
    expect(stripOwnership(value)).toEqual(value);
  });
});

describe('applyOwnership (the GET overwrite)', () => {
  it('replaces both fields with the server answer and leaves the rest alone', () => {
    const out = applyOwnership(
      { materialBank: { mat_ice: 1 }, unlockedBlueprints: ['smuggled'], ownedCharacters: ['smuggled'] },
      { unlockedBlueprints: ['cannon'], ownedCharacters: ['hero'] },
    );
    expect(out).toEqual({ materialBank: { mat_ice: 1 }, unlockedBlueprints: ['cannon'], ownedCharacters: ['hero'] });
  });

  it('ADDS both fields to a blob that has neither, so the client always gets arrays', () => {
    expect(applyOwnership({ loadout: [] }, { unlockedBlueprints: ['cannon'], ownedCharacters: [] })).toEqual({
      loadout: [],
      unlockedBlueprints: ['cannon'],
      ownedCharacters: [],
    });
  });

  it('copies the arrays rather than aliasing the caller state', () => {
    const own = { unlockedBlueprints: ['cannon'], ownedCharacters: [] };
    const out = applyOwnership({}, own) as { unlockedBlueprints: string[] };
    out.unlockedBlueprints.push('mutated');
    expect(own.unlockedBlueprints).toEqual(['cannon']);
  });

  it.each([
    ['null', null],
    ['a string', 'not-a-blob'],
    ['an array', [1, 2]],
  ])('returns %s untouched — a non-object blob has nowhere to put the fields', (_label, value) => {
    expect(applyOwnership(value, { unlockedBlueprints: ['cannon'], ownedCharacters: [] })).toEqual(value);
  });
});

// --- the table ---------------------------------------------------------------------------

describe('EntitlementService.grant', () => {
  it('lands a row and reports that it did', () => {
    const a = makeAccount('acct-1');
    expect(ents.grant(a, blueprintSku('cannon'), 'grant')).toBe(true);
    expect(ents.list(a)).toHaveLength(1);
  });

  it('is idempotent: a redelivered grant is a no-op that reports false', () => {
    // design/19 §4 — platform callbacks are at-least-once by contract, so the UNIQUE
    // constraint (not a prior SELECT) has to be the idempotency key.
    const a = makeAccount('acct-1');
    expect(ents.grant(a, characterSku('hero'), 'purchase', { orderId: 'ord-1' })).toBe(true);
    expect(ents.grant(a, characterSku('hero'), 'purchase', { orderId: 'ord-1' })).toBe(false);
    expect(ents.list(a)).toHaveLength(1);
  });

  it('a re-grant never overwrites the first grant source or order — the audit record wins', () => {
    // A free hand-issue arriving after a paid one must not erase the order behind it, or
    // §7's reconciliation loses the only local end of that join.
    const a = makeAccount('acct-1');
    ents.grant(a, characterSku('hero'), 'purchase', { orderId: 'ord-1', nowMs: 1000 });
    expect(ents.grant(a, characterSku('hero'), 'grant', { nowMs: 2000 })).toBe(false);
    expect(ents.list(a)[0]).toMatchObject({ source: 'purchase', orderId: 'ord-1', grantedAt: 1000 });
  });

  it('scopes ownership per account — the same SKU granted twice is two independent rows', () => {
    const a = makeAccount('acct-1');
    const b = makeAccount('acct-2');
    expect(ents.grant(a, characterSku('hero'), 'grant')).toBe(true);
    expect(ents.grant(b, characterSku('hero'), 'grant')).toBe(true);
    expect(ents.list(a)).toHaveLength(1);
    expect(ents.list(b)).toHaveLength(1);
  });

  it('defaults order_id to NULL and granted_at to the wall clock when neither is given', () => {
    const before = Date.now();
    const a = makeAccount('acct-1');
    ents.grant(a, blueprintSku('cannon'), 'drop');
    const row = ents.list(a)[0]!;
    expect(row.orderId).toBeNull();
    expect(row.grantedAt).toBeGreaterThanOrEqual(before);
    expect(row.grantedAt).toBeLessThanOrEqual(Date.now());
  });

  it('records the injected clock verbatim when one is given', () => {
    const a = makeAccount('acct-1');
    ents.grant(a, blueprintSku('cannon'), 'event', { nowMs: 1_234_567 });
    expect(ents.list(a)[0]!.grantedAt).toBe(1_234_567);
  });

  it.each(ENTITLEMENT_SOURCES)('accepts source %s', (source) => {
    const a = makeAccount('acct-1');
    // Only `purchase` needs an order behind it; the CHECK below is what makes that true.
    const opts = source === 'purchase' ? { orderId: 'ord-1' } : {};
    expect(ents.grant(a, blueprintSku('cannon'), source, opts)).toBe(true);
    expect(ents.list(a)[0]!.source).toBe(source);
  });

  it('REFUSES a purchase with no order behind it — an unauditable paid row', () => {
    const a = makeAccount('acct-1');
    expect(() => ents.grant(a, characterSku('hero'), 'purchase')).toThrow(/CHECK constraint failed: source <> 'purchase'/);
    expect(ents.list(a)).toEqual([]);
  });

  it('REFUSES a source outside the enum, so a typo cannot poison the audit column', () => {
    // Reachable only past TypeScript, which is exactly the shape a hand-written SQL
    // correction (design/19 §7's "no admin service") takes.
    const a = makeAccount('acct-1');
    expect(() => ents.grant(a, characterSku('hero'), 'gift' as EntitlementSource)).toThrow(/CHECK constraint failed: source IN/);
  });

  it('REFUSES a grant to an account that does not exist — the FK ratings deliberately lacks', () => {
    // db.ts's own note: a rating key can be a guest/bot `seat:{roomId}:{seatIdx}` scaffold
    // with no accounts row, so ratings cannot take this constraint. An entitlement is only
    // ever minted for a real logged-in account, so it can — and a typo'd hand-issue then
    // fails loudly instead of becoming an orphan row that silently never delivers.
    expect(() => ents.grant('no-such-account', characterSku('hero'), 'grant')).toThrow(/FOREIGN KEY constraint failed/);
  });
});

describe('EntitlementService.revoke', () => {
  it('deletes an owned SKU and reports that it did', () => {
    const a = makeAccount('acct-1');
    ents.grant(a, characterSku('hero'), 'grant');
    expect(ents.revoke(a, characterSku('hero'))).toBe(true);
    expect(ents.list(a)).toEqual([]);
  });

  it('reports false for a SKU the account never owned', () => {
    const a = makeAccount('acct-1');
    expect(ents.revoke(a, characterSku('hero'))).toBe(false);
  });

  it('does not touch another account holding the same SKU', () => {
    const a = makeAccount('acct-1');
    const b = makeAccount('acct-2');
    ents.grant(a, characterSku('hero'), 'grant');
    ents.grant(b, characterSku('hero'), 'grant');
    ents.revoke(a, characterSku('hero'));
    expect(ents.list(b)).toHaveLength(1);
  });
});

describe('EntitlementService.list', () => {
  it('is empty for an account that has been granted nothing', () => {
    expect(ents.list(makeAccount('acct-1'))).toEqual([]);
  });

  it('returns full rows in grant order, mapped out of SQL snake_case', () => {
    const a = makeAccount('acct-1');
    ents.grant(a, blueprintSku('cannon'), 'purchase', { orderId: 'ord-9', nowMs: 10 });
    ents.grant(a, characterSku('hero'), 'starter', { nowMs: 20 });
    expect(ents.list(a).map((r) => ({ ...r, id: typeof r.id }))).toEqual([
      { id: 'number', accountId: a, sku: 'blueprint:cannon', source: 'purchase', orderId: 'ord-9', grantedAt: 10 },
      { id: 'number', accountId: a, sku: 'character:hero', source: 'starter', orderId: null, grantedAt: 20 },
    ]);
  });

  it('returns only this account rows', () => {
    const a = makeAccount('acct-1');
    const b = makeAccount('acct-2');
    ents.grant(a, blueprintSku('cannon'), 'grant');
    ents.grant(b, blueprintSku('seeker'), 'grant');
    expect(ents.list(a).map((r) => r.sku)).toEqual(['blueprint:cannon']);
  });
});

describe('EntitlementService.owns', () => {
  it('answers true only for a SKU this account actually holds', () => {
    const a = makeAccount('acct-1');
    const b = makeAccount('acct-2');
    ents.grant(a, characterSku('hero'), 'grant');
    expect(ents.owns(a, characterSku('hero'))).toBe(true);
    expect(ents.owns(a, characterSku('other'))).toBe(false);
    // The check a PvP character gate would make (design/14: the one meta axis that reaches
    // PvP) — it has to be account-scoped, not "does anyone own this".
    expect(ents.owns(b, characterSku('hero'))).toBe(false);
  });
});

describe('EntitlementService.ownership', () => {
  it('projects this account grants onto the two MetaState arrays', () => {
    const a = makeAccount('acct-1');
    ents.grant(a, blueprintSku('cannon'), 'purchase', { orderId: 'ord-1' });
    ents.grant(a, characterSku('hero'), 'event');
    ents.grant(a, 'bundle:season1', 'event'); // an unknown namespace, skipped
    expect(ents.ownership(a)).toEqual({ unlockedBlueprints: ['cannon'], ownedCharacters: ['hero'] });
  });

  it('is empty for an account with no grants — which is every account today', () => {
    expect(ents.ownership(makeAccount('acct-1'))).toEqual({ unlockedBlueprints: [], ownedCharacters: [] });
  });
});

describe('the entitlements schema itself', () => {
  it('is hand-queryable the way design/19 §7 requires, with no admin service', () => {
    // Not decoration: §7 rules out an admin service and says the requirement is only that
    // the schema be readable and correctable with plain SQL. This is that claim, executed.
    const a = makeAccount('acct-1');
    ents.grant(a, characterSku('hero'), 'purchase', { orderId: 'ord-1' });
    ents.grant(a, characterSku('villain'), 'grant');
    ents.grant(a, blueprintSku('cannon'), 'grant');

    const characters = db.prepare("SELECT sku FROM entitlements WHERE sku LIKE 'character:%' ORDER BY id").all() as unknown as {
      sku: string;
    }[];
    expect(characters.map((r) => r.sku)).toEqual(['character:hero', 'character:villain']);

    // §7's daily anomaly audit, in one line: count the non-purchase grants per account.
    const audit = db
      .prepare("SELECT account_id, COUNT(*) AS n FROM entitlements WHERE source <> 'purchase' GROUP BY account_id")
      .all() as unknown as { account_id: string; n: number }[];
    expect(audit).toEqual([{ account_id: a, n: 2 }]);
  });

  it('survives being opened twice — CREATE TABLE IF NOT EXISTS, like every other table here', () => {
    const a = makeAccount('acct-1');
    ents.grant(a, characterSku('hero'), 'grant');
    db.exec('SELECT 1'); // the db is live
    const second = openDb(':memory:'); // a fresh file gets the same schema, not an error
    expect(() => new EntitlementService(second).list('acct-1')).not.toThrow();
    second.close();
  });
});
