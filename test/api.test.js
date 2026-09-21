const { test } = require('node:test');
const assert = require('node:assert');
const { createApi, listOf } = require('../main/api');

// Minimal fetch double. `routes` maps a URL substring to a response spec.
function fakeFetch(routes, log = []) {
  return async (url, opts) => {
    log.push({ url, opts });
    for (const [needle, spec] of Object.entries(routes)) {
      if (url.includes(needle)) {
        return {
          ok: spec.status === undefined || spec.status < 400,
          status: spec.status ?? 200,
          headers: new Map(Object.entries(spec.headers ?? {})),
          json: async () => spec.body,
          text: async () => JSON.stringify(spec.body),
        };
      }
    }
    throw new Error(`unexpected url ${url}`);
  };
}

test('the bearer token is sent in the Authorization header', async () => {
  const log = [];
  const api = createApi({ token: 'a.b.c', fetchImpl: fakeFetch({ '/accounts': { body: { accounts: [] } } }, log) });
  await api.accounts();
  assert.strictEqual(log[0].opts.headers.Authorization, 'Bearer a.b.c');
});

test('budgets asks for a year of history, not two periods', async () => {
  const log = [];
  const api = createApi({ token: 'a.b.c', fetchImpl: fakeFetch({ '/budgets': { body: { budgets: [{ id: 'b' }] } } }, log) });
  const r = await api.budgets();
  assert.ok(
    log[0].url.includes('spending=current%2B11') || log[0].url.includes('spending=current+11'),
    `expected current+11, got ${log[0].url}`,
  );
  assert.deepStrictEqual(r, [{ id: 'b' }]);
});

test('records asks the server to convert to EUR', async () => {
  const log = [];
  const api = createApi({ token: 'a.b.c', fetchImpl: fakeFetch({ '/records': { body: { records: [] } } }, log) });
  await api.records({ from: '2026-09-01', to: '2026-09-30' });
  assert.ok(log[0].url.includes('convertTo=EUR'));
  assert.ok(log[0].url.includes('recordDate=gte.2026-09-01'));
  assert.ok(log[0].url.includes('recordDate=lte.2026-09-30'));
});

test('records pages until a short page arrives', async () => {
  const full = Array.from({ length: 200 }, (_, i) => ({ id: `r${i}` }));
  let call = 0;
  const api = createApi({
    token: 'a.b.c',
    fetchImpl: async (url) => {
      call += 1;
      const body = { records: call === 1 ? full : [{ id: 'last' }] };
      return { ok: true, status: 200, headers: new Map(), json: async () => body };
    },
  });
  const r = await api.records({ from: '2026-09-01', to: '2026-09-30' });
  assert.strictEqual(r.length, 201);
  assert.strictEqual(call, 2);
});

test('a 401 throws an unauthorized error carrying the status', async () => {
  const api = createApi({ token: 'a.b.c', fetchImpl: fakeFetch({ '/accounts': { status: 401, body: {} } }) });
  await assert.rejects(() => api.accounts(), (e) => e.status === 401 && /unauthorized/.test(e.message));
});

test('a 500 throws and carries the status', async () => {
  const api = createApi({ token: 'a.b.c', fetchImpl: fakeFetch({ '/accounts': { status: 500, body: {} } }) });
  await assert.rejects(() => api.accounts(), (e) => e.status === 500);
});

test('rate limit headers are recorded from the last response', async () => {
  const api = createApi({
    token: 'a.b.c',
    fetchImpl: fakeFetch({ '/accounts': { body: { accounts: [] }, headers: { 'x-ratelimit-remaining-hour': '271', 'x-ratelimit-limit-hour': '450' } } }),
  });
  await api.accounts();
  assert.deepStrictEqual(api.rateLimit(), { remaining: 271, limit: 450 });
});

