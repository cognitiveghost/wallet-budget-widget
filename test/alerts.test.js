const { test } = require('node:test');
const assert = require('node:assert');
const { decide } = require('../main/alerts');

const order = (over) => ({
  id: 'o1', name: 'Spotify', amount: 5.62, type: 'expense',
  accountId: 'a1', categoryId: 'c1',
  generateFromDate: '2026-08-01',
  recurrenceRule: 'FREQ=MONTHLY;INTERVAL=1;BYMONTHDAY=22',
  dueDateNotificationEnabled: true,
  threeDaysBeforeNotificationEnabled: false,
  ...over,
});

const budget = (over) => ({
  id: 'b1', name: 'per:total',
  spending: { current: { spent: 50, effectiveLimit: 100, periodStart: '2026-09-01', periodEnd: '2026-09-30' } },
  ...over,
});

const snap = (over) => ({ budgets: [], orders: [], uncategorized: [], ...over });

test('a standing order due today fires when its due flag is on', () => {
  const r = decide(snap({ orders: [order()] }), {}, '2026-09-22');
  assert.strictEqual(r.fire.length, 1);
  assert.strictEqual(r.fire[0].key, 'order:o1:2026-09-22:due');
  assert.match(r.fire[0].title, /Spotify/);
});

test('a standing order due today stays silent when its due flag is off', () => {
  const r = decide(snap({ orders: [order({ dueDateNotificationEnabled: false })] }), {}, '2026-09-22');
  assert.deepStrictEqual(r.fire, []);
});

test('the three-day warning fires only when that flag is on', () => {
  const off = decide(snap({ orders: [order()] }), {}, '2026-09-19');
  assert.deepStrictEqual(off.fire, []);

  const on = decide(snap({ orders: [order({ threeDaysBeforeNotificationEnabled: true })] }), {}, '2026-09-19');
  assert.strictEqual(on.fire.length, 1);
  assert.strictEqual(on.fire[0].key, 'order:o1:2026-09-22:3day');
});

test('an already notified order does not fire again', () => {
  const first = decide(snap({ orders: [order()] }), {}, '2026-09-22');
  const second = decide(snap({ orders: [order()] }), first.notified, '2026-09-22');
  assert.deepStrictEqual(second.fire, []);
});

test('the next month occurrence fires even though last month was notified', () => {
  const first = decide(snap({ orders: [order()] }), {}, '2026-09-22');
  const next = decide(snap({ orders: [order()] }), first.notified, '2026-10-22');
  assert.strictEqual(next.fire.length, 1);
  assert.strictEqual(next.fire[0].key, 'order:o1:2026-10-22:due');
});

test('a budget crossing eighty percent fires once', () => {
  const b = budget({ spending: { current: { spent: 85, effectiveLimit: 100, periodStart: '2026-09-01', periodEnd: '2026-09-30' } } });
  const r = decide(snap({ budgets: [b] }), {}, '2026-09-18');
  assert.strictEqual(r.fire.length, 1);
  assert.strictEqual(r.fire[0].key, 'budget:b1:2026-09-01:80');
});

test('a budget over the limit fires both thresholds at once', () => {
  const b = budget({ spending: { current: { spent: 120, effectiveLimit: 100, periodStart: '2026-09-01', periodEnd: '2026-09-30' } } });
  const r = decide(snap({ budgets: [b] }), {}, '2026-09-18');
  assert.deepStrictEqual(r.fire.map((x) => x.key).sort(),
    ['budget:b1:2026-09-01:100', 'budget:b1:2026-09-01:80']);
});

test('a budget under eighty percent fires nothing', () => {
  const r = decide(snap({ budgets: [budget()] }), {}, '2026-09-18');
  assert.deepStrictEqual(r.fire, []);
});

test('a budget threshold re-arms in a new period', () => {
  const b = budget({ spending: { current: { spent: 85, effectiveLimit: 100, periodStart: '2026-09-01', periodEnd: '2026-09-30' } } });
  const first = decide(snap({ budgets: [b] }), {}, '2026-09-18');
  const b2 = budget({ spending: { current: { spent: 85, effectiveLimit: 100, periodStart: '2026-10-01', periodEnd: '2026-10-31' } } });
  const next = decide(snap({ budgets: [b2] }), first.notified, '2026-10-18');
  assert.strictEqual(next.fire.length, 1);
  assert.strictEqual(next.fire[0].key, 'budget:b1:2026-10-01:80');
});

test('a budget with a zero limit does not fire on a division by zero', () => {
  const b = budget({ spending: { current: { spent: 5, effectiveLimit: 0, periodStart: '2026-09-01', periodEnd: '2026-09-30' } } });
  assert.deepStrictEqual(decide(snap({ budgets: [b] }), {}, '2026-09-18').fire, []);
});

test('uncategorized records produce one digest per day, not one per record', () => {
  const s = snap({ uncategorized: [{ id: 'r1' }, { id: 'r2' }, { id: 'r3' }] });
  const r = decide(s, {}, '2026-09-18');
  assert.strictEqual(r.fire.length, 1);
  assert.strictEqual(r.fire[0].key, 'digest:2026-09-18');
  assert.match(r.fire[0].body, /3/);
});

test('the digest does not repeat on a later poll the same day', () => {
  const s = snap({ uncategorized: [{ id: 'r1' }] });
  const first = decide(s, {}, '2026-09-18');
  assert.deepStrictEqual(decide(s, first.notified, '2026-09-18').fire, []);
});

test('the digest fires again the next day', () => {
  const s = snap({ uncategorized: [{ id: 'r1' }] });
  const first = decide(s, {}, '2026-09-18');
  assert.strictEqual(decide(s, first.notified, '2026-09-19').fire.length, 1);
});

test('no uncategorized records produces no digest', () => {
  assert.deepStrictEqual(decide(snap(), {}, '2026-09-18').fire, []);
});

test('decide does not mutate the notified map it is given', () => {
  const notified = {};
  decide(snap({ orders: [order()] }), notified, '2026-09-22');
  assert.deepStrictEqual(notified, {}, 'the input map must be left untouched');
});

test('markers from old periods are pruned so state.json cannot grow forever', () => {
  const stale = { 'order:old:2020-01-01:due': true, 'digest:2020-01-01': true };
  const r = decide(snap(), stale, '2026-09-18');
  assert.deepStrictEqual(r.notified, {});
});
