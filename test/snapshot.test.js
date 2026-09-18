const { test } = require('node:test');
const assert = require('node:assert');
const { build, UNCATEGORIZED } = require('../main/snapshot');

const raw = (over) => ({
  budgets: [], orders: [], accounts: [], records: [], uncategorized: [], ...over,
});

const budget = (over) => ({
  id: 'b1', name: 'per:total', accountIds: [], categoryIds: [], labelIds: [],
  type: 'BUDGET_INTERVAL_MONTH',
  spending: { current: { spent: 200, effectiveLimit: 400, progress: 0.5, periodStart: '2026-09-01', periodEnd: '2026-09-30' } },
  ...over,
});

test('a snapshot carries the date it was built for', () => {
  const s = build(raw(), '2026-09-18');
  assert.strictEqual(s.today, '2026-09-18');
  assert.ok(s.generatedAt);
});

test('each budget gains its projection alongside its reported spending', () => {
  const s = build(raw({ budgets: [budget()], records: [
    { id: 'r1', convertedAmount: -200, recordDate: '2026-09-05T12:00:00Z', accountId: 'a1', category: { id: 'c1' }, labels: [] },
  ] }), '2026-09-18');
  assert.strictEqual(s.budgets[0].spent, 200);
  assert.ok(s.budgets[0].projected > 200, 'projection extends past current spend');
  assert.strictEqual(s.budgets[0].limit, 400);
});

test('budgets sort by projected overshoot, worst first', () => {
  const safe = budget({ id: 'safe', name: 'safe', spending: { current: { spent: 10, effectiveLimit: 1000, periodStart: '2026-09-01', periodEnd: '2026-09-30' } } });
  const bad = budget({ id: 'bad', name: 'bad', spending: { current: { spent: 900, effectiveLimit: 1000, periodStart: '2026-09-01', periodEnd: '2026-09-30' } } });
  const records = [
    { id: 'r1', convertedAmount: -10, recordDate: '2026-09-05T12:00:00Z', accountId: 'a1', category: { id: 'c1' }, labels: [] },
    { id: 'r2', convertedAmount: -900, recordDate: '2026-09-05T12:00:00Z', accountId: 'a1', category: { id: 'c1' }, labels: [] },
  ];
  const s = build(raw({ budgets: [safe, bad], records }), '2026-09-18');
  assert.strictEqual(s.budgets[0].id, 'bad');
});

test('sync rows flag a bank account whose newest record is old', () => {
  const accounts = [{
    id: 'a1', name: 'Revolut', isBankSync: true,
    balance: { currentBalance: 100 },
    recordStats: { recordDate: { max: '2026-09-12T00:00:00Z' }, error: null },
  }];
  const s = build(raw({ accounts }), '2026-09-18');
  assert.strictEqual(s.sync[0].ageDays, 6);
  assert.strictEqual(s.sync[0].stale, true);
});

test('a freshly synced bank account is not flagged stale', () => {
  const accounts = [{
    id: 'a1', name: 'Revolut', isBankSync: true,
    balance: { currentBalance: 100 },
    recordStats: { recordDate: { max: '2026-09-17T00:00:00Z' }, error: null },
  }];
  assert.strictEqual(build(raw({ accounts }), '2026-09-18').sync[0].stale, false);
});

test('accounts without bank sync are left out of the sync panel', () => {
  const accounts = [{ id: 'a1', name: 'Cash', isBankSync: false, balance: { currentBalance: 5 }, recordStats: {} }];
  assert.deepStrictEqual(build(raw({ accounts }), '2026-09-18').sync, []);
});

test('a sync error is surfaced even when records are recent', () => {
  const accounts = [{
    id: 'a1', name: 'Revolut', isBankSync: true,
    balance: { currentBalance: 100 },
    recordStats: { recordDate: { max: '2026-09-18T00:00:00Z' }, error: 'consent expired' },
  }];
  assert.strictEqual(build(raw({ accounts }), '2026-09-18').sync[0].error, 'consent expired');
});

test('the uncategorized list is flattened for display', () => {
  const uncategorized = [{
    id: 'r1', convertedAmount: -12.4, recordDate: '2026-09-17T10:00:00Z',
    counterParty: 'LIDL', accountName: 'Revolut',
  }];
  const s = build(raw({ uncategorized }), '2026-09-18');
  assert.deepStrictEqual(s.uncategorized[0], {
    id: 'r1', date: '2026-09-17', amount: -12.4, counterParty: 'LIDL', accountName: 'Revolut',
  });
});

test('the upcoming list covers the next thirty days', () => {
  const orders = [{
    id: 'o1', name: 'Payday', amount: 926.61, type: 'income',
    accountId: 'a1', categoryId: 'c1', generateFromDate: '2026-08-01',
    recurrenceRule: 'FREQ=MONTHLY;INTERVAL=1;BYMONTHDAY=20',
  }];
  const s = build(raw({ orders }), '2026-09-18');
  assert.strictEqual(s.upcoming[0].date, '2026-09-20');
  assert.strictEqual(s.upcoming[0].signed, 926.61);
});

test('the runway starts from the summed account balances', () => {
  const accounts = [
    { id: 'a1', name: 'A', isBankSync: false, balance: { currentBalance: 60 }, recordStats: {} },
    { id: 'a2', name: 'B', isBankSync: false, balance: { currentBalance: 40 }, recordStats: {} },
  ];
  const s = build(raw({ accounts }), '2026-09-18');
  // Current balance already reflects the month's records, so the series must
  // end at today on that total rather than starting from it.
  const atToday = s.runway.actual[s.runway.actual.length - 1];
  assert.strictEqual(atToday.balance, 100);
});

test('the three uncategorized category ids are exported for the records query', () => {
  assert.strictEqual(UNCATEGORIZED.length, 3);
  assert.ok(UNCATEGORIZED.includes('5c5c4e23-00c8-8000-8000-000000000000'));
});

test('an empty account produces a snapshot rather than throwing', () => {
  const s = build(raw(), '2026-09-18');
  assert.deepStrictEqual(s.budgets, []);
  assert.deepStrictEqual(s.upcoming, []);
  assert.ok(s.runway);
});