test('a response with no rate limit headers leaves the previous reading alone', async () => {
  const api = createApi({ token: 'a.b.c', fetchImpl: fakeFetch({ '/accounts': { body: { accounts: [] } } }) });
  await api.accounts();
  assert.deepStrictEqual(api.rateLimit(), { remaining: null, limit: null });
});

test('a list response under an unexpected key still yields an array', async () => {
  const api = createApi({ token: 'a.b.c', fetchImpl: fakeFetch({ '/standing-orders': { body: { results: [{ id: 's' }] } } }) });
  assert.deepStrictEqual(await api.standingOrders(), [{ id: 's' }]);
});

test('records accepts a category filter', async () => {
  const log = [];
  const api = createApi({ token: 'a.b.c', fetchImpl: fakeFetch({ '/records': { body: { records: [] } } }, log) });
  await api.records({ from: '2026-09-01', to: '2026-09-30', categoryId: 'cat1,cat2' });
  assert.ok(log[0].url.includes('categoryId=cat1%2Ccat2'));
});

// --- envelope regressions --------------------------------------------------
// agentHints is an array and is serialised before the data key for budgets,
// records and standing-orders, so "first array" returned the hints instead.

test('listOf prefers the named key over agentHints', () => {
  const body = { agentHints: [{ type: 'pagination.has_more' }], budgets: [{ id: 'b1' }] };
  assert.deepEqual(listOf(body, 'budgets'), [{ id: 'b1' }]);
});

test('listOf returns empty, not hints, when the named key is absent', () => {
  assert.deepEqual(listOf({ agentHints: [{ type: 'x' }] }, 'budgets'), []);
});

test('listOf still handles a bare array body', () => {
  assert.deepEqual(listOf([{ id: 'a' }], 'accounts'), [{ id: 'a' }]);
});

test('budgets reads the budgets key past leading agentHints', async () => {
  const api = createApi({
    token: 't',
    fetchImpl: async () => ({
      ok: true, status: 200, headers: { get: () => null },
      json: async () => ({ agentHints: [{ type: 'x' }], budgets: [{ id: 'b1' }, { id: 'b2' }] }),
    }),
  });
  assert.equal((await api.budgets()).length, 2);
});

test('paged stops instead of looping forever when offset is ignored', async () => {
  let calls = 0;
  const full = Array.from({ length: 200 }, (_, i) => ({ id: `r${i}` }));
  const api = createApi({
    token: 't',
    fetchImpl: async () => {
      calls += 1;
      return { ok: true, status: 200, headers: { get: () => null }, json: async () => ({ records: full }) };
    },
  });
  const out = await api.records({ from: '2026-01-01', to: '2026-01-31' });
  assert.equal(calls, 100);
  assert.equal(out.length, 20000);
});

test('a stalled request reports a timeout instead of hanging', async () => {
  // The real deadline is 30s; assert the mapping, not the wall clock.
  const api = createApi({
    token: 't',
    fetchImpl: async () => { throw Object.assign(new Error('aborted'), { name: 'TimeoutError' }); },
  });
  await assert.rejects(() => api.accounts(), /did not respond within 30s/);
});

test('a non-timeout network error passes through unchanged', async () => {
  const api = createApi({
    token: 't',
    fetchImpl: async () => { throw new TypeError('fetch failed'); },
  });
  await assert.rejects(() => api.accounts(), /fetch failed/);
});

test('the request carries an abort signal', async () => {
  let seen = null;
  const api = createApi({
    token: 't',
    fetchImpl: async (_u, opts) => {
      seen = opts.signal;
      return { ok: true, status: 200, headers: { get: () => null }, json: async () => ({ accounts: [] }) };
    },
  });
  await api.accounts();
  assert.ok(seen && typeof seen.addEventListener === 'function');
});

