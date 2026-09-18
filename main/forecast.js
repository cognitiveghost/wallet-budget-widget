const { upcoming, occurrences } = require('./rrule');

const DAY = 86400000;

// Money conventions in this module:
//   record.convertedAmount  SIGNED  (expense negative, income positive)
//   order.amount            POSITIVE, direction in order.type
//   budget spent/projected  POSITIVE magnitudes
//   runway balances         SIGNED

function dayOf(iso) {
  const m = String(iso).match(/^(\d{4})-(\d{2})-(\d{2})/);
  return m ? Date.UTC(+m[1], +m[2] - 1, +m[3]) : NaN;
}

function fmt(ms) {
  return new Date(ms).toISOString().slice(0, 10);
}

function addDays(iso, n) {
  return fmt(dayOf(iso) + n * DAY);
}

// The API returns money as {currencyCode, value}; older payloads used a bare
// number. Accept both rather than silently reading every amount as 0.
function amountOf(v) {
  if (v && typeof v === 'object') return Number(v.value) || 0;
  return Number(v) || 0;
}

function signedOf(record) {
  const v = record.convertedAmount;
  return amountOf(v === undefined || v === null ? record.amount : v);
}

// A budget's scope is three ID sets combined with AND. An empty set means that
// dimension is unconstrained — not that nothing matches.
function inScope(budget, item) {
  const accounts = budget.accountIds || [];
  const categories = budget.categoryIds || [];
  const labels = budget.labelIds || [];

  if (accounts.length && !accounts.includes(item.accountId)) return false;

  if (categories.length) {
    const cid = item.categoryId || (item.category && item.category.id);
    if (!categories.includes(cid)) return false;
  }

  if (labels.length) {
    const ids = (item.labels || []).map((l) => (typeof l === 'string' ? l : l.id));
    if (!ids.some((id) => labels.includes(id))) return false;
  }

  return true;
}

// Attribute a record to a standing order so it can be excluded from the
// discretionary rate. /standing-orders/items links generated records to their
// parent, but manualPayment orders produce hand-entered records with no such
// link, so this heuristic covers both.
// ponytail: amount+account+-3d window. Tighten with standing-order-items if
// false positives ever show up in practice.
function isRecurring(record, orders) {
  const amount = Math.abs(signedOf(record));
  const when = dayOf(record.recordDate);
  if (!Number.isFinite(when)) return false;

  for (const o of orders || []) {
    if (o.accountId && record.accountId && o.accountId !== record.accountId) continue;
    const target = Math.abs(Number(o.amount) || 0);
    if (target === 0) continue;
    if (Math.abs(amount - target) / target > 0.01) continue;

    const seed = o.generateFromDate || o.dueDate;
    const near = occurrences(o.recurrenceRule, seed, fmt(when - 3 * DAY), fmt(when + 3 * DAY));
    if (near.length) return true;
  }
  return false;
}

// Mean daily spend of everything that is neither a transfer, nor income, nor
// attributable to a standing order. Always a non-negative magnitude.
function discretionaryRate(records, orders, days) {
  if (!days || days <= 0) return 0;
  let total = 0;
  for (const r of records || []) {
    if (r.transfer) continue;
    const v = signedOf(r);
    if (v >= 0) continue; // income and zero-value records
    if (isRecurring(r, orders)) continue;
    total += -v;
  }
  return total / days;
}

