const { test } = require('node:test');
const assert = require('node:assert');
const f = require('../main/forecast');

const budget = (over) => ({
  id: 'b1', name: 'test', limit: 300,
  accountIds: [], categoryIds: [], labelIds: [],
  spending: { current: { spent: 100, effectiveLimit: 300, periodStart: '2026-09-01', periodEnd: '2026-09-30' } },
  ...over,
});

// Records carry SIGNED convertedAmount: expenses negative.
const rec = (amount, over = {}) => ({
  id: `r${Math.random()}`, convertedAmount: amount, amount,
  recordDate: '2026-09-10T12:00:00Z', accountId: 'a1',
  category: { id: 'c1' }, labels: [], recordType: amount < 0 ? 'expense' : 'income',
  transfer: null, ...over,
});

const order = (over) => ({
  id: 'o1', name: 'Rent', amount: 50, type: 'expense',
  accountId: 'a1', categoryId: 'c1',
  generateFromDate: '2026-08-01', recurrenceRule: 'FREQ=MONTHLY;INTERVAL=1;BYMONTHDAY=25',
  ...over,
});

// ---------------------------------------------------------------- inScope

test('an unconstrained budget matches anything', () => {
  assert.strictEqual(f.inScope(budget(), { accountId: 'x', categoryId: 'y', labels: [] }), true);
});

test('an account-scoped budget rejects other accounts', () => {
  const b = budget({ accountIds: ['a1'] });
  assert.strictEqual(f.inScope(b, { accountId: 'a1' }), true);
  assert.strictEqual(f.inScope(b, { accountId: 'a2' }), false);
});

test('scope dimensions combine with AND, not OR', () => {
  const b = budget({ accountIds: ['a1'], categoryIds: ['c1'] });
  assert.strictEqual(f.inScope(b, { accountId: 'a1', categoryId: 'c1' }), true);
  assert.strictEqual(f.inScope(b, { accountId: 'a1', categoryId: 'c9' }), false);
  assert.strictEqual(f.inScope(b, { accountId: 'a9', categoryId: 'c1' }), false);
});

test('a label-scoped budget matches any one of the item labels', () => {
  const b = budget({ labelIds: ['L1'] });
  assert.strictEqual(f.inScope(b, { labels: [{ id: 'L0' }, { id: 'L1' }] }), true);
  assert.strictEqual(f.inScope(b, { labels: [{ id: 'L0' }] }), false);
});

test('a record nests its category under category.id', () => {
  const b = budget({ categoryIds: ['c1'] });
  assert.strictEqual(f.inScope(b, rec(-10)), true);
});

// ------------------------------------------------------------ isRecurring

test('a record matching an order amount, account and date is recurring', () => {
  const o = order({ amount: 50 });
  assert.strictEqual(f.isRecurring(rec(-50, { recordDate: '2026-09-25T09:00:00Z' }), [o]), true);
});

test('a record three days off a scheduled date still counts as that payment', () => {
  const o = order({ amount: 50 });
  assert.strictEqual(f.isRecurring(rec(-50, { recordDate: '2026-09-27T09:00:00Z' }), [o]), true);
});

test('a record four days off a scheduled date is not attributed', () => {
  const o = order({ amount: 50 });
  assert.strictEqual(f.isRecurring(rec(-50, { recordDate: '2026-09-29T09:00:00Z' }), [o]), false);
});

test('a different amount on the right day is not attributed', () => {
  const o = order({ amount: 50 });
  assert.strictEqual(f.isRecurring(rec(-80, { recordDate: '2026-09-25T09:00:00Z' }), [o]), false);
});

test('amounts within one percent are treated as the same payment', () => {
  const o = order({ amount: 100 });
  assert.strictEqual(f.isRecurring(rec(-100.5, { recordDate: '2026-09-25T09:00:00Z' }), [o]), true);
});

test('a different account on the right day and amount is not attributed', () => {
  const o = order({ amount: 50, accountId: 'other' });
  assert.strictEqual(f.isRecurring(rec(-50, { recordDate: '2026-09-25T09:00:00Z' }), [o]), false);
});

// ------------------------------------------------------- discretionaryRate

