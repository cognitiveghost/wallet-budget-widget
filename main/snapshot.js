const { upcoming } = require('./rrule');
const { projectBudget, runway, amountOf, discretionaryRate } = require('./forecast');

const DAY = 86400000;
const STALE_DAYS = 4;
const RATE_DAYS = 60; // trailing window the everyday burn rate is averaged over
// Wallet reports these two for a record nobody has confirmed yet: uncleared is
// imported and untouched, waitForAssign is waiting on categorisation.
const NEEDS_REVIEW = ['uncleared', 'waitForAssign'];
const BASE_CURRENCY = 'EUR'; // matches the convertTo the API layer requests

// Fixed across every Wallet account.
const UNCATEGORIZED = [
  '5c5c32c8-0082-8000-8000-000000000000', // Unknown income
  '5c5c32c9-0082-8000-8000-000000000000', // Unknown expense
  '5c5c4e23-00c8-8000-8000-000000000000', // Uncategorized
];

function dayOf(iso) {
  const m = String(iso).match(/^(\d{4})-(\d{2})-(\d{2})/);
  return m ? Date.UTC(+m[1], +m[2] - 1, +m[3]) : NaN;
}

function fmt(ms) {
  return new Date(ms).toISOString().slice(0, 10);
}

function monthBounds(todayISO, offset = 0) {
  const d = new Date(dayOf(todayISO));
  const y = d.getUTCFullYear();
  const m = d.getUTCMonth() + offset;
  return { start: fmt(Date.UTC(y, m, 1)), end: fmt(Date.UTC(y, m + 1, 0)) };
}