function projectBudget(budget, orders, records, todayISO) {
  const cur = (budget.spending && budget.spending.current) || null;
  const spent = cur ? Number(cur.spent) || 0 : 0;
  const limit = cur && cur.effectiveLimit != null
    ? Number(cur.effectiveLimit)
    : Number(budget.limit) || 0;

  if (!cur) {
    return { spent: 0, scheduled: 0, discretionary: 0, projected: 0, limit, ratio: 0, overshoot: 0, crossesOn: null };
  }

  const start = cur.periodStart;
  const end = cur.periodEnd;
  const today = todayISO;

  // Elapsed counts today as a day in progress, so day one divides by 1, not 0.
  const elapsed = Math.max(1, Math.round((dayOf(today) - dayOf(start)) / DAY) + 1);
  const remaining = Math.max(0, Math.round((dayOf(end) - dayOf(today)) / DAY));

  if (remaining === 0) {
    const ratio = limit > 0 ? spent / limit : 0;
    return { spent, scheduled: 0, discretionary: 0, projected: spent, limit, ratio, overshoot: Math.max(0, spent - limit), crossesOn: null };
  }

  // Scheduled: standing orders in this budget's scope that fall after today.
  const scopedOrders = (orders || []).filter((o) => inScope(budget, o));
  const scheduled = upcoming(scopedOrders, addDays(today, 1), end)
    .filter((e) => e.type === 'expense')
    .reduce((sum, e) => sum + e.amount, 0);

  // Discretionary: rate derived only from this budget's own scoped records.
  const scopedRecords = (records || [])
    .filter((r) => inScope(budget, r))
    .filter((r) => dayOf(r.recordDate) >= dayOf(start) && dayOf(r.recordDate) <= dayOf(today));
  const rate = discretionaryRate(scopedRecords, orders, elapsed);
  const discretionary = rate * remaining;

  const projected = spent + scheduled + discretionary;
  const ratio = limit > 0 ? projected / limit : 0;

  // The day the limit is first passed, walked out day by day rather than
  // divided out of the total: a rent payment on the 28th crosses on the 28th,
  // and "over on the 26th" is a thing you can still act on. Null when the
  // budget lands inside its limit, and when it is over already — spent and
  // limit say that on their own.
  let crossesOn = null;
  if (limit > 0 && spent <= limit) {
    const byDay = new Map();
    for (const e of upcoming(scopedOrders, addDays(today, 1), end)) {
      if (e.type === 'expense') byDay.set(e.date, (byDay.get(e.date) || 0) + e.amount);
    }
    let running = spent;
    for (let ms = dayOf(today) + DAY; ms <= dayOf(end); ms += DAY) {
      const d = fmt(ms);
      running += (byDay.get(d) || 0) + rate;
      if (running > limit) { crossesOn = d; break; }
    }
  }

  return {
    spent,
    scheduled,
    discretionary,
    projected,
    limit,
    ratio,
    overshoot: Math.max(0, projected - limit),
    crossesOn,
  };
}

// Daily balance series: measured up to today, arithmetic from today to the
// horizon. startBalance is the balance as of periodStartISO.
//
// burnPerDay is everyday spending — what is left after transfers, income and
// standing orders are taken out. Without it the projection only ever books the
// money it knows the date of, so the line drifts up and the further the
// horizon runs the more it lies.
function runway(records, orders, startBalance, periodStartISO, periodEndISO, todayISO, burnPerDay = 0) {
  const start = dayOf(periodStartISO);
  const end = dayOf(periodEndISO);
  const today = Math.min(dayOf(todayISO), end);

  const perDay = new Map();
  for (const r of records || []) {
    if (r.transfer) continue;
    const ms = dayOf(r.recordDate);
    // An undated record cannot sit on a day-by-day series; dropping it beats
    // throwing `Invalid time value` out of the whole poll cycle.
    if (!Number.isFinite(ms)) continue;
    const d = fmt(ms);
    perDay.set(d, (perDay.get(d) || 0) + signedOf(r));
  }

  const actual = [];
  let balance = Number(startBalance) || 0;
  for (let ms = start; ms <= today; ms += DAY) {
    const d = fmt(ms);
    balance += perDay.get(d) || 0;
    actual.push({ date: d, balance: Math.round(balance * 100) / 100 });
  }

  const events = new Map();
  for (const e of upcoming(orders, fmt(today + DAY), periodEndISO)) {
    events.set(e.date, (events.get(e.date) || 0) + e.signed);
  }

  const burn = Math.max(0, Number(burnPerDay) || 0);
  const projected = [{ date: fmt(today), balance: actual.length ? actual[actual.length - 1].balance : balance }];
  let p = projected[0].balance;
  for (let ms = today + DAY; ms <= end; ms += DAY) {
    const d = fmt(ms);
    p += (events.get(d) || 0) - burn;
    projected.push({ date: d, balance: Math.round(p * 100) / 100 });
  }

  return { actual, projected, end: projected[projected.length - 1].balance };
}

module.exports = { inScope, isRecurring, discretionaryRate, projectBudget, runway, amountOf };
