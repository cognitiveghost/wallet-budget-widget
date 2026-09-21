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
    const { start } = monthBounds(t);
    // Out to the end of NEXT month, because that is how far the line runs and
    // a hand-entered record out there now moves it. Fetching only to this
    // month's end meant next month's cash payments were never even asked for.
    const { end } = monthBounds(t, 1);
    // Categories and order items are enrichment, not structure: the dashboard
    // is correct without either, so neither is allowed to fail the cycle.
    // `budgets`, `orders` and `accounts` are not optional and still throw.
    const optional = (p) => p.then((x) => x, () => []);

    const [budgets, orders, accounts, categories] = await Promise.all([
      api.budgets(), api.standingOrders(), api.accounts(), optional(api.categories()),
    ]);
    // 90 days of history feeds the discretionary rate; the runway needs only
    // this month, and the wider window is a superset of it.
    const from = new Date(Date.parse(`${start}T00:00:00Z`) - 90 * 86400000)
      .toISOString().slice(0, 10);
    const records = await api.records({ from, to: end });
    const uncategorized = await api.records({ from, to: end, categoryId: UNCATEGORIZED.join(',') });
    // The same window the records use: an item older than the window can only
    // settle a record the window does not contain.
    const orderItems = await optional(api.orderItems({ from, to: end }));

    // The full window goes through untrimmed. Every consumer in build() does
    // its own date filtering, and budgets on a quarterly or yearly period need
    // history older than this month or their discretionary rate divides a
    // month of spending by a year of days and projects almost nothing.
    // ponytail: 90 days back. A yearly budget still sees a partial period;
    // widen the window if yearly budgets turn out to matter.
    onSnapshot(build({
      budgets, orders, accounts, records, uncategorized, categories, orderItems,
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
