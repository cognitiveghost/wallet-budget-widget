const { build, UNCATEGORIZED, monthBounds } = require('./snapshot');

const DEFAULT_INTERVAL = 5 * 60 * 1000;
const LOW_WATER = 50; // back off below this many requests left in the hour

let timer = null;
let running = false;

function today() {
  return new Date().toISOString().slice(0, 10);
}

async function cycle({ api, onSnapshot, onError }) {
  if (running) return; // never overlap a slow cycle with the next tick
  running = true;
  try {
    const t = today();
    const { start, end } = monthBounds(t);
    const [budgets, orders, accounts] = await Promise.all([
      api.budgets(), api.standingOrders(), api.accounts(),
    ]);
    // 90 days of history feeds the discretionary rate; the runway needs only
    // this month, and the wider window is a superset of it.
    const from = new Date(Date.parse(`${start}T00:00:00Z`) - 90 * 86400000)
      .toISOString().slice(0, 10);
    const records = await api.records({ from, to: end });
    const uncategorized = await api.records({ from, to: end, categoryId: UNCATEGORIZED.join(',') });

    onSnapshot(build({
      budgets, orders, accounts,
      records: records.filter((r) => r.recordDate >= start),
      uncategorized,
      rateLimit: api.rateLimit(),
    }, t));
  } catch (err) {
    onError(err);
  } finally {
    running = false;
  }
}

function start(opts) {
  stop();
  const base = opts.intervalMs || DEFAULT_INTERVAL;
  const tick = async () => {
    await cycle(opts);
    const { remaining } = opts.api.rateLimit();
    // Doubling on a low budget is enough to ride out the rest of the hour.
    const wait = remaining !== null && remaining < LOW_WATER ? base * 2 : base;
    timer = setTimeout(tick, wait);
  };
  tick();
}

function stop() {
  clearTimeout(timer);
  timer = null;
}

module.exports = { start, stop, refreshNow: cycle, DEFAULT_INTERVAL };