function build(rawData, todayISO) {
  const { budgets = [], orders = [], accounts = [], records = [], uncategorized = [] } = rawData;
  const { start, end } = monthBounds(todayISO);

  const projected = budgets.map((b) => {
    const p = projectBudget(b, orders, records, todayISO);
    const cur = (b.spending && b.spending.current) || {};
    return {
      id: b.id,
      name: b.name,
      period: cur.period || '',
      periodStart: cur.periodStart || start,
      periodEnd: cur.periodEnd || end,
      progress: Number(cur.progress) || 0,
      ...p,
    };
  });

  // Worst news first — whatever is about to go wrong rises to the top.
  projected.sort((a, b) => (b.overshoot - a.overshoot) || (b.ratio - a.ratio));

  // The runway is one line of money, so its balances and its records have to
  // come from the same set of accounts. Archived and excluded-from-stats
  // accounts are out because Wallet leaves them out of its own totals; other
  // currencies are out because records arrive converted to EUR while balances
  // do not, and the API exposes no converted balance. Dropping those accounts
  // and naming them beats adding a CZK balance to a EUR line.
  const currencyOf = (a) => (a.balance && a.balance.currencyCode) || a.currencyCode || BASE_CURRENCY;
  const active = accounts.filter((a) => !a.archived && !a.excludeFromStats);
  const included = active.filter((a) => currencyOf(a) === BASE_CURRENCY);
  const excludedAccounts = active.filter((a) => currencyOf(a) !== BASE_CURRENCY).map((a) => a.name);

  // A record on no included account cannot reconcile against these balances.
  const includedIds = new Set(included.map((a) => a.id));
  const balanceRecords = records.filter((r) => includedIds.has(r.accountId));

  // Everyday spending: what is left once transfers, income and standing orders
  // are taken out, averaged over a window long enough that one big Saturday
  // does not become the forecast. It is the only term that carries the
  // projection past the dates we already know.
  const rateFrom = dayOf(todayISO) - RATE_DAYS * DAY;
  const burn = discretionaryRate(
    balanceRecords.filter((r) => dayOf(r.recordDate) >= rateFrom && dayOf(r.recordDate) <= dayOf(todayISO)),
    orders,
    RATE_DAYS,
  );

  const total = included.reduce((sum, a) => sum + (Number(a.balance && a.balance.currentBalance) || 0), 0);

  // currentBalance is as of now, so walk this month's records backward to
  // recover the opening balance the runway starts from.
  const monthNet = balanceRecords
    .filter((r) => !r.transfer && dayOf(r.recordDate) >= dayOf(start) && dayOf(r.recordDate) <= dayOf(todayISO))
    .reduce((sum, r) => sum + amountOf(r.convertedAmount ?? r.amount), 0);
  const opening = total - monthNet;

  const sync = accounts
    .filter((a) => a.isBankSync)
    .map((a) => {
      const last = a.recordStats && a.recordStats.recordDate && a.recordStats.recordDate.max;
      // `last` can be present but unparseable, so test the parse, not the field.
      const lastMs = dayOf(last);
      const dated = Number.isFinite(lastMs);
      const ageDays = dated ? Math.round((dayOf(todayISO) - lastMs) / DAY) : null;
      return {
        id: a.id,
        name: a.name,
        lastRecord: dated ? fmt(lastMs) : null,
        ageDays,
        error: (a.recordStats && a.recordStats.error) || null,
        stale: ageDays !== null && ageDays >= STALE_DAYS,
      };
    });

  // The line runs to the end of next month: this month's closing balance is
  // only half an answer when rent and payday both land on the far side of it.
  const next = monthBounds(todayISO, 1);
  const line = runway(balanceRecords, orders, opening, start, next.end, todayISO, burn);
  const balanceOn = (d) => {
    const hit = line.projected.find((x) => x.date === d) || line.actual.find((x) => x.date === d);
    return hit ? hit.balance : null;
  };

  const nextEvents = upcoming(orders, next.start, next.end);
  const nextDays = Math.round((dayOf(next.end) - dayOf(next.start)) / DAY) + 1;

  return {
    generatedAt: new Date().toISOString(),
    today: todayISO,
    budgets: projected,
    runway: { ...line, monthEnd: balanceOn(end), monthEndDate: end },
    burnPerDay: Math.round(burn * 100) / 100,
    nextMonth: {
      start: next.start,
      end: next.end,
      opening: balanceOn(end),
      income: nextEvents.filter((e) => e.signed > 0).reduce((sum, e) => sum + e.signed, 0),
      expense: nextEvents.filter((e) => e.signed < 0).reduce((sum, e) => sum - e.signed, 0),
      burn: Math.round(burn * nextDays * 100) / 100,
      closing: line.end,
    },
    currency: BASE_CURRENCY,
    excludedAccounts,
    upcoming: upcoming(orders, todayISO, fmt(dayOf(todayISO) + 30 * DAY)),
    uncategorized: uncategorized.filter((r) => Number.isFinite(dayOf(r.recordDate))).map((r) => ({
      id: r.id,
      date: fmt(dayOf(r.recordDate)),
      amount: amountOf(r.convertedAmount ?? r.amount),
      counterParty: r.counterParty || '',
      accountName: r.accountName || '',
    })),
    // Records nobody has confirmed. Wallet only sends recordState on some
    // payloads, so `reviewStateSeen` lets the UI tell "nothing to review" apart
    // from "this account never reports review state".
    unchecked: records
      .filter((r) => NEEDS_REVIEW.includes(r.recordState) && Number.isFinite(dayOf(r.recordDate)))
      .sort((a, b) => dayOf(b.recordDate) - dayOf(a.recordDate))
      .slice(0, 50)
      .map((r) => ({
        id: r.id,
        date: fmt(dayOf(r.recordDate)),
        amount: amountOf(r.convertedAmount ?? r.amount),
        counterParty: r.counterParty || '',
        accountName: r.accountName || '',
        state: r.recordState,
      })),
    reviewStateSeen: records.some((r) => typeof r.recordState === 'string'),
    sync,
    orders,
    rateLimit: rawData.rateLimit || { remaining: null, limit: null },
  };
}

module.exports = { build, UNCATEGORIZED, monthBounds };
