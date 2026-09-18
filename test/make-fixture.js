// Regenerates test/fixture-snapshot.js for test/preview.html:
//   node test/make-fixture.js
// It runs the sample data through the real build(), so the preview can never
// drift from the shape the renderer actually receives. Hand-editing the
// fixture is what lets a panel look fine in the preview and empty in the app.
const fs = require('node:fs');
const path = require('node:path');
const { build } = require('../main/snapshot');

const TODAY = '2026-09-18';
const DAY = 86400000;
const iso = (offset) => new Date(Date.parse(`${TODAY}T12:00:00Z`) + offset * DAY).toISOString();
const day = (offset) => iso(offset).slice(0, 10);

// Deterministic: a fixture that changes every run is a fixture you cannot
// review a screenshot against.
let seed = 7;
const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
const pick = (xs) => xs[Math.floor(rnd() * xs.length)];

const CAT = { groceries: 'c-gro', eating: 'c-eat', transport: 'c-tra', subs: 'c-sub', home: 'c-hom', fun: 'c-fun' };

const accounts = [
  { id: 'a1', name: 'Revolut', isBankSync: true, balance: { currentBalance: 2184.4, currencyCode: 'EUR' },
    recordStats: { recordDate: { max: iso(0) }, error: null } },
  { id: 'a2', name: 'Cash', isBankSync: false, balance: { currentBalance: 96.2, currencyCode: 'EUR' }, recordStats: {} },
  { id: 'a3', name: 'Revolut CZK', isBankSync: true, balance: { currentBalance: 8400, currencyCode: 'CZK' },
    recordStats: { recordDate: { max: iso(-9) }, error: null } },
];

const orders = [
  { id: 'o1', name: 'Salary', amount: 2480, type: 'income', accountId: 'a1', categoryId: 'c-inc',
    generateFromDate: '2026-01-25', recurrenceRule: 'FREQ=MONTHLY;INTERVAL=1;BYMONTHDAY=25',
    dueDateNotificationEnabled: true },
  { id: 'o2', name: 'Rent', amount: 1150, type: 'expense', accountId: 'a1', categoryId: CAT.home,
    generateFromDate: '2026-01-01', recurrenceRule: 'FREQ=MONTHLY;INTERVAL=1;BYMONTHDAY=1' },
  { id: 'o3', name: 'Spotify', amount: 11.99, type: 'expense', accountId: 'a1', categoryId: CAT.subs,
    generateFromDate: '2026-01-22', recurrenceRule: 'FREQ=MONTHLY;INTERVAL=1;BYMONTHDAY=22' },
  { id: 'o4', name: 'Gym', amount: 39, type: 'expense', accountId: 'a1', categoryId: CAT.subs,
    generateFromDate: '2026-01-05', recurrenceRule: 'FREQ=MONTHLY;INTERVAL=1;BYMONTHDAY=5' },
  { id: 'o5', name: 'Phone', amount: 24.5, type: 'expense', accountId: 'a1', categoryId: CAT.subs,
    generateFromDate: '2026-01-14', recurrenceRule: 'FREQ=MONTHLY;INTERVAL=1;BYMONTHDAY=14' },
  { id: 'o6', name: 'Insurance', amount: 62, type: 'expense', accountId: 'a1', categoryId: CAT.home,
    generateFromDate: '2026-01-28', recurrenceRule: 'FREQ=MONTHLY;INTERVAL=1;BYMONTHDAY=28' },
];

const SHOPS = {
  [CAT.groceries]: ['Lidl', 'Kaufland', 'Mini Mart 1075', 'Billa'],
  [CAT.eating]: ['Ugo Pizza', 'Coffee Room', 'Sushi Bar', 'Bageterie'],
  [CAT.transport]: ['Metro', 'Bolt', 'Shell'],
  [CAT.fun]: ['Cinema City', 'Steam', 'Bookshop'],
};

