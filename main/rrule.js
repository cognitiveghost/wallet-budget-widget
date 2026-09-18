// RRULE expansion, limited to the parts Wallet actually emits:
// FREQ (DAILY|WEEKLY|MONTHLY|YEARLY), INTERVAL, BYMONTHDAY, UNTIL, COUNT.
// ponytail: no BYDAY/BYSETPOS/EXDATE. Wallet's standing-order editor does not
// produce them; add them here if a rule ever arrives that needs them.

const DAY = 86400000;

function toUtcDays(iso) {
  // Accepts '2026-09-15', ISO timestamps, and Wallet's
  // 'YYYY-MM-DD HH:mm:ss.SSS' generateFromDate form.
  const m = String(iso).match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!m) return NaN;
  return Date.UTC(+m[1], +m[2] - 1, +m[3]);
}

function fmt(ms) {
  return new Date(ms).toISOString().slice(0, 10);
}

function parseUntil(v) {
  // UNTIL arrives as a basic-format stamp: 20270101T100000Z
  const m = String(v).match(/^(\d{4})(\d{2})(\d{2})/);
  return m ? Date.UTC(+m[1], +m[2] - 1, +m[3]) : NaN;
}

function parse(rule) {
  const out = {};
  for (const part of String(rule).split(';')) {
    const [k, v] = part.split('=');
    if (k && v !== undefined) out[k.trim().toUpperCase()] = v.trim();
  }
  return out;
}

function lastDayOfMonth(y, mIdx) {
  return new Date(Date.UTC(y, mIdx + 1, 0)).getUTCDate();
}

function occurrences(rule, seedISO, fromISO, toISO) {
  const seed = toUtcDays(seedISO);
  const from = toUtcDays(fromISO);
  const to = toUtcDays(toISO);
  if (!Number.isFinite(seed) || !Number.isFinite(from) || !Number.isFinite(to)) return [];
  if (to < from) return [];

  // No rule: a one-off that occurs exactly once, on its own date.
  if (!rule) return seed >= from && seed <= to ? [fmt(seed)] : [];

  const r = parse(rule);
  const interval = Math.max(1, parseInt(r.INTERVAL, 10) || 1);
  const until = r.UNTIL ? parseUntil(r.UNTIL) : Infinity;
  const count = r.COUNT ? parseInt(r.COUNT, 10) : Infinity;
  const limit = Number.isFinite(until) ? until : Infinity;

  const hits = [];
  let emitted = 0;

  const push = (ms) => {
    if (ms > limit) return false;
    if (emitted >= count) return false;
    emitted += 1;
    if (ms >= from && ms <= to) hits.push(fmt(ms));
    return true;
  };

  if (r.FREQ === 'DAILY' || r.FREQ === 'WEEKLY') {
    const stride = (r.FREQ === 'WEEKLY' ? 7 : 1) * interval * DAY;
    // Walk from the seed; stop once past the range or past UNTIL/COUNT.
    for (let ms = seed; ms <= to; ms += stride) {
      if (!push(ms)) break;
    }
    return hits;
  }

  if (r.FREQ === 'MONTHLY' || r.FREQ === 'YEARLY') {
    const step = r.FREQ === 'YEARLY' ? 12 * interval : interval;
    const seedDate = new Date(seed);
    const monthDay = r.BYMONTHDAY ? parseInt(r.BYMONTHDAY, 10) : seedDate.getUTCDate();
    let y = seedDate.getUTCFullYear();
    let mIdx = seedDate.getUTCMonth();

    // Guarded rather than while(true): a malformed interval must not spin.
    const maxIterations = 1200;
    for (let i = 0; i < maxIterations; i += 1) {
      // BYMONTHDAY=31 in February means the 28th/29th, not a skipped month.
      const day = Math.min(monthDay, lastDayOfMonth(y, mIdx));
      const ms = Date.UTC(y, mIdx, day);
      if (ms > to) break;
      // No `ms >= seed` guard: Wallet's `dueDate` is the NEXT due date, not the
      // series start, so a BYMONTHDAY earlier in that same month is still a real
      // occurrence. The walk begins in the seed's month, which bounds how far
      // back this can reach.
      if (!push(ms)) break;
      mIdx += step;
      y += Math.floor(mIdx / 12);
      mIdx = ((mIdx % 12) + 12) % 12;
    }
    return hits;
  }

  // Unrecognised FREQ: report nothing rather than guessing at a schedule.
  return [];
}

function upcoming(orders, fromISO, toISO) {
  const events = [];
  for (const o of orders || []) {
    const seed = o.generateFromDate || o.dueDate;
    for (const date of occurrences(o.recurrenceRule, seed, fromISO, toISO)) {
      const magnitude = Math.abs(Number(o.amount) || 0);
      events.push({
        date,
        orderId: o.id,
        name: o.name,
        amount: magnitude,
        type: o.type,
        // Standing orders store a positive amount; direction lives in `type`.
        signed: o.type === 'income' ? magnitude : -magnitude,
        accountId: o.accountId,
        categoryId: o.categoryId,
      });
    }
  }
  events.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  return events;
}

module.exports = { occurrences, upcoming };
