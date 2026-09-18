const { upcoming } = require('./rrule');
const { projectBudget, runway, amountOf } = require('./forecast');

const DAY = 86400000;
const STALE_DAYS = 4;

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

function monthBounds(todayISO) {
  const d = new Date(dayOf(todayISO));
  const y = d.getUTCFullYear();
  const m = d.getUTCMonth();
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

  const total = accounts.reduce((sum, a) => sum + (Number(a.balance && a.balance.currentBalance) || 0), 0);

  // currentBalance is as of now, so walk this month's records backward to
  // recover the opening balance the runway starts from.
  const monthNet = records
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

  return {
    generatedAt: new Date().toISOString(),
    today: todayISO,
    budgets: projected,
    runway: runway(records, orders, opening, start, end, todayISO),
    upcoming: upcoming(orders, todayISO, fmt(dayOf(todayISO) + 30 * DAY)),
    uncategorized: uncategorized.filter((r) => Number.isFinite(dayOf(r.recordDate))).map((r) => ({
      id: r.id,
      date: fmt(dayOf(r.recordDate)),
      amount: amountOf(r.convertedAmount ?? r.amount),
      counterParty: r.counterParty || '',
      accountName: r.accountName || '',
    })),
    sync,
    orders,
    rateLimit: rawData.rateLimit || { remaining: null, limit: null },
  };
}

module.exports = { build, UNCATEGORIZED, monthBounds };
