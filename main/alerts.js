const { upcoming } = require('./rrule');

const DAY = 86400000;
const KEEP_DAYS = 120; // markers older than this cannot re-fire; drop them

function dayOf(iso) {
  const m = String(iso).match(/^(\d{4})-(\d{2})-(\d{2})/);
  return m ? Date.UTC(+m[1], +m[2] - 1, +m[3]) : NaN;
}

function fmt(ms) {
  return new Date(ms).toISOString().slice(0, 10);
}

const money = (n) => `${n < 0 ? '-' : ''}${Math.abs(n).toFixed(2)} EUR`;

// Drop markers whose embedded date is long past. Keys carry their date, so
// pruning needs no extra bookkeeping.
function prune(notified, todayISO) {
  const cutoff = dayOf(todayISO) - KEEP_DAYS * DAY;
  const out = {};
  for (const [k, v] of Object.entries(notified || {})) {
    const m = k.match(/(\d{4}-\d{2}-\d{2})/);
    if (m && dayOf(m[1]) < cutoff) continue;
    out[k] = v;
  }
  return out;
}

function decide(snapshot, notified, todayISO) {
  const next = prune(notified, todayISO);
  const fire = [];

  const emit = (key, title, body) => {
    if (next[key]) return;
    next[key] = true;
    fire.push({ key, title, body });
  };

  // --- standing orders: honour the per-order flags set in Wallet ----------
  const orders = snapshot.orders || [];
  const dueToday = upcoming(orders, todayISO, todayISO);
  for (const e of dueToday) {
    const o = orders.find((x) => x.id === e.orderId);
    if (!o || !o.dueDateNotificationEnabled) continue;
    emit(`order:${e.orderId}:${e.date}:due`,
      `${e.name} due today`,
      `${money(e.signed)} — ${e.date}`);
  }

  const inThree = fmt(dayOf(todayISO) + 3 * DAY);
  for (const e of upcoming(orders, inThree, inThree)) {
    const o = orders.find((x) => x.id === e.orderId);
    if (!o || !o.threeDaysBeforeNotificationEnabled) continue;
    emit(`order:${e.orderId}:${e.date}:3day`,
      `${e.name} in 3 days`,
      `${money(e.signed)} — ${e.date}`);
  }

  // --- budget thresholds --------------------------------------------------
  for (const b of snapshot.budgets || []) {
    const cur = b.spending && b.spending.current;
    if (!cur) continue;
    const limit = Number(cur.effectiveLimit) || 0;
    if (limit <= 0) continue;
    const pct = (Number(cur.spent) || 0) / limit;

    if (pct >= 1) {
      emit(`budget:${b.id}:${cur.periodStart}:100`,
        `${b.name} is over budget`,
        `${money(cur.spent)} of ${money(limit)} — ${Math.round(pct * 100)}%`);
    }
    if (pct >= 0.8) {
      emit(`budget:${b.id}:${cur.periodStart}:80`,
        `${b.name} past 80%`,
        `${money(cur.spent)} of ${money(limit)} — ${Math.round(pct * 100)}%`);
    }
  }

  // --- uncategorized digest, once a day -----------------------------------
  const n = (snapshot.uncategorized || []).length;
  if (n > 0) {
    emit(`digest:${todayISO}`,
      'Records need a category',
      `${n} record${n === 1 ? '' : 's'} arrived uncategorized.`);
  }

  return { fire, notified: next };
}

module.exports = { decide };
