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

test('budgets requests the precomputed spending window', async () => {
  const log = [];
  const api = createApi({ token: 'a.b.c', fetchImpl: fakeFetch({ '/budgets': { body: { budgets: [{ id: 'b' }] } } }, log) });
  const r = await api.budgets();
  assert.ok(log[0].url.includes('spending=current%2B2') || log[0].url.includes('spending=current+2'));
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
