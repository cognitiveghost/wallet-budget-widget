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

// ----------------------------------------------- the rate, against the calendar
// The rate is what the window did that the standing orders do not already
// account for. Nothing is classified record by record: the same RRULEs are
// expanded backwards over the measured window and subtracted, so whatever an
// order claims to generate leaves the rate at exactly the rate it will be
// re-added going forward.

const WIN = ['2026-09-01', '2026-09-30']; // 30 days inclusive

test('the discretionary rate averages expenses over the window', () => {
  assert.strictEqual(f.discretionaryRate([rec(-30), rec(-60)], [], ...WIN), 3);
});

test('income is left out of the discretionary rate', () => {
  assert.strictEqual(f.discretionaryRate([rec(-30), rec(900)], [], ...WIN), 1);
});

test('what the calendar already claims is subtracted from the rate', () => {
  // The order says it produced 50 on the 25th, so only the other 30 is rate.
  const o = order({ amount: 50 });
  assert.strictEqual(f.discretionaryRate([rec(-30), rec(-50, { recordDate: '2026-09-25T09:00:00Z' })], [o], ...WIN), 1);
});

test('a bill that came in higher than its order leaves only the excess', () => {
  // The heuristic this replaced saw 88 against an order of 60, decided it was
  // not that payment, and counted the whole 88 in the rate as well as adding
  // the order again on its next date.
  const o = order({ amount: 60 });
  const bill = rec(-88, { recordDate: '2026-09-25T09:00:00Z' });
  assert.strictEqual(f.discretionaryRate([bill], [o], ...WIN), 28 / 30);
});

test('an order that never actually fired pushes the rate back up, not below zero', () => {
  const o = order({ amount: 50 });
  assert.strictEqual(f.discretionaryRate([], [o], ...WIN), 0, 'a budget cannot spend backwards');
});

test('transfers are left out of the discretionary rate', () => {
  assert.strictEqual(f.discretionaryRate([rec(-30), rec(-500, { transfer: { id: 't1' } })], [], ...WIN), 1);
});

test('records outside the window do not count toward it', () => {
  const old = rec(-300, { recordDate: '2026-07-04T09:00:00Z' });
  assert.strictEqual(f.discretionaryRate([rec(-30), old], [], ...WIN), 1);
});

test('a backwards window yields a zero rate rather than dividing by zero', () => {
  assert.strictEqual(f.discretionaryRate([rec(-30)], [], '2026-09-30', '2026-09-01'), 0);
});

test('no records yields a zero rate', () => {
  assert.strictEqual(f.discretionaryRate([], [], ...WIN), 0);
});

// -------------------------------------------------------- projectBudget

test('a mid-period burn rate extrapolates to the period end', () => {
  // 100 spent over the 9 COMPLETE days Sep 1-9 => 11.11/day, and 20 days are
  // left after today => 222. Today is in neither term: it is half a day of
  // evidence, and counting it in both (a rate day AND a day remaining) is what
  // made a 30-day month project over 31 days.
  const b = budget({ spending: { current: { spent: 100, effectiveLimit: 300, periodStart: '2026-09-01', periodEnd: '2026-09-30' } } });
  const r = f.projectBudget(b, [], [rec(-100, { recordDate: '2026-09-05T12:00:00Z' })], '2026-09-10');
  assert.strictEqual(r.spent, 100);
  assert.strictEqual(Math.round(r.projected), 322);
  assert.strictEqual(Math.round(r.discretionary), 222);
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
  // spent 100 + scheduled 50 + discretionary (100/9 complete days * 20 = 222)
  assert.strictEqual(r.scheduled, 50);
  assert.strictEqual(Math.round(r.discretionary), 222);
  assert.strictEqual(Math.round(r.projected), 372);
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
  // 40 spent over the 3 complete days Sep 14-16 => 13.33/day, 3 days left.
  const b = budget({ spending: { current: { spent: 40, effectiveLimit: 150, periodStart: '2026-09-14', periodEnd: '2026-09-20' } } });
  const r = f.projectBudget(b, [], [rec(-40, { recordDate: '2026-09-15T12:00:00Z' })], '2026-09-17');
  assert.strictEqual(Math.round(r.projected), 80);
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
  const burnt = f.runway([], [], 1000, '2026-09-01', '2026-09-30', '2026-09-10', -10);
  assert.strictEqual(flat.end, 1000, 'no orders and no rate means a flat line');
  // 20 days from the 10th to the 30th, at 10 a day.
  assert.strictEqual(burnt.end, 800);
});

