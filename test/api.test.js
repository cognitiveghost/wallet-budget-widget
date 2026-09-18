const { test } = require('node:test');
const assert = require('node:assert');
const { createApi } = require('../main/api');

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
