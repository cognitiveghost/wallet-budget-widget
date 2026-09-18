const BASE = 'https://rest.budgetbakers.com/wallet/v1/api';
const PAGE = 200; // the documented maximum for limit

// Responses wrap their list under a type-specific key (budgets, accounts,
// records, standingOrders). Take that key by name: `agentHints` is also an
// array and is serialised BEFORE the data key for every collection except
// accounts, so "first array-valued property" silently returns the hints.
function listOf(body, key) {
  if (Array.isArray(body)) return body;
  if (!body || typeof body !== 'object') return [];
  if (Array.isArray(body[key])) return body[key];
  // Unknown envelope: any array will do, but never the hints.
  for (const [k, v] of Object.entries(body)) {
    if (k !== 'agentHints' && Array.isArray(v)) return v;
  }
  return [];
}

function createApi({ token, fetchImpl }) {
  const doFetch = fetchImpl || globalThis.fetch;
  let remaining = null;
  let limit = null;

  async function get(path, key, params = {}) {
    const url = new URL(BASE + path);
    for (const [k, v] of Object.entries(params)) {
      if (v === undefined || v === null) continue;
      if (Array.isArray(v)) v.forEach((x) => url.searchParams.append(k, x));
      else url.searchParams.append(k, v);
    }

    const res = await doFetch(url.toString(), {
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
    });

    const hdr = (n) => (res.headers && typeof res.headers.get === 'function' ? res.headers.get(n) : null);
    const rem = hdr('x-ratelimit-remaining-hour');
    const lim = hdr('x-ratelimit-limit-hour');
    if (rem !== null && rem !== undefined) remaining = Number(rem);
    if (lim !== null && lim !== undefined) limit = Number(lim);

    if (!res.ok) {
      const err = new Error(res.status === 401 ? 'unauthorized' : `request failed (${res.status})`);
      err.status = res.status;
      throw err;
    }
    return listOf(await res.json(), key);
  }

  // Bounded: an API that ignored `offset` would otherwise loop forever against
  // a rate-limited endpoint. 100 pages is 20k records, far beyond any window
  // this app asks for.
  const MAX_PAGES = 100;

  async function paged(path, key, params) {
    const all = [];
    for (let i = 0; i < MAX_PAGES; i += 1) {
      const page = await get(path, key, { ...params, limit: PAGE, offset: i * PAGE });
      all.push(...page);
      // A short page means the end; no total is needed to know we are done.
      if (page.length < PAGE) return all;
    }
    return all;
  }

  return {
    budgets: () => get('/budgets', 'budgets', { spending: 'current+2', limit: 20 }),
    standingOrders: () => get('/standing-orders', 'standingOrders', { limit: PAGE }),
    accounts: () => get('/accounts', 'accounts', { limit: 20 }),
    records: ({ from, to, categoryId }) => paged('/records', 'records', {
      recordDate: [`gte.${from}`, `lte.${to}`],
      categoryId,
      convertTo: 'EUR',
      sortBy: '-recordDate',
    }),
    rateLimit: () => ({ remaining, limit }),
  };
}

module.exports = { createApi, BASE, listOf };
