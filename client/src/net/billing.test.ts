/**
 * The store's wire calls (design/19-server-platform.md §4). Fake-fetch driven, mirroring
 * `auth.test.ts`/`party.test.ts` — the server's own `BillingService.test.ts` owns whether
 * settlement is correct; this pins the shapes the CLIENT sends and what it does with a
 * response it does not fully understand.
 *
 * The parse cases are the ones worth reading. Everything here comes off a network, and this
 * client's rule is that a response it cannot make sense of degrades to "nothing to sell"
 * rather than to a plausible-looking guess — a defaulted PRICE or a defaulted `configured`
 * would both be the client inventing permission to charge someone.
 */
import { describe, it, expect, vi } from 'vitest';
import {
  createStoreOrder, fetchStoreOrder, formatSkuPrice, listStoreSkus, parseOrder, parseSku,
} from './billing';

const SKU = { sku: 'bp.cryobolt', title: 'Blueprint — Cryobolt', amountCents: 1200, currency: 'CNY', grants: [{ kind: 'blueprint', id: 'cryobolt' }] };
const ORDER = { id: 'ord-1', sku: 'bp.cryobolt', platform: 'dev', amountCents: 1200, currency: 'CNY', state: 'created' };

function fakeFetch(status: number, body: unknown) {
  return vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) =>
    ({ ok: status < 400, status, json: async () => body }) as Response);
}

/** A response whose body is not JSON at all — a proxy's HTML error page on a 502. */
function htmlErrorFetch(status: number) {
  return vi.fn(async () => ({ ok: status < 400, status, json: async () => { throw new SyntaxError('Unexpected token <'); } }) as unknown as Response);
}

describe('listStoreSkus', () => {
  it('sends the player bearer token and returns the listing', async () => {
    const fetch = fakeFetch(200, { skus: [SKU] });
    const skus = await listStoreSkus('http://mm', 'tok-1', { fetch });
    expect(skus).toEqual([SKU]);
    const [url, init] = fetch.mock.calls[0]!;
    expect(url).toBe('http://mm/store/skus');
    // A PLAYER session, not an internal key: the listing is answered relative to whoever
    // the token names.
    expect((init as RequestInit).headers).toMatchObject({ authorization: 'Bearer tok-1' });
  });

  it('drops a row with no price rather than defaulting one', async () => {
    // The whole file header, in one case. A SKU whose `amountCents` did not arrive must not
    // be offered: every fallback number available here is a price the client made up.
    const fetch = fakeFetch(200, {
      skus: [SKU, { sku: 'bp.mystery', title: 'Mystery', currency: 'CNY', grants: [] }],
    });
    expect(await listStoreSkus('http://mm', 'tok-1', { fetch })).toEqual([SKU]);
  });

  it.each([
    ['no sku id', { title: 'X', amountCents: 100, currency: 'CNY' }],
    ['an empty sku id', { sku: '', title: 'X', amountCents: 100, currency: 'CNY' }],
    ['a negative price', { sku: 'a', amountCents: -1, currency: 'CNY' }],
    ['a non-finite price', { sku: 'a', amountCents: Number.NaN, currency: 'CNY' }],
    ['no currency', { sku: 'a', amountCents: 100 }],
    ['not an object', 'bp.cryobolt'],
  ])('drops a row with %s', (_why, row) => {
    expect(parseSku(row)).toBeNull();
  });

  it('drops a bad row WITHOUT discarding the good ones around it', async () => {
    // Same posture as `parseEntitlements`: one malformed entry is one lost row, not a lost
    // store. Ordering matters here — the bad row is in the MIDDLE.
    const second = { ...SKU, sku: 'bp.cannon', grants: [{ kind: 'blueprint', id: 'cannon' }] };
    const fetch = fakeFetch(200, { skus: [SKU, null, second] });
    expect((await listStoreSkus('http://mm', 'tok-1', { fetch })).map((s) => s.sku))
      .toEqual(['bp.cryobolt', 'bp.cannon']);
  });

  it('keeps only grants it understands, and keeps the SKU either way', async () => {
    // A kind billsvc adds later must not break the store for the SKUs that already work.
    const fetch = fakeFetch(200, {
      skus: [{ ...SKU, grants: [{ kind: 'blueprint', id: 'cryobolt' }, { kind: 'wallet', id: 'coins' }, { kind: 'character', id: '' }] }],
    });
    const [only] = await listStoreSkus('http://mm', 'tok-1', { fetch });
    expect(only!.grants).toEqual([{ kind: 'blueprint', id: 'cryobolt' }]);
  });

  it('falls back to the sku id when the server sent no title', async () => {
    const fetch = fakeFetch(200, { skus: [{ sku: 'bp.cannon', amountCents: 1800, currency: 'CNY' }] });
    expect((await listStoreSkus('http://mm', 'tok-1', { fetch }))[0]!.title).toBe('bp.cannon');
  });

  it('rejects a 200 whose body is literally `null`', async () => {
    // A gateway that answers 200 with `null` used to reach the caller as
    // "cannot read properties of null" from inside a screen. `res.ok` is not enough on its
    // own — the body has to be there too.
    const e = await listStoreSkus('http://mm', 'tok-1', { fetch: fakeFetch(200, null) }).catch((x: Error) => x);
    expect(e).toBeInstanceOf(Error);
    expect((e as Error).message).toMatch(/no body/);
  });

  it('returns nothing at all when `skus` is not an array', async () => {
    expect(await listStoreSkus('http://mm', 'tok-1', { fetch: fakeFetch(200, { skus: 'all of them' }) })).toEqual([]);
  });

  it('rejects with the server message, and with a clean Error on a non-JSON body', async () => {
    await expect(listStoreSkus('http://mm', 'tok-1', { fetch: fakeFetch(401, { error: 'invalid token' }) }))
      .rejects.toThrow(/invalid token/);
    // The guarded `res.json()`: a proxy's HTML 502 must not surface as a raw SyntaxError
    // from somewhere deep inside a Pixi screen.
    const e = await listStoreSkus('http://mm', 'tok-1', { fetch: htmlErrorFetch(502) }).catch((x: Error) => x);
    expect(e).toBeInstanceOf(Error);
    expect((e as Error).message).toMatch(/502/);
    expect((e as Error).name).not.toBe('SyntaxError');
  });
});

