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

// --- live API shape regressions -------------------------------------------
// The Wallet API returns amounts as {currencyCode, value} and can emit records
// whose recordDate is absent or unparseable. Both reached `build` unguarded.

test('build survives a record with no recordDate', () => {
  const r = { id: 'r1', accountId: 'a1', convertedAmount: { currencyCode: 'EUR', value: -5 } };
  assert.doesNotThrow(() => build(raw({ records: [r] }), '2026-09-18'));
});

test('build survives an uncategorized record with no recordDate', () => {
  const r = { id: 'r1', accountId: 'a1', convertedAmount: { currencyCode: 'EUR', value: -5 } };
  const snap = build(raw({ uncategorized: [r] }), '2026-09-18');
  assert.equal(snap.uncategorized.length, 0);
});

test('build survives an account whose last record date is unparseable', () => {
  const a = { id: 'a1', name: 'Bank', isBankSync: true, balance: { currentBalance: 10 },
    recordStats: { recordDate: { max: 'N/A' } } };
  const snap = build(raw({ accounts: [a] }), '2026-09-18');
  assert.equal(snap.sync[0].lastRecord, null);
  assert.equal(snap.sync[0].ageDays, null);
});

test('build reads the object amount shape the API actually returns', () => {
  const r = { id: 'r1', accountId: 'a1', recordDate: '2026-09-10T09:00:00.000Z',
    convertedAmount: { currencyCode: 'EUR', value: -12.5 } };
  const snap = build(raw({ uncategorized: [r] }), '2026-09-18');
  assert.equal(snap.uncategorized[0].amount, -12.5);
});

// --- account scoping -------------------------------------------------------
// Balances are in each account's own currency while records arrive converted
// to EUR, so a non-EUR balance cannot join the runway's sum.

test('archived and excluded accounts stay out of the runway total', () => {
  const accounts = [
    { id: 'a1', name: 'A', balance: { currentBalance: 60, currencyCode: 'EUR' }, recordStats: {} },
    { id: 'a2', name: 'Old', archived: true, balance: { currentBalance: 500, currencyCode: 'EUR' }, recordStats: {} },
    { id: 'a3', name: 'Shared', excludeFromStats: true, balance: { currentBalance: 900, currencyCode: 'EUR' }, recordStats: {} },
  ];
  const s = build(raw({ accounts }), '2026-09-18');
  assert.strictEqual(s.runway.actual[s.runway.actual.length - 1].balance, 60);
});

test('a foreign-currency account is dropped from the total and named', () => {
  const accounts = [
    { id: 'a1', name: 'A', balance: { currentBalance: 60, currencyCode: 'EUR' }, recordStats: {} },
    { id: 'a2', name: 'Revolut CZK', balance: { currentBalance: 9000, currencyCode: 'CZK' }, recordStats: {} },
  ];
  const s = build(raw({ accounts }), '2026-09-18');
  assert.strictEqual(s.runway.actual[s.runway.actual.length - 1].balance, 60);
  assert.deepStrictEqual(s.excludedAccounts, ['Revolut CZK']);
});

test('records on an excluded account do not move the runway', () => {
  const accounts = [
    { id: 'a1', name: 'A', balance: { currentBalance: 100, currencyCode: 'EUR' }, recordStats: {} },
    { id: 'a2', name: 'CZK', balance: { currentBalance: 0, currencyCode: 'CZK' }, recordStats: {} },
  ];
  const records = [
    { id: 'r1', accountId: 'a1', convertedAmount: -20, recordDate: '2026-09-05T12:00:00Z' },
    { id: 'r2', accountId: 'a2', convertedAmount: -400, recordDate: '2026-09-06T12:00:00Z' },
  ];
  const s = build(raw({ accounts, records }), '2026-09-18');
  const series = s.runway.actual;
  assert.strictEqual(series[series.length - 1].balance, 100);
  // Opening is 120: the a1 record is walked back out, the a2 record never was.
  assert.strictEqual(series[0].balance, 120);
});

// --- next month ------------------------------------------------------------
// This month's closing balance is half an answer when rent and payday both
// land on the far side of it.

const eurAccount = (over) => ({
  id: 'a1', name: 'A', balance: { currentBalance: 1000, currencyCode: 'EUR' }, recordStats: {}, ...over,
});

test('the line runs to the end of next month', () => {
  const s = build(raw({ accounts: [eurAccount()] }), '2026-09-18');
  const last = s.runway.projected[s.runway.projected.length - 1];
  assert.strictEqual(last.date, '2026-10-31');
  assert.strictEqual(s.nextMonth.start, '2026-10-01');
  assert.strictEqual(s.nextMonth.end, '2026-10-31');
});

test('this month still has its own closing figure alongside the horizon', () => {
  const s = build(raw({ accounts: [eurAccount()] }), '2026-09-18');
  assert.strictEqual(s.runway.monthEndDate, '2026-09-30');
  assert.strictEqual(s.runway.monthEnd, 1000);
  assert.strictEqual(s.nextMonth.opening, s.runway.monthEnd, 'next month opens where this one closed');
});