test('the discretionary rate averages non-recurring expenses over the window', () => {
  const rs = [rec(-30), rec(-60)];
  assert.strictEqual(f.discretionaryRate(rs, [], 30), 3);
});

test('income is excluded from the discretionary rate', () => {
  const rs = [rec(-30), rec(900)];
  assert.strictEqual(f.discretionaryRate(rs, [], 30), 1);
});

test('records attributable to standing orders are excluded', () => {
  const o = order({ amount: 50 });
  const rs = [rec(-30), rec(-50, { recordDate: '2026-09-25T09:00:00Z' })];
  assert.strictEqual(f.discretionaryRate(rs, [o], 30), 1);
});

test('transfers are excluded from the discretionary rate', () => {
  const rs = [rec(-30), rec(-500, { transfer: { id: 't1' } })];
  assert.strictEqual(f.discretionaryRate(rs, [], 30), 1);
});

test('a zero-day window yields a zero rate rather than dividing by zero', () => {
  assert.strictEqual(f.discretionaryRate([rec(-30)], [], 0), 0);
});

test('no records yields a zero rate', () => {
  assert.strictEqual(f.discretionaryRate([], [], 30), 0);
});

// -------------------------------------------------------- projectBudget

test('a mid-period burn rate extrapolates to the period end', () => {
  // 100 spent over 10 elapsed days of 30 => 10/day => 300 projected.
  const b = budget({ spending: { current: { spent: 100, effectiveLimit: 300, periodStart: '2026-09-01', periodEnd: '2026-09-30' } } });
  const r = f.projectBudget(b, [], [rec(-100, { recordDate: '2026-09-05T12:00:00Z' })], '2026-09-10');
  assert.strictEqual(r.spent, 100);
  assert.strictEqual(Math.round(r.projected), 300);
  assert.strictEqual(Math.round(r.ratio * 100), 100);
});

test('a scheduled-only budget is projected from its known payments, not a daily rate', () => {
  // The `subscriptions` case: all spending is standing orders. A naive daily
  // rate would overstate it; the remaining scheduled charge is known exactly.
  const o = order({ amount: 20, recurrenceRule: 'FREQ=MONTHLY;INTERVAL=1;BYMONTHDAY=25' });
  const paid = rec(-20, { recordDate: '2026-08-25T09:00:00Z' });
  const b = budget({ limit: 100, spending: { current: { spent: 20, effectiveLimit: 100, periodStart: '2026-09-01', periodEnd: '2026-09-30' } } });
  const r = f.projectBudget(b, [o], [paid], '2026-09-10');
  assert.strictEqual(r.discretionary, 0);
  assert.strictEqual(r.scheduled, 20);
  assert.strictEqual(r.projected, 40);
});

test('projection combines spent, scheduled and discretionary', () => {
  const o = order({ amount: 50, recurrenceRule: 'FREQ=MONTHLY;INTERVAL=1;BYMONTHDAY=25' });
  const rs = [rec(-100, { recordDate: '2026-09-05T12:00:00Z' })];
  const b = budget({ limit: 500, spending: { current: { spent: 100, effectiveLimit: 500, periodStart: '2026-09-01', periodEnd: '2026-09-30' } } });
  const r = f.projectBudget(b, [o], rs, '2026-09-10');
  // spent 100 + scheduled 50 + discretionary (100/10 * 20 = 200) = 350
  assert.strictEqual(r.scheduled, 50);
  assert.strictEqual(Math.round(r.discretionary), 200);
  assert.strictEqual(Math.round(r.projected), 350);
});

test('overshoot is the projected excess over the effective limit, or zero', () => {
  const under = f.projectBudget(
    budget({ spending: { current: { spent: 10, effectiveLimit: 300, periodStart: '2026-09-01', periodEnd: '2026-09-30' } } }),
    [], [rec(-10, { recordDate: '2026-09-05T12:00:00Z' })], '2026-09-10');
  assert.strictEqual(under.overshoot, 0);

  const over = f.projectBudget(
    budget({ spending: { current: { spent: 200, effectiveLimit: 300, periodStart: '2026-09-01', periodEnd: '2026-09-30' } } }),
    [], [rec(-200, { recordDate: '2026-09-05T12:00:00Z' })], '2026-09-10');
  assert.ok(over.overshoot > 0);
});