describe('createStoreOrder', () => {
  it('sends ONLY the sku and the platform — never an amount', async () => {
    // design/19 §4's rule: "an `amount` in the request body is discarded". Sending one
    // anyway would create the illusion that the client has a say in the price.
    const fetch = fakeFetch(200, { order: ORDER, payment: { configured: true, params: { orderId: 'ord-1' } } });
    await createStoreOrder('http://mm', 'tok-1', 'bp.cryobolt', 'dev', { fetch });
    const [url, init] = fetch.mock.calls[0]!;
    expect(url).toBe('http://mm/store/order');
    expect((init as RequestInit).method).toBe('POST');
    expect(JSON.parse((init as RequestInit).body as string)).toEqual({ sku: 'bp.cryobolt', platform: 'dev' });
    expect((init as RequestInit).headers).toMatchObject({ authorization: 'Bearer tok-1' });
  });

  it('returns the order and its payment block', async () => {
    const fetch = fakeFetch(200, { order: ORDER, payment: { configured: true, params: { receipt: 'product:bp.cryobolt' }, note: 'dev stub' } });
    const { order, payment } = await createStoreOrder('http://mm', 'tok-1', 'bp.cryobolt', 'dev', { fetch });
    expect(order.id).toBe('ord-1');
    expect(payment).toEqual({ configured: true, params: { receipt: 'product:bp.cryobolt' }, note: 'dev stub' });
  });

  it('rejects a 400 for an unknown SKU', async () => {
    await expect(createStoreOrder('http://mm', 'tok-1', 'bp.nope', 'dev', { fetch: fakeFetch(400, { error: 'unknown sku' }) }))
      .rejects.toThrow(/unknown sku/);
  });

  it('rejects a 200 that carried no usable order', async () => {
    // A response the client cannot read is not a booked order. Accepting it would send the
    // caller into a poll against an id it never got.
    await expect(createStoreOrder('http://mm', 'tok-1', 'bp.cryobolt', 'dev', { fetch: fakeFetch(200, { payment: { configured: true } }) }))
      .rejects.toThrow(/no usable order/);
  });

  it.each([
    ['the payment block is missing', {}],
    ['the payment block is not an object', { payment: 'yes' }],
    ['configured is the STRING "true"', { payment: { configured: 'true', params: {} } }],
    ['configured is 1', { payment: { configured: 1, params: {} } }],
  ])('FAILS CLOSED when %s', async (_why, extra) => {
    // The one branch where being permissive costs money. Anything that is not an explicit
    // boolean `true` means "this platform cannot take a payment".
    const fetch = fakeFetch(200, { order: ORDER, ...extra });
    const { payment } = await createStoreOrder('http://mm', 'tok-1', 'bp.cryobolt', 'dev', { fetch });
    expect(payment.configured).toBe(false);
    expect(payment.params).toEqual({});
  });
});

describe('fetchStoreOrder', () => {
  it('reads the order by id, url-encoded', async () => {
    const fetch = fakeFetch(200, { order: { ...ORDER, id: 'ord/1', state: 'settled' } });
    const order = await fetchStoreOrder('http://mm', 'tok-1', 'ord/1', { fetch });
    expect(fetch.mock.calls[0]![0]).toBe('http://mm/store/order/ord%2F1');
    expect(order.state).toBe('settled');
  });

  it.each(['created', 'settled', 'failed'] as const)('accepts the %s state', async (state) => {
    const order = await fetchStoreOrder('http://mm', 'tok-1', 'ord-1', { fetch: fakeFetch(200, { order: { ...ORDER, state } }) });
    expect(order.state).toBe(state);
  });

  it('rejects a state it does not know rather than guessing at it', async () => {
    // A poll that read an unknown state as terminal would either strand a paid order or
    // declare an unpaid one delivered. Neither is a guess worth making.
    expect(parseOrder({ ...ORDER, state: 'refunded' })).toBeNull();
    await expect(fetchStoreOrder('http://mm', 'tok-1', 'ord-1', { fetch: fakeFetch(200, { order: { ...ORDER, state: 'refunded' } }) }))
      .rejects.toThrow(/no usable order/);
  });

  it('fills the advisory fields it can and zeroes the ones it cannot', async () => {
    // Only `id` and `state` drive anything. The rest is display, so a missing one degrades
    // rather than dropping an order the poll is waiting on.
    expect(parseOrder({ id: 'ord-1', state: 'created' })).toEqual({
      id: 'ord-1', sku: '', platform: '', amountCents: 0, currency: '', state: 'created',
    });
  });
});

describe('formatSkuPrice', () => {
  it('renders the SERVER\'s minor units, and nothing else', () => {
    // The only arithmetic this client does with money, and it is presentational.
    expect(formatSkuPrice(1200, 'CNY')).toMatch(/12/);
    expect(formatSkuPrice(1800, 'CNY')).toMatch(/18/);
  });

  it('degrades to a readable string on a host with no usable Intl', () => {
    // A mini-game runtime has historically shipped without a full ICU; a formatter that
    // throws inside render() would take the whole screen with it.
    expect(formatSkuPrice(1200, 'NOT-A-CURRENCY')).toBe('12.00 NOT-A-CURRENCY');
  });
});