test('next month closes on its opening plus what is planned, minus the rate', () => {
  const orders = [
    { id: 'o1', name: 'Payday', amount: 2000, type: 'income', accountId: 'a1', categoryId: 'c1',
      generateFromDate: '2026-01-25', recurrenceRule: 'FREQ=MONTHLY;INTERVAL=1;BYMONTHDAY=25' },
    { id: 'o2', name: 'Rent', amount: 800, type: 'expense', accountId: 'a1', categoryId: 'c2',
      generateFromDate: '2026-01-01', recurrenceRule: 'FREQ=MONTHLY;INTERVAL=1;BYMONTHDAY=1' },
  ];
  const s = build(raw({ accounts: [eurAccount()], orders }), '2026-09-18');
  const n = s.nextMonth;
  assert.strictEqual(n.income, 2000);
  assert.strictEqual(n.expense, 800);
  assert.ok(Math.abs((n.opening + n.income - n.expense + n.rate) - n.closing) < 0.02,
    `${n.opening} + ${n.income} - ${n.expense} + ${n.rate} should reach ${n.closing}`);
});

test('everyday spending reaches the line, so the far end is not just orders', () => {
  const records = Array.from({ length: 30 }, (_, i) => ({
    id: `r${i}`, accountId: 'a1', convertedAmount: -20,
    recordDate: `2026-08-${String(i + 1).padStart(2, '0')}T12:00:00Z`,
  }));
  const s = build(raw({ accounts: [eurAccount()], records }), '2026-09-18');
  assert.ok(s.ratePerDay < 0, 'a month of nothing but spending has a negative rate');
  assert.ok(s.nextMonth.closing < s.nextMonth.opening,
    'with no income planned, next month can only go down');
});

// --- records nobody has checked -------------------------------------------

test('uncleared and waiting records are listed, checked ones are not', () => {
  const records = [
    { id: 'r1', accountId: 'a1', convertedAmount: -5, recordDate: '2026-09-17T10:00:00Z', recordState: 'uncleared', counterParty: 'Lidl' },
    { id: 'r2', accountId: 'a1', convertedAmount: -6, recordDate: '2026-09-16T10:00:00Z', recordState: 'waitForAssign' },
    { id: 'r3', accountId: 'a1', convertedAmount: -7, recordDate: '2026-09-15T10:00:00Z', recordState: 'cleared' },
    { id: 'r4', accountId: 'a1', convertedAmount: -8, recordDate: '2026-09-14T10:00:00Z', recordState: 'reconciled' },
  ];
  const s = build(raw({ accounts: [eurAccount()], records }), '2026-09-18');
  assert.deepStrictEqual(s.unchecked.map((r) => r.id), ['r1', 'r2'], 'newest first');
  assert.strictEqual(s.unchecked[0].counterParty, 'Lidl');
  assert.strictEqual(s.reviewStateSeen, true);
});

test('an account that never reports review state is told apart from a clean one', () => {
  const records = [{ id: 'r1', accountId: 'a1', convertedAmount: -5, recordDate: '2026-09-17T10:00:00Z' }];
  const s = build(raw({ accounts: [eurAccount()], records }), '2026-09-18');
  assert.deepStrictEqual(s.unchecked, []);
  assert.strictEqual(s.reviewStateSeen, false, 'the UI needs to say why the list is empty');
});

test('off-schedule income keeps the line from marching to zero', () => {
  // Spends 40 a day and is paid 40 a day by transfers nobody scheduled. The
  // balance is flat in reality, and the projection has to say so.
  const records = [];
  for (let d = 1; d <= 28; d += 1) {
    const day = `2026-08-${String(d).padStart(2, '0')}T12:00:00Z`;
    records.push({ id: `out${d}`, accountId: 'a1', recordDate: day, convertedAmount: -40 });
    records.push({ id: `in${d}`, accountId: 'a1', recordDate: day, convertedAmount: 40 });
  }
  const s = build(raw({ accounts: [eurAccount()], records }), '2026-09-18');
  assert.strictEqual(s.ratePerDay, 0);
  assert.strictEqual(s.nextMonth.closing, s.nextMonth.opening,
    'nothing scheduled and no drift means the balance stays put');
});

test('a standing order the link claims is left out of the rate', () => {
  const orders = [{
    id: 'o1', name: 'Bill', amount: 60, type: 'expense', accountId: 'a1', categoryId: 'c1',
    generateFromDate: '2026-01-10', recurrenceRule: 'FREQ=MONTHLY;INTERVAL=1;BYMONTHDAY=10',
  }];
  // Billed 88, not the 60 the order says, so only the link can attribute it.
  const records = [{ id: 'bill-88', accountId: 'a1', recordDate: '2026-09-10T12:00:00Z', convertedAmount: -88 }];
  const loose = build(raw({ accounts: [eurAccount()], orders, records }), '2026-09-18');
  const tied = build(raw({
    accounts: [eurAccount()], orders, records,
    orderItems: [{ standingOrderId: 'o1', recordIds: ['bill-88'] }],
  }), '2026-09-18');

  assert.ok(loose.ratePerDay < 0, 'unlinked, the bill is everyday spending as well as a payment due');
  assert.strictEqual(tied.ratePerDay, 0);
  assert.ok(tied.nextMonth.closing > loose.nextMonth.closing,
    'counting it once instead of twice leaves more money at the end');
});
