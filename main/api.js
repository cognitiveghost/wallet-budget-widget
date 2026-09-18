const BASE = 'https://rest.budgetbakers.com/wallet/v1/api';
const PAGE = 200; // the documented maximum for limit

// Responses wrap their list under a type-specific key (budgets, accounts,
// records, ...) and standing orders use `results`. Rather than hardcode each,
// take the first array-valued property.
function firstArray(body) {
  if (Array.isArray(body)) return body;
  for (const v of Object.values(body || {})) if (Array.isArray(v)) return v;
  return [];
}

function createApi({ token, fetchImpl }) {
  const doFetch = fetchImpl || globalThis.fetch;
  let remaining = null;
  let limit = null;

  async function get(path, params = {}) {
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
    return firstArray(await res.json());
  }

  async function paged(path, params) {
    const all = [];
    for (let offset = 0; ; offset += PAGE) {
      const page = await get(path, { ...params, limit: PAGE, offset });
      all.push(...page);
      // A short page means the end; no total is needed to know we are done.
      if (page.length < PAGE) return all;
    }
  }

  return {
    budgets: () => get('/budgets', { spending: 'current+2', limit: 20 }),
    standingOrders: () => get('/standing-orders', { limit: PAGE }),
    accounts: () => get('/accounts', { limit: 20 }),
    records: ({ from, to, categoryId }) => paged('/records', {
      recordDate: [`gte.${from}`, `lte.${to}`],
      categoryId,
      convertTo: 'EUR',
      sortBy: '-recordDate',
    }),
    rateLimit: () => ({ remaining, limit }),
  };
}

module.exports = { createApi, BASE };
