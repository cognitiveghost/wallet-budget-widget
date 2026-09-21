const BASE = 'https://rest.budgetbakers.com/wallet/v1/api';
const PAGE = 200; // the documented maximum for limit
// `spending=current+N` asks for N closed periods alongside the running one.
// Wallet caps N server-side and answers anything past the cap with 400 — the
// documented parameter says nothing about a bound, and the cap is not
// discoverable without asking. The wide window is what the median tick and the
// "over in N of M" footer are drawn from; the narrow one is what the app ran on
// for a year and is always accepted.
const SPENDING_WIDE = 'current+11';
const SPENDING_NARROW = 'current+2';
// Without a deadline a stalled connection (proxy blackhole, TLS interception)
// leaves the UI on "Connecting…" forever instead of reporting a failure.
const TIMEOUT_MS = 30000;

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

    let res;
    try {
      res = await doFetch(url.toString(), {
        headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch (err) {
      if (err && (err.name === 'TimeoutError' || err.name === 'AbortError')) {
        throw new Error(`Wallet did not respond within ${TIMEOUT_MS / 1000}s`);
      }
      throw err;
    }

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

  // A year of closed periods costs the same request as two, so the widening
  // buys `past[]` for nothing — but only where the server allows it. Budgets
  // are the one call the dashboard cannot render without, and history is an
  // enrichment on top of it, so a server that refuses the wide window gets the
  // narrow one rather than taking the whole dashboard to the gate. Only 400 is
  // caught: a 401 has to reach the gate as a token problem, and a 5xx is not a
  // bad request.
  let spendingWindow = SPENDING_WIDE;

  async function budgets() {
    try {
      return await get('/budgets', 'budgets', { spending: spendingWindow, limit: 20 });
    } catch (err) {
      if (err.status !== 400 || spendingWindow === SPENDING_NARROW) throw err;
      // Remembered, so this costs one wasted request per session, not one per
      // poll cycle.
      spendingWindow = SPENDING_NARROW;
      return get('/budgets', 'budgets', { spending: spendingWindow, limit: 20 });
    }
  }

  return {
    budgets,
    standingOrders: () => get('/standing-orders', 'standingOrders', { limit: PAGE }),
    // Cardinality (must/need/want) lives only on the category, never on the
    // record, so the list has to be fetched to classify a month's spending.
    categories: () => paged('/categories', 'categories', {}),
    // Which occurrences have already produced records, been paid, or been
    // dismissed. The filter takes timestamps, not bare days.
    orderItems: ({ from, to }) => paged('/standing-orders/items', 'standingOrderItems', {
      originalDate: [`gte.${from}T00:00:00Z`, `lte.${to}T23:59:59Z`],
    }),
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
