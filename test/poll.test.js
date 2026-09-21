const { test } = require('node:test');
const assert = require('node:assert');
const poll = require('../main/poll');

const iso = (ms) => new Date(ms).toISOString().slice(0, 10);
const DAY = 86400000;

// A quarterly or yearly budget measures its rate over a period that started
// long before this month. Trimming the fetched window down to the current
// month divided that budget's spending by its whole period and projected
// almost nothing, so the wider window has to survive all the way into build().
test('spending from before this month still feeds a long budget period', async () => {
  const today = Date.now();
  const monthStart = new Date().toISOString().slice(0, 8) + '01';
  const periodStart = iso(today - 60 * DAY);
  const periodEnd = iso(today + 30 * DAY);
  const oldRecord = iso(today - 45 * DAY);

  assert.ok(oldRecord < monthStart, 'fixture must sit before the current month');

  const api = {
    budgets: async () => [{
      id: 'b1',
      name: 'Quarterly',
      accountIds: [], categoryIds: [], labelIds: [],
      spending: { current: { spent: 300, effectiveLimit: 1000, periodStart, periodEnd } },
    }],
    standingOrders: async () => [],
    categories: async () => [],
    orderItems: async () => [],
    accounts: async () => [{ id: 'a1', name: 'A', balance: { currentBalance: 0, currencyCode: 'EUR' }, recordStats: {} }],
    records: async (params) => (params.categoryId ? [] : [
      { id: 'r1', accountId: 'a1', convertedAmount: -300, recordDate: `${oldRecord}T12:00:00Z` },
    ]),
    rateLimit: () => ({ remaining: 200, limit: 300 }),
  };

  let snapshot = null;
  await poll.refreshNow({ api, onSnapshot: (s) => { snapshot = s; }, onError: (e) => { throw e; } });

  assert.ok(snapshot, 'no snapshot was produced');
  assert.ok(snapshot.budgets[0].discretionary > 0,
    `discretionary was ${snapshot.budgets[0].discretionary} — the record was filtered out before build()`);
});

const { refreshNow } = poll;

test('the cycle fetches categories and order items alongside everything else', async () => {
  const calls = [];
  const api = {
    budgets: async () => { calls.push('budgets'); return []; },
    standingOrders: async () => { calls.push('orders'); return []; },
    accounts: async () => { calls.push('accounts'); return []; },
    categories: async () => { calls.push('categories'); return [{ id: 'c1', cardinality: 'must' }]; },
    orderItems: async () => { calls.push('items'); return [{ id: 'i1', standingOrderId: 'o1', recordIds: [] }]; },
    records: async () => { calls.push('records'); return []; },
    rateLimit: () => ({ remaining: 200, limit: 300 }),
  };
  let snap = null;
  await refreshNow({ api, onSnapshot: (s) => { snap = s; }, onError: (e) => { throw e; } });
  assert.ok(calls.includes('categories'), 'categories must be fetched');
  assert.ok(calls.includes('items'), 'order items must be fetched');
  assert.ok(snap, 'a snapshot must still be produced');
});

test('a failing order-items call does not take the whole cycle down', async () => {
  const api = {
    budgets: async () => [],
    standingOrders: async () => [],
    accounts: async () => [],
    categories: async () => { throw new Error('categories exploded'); },
    orderItems: async () => { throw new Error('items exploded'); },
    records: async () => [],
    rateLimit: () => ({ remaining: 200, limit: 300 }),
  };
  let snap = null;
  let err = null;
  await refreshNow({ api, onSnapshot: (s) => { snap = s; }, onError: (e) => { err = e; } });
  assert.ok(snap, 'the dashboard still renders without the two optional calls');
  assert.strictEqual(err, null);
});