test('the effective limit is preferred over the plain limit', () => {
  const b = budget({ limit: 999, spending: { current: { spent: 10, effectiveLimit: 300, periodStart: '2026-09-01', periodEnd: '2026-09-30' } } });
  assert.strictEqual(f.projectBudget(b, [], [], '2026-09-10').limit, 300);
});

test('the first day of a period does not divide by zero', () => {
  const b = budget({ spending: { current: { spent: 5, effectiveLimit: 300, periodStart: '2026-09-01', periodEnd: '2026-09-30' } } });
  const r = f.projectBudget(b, [], [rec(-5, { recordDate: '2026-09-01T12:00:00Z' })], '2026-09-01');
  assert.ok(Number.isFinite(r.projected), 'projection must be finite on day one');
});

test('a weekly period projects over its own seven days', () => {
  // 40 spent over 4 elapsed days of a 7-day period => 10/day => 70.
  const b = budget({ spending: { current: { spent: 40, effectiveLimit: 150, periodStart: '2026-09-14', periodEnd: '2026-09-20' } } });
  const r = f.projectBudget(b, [], [rec(-40, { recordDate: '2026-09-15T12:00:00Z' })], '2026-09-17');
  assert.strictEqual(Math.round(r.projected), 70);
});

test('a budget with no spending block projects as zero rather than throwing', () => {
  const r = f.projectBudget({ id: 'x', limit: 100, accountIds: [], categoryIds: [], labelIds: [] }, [], [], '2026-09-10');
  assert.strictEqual(r.projected, 0);
  assert.strictEqual(r.spent, 0);
});

test('a period already ended projects to exactly what was spent', () => {
  const b = budget({ spending: { current: { spent: 250, effectiveLimit: 300, periodStart: '2026-08-01', periodEnd: '2026-08-31' } } });
  const r = f.projectBudget(b, [], [], '2026-09-10');
  assert.strictEqual(r.projected, 250);
});

// --------------------------------------------------------------- runway

test('the runway walks actual balance forward day by day', () => {
  const rs = [rec(-10, { recordDate: '2026-09-02T12:00:00Z' }), rec(-5, { recordDate: '2026-09-03T12:00:00Z' })];
  const r = f.runway(rs, [], 100, '2026-09-01', '2026-09-05', '2026-09-03');
  assert.deepStrictEqual(r.actual.map((p) => p.balance), [100, 90, 85]);
  assert.deepStrictEqual(r.actual.map((p) => p.date), ['2026-09-01', '2026-09-02', '2026-09-03']);
});

test('the projected leg starts from the last actual balance', () => {
  const r = f.runway([], [], 100, '2026-09-01', '2026-09-05', '2026-09-03');
  assert.strictEqual(r.projected[0].date, '2026-09-03');
  assert.strictEqual(r.projected[0].balance, 100);
});

test('a scheduled income raises the projected balance on its date', () => {
  const o = order({ type: 'income', amount: 500, recurrenceRule: 'FREQ=MONTHLY;INTERVAL=1;BYMONTHDAY=4' });
  const r = f.runway([], [o], 100, '2026-09-01', '2026-09-05', '2026-09-03');
  assert.strictEqual(r.end, 600);
});

test('a scheduled expense lowers the projected balance on its date', () => {
  const o = order({ type: 'expense', amount: 40, recurrenceRule: 'FREQ=MONTHLY;INTERVAL=1;BYMONTHDAY=4' });
  const r = f.runway([], [o], 100, '2026-09-01', '2026-09-05', '2026-09-03');
  assert.strictEqual(r.end, 60);
});

test('the projected leg reaches the period end date', () => {
  const r = f.runway([], [], 100, '2026-09-01', '2026-09-30', '2026-09-18');
  assert.strictEqual(r.projected[r.projected.length - 1].date, '2026-09-30');
});

test('a today past the period end yields no projected leg beyond the end', () => {
  const r = f.runway([], [], 100, '2026-09-01', '2026-09-05', '2026-09-20');
  assert.strictEqual(r.projected.length, 1);
  assert.strictEqual(r.end, r.actual[r.actual.length - 1].balance);
});

