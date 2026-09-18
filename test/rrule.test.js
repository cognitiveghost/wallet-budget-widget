const { test } = require('node:test');
const assert = require('node:assert');
const { occurrences, upcoming } = require('../main/rrule');

const order = (over) => ({
  id: 'o1', name: 'Test', amount: 10, type: 'expense',
  accountId: 'a1', categoryId: 'c1',
  dueDate: '2026-09-17T09:00:00.000Z',
  recurrenceRule: 'FREQ=MONTHLY;INTERVAL=1;BYMONTHDAY=15',
  ...over,
});

test('a monthly BYMONTHDAY rule yields that day of each month in range', () => {
  const r = occurrences('FREQ=MONTHLY;INTERVAL=1;BYMONTHDAY=15',
    '2026-08-11', '2026-09-01', '2026-11-30');
  assert.deepStrictEqual(r, ['2026-09-15', '2026-10-15', '2026-11-15']);
});

test('range bounds are inclusive on both ends', () => {
  const r = occurrences('FREQ=MONTHLY;INTERVAL=1;BYMONTHDAY=15',
    '2026-08-11', '2026-09-15', '2026-10-15');
  assert.deepStrictEqual(r, ['2026-09-15', '2026-10-15']);
});

test('UNTIL stops the series', () => {
  // The Gym order carries UNTIL=20270101T100000Z.
  const r = occurrences('FREQ=MONTHLY;INTERVAL=1;BYMONTHDAY=1;UNTIL=20270101T100000Z',
    '2026-08-11', '2026-11-01', '2027-04-01');
  assert.deepStrictEqual(r, ['2026-11-01', '2026-12-01', '2027-01-01']);
});

test('COUNT stops the series', () => {
  const r = occurrences('FREQ=MONTHLY;INTERVAL=1;BYMONTHDAY=5;COUNT=2',
    '2026-09-01', '2026-09-01', '2026-12-31');
  assert.deepStrictEqual(r, ['2026-09-05', '2026-10-05']);
});

test('BYMONTHDAY beyond a short month clamps to the last day', () => {
  const r = occurrences('FREQ=MONTHLY;INTERVAL=1;BYMONTHDAY=31',
    '2026-01-31', '2026-02-01', '2026-04-30');
  assert.deepStrictEqual(r, ['2026-02-28', '2026-03-31', '2026-04-30']);
});

test('INTERVAL skips months', () => {
  const r = occurrences('FREQ=MONTHLY;INTERVAL=3;BYMONTHDAY=10',
    '2026-01-10', '2026-01-01', '2026-12-31');
  assert.deepStrictEqual(r, ['2026-01-10', '2026-04-10', '2026-07-10', '2026-10-10']);
});

test('a weekly rule repeats every seven days from the seed', () => {
  const r = occurrences('FREQ=WEEKLY;INTERVAL=1', '2026-09-07', '2026-09-01', '2026-09-30');
  assert.deepStrictEqual(r, ['2026-09-07', '2026-09-14', '2026-09-21', '2026-09-28']);
});

test('a daily rule with an interval repeats on that stride', () => {
  const r = occurrences('FREQ=DAILY;INTERVAL=10', '2026-09-01', '2026-09-01', '2026-09-30');
  assert.deepStrictEqual(r, ['2026-09-01', '2026-09-11', '2026-09-21']);
});

test('a yearly rule repeats on the seed anniversary', () => {
  const r = occurrences('FREQ=YEARLY;INTERVAL=1', '2024-03-05', '2026-01-01', '2027-12-31');
  assert.deepStrictEqual(r, ['2026-03-05', '2027-03-05']);
});

test('no rule at all yields the seed date alone', () => {
  // "yettel: close contract" is a one-off with no recurrenceRule.
  assert.deepStrictEqual(occurrences(null, '2026-09-22', '2026-09-01', '2026-09-30'),
    ['2026-09-22']);
});

test('a one-off outside the range yields nothing', () => {
  assert.deepStrictEqual(occurrences(null, '2026-08-22', '2026-09-01', '2026-09-30'), []);
});

test('an unparseable rule yields nothing rather than throwing', () => {
  assert.deepStrictEqual(occurrences('FREQ=HOURLY;BYWEIRD=1', '2026-09-01',
    '2026-09-01', '2026-09-30'), []);
});

test('a range that ends before it starts yields nothing', () => {
  assert.deepStrictEqual(occurrences('FREQ=MONTHLY;BYMONTHDAY=15', '2026-01-01',
    '2026-09-30', '2026-09-01'), []);
});

test('upcoming signs expenses negative and income positive', () => {
  const r = upcoming([
    order({ id: 'e', type: 'expense', amount: 10 }),
    order({ id: 'i', type: 'income', amount: 20 }),
  ], '2026-09-01', '2026-09-30');
  assert.deepStrictEqual(r.map((x) => x.signed), [-10, 20]);
});

test('upcoming sorts the flattened events by date', () => {
  const r = upcoming([
    order({ id: 'late', recurrenceRule: 'FREQ=MONTHLY;BYMONTHDAY=25' }),
    order({ id: 'early', recurrenceRule: 'FREQ=MONTHLY;BYMONTHDAY=3' }),
  ], '2026-09-01', '2026-09-30');
  assert.deepStrictEqual(r.map((x) => x.orderId), ['early', 'late']);
  assert.deepStrictEqual(r.map((x) => x.date), ['2026-09-03', '2026-09-25']);
});

test('upcoming carries the order identity onto each event', () => {
  const [e] = upcoming([order({ name: 'Payday', accountId: 'acc', categoryId: 'cat' })],
    '2026-09-01', '2026-09-30');
  assert.strictEqual(e.name, 'Payday');
  assert.strictEqual(e.accountId, 'acc');
  assert.strictEqual(e.categoryId, 'cat');
});

test('upcoming uses generateFromDate as the seed when present', () => {
  const r = upcoming([order({
    recurrenceRule: 'FREQ=DAILY;INTERVAL=10',
    generateFromDate: '2026-09-02 14:16:51.608',
    dueDate: '2026-09-17T09:00:00.000Z',
  })], '2026-09-01', '2026-09-30');
  assert.deepStrictEqual(r.map((x) => x.date), ['2026-09-02', '2026-09-12', '2026-09-22']);
});