// An account that takes in more off-schedule than it spends really does climb.
// Refusing to draw that was what made every projection end at zero.
test('a positive rate lifts the projection', () => {
  const r = f.runway([], [], 500, '2026-09-01', '2026-09-30', '2026-09-10', 25);
  assert.strictEqual(r.end, 1000); // 500 + 20 days x 25
});

test('the projection applies the rate alongside standing orders', () => {
  const orders = [{
    id: 'o1', name: 'Rent', amount: 100, type: 'expense', accountId: 'a1',
    generateFromDate: '2026-09-01', recurrenceRule: 'FREQ=MONTHLY;INTERVAL=1;BYMONTHDAY=20',
  }];
  const r = f.runway([], orders, 1000, '2026-09-01', '2026-09-30', '2026-09-10', -10);
  assert.strictEqual(r.end, 700); // 1000 - 100 rent - 200 everyday
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

// --- the rate is net ------------------------------------------------------
// Checked against live data: two months of records netting to roughly
// break-even were projecting -644 a month, because every euro out was
// extrapolated while euros in counted only when a standing order scheduled
// them.

test('the net rate counts money arriving, not only money leaving', () => {
  const records = [rec(-300, { recordDate: '2026-09-02T12:00:00Z' }), rec(300, { recordDate: '2026-09-03T12:00:00Z' })];
  assert.strictEqual(f.netRate(records, [], ...WIN), 0, 'a window that breaks even has no drift');
  assert.strictEqual(f.discretionaryRate(records, [], ...WIN), 10, 'budgets still see gross spend');
});

test('an account taking in more than it spends has a positive rate', () => {
  const records = [rec(-100), rec(400)];
  assert.strictEqual(f.netRate(records, [], ...WIN), 10);
});

test('scheduled income is subtracted from the net rate, not counted twice', () => {
  // Payday lands on the 25th and is also a standing order, so the rate that
  // carries the projection forward must not carry payday forward as well.
  const pay = order({ amount: 900, type: 'income' });
  const records = [rec(900, { recordDate: '2026-09-25T12:00:00Z' }), rec(-300)];
  assert.strictEqual(f.netRate(records, [pay], ...WIN), -10);
});

test('an unpaid scheduled expense pushes the net rate up to compensate', () => {
  // The order claims 50 went out and it never did. The rate carries that
  // correction forward rather than the projection quietly losing the money.
  const o = order({ amount: 50 });
  assert.strictEqual(f.netRate([], [o], ...WIN), 50 / 30);
});

test('a record dated ahead of today reaches the projected line', () => {
  // Card payments arrive from bank sync only after they happen, so a record in
  // the future is one somebody entered by hand — a cash payment they already
  // know about. It used to be dropped, and the money never appeared at all.
  const future = [{ recordDate: '2026-09-25T12:00:00Z', counterParty: 'Dentist', convertedAmount: { value: -500 } }];
  const r = f.runway(future, [], 3000, '2026-09-01', '2026-09-30', '2026-09-19', 0);
  assert.strictEqual(r.end, 2500);
  assert.deepStrictEqual(r.planned, [{ date: '2026-09-25', signed: -500, names: ['Dentist'] }]);
});

test('a future record and a standing order on one day are one mark', () => {
  const o = order({ amount: 40 }); // the helper's rule already lands on the 25th
  const future = [{ recordDate: '2026-09-25T12:00:00Z', counterParty: 'Dentist', convertedAmount: { value: -500 } }];
  const r = f.runway(future, [o], 3000, '2026-09-01', '2026-09-30', '2026-09-19', 0);
  assert.strictEqual(r.end, 2460);
  assert.strictEqual(r.planned.length, 1);
  assert.strictEqual(r.planned[0].signed, -540);
});

test('a past record is history, not a second entry in the projection', () => {
  const past = [{ recordDate: '2026-09-10T12:00:00Z', convertedAmount: { value: -500 } }];
  const r = f.runway(past, [], 3000, '2026-09-01', '2026-09-30', '2026-09-19', 0);
  assert.strictEqual(r.actual[r.actual.length - 1].balance, 2500);
  assert.strictEqual(r.end, 2500);
  assert.deepStrictEqual(r.planned, []);
});

// ------------------------------------------------------------------ history

const { budgetHistory } = require('../main/forecast');

// A budget whose past periods are handed back by the server. `current` is
// separate from `past` in the payload, but the guard is tested anyway: the
// median must never include a period that is still running.
const withPast = (past, extra = {}) => ({
  id: 'b1', name: 'Transport', startDate: '2025-01-01', limit: 120,
  spending: { current: { periodStart: '2026-09-01', periodEnd: '2026-09-30', spent: 367, effectiveLimit: 120 }, past },
  ...extra,
});

const p = (periodStart, periodEnd, spent, effectiveLimit = 120, more = {}) =>
  ({ period: periodStart.slice(0, 7), periodStart, periodEnd, spent, effectiveLimit, ...more });

test('history is ordered oldest first and carries each period own limit', () => {
  const h = budgetHistory(withPast([
    p('2026-08-01', '2026-08-31', 200),
    p('2026-06-01', '2026-06-30', 100),
    p('2026-07-01', '2026-07-31', 300),
  ]));
  assert.deepStrictEqual(h.periods.map((x) => x.periodStart), ['2026-06-01', '2026-07-01', '2026-08-01']);
  assert.deepStrictEqual(h.periods.map((x) => x.spent), [100, 300, 200]);
});

test('the median of three is the middle value', () => {
  const h = budgetHistory(withPast([
    p('2026-06-01', '2026-06-30', 100),
    p('2026-07-01', '2026-07-31', 300),
    p('2026-08-01', '2026-08-31', 200),
  ]));
  assert.strictEqual(h.median, 200);
});

test('an even count takes the mean of the middle two', () => {
  const h = budgetHistory(withPast([
    p('2026-05-01', '2026-05-31', 100),
    p('2026-06-01', '2026-06-30', 200),
    p('2026-07-01', '2026-07-31', 300),
    p('2026-08-01', '2026-08-31', 500),
  ]));
  assert.strictEqual(h.median, 250);
});

test('under three usable periods there is no median', () => {
  const h = budgetHistory(withPast([
    p('2026-07-01', '2026-07-31', 300),
    p('2026-08-01', '2026-08-31', 200),
  ]));
  assert.strictEqual(h.median, null);
  assert.strictEqual(h.periods.length, 2);
});

test('incomplete periods are dropped — a partial sum is not a month', () => {
  const h = budgetHistory(withPast([
    p('2026-06-01', '2026-06-30', 100),
    p('2026-07-01', '2026-07-31', 300),
    p('2026-08-01', '2026-08-31', 5, 120, { incomplete: true }),
  ]));
  assert.deepStrictEqual(h.periods.map((x) => x.spent), [100, 300]);
  assert.strictEqual(h.median, null, 'two survivors is under the floor');
});

test('periods that ended before the budget existed are dropped', () => {
  const h = budgetHistory(withPast([
    p('2024-11-01', '2024-11-30', 0),
    p('2024-12-01', '2024-12-31', 0),
    p('2026-06-01', '2026-06-30', 100),
    p('2026-07-01', '2026-07-31', 300),
    p('2026-08-01', '2026-08-31', 200),
  ]));
  assert.strictEqual(h.periods.length, 3, 'the two pre-startDate zeroes are gone');
  assert.strictEqual(h.median, 200, 'zeroes would have dragged this to 100');
});

test('the current period never counts toward the median', () => {
  const b = withPast([
    p('2026-06-01', '2026-06-30', 100),
    p('2026-07-01', '2026-07-31', 300),
    p('2026-08-01', '2026-08-31', 200),
    p('2026-09-01', '2026-09-30', 367), // same periodStart as spending.current
  ]);
  const h = budgetHistory(b);
  assert.strictEqual(h.periods.length, 3);
  assert.strictEqual(h.median, 200);
});

test('over is judged against the limit that was in force then', () => {
  const h = budgetHistory(withPast([
    p('2026-06-01', '2026-06-30', 200, 300), // limit was 300 then: not over
    p('2026-07-01', '2026-07-31', 200, 120), // limit was 120 then: over
    p('2026-08-01', '2026-08-31', 100, 120),
  ]));
  assert.deepStrictEqual(h.periods.map((x) => x.over), [false, true, false]);
  assert.strictEqual(h.overCount, 1);
});

test('a budget with no spending payload yields an empty history, not a throw', () => {
  const h = budgetHistory({ id: 'b9', name: 'New' });
  assert.deepStrictEqual(h, { periods: [], median: null, overCount: 0 });
});

test('a zero limit is never over — an unlimited budget cannot overspend', () => {
  const h = budgetHistory(withPast([
    p('2026-06-01', '2026-06-30', 100, 0),
    p('2026-07-01', '2026-07-31', 300, 0),
    p('2026-08-01', '2026-08-31', 200, 0),
  ]));
  assert.strictEqual(h.overCount, 0);
  assert.strictEqual(h.median, 200);
});

// ---------------------------------------------------------- settled orders

const { runway } = require('../main/forecast');

// One order, due on the 25th, and a hand-entered record for the same payment.
const salary = { id: 'o1', name: 'Salary', amount: 1000, type: 'income', accountId: 'a1',
  generateFromDate: '2026-01-25', recurrenceRule: 'FREQ=MONTHLY;INTERVAL=1;BYMONTHDAY=25' };
const handEntered = { id: 'r1', recordDate: '2026-09-25', accountId: 'a1',
  convertedAmount: { currencyCode: 'EUR', value: 1000 }, counterParty: 'Salary', transfer: null };

test('without items, an order and its hand-entered record are both booked — the known double-count', () => {
  const line = runway([handEntered], [salary], 0, '2026-09-01', '2026-09-30', '2026-09-18', 0);
  assert.strictEqual(line.end, 2000, 'this is the bug the items fix');
});

test('a record named by an item recordIds is booked by the order, not twice', () => {
  const items = [{ id: 'i1', standingOrderId: 'o1', originalDate: '2026-09-25', recordIds: ['r1'] }];
  const line = runway([handEntered], [salary], 0, '2026-09-01', '2026-09-30', '2026-09-18', 0, items);
  assert.strictEqual(line.end, 1000);
});

test('a dismissed occurrence does not book at all', () => {
  const items = [{ id: 'i1', standingOrderId: 'o1', originalDate: '2026-09-25', dismissed: true, recordIds: [] }];
  const line = runway([], [salary], 0, '2026-09-01', '2026-09-30', '2026-09-18', 0, items);
  assert.strictEqual(line.end, 0);
  assert.deepStrictEqual(line.planned, [], 'and it is not offered to the plot either');
});

test('a paid occurrence does not book again', () => {
  const items = [{ id: 'i1', standingOrderId: 'o1', originalDate: '2026-09-25', paidDate: '2026-09-25T09:00:00Z', recordIds: [] }];
  const line = runway([], [salary], 0, '2026-09-01', '2026-09-30', '2026-09-18', 0, items);
  assert.strictEqual(line.end, 0);
});

test('an item aligned to a different day than the rule still suppresses its occurrence', () => {
  // The 25th fell on a weekend and the bank moved it; the RRULE still expands
  // to the 25th, so both dates have to key the suppression.
  const items = [{ id: 'i1', standingOrderId: 'o1', originalDate: '2026-09-25', alignedDate: '2026-09-27', dismissed: true }];
  const line = runway([], [salary], 0, '2026-09-01', '2026-09-30', '2026-09-18', 0, items);
  assert.strictEqual(line.end, 0);
});

test('an item for a different order suppresses nothing', () => {
  const items = [{ id: 'i1', standingOrderId: 'o-other', originalDate: '2026-09-25', dismissed: true }];
  const line = runway([], [salary], 0, '2026-09-01', '2026-09-30', '2026-09-18', 0, items);
  assert.strictEqual(line.end, 1000);
});

test('an empty item list leaves the line identical to no argument at all', () => {
  const a = runway([handEntered], [salary], 0, '2026-09-01', '2026-09-30', '2026-09-18', 0);
  const b = runway([handEntered], [salary], 0, '2026-09-01', '2026-09-30', '2026-09-18', 0, []);
  assert.deepStrictEqual(a, b);
});

test('items never suppress the measured leg — a past record still moved the balance', () => {
  const past = { id: 'r2', recordDate: '2026-09-05', accountId: 'a1',
    convertedAmount: { currencyCode: 'EUR', value: -50 }, counterParty: 'Gym', transfer: null };
  const items = [{ id: 'i2', standingOrderId: 'o2', originalDate: '2026-09-05', recordIds: ['r2'] }];
  const line = runway([past], [], 0, '2026-09-01', '2026-09-30', '2026-09-18', 0, items);
  assert.strictEqual(line.actual[line.actual.length - 1].balance, -50, 'history is history');
});