const records = [];
let n = 0;
for (let d = -74; d <= 0; d += 1) {
  const perDay = 1 + Math.floor(rnd() * 3);
  for (let i = 0; i < perDay; i += 1) {
    const categoryId = pick([CAT.groceries, CAT.groceries, CAT.eating, CAT.transport, CAT.fun]);
    const value = -Math.round((2 + rnd() * 46) * 100) / 100;
    records.push({
      id: `r${n += 1}`,
      accountId: rnd() > 0.15 ? 'a1' : 'a2',
      recordDate: iso(d),
      convertedAmount: { currencyCode: 'EUR', value },
      amount: { currencyCode: 'EUR', value },
      category: { id: categoryId },
      categoryId,
      labels: [],
      counterParty: pick(SHOPS[categoryId] || ['Shop']),
      accountName: 'Revolut',
      // Bank sync lands records uncleared; the last few days have not been
      // reviewed yet, which is exactly the pile the panel is for.
      recordState: d >= -4 && rnd() > 0.45 ? 'uncleared' : 'cleared',
      transfer: null,
    });
  }
}

// A couple of records the rules never assigned, so the panel shows both states.
records.push({
  id: 'r-wa1', accountId: 'a1', recordDate: iso(-2),
  convertedAmount: { currencyCode: 'EUR', value: -84.9 }, amount: { currencyCode: 'EUR', value: -84.9 },
  category: { id: '5c5c32c9-0082-8000-8000-000000000000' }, labels: [],
  counterParty: 'SumUp *Unknown', accountName: 'Revolut', recordState: 'waitForAssign', transfer: null,
});

const spent = (categoryId, from) => records
  .filter((r) => r.categoryId === categoryId && r.recordDate >= from)
  .reduce((sum, r) => sum - r.convertedAmount.value, 0);

const monthStart = '2026-09-01';
const budget = (id, name, categoryId, limit) => ({
  id, name, accountIds: [], categoryIds: [categoryId], labelIds: [],
  type: 'BUDGET_INTERVAL_MONTH', limit,
  spending: { current: {
    period: 'MONTH', periodStart: monthStart, periodEnd: '2026-09-30',
    spent: Math.round(spent(categoryId, monthStart) * 100) / 100,
    effectiveLimit: limit,
    progress: Math.round((spent(categoryId, monthStart) / limit) * 100) / 100,
  } },
});

const budgets = [
  budget('b1', 'Groceries', CAT.groceries, 200), // crosses mid-month: exercises crossesOn
  budget('b2', 'Eating out', CAT.eating, 180),
  budget('b3', 'Transport', CAT.transport, 120),
  budget('b4', 'Fun', CAT.fun, 90),
  budget('b5', 'Subscriptions', CAT.subs, 90),
  budget('b6', 'Home', CAT.home, 1300),
];

const uncategorized = records
  .filter((r) => r.category.id.startsWith('5c5c32'))
  .map((r) => ({ ...r }));

const snapshot = build({ budgets, orders, accounts, records, uncategorized }, TODAY);
snapshot.generatedAt = '2026-09-18T14:32:00Z';

const out = path.join(__dirname, 'fixture-snapshot.js');
fs.writeFileSync(out, `// Generated by test/make-fixture.js for test/preview.html. Not shipped.
const FIXTURE = ${JSON.stringify(snapshot, null, 2)};

if (typeof window !== "undefined") window.FIXTURE = FIXTURE;
if (typeof module !== "undefined") module.exports = FIXTURE;
`);
console.log(`${out}: ${snapshot.budgets.length} budgets, ${snapshot.unchecked.length} unchecked, ` +
  `runway ${snapshot.runway.actual[0].date} → ${snapshot.runway.projected[snapshot.runway.projected.length - 1].date}`);
console.log(`today ${day(0)} balance ${snapshot.runway.actual[snapshot.runway.actual.length - 1].balance}, ` +
  `month end ${snapshot.runway.monthEnd}, next close ${snapshot.nextMonth.closing}, burn/day ${snapshot.burnPerDay}`);