// --- live API shape regressions -------------------------------------------

test('runway skips records with an unparseable recordDate', () => {
  const records = [{ recordDate: null, convertedAmount: { value: -5 } }];
  assert.doesNotThrow(() => f.runway(records, [], 100, '2026-09-01', '2026-09-30', '2026-09-18'));
});

test('signed amount reads the {value} object the API returns', () => {
  const records = [{ recordDate: '2026-09-02T00:00:00.000Z', convertedAmount: { currencyCode: 'EUR', value: -40 } }];
  const r = f.runway(records, [], 100, '2026-09-01', '2026-09-30', '2026-09-18');
  assert.equal(r.actual[1].balance, 60);
});

// --- everyday spending on the line ----------------------------------------
// The projected half used to book only what it had a date for, so the line
// drifted up and a two-month horizon made that error twice as large.

test('everyday spending pulls the projection down by the rate per day', () => {
  const flat = f.runway([], [], 1000, '2026-09-01', '2026-09-30', '2026-09-10');
  const burnt = f.runway([], [], 1000, '2026-09-01', '2026-09-30', '2026-09-10', 10);
  assert.strictEqual(flat.end, 1000, 'no orders and no burn means a flat line');
  // 20 days from the 10th to the 30th, at 10 a day.
  assert.strictEqual(burnt.end, 800);
});

test('a burn rate never turns a projection upward', () => {
  const r = f.runway([], [], 500, '2026-09-01', '2026-09-30', '2026-09-10', -25);
  assert.strictEqual(r.end, 500, 'a negative rate is refused, not added as income');
});

test('the projection subtracts the rate alongside standing orders', () => {
  const orders = [{
    id: 'o1', name: 'Rent', amount: 100, type: 'expense', accountId: 'a1',
    generateFromDate: '2026-09-01', recurrenceRule: 'FREQ=MONTHLY;INTERVAL=1;BYMONTHDAY=20',
  }];
  const r = f.runway([], orders, 1000, '2026-09-01', '2026-09-30', '2026-09-10', 10);
  assert.strictEqual(r.end, 700); // 1000 - 100 rent - 200 burn
});

// --- the day a budget goes over -------------------------------------------

test('a budget names the day its limit is crossed', () => {
  const b = {
    id: 'b1', name: 'Groceries', accountIds: [], categoryIds: ['c1'], labelIds: [],
    spending: { current: { spent: 90, effectiveLimit: 100, periodStart: '2026-09-01', periodEnd: '2026-09-30' } },
  };
  // 10 a day across the 9 elapsed days. The 10th brings it to exactly 100,
  // and exactly at the limit is not over it, so the 11th is the day.
  const records = Array.from({ length: 9 }, (_, i) => ({
    id: `r${i}`, accountId: 'a1', category: { id: 'c1' }, labels: [],
    recordDate: `2026-09-0${i + 1}T12:00:00Z`, convertedAmount: -10,
  }));
  const p = f.projectBudget(b, [], records, '2026-09-09');
  assert.strictEqual(p.crossesOn, '2026-09-11');
});

test('a budget that lands inside its limit names no day', () => {
  const b = {
    id: 'b1', name: 'Rare', accountIds: [], categoryIds: ['c1'], labelIds: [],
    spending: { current: { spent: 5, effectiveLimit: 1000, periodStart: '2026-09-01', periodEnd: '2026-09-30' } },
  };
  const records = [{ id: 'r1', accountId: 'a1', category: { id: 'c1' }, labels: [], recordDate: '2026-09-02T12:00:00Z', convertedAmount: -5 }];
  assert.strictEqual(f.projectBudget(b, [], records, '2026-09-09').crossesOn, null);
});

test('a budget already past its limit names no day, because the day has gone', () => {
  const b = {
    id: 'b1', name: 'Blown', accountIds: [], categoryIds: ['c1'], labelIds: [],
    spending: { current: { spent: 300, effectiveLimit: 100, periodStart: '2026-09-01', periodEnd: '2026-09-30' } },
  };
  const p = f.projectBudget(b, [], [], '2026-09-09');
  assert.strictEqual(p.crossesOn, null);
  assert.ok(p.spent > p.limit, 'the UI reads this pair instead');
});
