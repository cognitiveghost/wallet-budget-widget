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

// The rate is what history did that the calendar does not already account for.
//
// Deciding record by record whether something was a standing-order payment is
// a guess, and every miss costs twice: the payment stays in the rate AND gets
// added again as a payment still to come. So don't decide. Expand the same
// RRULEs backwards over the measured window and subtract what they claim to
// have produced. Whatever an order says it generates is removed at exactly the
// rate it will be re-added going forward, so double counting is impossible by
// construction — and an order that never actually fires simply pushes the rate
// back up to compensate.
function windowDays(fromISO, toISO) {
  return Math.round((dayOf(toISO) - dayOf(fromISO)) / DAY) + 1;
}

function inWindow(record, fromISO, toISO) {
  const ms = dayOf(record.recordDate);
  return Number.isFinite(ms) && ms >= dayOf(fromISO) && ms <= dayOf(toISO);
}

// Mean daily change in balance from everything not already on the calendar.
// Signed: a balance moves on net flow, so money arriving off-schedule counts
// as much as money leaving. Extrapolating only the outgoings while counting
// nothing incoming but scheduled income walks every projection to zero whether
// or not the account is really draining.
function netRate(records, orders, fromISO, toISO) {
  const days = windowDays(fromISO, toISO);
  if (days <= 0) return 0;

  let actual = 0;
  for (const r of records || []) {
    if (r.transfer) continue;
    if (!inWindow(r, fromISO, toISO)) continue;
    actual += signedOf(r);
  }
  const scheduled = upcoming(orders, fromISO, toISO).reduce((sum, e) => sum + e.signed, 0);
  return (actual - scheduled) / days;
}

// The same calibration for one budget's scope. Budgets count expenses only —
// Wallet leaves income categories out of a budget's spending — so this stays
// gross, and never goes below zero: a budget cannot spend backwards.
function discretionaryRate(records, orders, fromISO, toISO) {
  const days = windowDays(fromISO, toISO);
  if (days <= 0) return 0;

  let gross = 0;
  for (const r of records || []) {
    if (r.transfer) continue;
    if (!inWindow(r, fromISO, toISO)) continue;
    const v = signedOf(r);
    if (v < 0) gross += -v;
  }
  const scheduled = upcoming(orders, fromISO, toISO)
    .filter((e) => e.type === 'expense')
    .reduce((sum, e) => sum + e.amount, 0);
  return Math.max(0, gross - scheduled) / days;
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

  const scopedOrders = (orders || []).filter((o) => inScope(budget, o));

  // Scheduled: standing orders in this budget's scope that fall after today.
  const scheduled = upcoming(scopedOrders, addDays(today, 1), end)
    .filter((e) => e.type === 'expense')
    .reduce((sum, e) => sum + e.amount, 0);

  // Discretionary: rate derived only from this budget's own scoped records.
  const scopedRecords = (records || []).filter((r) => inScope(budget, r));
  const rate = discretionaryRate(scopedRecords, scopedOrders, start, today);
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
// ratePerDay is the everyday net flow — what moves the balance that is not a
// transfer and not already on the calendar. Signed: negative is the usual
// case, positive is an account that takes in more off-schedule than it spends.
// Without it the projection only books money it knows the date of, so the line
// drifts and the further the horizon runs the more it lies.
function runway(records, orders, startBalance, periodStartISO, periodEndISO, todayISO, ratePerDay = 0) {
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

  const rate = Number(ratePerDay) || 0;
  const projected = [{ date: fmt(today), balance: actual.length ? actual[actual.length - 1].balance : balance }];
  let p = projected[0].balance;
  for (let ms = today + DAY; ms <= end; ms += DAY) {
    const d = fmt(ms);
    p += (events.get(d) || 0) + rate;
    projected.push({ date: d, balance: Math.round(p * 100) / 100 });
  }

  return { actual, projected, end: projected[projected.length - 1].balance };
}

module.exports = { inScope, discretionaryRate, netRate, projectBudget, runway, amountOf };