test('categories unwraps its own key, not agentHints', async () => {
  const body = { agentHints: [{ type: 'noise' }], categories: [{ id: 'c1', name: 'Groceries', cardinality: 'must' }] };
  const api = createApi({ token: 'a.b.c', fetchImpl: fakeFetch({ '/categories': { body } }) });
  assert.deepStrictEqual(await api.categories(), [{ id: 'c1', name: 'Groceries', cardinality: 'must' }]);
});

test('order items are asked for over the given window and unwrap standingOrderItems', async () => {
  const log = [];
  const body = { agentHints: [{ type: 'noise' }], standingOrderItems: [{ id: 'i1', standingOrderId: 'o1', recordIds: ['r9'] }] };
  const api = createApi({ token: 'a.b.c', fetchImpl: fakeFetch({ '/standing-orders/items': { body } }, log) });
  const items = await api.orderItems({ from: '2026-06-01', to: '2026-10-31' });
  assert.deepStrictEqual(items, [{ id: 'i1', standingOrderId: 'o1', recordIds: ['r9'] }]);
  assert.ok(log[0].url.includes('originalDate=gte.2026-06-01T00%3A00%3A00Z'), log[0].url);
  assert.ok(log[0].url.includes('originalDate=lte.2026-10-31T23%3A59%3A59Z'), log[0].url);
});

// A 400 on the widened spending window took the whole dashboard to the gate
// with "request failed (400)": the token was fine, the request shape was not.
// The wide window is an enrichment — it buys `past[]` for the history marks —
// and an enrichment must never be able to fail the one call the dashboard
// cannot render without.
function sequenceFetch(responses, log = []) {
  let i = 0;
  return async (url, opts) => {
    log.push({ url, opts });
    const spec = responses[Math.min(i += 1, responses.length) - 1];
    return {
      ok: spec.status === undefined || spec.status < 400,
      status: spec.status ?? 200,
      headers: new Map(),
      json: async () => spec.body,
      text: async () => JSON.stringify(spec.body),
    };
  };
}

test('a 400 on the wide spending window falls back to the narrow one', async () => {
  const log = [];
  const api = createApi({
    token: 'a.b.c',
    fetchImpl: sequenceFetch([{ status: 400, body: {} }, { body: { budgets: [{ id: 'b' }] } }], log),
  });
  assert.deepStrictEqual(await api.budgets(), [{ id: 'b' }]);
  assert.strictEqual(log.length, 2, 'it must retry exactly once');
  assert.ok(log[0].url.includes('current%2B11') || log[0].url.includes('current+11'), log[0].url);
  assert.ok(log[1].url.includes('current%2B2') || log[1].url.includes('current+2'), log[1].url);
});

test('a rejected token is never retried — 401 has to reach the gate as 401', async () => {
  const log = [];
  const api = createApi({
    token: 'a.b.c',
    fetchImpl: sequenceFetch([{ status: 401, body: {} }, { body: { budgets: [{ id: 'b' }] } }], log),
  });
  await assert.rejects(() => api.budgets(), (e) => e.status === 401 && e.message === 'unauthorized');
  assert.strictEqual(log.length, 1, 'a 401 must not burn a second request');
});

test('a server error is not retried either — a 500 is not a bad request', async () => {
  const log = [];
  const api = createApi({
    token: 'a.b.c',
    fetchImpl: sequenceFetch([{ status: 500, body: {} }, { body: { budgets: [] } }], log),
  });
  await assert.rejects(() => api.budgets(), (e) => e.status === 500);
  assert.strictEqual(log.length, 1);
});

test('the fallback fires once, not on every later call', async () => {
  const log = [];
  const api = createApi({
    token: 'a.b.c',
    fetchImpl: sequenceFetch([{ status: 400, body: {} }, { body: { budgets: [{ id: 'b' }] } }], log),
  });
  await api.budgets();
  await api.budgets();
  assert.deepStrictEqual(
    log.slice(2).map((c) => (c.url.includes('current%2B2') ? 'narrow' : 'wide')),
    ['narrow'],
    'once the server has said no, stop asking for the wide window',
  );
});
