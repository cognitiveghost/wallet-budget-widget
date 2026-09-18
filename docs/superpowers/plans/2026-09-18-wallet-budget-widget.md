# Wallet Budget Widget Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** An Electron dashboard for a 1920x1080 second monitor that renders BudgetBakers Wallet budgets, standing orders, an arithmetic month projection, bank-sync freshness and an uncategorized inbox, and raises Windows notifications.

**Architecture:** Two processes. The main process holds the API token and performs all HTTP; the renderer receives plain JSON snapshots over IPC and never sees a credential. All meaningful logic lives in three pure modules (`rrule`, `forecast`, `alerts`) that take data and return data, so they are tested with `node --test` without launching Electron.

**Tech Stack:** Electron 33, CommonJS, vanilla JS/CSS renderer, hand-rolled SVG charts, `node:test`, `electron-builder` for a Windows portable exe. Zero runtime dependencies.

**Spec:** `docs/superpowers/specs/2026-09-18-wallet-budget-widget-design.md`

## Global Constraints

- **Zero runtime dependencies.** `dependencies` in `package.json` stays empty. Electron and electron-builder are `devDependencies` only.
- **CommonJS throughout** (`require` / `module.exports`). Not ESM. Matches the sibling `sofia-stop-widget` project.
- **Tests are `node:test` + `node:assert`.** No framework, no mocking library. Run with `npm test` → `node --test`.
- **Main-process modules must load outside Electron.** Any module needing an Electron API requires it lazily inside a function, and exposes a `setPath()` / injection escape hatch for tests. Copy the pattern in `sofia-stop-widget/main/store.js`.
- **The token never crosses IPC to the renderer.** No IPC channel returns it, logs it, or includes it in an error message.
- **API base:** `https://rest.budgetbakers.com/wallet/v1/api`
- **Auth header:** `Authorization: Bearer <token>`
- **Rate limit planning figure: 300 requests/hour** (server currently advertises 450; plan against the documented lower number).
- **All dates are UTC.** The API is UTC throughout. Use `Date.UTC(...)` and `YYYY-MM-DD` strings; never use local-time `getMonth()`/`getDate()` on API data.
- **Sign conventions — the single most bug-prone part of this codebase:**
  - Record `amount` / `convertedAmount` are **signed**: expenses negative, income positive.
  - Standing order `amount` is **always positive**; direction comes from `type: 'expense' | 'income'`.
  - Budget `spending.current.spent` is **positive** (it is a magnitude).
  - Every function that mixes these must state its convention in a comment.
- **Currency:** request `convertTo=EUR` on record queries and read `convertedAmount`. The account set spans BGN, EUR and UAH; the base currency is EUR.
- **UI copy is English.**

---

### Task 1: Project scaffold and state store

**Files:**
- Create: `package.json`
- Create: `main/store.js`
- Test: `test/store.test.js`

**Interfaces:**
- Consumes: nothing.
- Produces: `store.setPath(dir)`, `store.load() -> object`, `store.save(state) -> void`. Default state shape: `{ window: null, token: null, notified: {} }`.

- [ ] **Step 1: Create `package.json`**

```json
{
  "name": "wallet-budget-widget",
  "version": "0.1.0",
  "private": true,
  "description": "Desktop dashboard for BudgetBakers Wallet budgets, standing orders and projections",
  "main": "main/index.js",
  "scripts": {
    "start": "electron .",
    "test": "node --test",
    "build": "electron-builder --win portable"
  },
  "dependencies": {},
  "devDependencies": {
    "electron": "^33.2.0",
    "electron-builder": "^25.1.8"
  }
}
```

- [ ] **Step 2: Write the failing test**

Create `test/store.test.js`:

```js
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const store = require('../main/store');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'wbw-'));

test('a missing state file loads as defaults rather than throwing', () => {
  store.setPath(tmp());
  assert.deepStrictEqual(store.load(), { window: null, token: null, notified: {} });
});

test('a saved state round-trips', () => {
  store.setPath(tmp());
  store.save({ window: { x: 1, y: 2, w: 3, h: 4 }, token: 'blob', notified: { a: 1 } });
  assert.deepStrictEqual(store.load().window, { x: 1, y: 2, w: 3, h: 4 });
  assert.strictEqual(store.load().token, 'blob');
});

test('a corrupt state file loads as defaults rather than throwing', () => {
  const d = tmp();
  store.setPath(d);
  fs.writeFileSync(path.join(d, 'state.json'), '{not json');
  assert.deepStrictEqual(store.load(), { window: null, token: null, notified: {} });
});

test('a partial state file is filled in with defaults', () => {
  const d = tmp();
  store.setPath(d);
  fs.writeFileSync(path.join(d, 'state.json'), JSON.stringify({ token: 'x' }));
  const s = store.load();
  assert.strictEqual(s.token, 'x');
  assert.deepStrictEqual(s.notified, {});
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npm test`
Expected: FAIL — `Cannot find module '../main/store'`

- [ ] **Step 4: Write the implementation**

Create `main/store.js`:

```js
const fs = require('node:fs');
const path = require('node:path');

const DEFAULTS = { window: null, token: null, notified: {} };

// Resolved lazily so this module can be required outside Electron (tests).
let dir = null;

function base() {
  if (dir) return dir;
  dir = require('electron').app.getPath('userData');
  return dir;
}

function file() {
  return path.join(base(), 'state.json');
}

function setPath(d) {
  dir = d;
}

function load() {
  try {
    return { ...DEFAULTS, ...JSON.parse(fs.readFileSync(file(), 'utf8')) };
  } catch {
    return { ...DEFAULTS };
  }
}

function save(state) {
  fs.mkdirSync(base(), { recursive: true });
  fs.writeFileSync(file(), JSON.stringify(state, null, 2));
}

module.exports = { setPath, load, save };
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npm test`
Expected: PASS, 4 tests.

- [ ] **Step 6: Commit**

```bash
git add package.json main/store.js test/store.test.js
git commit -m "feat: project scaffold and state store"
```

---

### Task 2: Token storage with safeStorage

**Files:**
- Create: `main/secrets.js`
- Test: `test/secrets.test.js`

**Interfaces:**
- Consumes: `store.load()`, `store.save()` from Task 1.
- Produces: `secrets.looksLikeJwt(s) -> boolean`, `secrets.setCrypto(impl)`, `secrets.save(token) -> void`, `secrets.load() -> string | null`, `secrets.clear() -> void`.

`setCrypto` injects `{ isEncryptionAvailable, encryptString, decryptString }` so tests do not need Electron. In production `main/index.js` calls `secrets.setCrypto(require('electron').safeStorage)` once at startup.

- [ ] **Step 1: Write the failing test**

Create `test/secrets.test.js`:

```js
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const store = require('../main/store');
const secrets = require('../main/secrets');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'wbw-'));

// Stands in for Electron's safeStorage. Reversible, not secure — the point is
// that secrets.js round-trips through whatever it is given.
const fakeCrypto = {
  isEncryptionAvailable: () => true,
  encryptString: (s) => Buffer.from(`enc:${s}`),
  decryptString: (b) => b.toString().replace(/^enc:/, ''),
};

const JWT = 'aaa.bbb.ccc';

test('a three-part token is recognised as a JWT', () => {
  assert.strictEqual(secrets.looksLikeJwt(JWT), true);
});

test('a token with the wrong number of parts is rejected', () => {
  assert.strictEqual(secrets.looksLikeJwt('nodots'), false);
  assert.strictEqual(secrets.looksLikeJwt('a.b'), false);
  assert.strictEqual(secrets.looksLikeJwt('a.b.c.d'), false);
});

test('an empty or blank token is rejected', () => {
  assert.strictEqual(secrets.looksLikeJwt(''), false);
  assert.strictEqual(secrets.looksLikeJwt('   '), false);
  assert.strictEqual(secrets.looksLikeJwt(null), false);
});

test('a part that is empty is rejected', () => {
  assert.strictEqual(secrets.looksLikeJwt('a..c'), false);
});

test('a saved token round-trips through the crypto layer', () => {
  store.setPath(tmp());
  secrets.setCrypto(fakeCrypto);
  secrets.save(JWT);
  assert.strictEqual(secrets.load(), JWT);
});

test('the token is not stored in plaintext on disk', () => {
  const d = tmp();
  store.setPath(d);
  secrets.setCrypto(fakeCrypto);
  secrets.save(JWT);
  const raw = fs.readFileSync(path.join(d, 'state.json'), 'utf8');
  assert.ok(!raw.includes(JWT), 'state.json must not contain the raw token');
});

test('saving a malformed token throws rather than storing garbage', () => {
  store.setPath(tmp());
  secrets.setCrypto(fakeCrypto);
  assert.throws(() => secrets.save('not-a-jwt'), /JWT/);
});

test('loading with no token saved returns null', () => {
  store.setPath(tmp());
  secrets.setCrypto(fakeCrypto);
  assert.strictEqual(secrets.load(), null);
});

test('clear removes the token', () => {
  store.setPath(tmp());
  secrets.setCrypto(fakeCrypto);
  secrets.save(JWT);
  secrets.clear();
  assert.strictEqual(secrets.load(), null);
});

test('an undecryptable blob loads as null rather than throwing', () => {
  store.setPath(tmp());
  secrets.setCrypto({
    isEncryptionAvailable: () => true,
    encryptString: (s) => Buffer.from(s),
    decryptString: () => { throw new Error('DPAPI failure'); },
  });
  secrets.save(JWT);
  assert.strictEqual(secrets.load(), null);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test`
Expected: FAIL — `Cannot find module '../main/secrets'`

- [ ] **Step 3: Write the implementation**

Create `main/secrets.js`:

```js
const store = require('./store');

let crypto = null;

// Injected so tests need no Electron. main/index.js passes safeStorage.
function setCrypto(impl) {
  crypto = impl;
}

function api() {
  if (crypto) return crypto;
  crypto = require('electron').safeStorage;
  return crypto;
}

// The API returns 401 "invalid JWT format: expected 3 parts, got 1" for a
// malformed token. Checking the shape here turns a paste error into an
// immediate message instead of a silent empty dashboard.
function looksLikeJwt(s) {
  if (typeof s !== 'string') return false;
  const parts = s.trim().split('.');
  return parts.length === 3 && parts.every((p) => p.length > 0);
}

function save(token) {
  const t = typeof token === 'string' ? token.trim() : token;
  if (!looksLikeJwt(t)) throw new Error('That does not look like a JWT API token.');
  if (!api().isEncryptionAvailable()) {
    throw new Error('OS encryption is unavailable, refusing to store the token.');
  }
  const blob = api().encryptString(t).toString('base64');
  store.save({ ...store.load(), token: blob });
}

function load() {
  const blob = store.load().token;
  if (!blob) return null;
  try {
    return api().decryptString(Buffer.from(blob, 'base64'));
  } catch {
    // Blob written by another OS user, or DPAPI keys rotated. Treat as absent
    // so the app re-prompts rather than wedging on an unreadable secret.
    return null;
  }
}

function clear() {
  store.save({ ...store.load(), token: null });
}

module.exports = { setCrypto, looksLikeJwt, save, load, clear };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test`
Expected: PASS, 14 tests total.

- [ ] **Step 5: Commit**

```bash
git add main/secrets.js test/secrets.test.js
git commit -m "feat: encrypted token storage via safeStorage"
```

---

### Task 3: RRULE expansion (pure)

**Files:**
- Create: `main/rrule.js`
- Test: `test/rrule.test.js`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `rrule.occurrences(rule, seedISO, fromISO, toISO) -> string[]` — `YYYY-MM-DD` dates, ascending, inclusive of both bounds. `rule` may be `null`/`undefined`, in which case the seed date itself is the only occurrence.
  - `rrule.upcoming(orders, fromISO, toISO) -> Array<{date, orderId, name, amount, type, signed, accountId, categoryId}>` — every standing order expanded and flattened, sorted by date. `signed` is negative for `type: 'expense'`, positive for `'income'`.

Supported rule parts: `FREQ` (DAILY, WEEKLY, MONTHLY, YEARLY), `INTERVAL`, `BYMONTHDAY`, `UNTIL`, `COUNT`. This covers every rule present in the account.

- [ ] **Step 1: Write the failing test**

Create `test/rrule.test.js`:

```js
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test`
Expected: FAIL — `Cannot find module '../main/rrule'`

- [ ] **Step 3: Write the implementation**

Create `main/rrule.js`:

```js
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
      if (ms >= seed && !push(ms)) break;
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test`
Expected: PASS, 31 tests total.

- [ ] **Step 5: Commit**

```bash
git add main/rrule.js test/rrule.test.js
git commit -m "feat: RRULE expansion for standing orders"
```

---

### Task 4: API client

**Files:**
- Create: `main/api.js`
- Test: `test/api.test.js`

**Interfaces:**
- Consumes: nothing (token is passed in).
- Produces: a factory `createApi({ token, fetchImpl }) -> client` with:
  - `client.budgets() -> Promise<Array>` — `GET /budgets?spending=current+2&limit=20`
  - `client.standingOrders() -> Promise<Array>` — `GET /standing-orders?limit=200`
  - `client.accounts() -> Promise<Array>` — `GET /accounts?limit=20`
  - `client.records({ from, to, categoryId }) -> Promise<Array>` — paged, `convertTo=EUR`
  - `client.rateLimit() -> { remaining, limit }` — from the most recent response headers
  - Errors thrown carry `.status`; 401 becomes `new Error('unauthorized')` with `.status = 401`.

`fetchImpl` defaults to global `fetch` (Node 18+ and Electron both provide it) and is injected in tests.

- [ ] **Step 1: Write the failing test**

Create `test/api.test.js`:

```js
const { test } = require('node:test');
const assert = require('node:assert');
const { createApi } = require('../main/api');

// Minimal fetch double. `routes` maps a URL substring to a response spec.
function fakeFetch(routes, log = []) {
  return async (url, opts) => {
    log.push({ url, opts });
    for (const [needle, spec] of Object.entries(routes)) {
      if (url.includes(needle)) {
        return {
          ok: spec.status === undefined || spec.status < 400,
          status: spec.status ?? 200,
          headers: new Map(Object.entries(spec.headers ?? {})),
          json: async () => spec.body,
          text: async () => JSON.stringify(spec.body),
        };
      }
    }
    throw new Error(`unexpected url ${url}`);
  };
}

test('the bearer token is sent in the Authorization header', async () => {
  const log = [];
  const api = createApi({ token: 'a.b.c', fetchImpl: fakeFetch({ '/accounts': { body: { accounts: [] } } }, log) });
  await api.accounts();
  assert.strictEqual(log[0].opts.headers.Authorization, 'Bearer a.b.c');
});

test('budgets requests the precomputed spending window', async () => {
  const log = [];
  const api = createApi({ token: 'a.b.c', fetchImpl: fakeFetch({ '/budgets': { body: { budgets: [{ id: 'b' }] } } }, log) });
  const r = await api.budgets();
  assert.ok(log[0].url.includes('spending=current%2B2') || log[0].url.includes('spending=current+2'));
  assert.deepStrictEqual(r, [{ id: 'b' }]);
});

test('records asks the server to convert to EUR', async () => {
  const log = [];
  const api = createApi({ token: 'a.b.c', fetchImpl: fakeFetch({ '/records': { body: { records: [] } } }, log) });
  await api.records({ from: '2026-09-01', to: '2026-09-30' });
  assert.ok(log[0].url.includes('convertTo=EUR'));
  assert.ok(log[0].url.includes('recordDate=gte.2026-09-01'));
  assert.ok(log[0].url.includes('recordDate=lte.2026-09-30'));
});

test('records pages until a short page arrives', async () => {
  const full = Array.from({ length: 200 }, (_, i) => ({ id: `r${i}` }));
  let call = 0;
  const api = createApi({
    token: 'a.b.c',
    fetchImpl: async (url) => {
      call += 1;
      const body = { records: call === 1 ? full : [{ id: 'last' }] };
      return { ok: true, status: 200, headers: new Map(), json: async () => body };
    },
  });
  const r = await api.records({ from: '2026-09-01', to: '2026-09-30' });
  assert.strictEqual(r.length, 201);
  assert.strictEqual(call, 2);
});

test('a 401 throws an unauthorized error carrying the status', async () => {
  const api = createApi({ token: 'a.b.c', fetchImpl: fakeFetch({ '/accounts': { status: 401, body: {} } }) });
  await assert.rejects(() => api.accounts(), (e) => e.status === 401 && /unauthorized/.test(e.message));
});

test('a 500 throws and carries the status', async () => {
  const api = createApi({ token: 'a.b.c', fetchImpl: fakeFetch({ '/accounts': { status: 500, body: {} } }) });
  await assert.rejects(() => api.accounts(), (e) => e.status === 500);
});

test('rate limit headers are recorded from the last response', async () => {
  const api = createApi({
    token: 'a.b.c',
    fetchImpl: fakeFetch({ '/accounts': { body: { accounts: [] }, headers: { 'x-ratelimit-remaining-hour': '271', 'x-ratelimit-limit-hour': '450' } } }),
  });
  await api.accounts();
  assert.deepStrictEqual(api.rateLimit(), { remaining: 271, limit: 450 });
});

test('a response with no rate limit headers leaves the previous reading alone', async () => {
  const api = createApi({ token: 'a.b.c', fetchImpl: fakeFetch({ '/accounts': { body: { accounts: [] } } }) });
  await api.accounts();
  assert.deepStrictEqual(api.rateLimit(), { remaining: null, limit: null });
});

test('a list response under an unexpected key still yields an array', async () => {
  const api = createApi({ token: 'a.b.c', fetchImpl: fakeFetch({ '/standing-orders': { body: { results: [{ id: 's' }] } } }) });
  assert.deepStrictEqual(await api.standingOrders(), [{ id: 's' }]);
});

test('records accepts a category filter', async () => {
  const log = [];
  const api = createApi({ token: 'a.b.c', fetchImpl: fakeFetch({ '/records': { body: { records: [] } } }, log) });
  await api.records({ from: '2026-09-01', to: '2026-09-30', categoryId: 'cat1,cat2' });
  assert.ok(log[0].url.includes('categoryId=cat1%2Ccat2'));
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test`
Expected: FAIL — `Cannot find module '../main/api'`

- [ ] **Step 3: Write the implementation**

Create `main/api.js`:

```js
const BASE = 'https://rest.budgetbakers.com/wallet/v1/api';
const PAGE = 200; // the documented maximum for limit

// Responses wrap their list under a type-specific key (budgets, accounts,
// records, ...) and standing orders use `results`. Rather than hardcode each,
// take the first array-valued property.
function firstArray(body) {
  if (Array.isArray(body)) return body;
  for (const v of Object.values(body || {})) if (Array.isArray(v)) return v;
  return [];
}

function createApi({ token, fetchImpl }) {
  const doFetch = fetchImpl || globalThis.fetch;
  let remaining = null;
  let limit = null;

  async function get(path, params = {}) {
    const url = new URL(BASE + path);
    for (const [k, v] of Object.entries(params)) {
      if (v === undefined || v === null) continue;
      if (Array.isArray(v)) v.forEach((x) => url.searchParams.append(k, x));
      else url.searchParams.append(k, v);
    }

    const res = await doFetch(url.toString(), {
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
    });

    const hdr = (n) => (res.headers && typeof res.headers.get === 'function' ? res.headers.get(n) : null);
    const rem = hdr('x-ratelimit-remaining-hour');
    const lim = hdr('x-ratelimit-limit-hour');
    if (rem !== null && rem !== undefined) remaining = Number(rem);
    if (lim !== null && lim !== undefined) limit = Number(lim);

    if (!res.ok) {
      const err = new Error(res.status === 401 ? 'unauthorized' : `request failed (${res.status})`);
      err.status = res.status;
      throw err;
    }
    return firstArray(await res.json());
  }

  async function paged(path, params) {
    const all = [];
    for (let offset = 0; ; offset += PAGE) {
      const page = await get(path, { ...params, limit: PAGE, offset });
      all.push(...page);
      // A short page means the end; no total is needed to know we are done.
      if (page.length < PAGE) return all;
    }
  }

  return {
    budgets: () => get('/budgets', { spending: 'current+2', limit: 20 }),
    standingOrders: () => get('/standing-orders', { limit: PAGE }),
    accounts: () => get('/accounts', { limit: 20 }),
    records: ({ from, to, categoryId }) => paged('/records', {
      recordDate: [`gte.${from}`, `lte.${to}`],
      categoryId,
      convertTo: 'EUR',
      sortBy: '-recordDate',
    }),
    rateLimit: () => ({ remaining, limit }),
  };
}

module.exports = { createApi, BASE };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test`
Expected: PASS, 41 tests total.

- [ ] **Step 5: Commit**

```bash
git add main/api.js test/api.test.js
git commit -m "feat: Wallet REST API client with paging and rate-limit accounting"
```

---

### Task 5: Forecast (pure) — the core

**Files:**
- Create: `main/forecast.js`
- Test: `test/forecast.test.js`

**Interfaces:**
- Consumes: `rrule.upcoming` from Task 3.
- Produces:
  - `forecast.inScope(budget, item) -> boolean` — AND across `accountIds`/`categoryIds`/`labelIds`; an empty array means unconstrained.
  - `forecast.isRecurring(record, orders) -> boolean` — attribution heuristic.
  - `forecast.discretionaryRate(records, orders, days) -> number` — mean daily non-recurring expense magnitude, EUR/day, always >= 0.
  - `forecast.projectBudget(budget, orders, records, todayISO) -> { spent, scheduled, discretionary, projected, limit, ratio, overshoot }`
  - `forecast.runway(records, orders, startBalance, periodStartISO, periodEndISO, todayISO) -> { actual: [{date, balance}], projected: [{date, balance}], end }`

All money values are EUR. `spent`, `scheduled`, `discretionary`, `projected` and `limit` are positive magnitudes on budgets; `runway` balances are signed.

- [ ] **Step 1: Write the failing test**

Create `test/forecast.test.js`:

```js
const { test } = require('node:test');
const assert = require('node:assert');
const f = require('../main/forecast');

const budget = (over) => ({
  id: 'b1', name: 'test', limit: 300,
  accountIds: [], categoryIds: [], labelIds: [],
  spending: { current: { spent: 100, effectiveLimit: 300, periodStart: '2026-09-01', periodEnd: '2026-09-30' } },
  ...over,
});

// Records carry SIGNED convertedAmount: expenses negative.
const rec = (amount, over = {}) => ({
  id: `r${Math.random()}`, convertedAmount: amount, amount,
  recordDate: '2026-09-10T12:00:00Z', accountId: 'a1',
  category: { id: 'c1' }, labels: [], recordType: amount < 0 ? 'expense' : 'income',
  transfer: null, ...over,
});

const order = (over) => ({
  id: 'o1', name: 'Rent', amount: 50, type: 'expense',
  accountId: 'a1', categoryId: 'c1',
  generateFromDate: '2026-08-01', recurrenceRule: 'FREQ=MONTHLY;INTERVAL=1;BYMONTHDAY=25',
  ...over,
});

// ---------------------------------------------------------------- inScope

test('an unconstrained budget matches anything', () => {
  assert.strictEqual(f.inScope(budget(), { accountId: 'x', categoryId: 'y', labels: [] }), true);
});

test('an account-scoped budget rejects other accounts', () => {
  const b = budget({ accountIds: ['a1'] });
  assert.strictEqual(f.inScope(b, { accountId: 'a1' }), true);
  assert.strictEqual(f.inScope(b, { accountId: 'a2' }), false);
});

test('scope dimensions combine with AND, not OR', () => {
  const b = budget({ accountIds: ['a1'], categoryIds: ['c1'] });
  assert.strictEqual(f.inScope(b, { accountId: 'a1', categoryId: 'c1' }), true);
  assert.strictEqual(f.inScope(b, { accountId: 'a1', categoryId: 'c9' }), false);
  assert.strictEqual(f.inScope(b, { accountId: 'a9', categoryId: 'c1' }), false);
});

test('a label-scoped budget matches any one of the item labels', () => {
  const b = budget({ labelIds: ['L1'] });
  assert.strictEqual(f.inScope(b, { labels: [{ id: 'L0' }, { id: 'L1' }] }), true);
  assert.strictEqual(f.inScope(b, { labels: [{ id: 'L0' }] }), false);
});

test('a record nests its category under category.id', () => {
  const b = budget({ categoryIds: ['c1'] });
  assert.strictEqual(f.inScope(b, rec(-10)), true);
});

// ------------------------------------------------------------ isRecurring

test('a record matching an order amount, account and date is recurring', () => {
  const o = order({ amount: 50 });
  assert.strictEqual(f.isRecurring(rec(-50, { recordDate: '2026-09-25T09:00:00Z' }), [o]), true);
});

test('a record three days off a scheduled date still counts as that payment', () => {
  const o = order({ amount: 50 });
  assert.strictEqual(f.isRecurring(rec(-50, { recordDate: '2026-09-27T09:00:00Z' }), [o]), true);
});

test('a record four days off a scheduled date is not attributed', () => {
  const o = order({ amount: 50 });
  assert.strictEqual(f.isRecurring(rec(-50, { recordDate: '2026-09-29T09:00:00Z' }), [o]), false);
});

test('a different amount on the right day is not attributed', () => {
  const o = order({ amount: 50 });
  assert.strictEqual(f.isRecurring(rec(-80, { recordDate: '2026-09-25T09:00:00Z' }), [o]), false);
});

test('amounts within one percent are treated as the same payment', () => {
  const o = order({ amount: 100 });
  assert.strictEqual(f.isRecurring(rec(-100.5, { recordDate: '2026-09-25T09:00:00Z' }), [o]), true);
});

test('a different account on the right day and amount is not attributed', () => {
  const o = order({ amount: 50, accountId: 'other' });
  assert.strictEqual(f.isRecurring(rec(-50, { recordDate: '2026-09-25T09:00:00Z' }), [o]), false);
});

// ------------------------------------------------------- discretionaryRate

test('the discretionary rate averages non-recurring expenses over the window', () => {
  const rs = [rec(-30), rec(-60)];
  assert.strictEqual(f.discretionaryRate(rs, [], 30), 3);
});

test('income is excluded from the discretionary rate', () => {
  const rs = [rec(-30), rec(900)];
  assert.strictEqual(f.discretionaryRate(rs, [], 30), 1);
});

test('records attributable to standing orders are excluded', () => {
  const o = order({ amount: 50 });
  const rs = [rec(-30), rec(-50, { recordDate: '2026-09-25T09:00:00Z' })];
  assert.strictEqual(f.discretionaryRate(rs, [o], 30), 1);
});

test('transfers are excluded from the discretionary rate', () => {
  const rs = [rec(-30), rec(-500, { transfer: { id: 't1' } })];
  assert.strictEqual(f.discretionaryRate(rs, [], 30), 1);
});

test('a zero-day window yields a zero rate rather than dividing by zero', () => {
  assert.strictEqual(f.discretionaryRate([rec(-30)], [], 0), 0);
});

test('no records yields a zero rate', () => {
  assert.strictEqual(f.discretionaryRate([], [], 30), 0);
});

// -------------------------------------------------------- projectBudget

test('a mid-period burn rate extrapolates to the period end', () => {
  // 100 spent over 10 elapsed days of 30 => 10/day => 300 projected.
  const b = budget({ spending: { current: { spent: 100, effectiveLimit: 300, periodStart: '2026-09-01', periodEnd: '2026-09-30' } } });
  const r = f.projectBudget(b, [], [rec(-100, { recordDate: '2026-09-05T12:00:00Z' })], '2026-09-10');
  assert.strictEqual(r.spent, 100);
  assert.strictEqual(Math.round(r.projected), 300);
  assert.strictEqual(Math.round(r.ratio * 100), 100);
});

test('a scheduled-only budget is projected from its known payments, not a daily rate', () => {
  // The `subscriptions` case: all spending is standing orders. A naive daily
  // rate would overstate it; the remaining scheduled charge is known exactly.
  const o = order({ amount: 20, recurrenceRule: 'FREQ=MONTHLY;INTERVAL=1;BYMONTHDAY=25' });
  const paid = rec(-20, { recordDate: '2026-08-25T09:00:00Z' });
  const b = budget({ limit: 100, spending: { current: { spent: 20, effectiveLimit: 100, periodStart: '2026-09-01', periodEnd: '2026-09-30' } } });
  const r = f.projectBudget(b, [o], [paid], '2026-09-10');
  assert.strictEqual(r.discretionary, 0);
  assert.strictEqual(r.scheduled, 20);
  assert.strictEqual(r.projected, 40);
});

test('projection combines spent, scheduled and discretionary', () => {
  const o = order({ amount: 50, recurrenceRule: 'FREQ=MONTHLY;INTERVAL=1;BYMONTHDAY=25' });
  const rs = [rec(-100, { recordDate: '2026-09-05T12:00:00Z' })];
  const b = budget({ limit: 500, spending: { current: { spent: 100, effectiveLimit: 500, periodStart: '2026-09-01', periodEnd: '2026-09-30' } } });
  const r = f.projectBudget(b, [o], rs, '2026-09-10');
  // spent 100 + scheduled 50 + discretionary (100/10 * 20 = 200) = 350
  assert.strictEqual(r.scheduled, 50);
  assert.strictEqual(Math.round(r.discretionary), 200);
  assert.strictEqual(Math.round(r.projected), 350);
});

test('overshoot is the projected excess over the effective limit, or zero', () => {
  const under = f.projectBudget(
    budget({ spending: { current: { spent: 10, effectiveLimit: 300, periodStart: '2026-09-01', periodEnd: '2026-09-30' } } }),
    [], [rec(-10, { recordDate: '2026-09-05T12:00:00Z' })], '2026-09-10');
  assert.strictEqual(under.overshoot, 0);

  const over = f.projectBudget(
    budget({ spending: { current: { spent: 200, effectiveLimit: 300, periodStart: '2026-09-01', periodEnd: '2026-09-30' } } }),
    [], [rec(-200, { recordDate: '2026-09-05T12:00:00Z' })], '2026-09-10');
  assert.ok(over.overshoot > 0);
});

test('the effective limit is preferred over the plain limit', () => {
  const b = budget({ limit: 999, spending: { current: { spent: 10, effectiveLimit: 300, periodStart: '2026-09-01', periodEnd: '2026-09-30' } } });
  assert.strictEqual(f.projectBudget(b, [], [], '2026-09-10').limit, 300);
});

test('the first day of a period does not divide by zero', () => {
  const b = budget({ spending: { current: { spent: 5, effectiveLimit: 300, periodStart: '2026-09-01', periodEnd: '2026-09-30' } } });
  const r = f.projectBudget(b, [], [rec(-5, { recordDate: '2026-09-01T12:00:00Z' })], '2026-09-01');
  assert.ok(Number.isFinite(r.projected), 'projection must be finite on day one');
});

test('a weekly period projects over its own seven days', () => {
  // 40 spent over 4 elapsed days of a 7-day period => 10/day => 70.
  const b = budget({ spending: { current: { spent: 40, effectiveLimit: 150, periodStart: '2026-09-14', periodEnd: '2026-09-20' } } });
  const r = f.projectBudget(b, [], [rec(-40, { recordDate: '2026-09-15T12:00:00Z' })], '2026-09-17');
  assert.strictEqual(Math.round(r.projected), 70);
});

test('a budget with no spending block projects as zero rather than throwing', () => {
  const r = f.projectBudget({ id: 'x', limit: 100, accountIds: [], categoryIds: [], labelIds: [] }, [], [], '2026-09-10');
  assert.strictEqual(r.projected, 0);
  assert.strictEqual(r.spent, 0);
});

test('a period already ended projects to exactly what was spent', () => {
  const b = budget({ spending: { current: { spent: 250, effectiveLimit: 300, periodStart: '2026-08-01', periodEnd: '2026-08-31' } } });
  const r = f.projectBudget(b, [], [], '2026-09-10');
  assert.strictEqual(r.projected, 250);
});

// --------------------------------------------------------------- runway

test('the runway walks actual balance forward day by day', () => {
  const rs = [rec(-10, { recordDate: '2026-09-02T12:00:00Z' }), rec(-5, { recordDate: '2026-09-03T12:00:00Z' })];
  const r = f.runway(rs, [], 100, '2026-09-01', '2026-09-05', '2026-09-03');
  assert.deepStrictEqual(r.actual.map((p) => p.balance), [100, 90, 85]);
  assert.deepStrictEqual(r.actual.map((p) => p.date), ['2026-09-01', '2026-09-02', '2026-09-03']);
});

test('the projected leg starts from the last actual balance', () => {
  const r = f.runway([], [], 100, '2026-09-01', '2026-09-05', '2026-09-03');
  assert.strictEqual(r.projected[0].date, '2026-09-03');
  assert.strictEqual(r.projected[0].balance, 100);
});

test('a scheduled income raises the projected balance on its date', () => {
  const o = order({ type: 'income', amount: 500, recurrenceRule: 'FREQ=MONTHLY;INTERVAL=1;BYMONTHDAY=4' });
  const r = f.runway([], [o], 100, '2026-09-01', '2026-09-05', '2026-09-03');
  assert.strictEqual(r.end, 600);
});

test('a scheduled expense lowers the projected balance on its date', () => {
  const o = order({ type: 'expense', amount: 40, recurrenceRule: 'FREQ=MONTHLY;INTERVAL=1;BYMONTHDAY=4' });
  const r = f.runway([], [o], 100, '2026-09-01', '2026-09-05', '2026-09-03');
  assert.strictEqual(r.end, 60);
});

test('the projected leg reaches the period end date', () => {
  const r = f.runway([], [], 100, '2026-09-01', '2026-09-30', '2026-09-18');
  assert.strictEqual(r.projected[r.projected.length - 1].date, '2026-09-30');
});

test('a today past the period end yields no projected leg beyond the end', () => {
  const r = f.runway([], [], 100, '2026-09-01', '2026-09-05', '2026-09-20');
  assert.strictEqual(r.projected.length, 1);
  assert.strictEqual(r.end, r.actual[r.actual.length - 1].balance);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test`
Expected: FAIL — `Cannot find module '../main/forecast'`

- [ ] **Step 3: Write the implementation**

Create `main/forecast.js`:

```js
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

function signedOf(record) {
  const v = record.convertedAmount;
  return Number(v === undefined || v === null ? record.amount : v) || 0;
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
    return { spent: 0, scheduled: 0, discretionary: 0, projected: 0, limit, ratio: 0, overshoot: 0 };
  }

  const start = cur.periodStart;
  const end = cur.periodEnd;
  const today = todayISO;

  // Elapsed counts today as a day in progress, so day one divides by 1, not 0.
  const elapsed = Math.max(1, Math.round((dayOf(today) - dayOf(start)) / DAY) + 1);
  const remaining = Math.max(0, Math.round((dayOf(end) - dayOf(today)) / DAY));

  if (remaining === 0) {
    const ratio = limit > 0 ? spent / limit : 0;
    return { spent, scheduled: 0, discretionary: 0, projected: spent, limit, ratio, overshoot: Math.max(0, spent - limit) };
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
  const discretionary = discretionaryRate(scopedRecords, orders, elapsed) * remaining;

  const projected = spent + scheduled + discretionary;
  const ratio = limit > 0 ? projected / limit : 0;

  return {
    spent,
    scheduled,
    discretionary,
    projected,
    limit,
    ratio,
    overshoot: Math.max(0, projected - limit),
  };
}

// Daily balance series: measured up to today, arithmetic from today to the
// period end. startBalance is the balance as of periodStart.
function runway(records, orders, startBalance, periodStartISO, periodEndISO, todayISO) {
  const start = dayOf(periodStartISO);
  const end = dayOf(periodEndISO);
  const today = Math.min(dayOf(todayISO), end);

  const perDay = new Map();
  for (const r of records || []) {
    if (r.transfer) continue;
    const d = fmt(dayOf(r.recordDate));
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

  const projected = [{ date: fmt(today), balance: actual.length ? actual[actual.length - 1].balance : balance }];
  let p = projected[0].balance;
  for (let ms = today + DAY; ms <= end; ms += DAY) {
    const d = fmt(ms);
    p += events.get(d) || 0;
    projected.push({ date: d, balance: Math.round(p * 100) / 100 });
  }

  return { actual, projected, end: projected[projected.length - 1].balance };
}

module.exports = { inScope, isRecurring, discretionaryRate, projectBudget, runway };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test`
Expected: PASS, 74 tests total.

- [ ] **Step 5: Verify against real data**

Create `test/forecast.live.test.js` using the captured snapshot committed in Task 7's fixture step. Until that fixture exists, skip this step and return to it after Task 7.

- [ ] **Step 6: Commit**

```bash
git add main/forecast.js test/forecast.test.js
git commit -m "feat: arithmetic budget projection and balance runway"
```

---

### Task 6: Alert decisions (pure)

**Files:**
- Create: `main/alerts.js`
- Test: `test/alerts.test.js`

**Interfaces:**
- Consumes: `rrule.upcoming` from Task 3.
- Produces: `alerts.decide(snapshot, notified, todayISO) -> { fire: Array<{key, title, body}>, notified: object }`

`notified` is an opaque map of keys to `true` (plus `digest:<date>` entries), persisted in `state.json`. `decide` is pure: it returns the alerts to fire and the updated map, and never fires anything itself.

Key formats — a stable key is what makes suppression work across polls:
- `order:<orderId>:<YYYY-MM-DD>:due`
- `order:<orderId>:<YYYY-MM-DD>:3day`
- `budget:<budgetId>:<periodStart>:80` and `:100`
- `digest:<YYYY-MM-DD>`

- [ ] **Step 1: Write the failing test**

Create `test/alerts.test.js`:

```js
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test`
Expected: FAIL — `Cannot find module '../main/alerts'`

- [ ] **Step 3: Write the implementation**

Create `main/alerts.js`:

```js
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test`
Expected: PASS, 90 tests total.

- [ ] **Step 5: Commit**

```bash
git add main/alerts.js test/alerts.test.js
git commit -m "feat: notification decisions with per-period suppression"
```

---

### Task 7: Snapshot assembly and polling

**Files:**
- Create: `main/snapshot.js`
- Create: `main/poll.js`
- Create: `main/notify.js`
- Test: `test/snapshot.test.js`

**Interfaces:**
- Consumes: `createApi` (Task 4), `forecast` (Task 5), `alerts` (Task 6), `store` (Task 1).
- Produces:
  - `snapshot.build(raw, todayISO) -> snapshot` where `raw = { budgets, orders, accounts, records, uncategorized }`. Pure.
  - `poll.start({ api, onSnapshot, onError, intervalMs })` / `poll.stop()` / `poll.refreshNow()`
  - `notify.fire(alerts)` — thin Electron wrapper, untested.

Snapshot shape consumed by the renderer:

```js
{
  generatedAt: '2026-09-18T11:00:00.000Z',
  today: '2026-09-18',
  budgets: [{ id, name, period, periodStart, periodEnd, spent, limit, progress,
              projected, ratio, overshoot, scheduled, discretionary }],
  runway: { actual: [{date, balance}], projected: [{date, balance}], end },
  upcoming: [{ date, orderId, name, amount, type, signed }],
  uncategorized: [{ id, date, amount, counterParty, accountName }],
  sync: [{ id, name, lastRecord, ageDays, error, stale }],
  orders: [...raw orders, for alerts],
  rateLimit: { remaining, limit }
}
```

The fixed uncategorized category IDs, which are identical for every Wallet account:

```js
const UNCATEGORIZED = [
  '5c5c32c8-0082-8000-8000-000000000000', // Unknown income
  '5c5c32c9-0082-8000-8000-000000000000', // Unknown expense
  '5c5c4e23-00c8-8000-8000-000000000000', // Uncategorized
];
```

- [ ] **Step 1: Capture a real fixture**

With a valid token exported as `WALLET_TOKEN`, run:

```bash
mkdir -p test/fixtures
node -e '
const { createApi } = require("./main/api");
const api = createApi({ token: process.env.WALLET_TOKEN });
(async () => {
  const [budgets, orders, accounts] = await Promise.all([
    api.budgets(), api.standingOrders(), api.accounts(),
  ]);
  const records = await api.records({ from: "2026-06-01", to: "2026-09-30" });
  require("fs").writeFileSync("test/fixtures/live.json",
    JSON.stringify({ budgets, orders, accounts, records }, null, 2));
  console.log("budgets", budgets.length, "orders", orders.length,
              "accounts", accounts.length, "records", records.length);
})();
'
```

Then scrub identifying detail before committing: replace `bankAccountNumber` values with `""` and `counterParty` values with generic strings. The fixture exists to pin the *shape* and the arithmetic, not to archive account numbers.

- [ ] **Step 2: Write the failing test**

Create `test/snapshot.test.js`:

```js
const { test } = require('node:test');
const assert = require('node:assert');
const { build, UNCATEGORIZED } = require('../main/snapshot');

const raw = (over) => ({
  budgets: [], orders: [], accounts: [], records: [], uncategorized: [], ...over,
});

const budget = (over) => ({
  id: 'b1', name: 'per:total', accountIds: [], categoryIds: [], labelIds: [],
  type: 'BUDGET_INTERVAL_MONTH',
  spending: { current: { spent: 200, effectiveLimit: 400, progress: 0.5, periodStart: '2026-09-01', periodEnd: '2026-09-30' } },
  ...over,
});

test('a snapshot carries the date it was built for', () => {
  const s = build(raw(), '2026-09-18');
  assert.strictEqual(s.today, '2026-09-18');
  assert.ok(s.generatedAt);
});

test('each budget gains its projection alongside its reported spending', () => {
  const s = build(raw({ budgets: [budget()], records: [
    { id: 'r1', convertedAmount: -200, recordDate: '2026-09-05T12:00:00Z', accountId: 'a1', category: { id: 'c1' }, labels: [] },
  ] }), '2026-09-18');
  assert.strictEqual(s.budgets[0].spent, 200);
  assert.ok(s.budgets[0].projected > 200, 'projection extends past current spend');
  assert.strictEqual(s.budgets[0].limit, 400);
});

test('budgets sort by projected overshoot, worst first', () => {
  const safe = budget({ id: 'safe', name: 'safe', spending: { current: { spent: 10, effectiveLimit: 1000, periodStart: '2026-09-01', periodEnd: '2026-09-30' } } });
  const bad = budget({ id: 'bad', name: 'bad', spending: { current: { spent: 900, effectiveLimit: 1000, periodStart: '2026-09-01', periodEnd: '2026-09-30' } } });
  const records = [
    { id: 'r1', convertedAmount: -10, recordDate: '2026-09-05T12:00:00Z', accountId: 'a1', category: { id: 'c1' }, labels: [] },
    { id: 'r2', convertedAmount: -900, recordDate: '2026-09-05T12:00:00Z', accountId: 'a1', category: { id: 'c1' }, labels: [] },
  ];
  const s = build(raw({ budgets: [safe, bad], records }), '2026-09-18');
  assert.strictEqual(s.budgets[0].id, 'bad');
});

test('sync rows flag a bank account whose newest record is old', () => {
  const accounts = [{
    id: 'a1', name: 'Revolut', isBankSync: true,
    balance: { currentBalance: 100 },
    recordStats: { recordDate: { max: '2026-09-12T00:00:00Z' }, error: null },
  }];
  const s = build(raw({ accounts }), '2026-09-18');
  assert.strictEqual(s.sync[0].ageDays, 6);
  assert.strictEqual(s.sync[0].stale, true);
});

test('a freshly synced bank account is not flagged stale', () => {
  const accounts = [{
    id: 'a1', name: 'Revolut', isBankSync: true,
    balance: { currentBalance: 100 },
    recordStats: { recordDate: { max: '2026-09-17T00:00:00Z' }, error: null },
  }];
  assert.strictEqual(build(raw({ accounts }), '2026-09-18').sync[0].stale, false);
});

test('accounts without bank sync are left out of the sync panel', () => {
  const accounts = [{ id: 'a1', name: 'Cash', isBankSync: false, balance: { currentBalance: 5 }, recordStats: {} }];
  assert.deepStrictEqual(build(raw({ accounts }), '2026-09-18').sync, []);
});

test('a sync error is surfaced even when records are recent', () => {
  const accounts = [{
    id: 'a1', name: 'Revolut', isBankSync: true,
    balance: { currentBalance: 100 },
    recordStats: { recordDate: { max: '2026-09-18T00:00:00Z' }, error: 'consent expired' },
  }];
  assert.strictEqual(build(raw({ accounts }), '2026-09-18').sync[0].error, 'consent expired');
});

test('the uncategorized list is flattened for display', () => {
  const uncategorized = [{
    id: 'r1', convertedAmount: -12.4, recordDate: '2026-09-17T10:00:00Z',
    counterParty: 'LIDL', accountName: 'Revolut',
  }];
  const s = build(raw({ uncategorized }), '2026-09-18');
  assert.deepStrictEqual(s.uncategorized[0], {
    id: 'r1', date: '2026-09-17', amount: -12.4, counterParty: 'LIDL', accountName: 'Revolut',
  });
});

test('the upcoming list covers the next thirty days', () => {
  const orders = [{
    id: 'o1', name: 'Payday', amount: 926.61, type: 'income',
    accountId: 'a1', categoryId: 'c1', generateFromDate: '2026-08-01',
    recurrenceRule: 'FREQ=MONTHLY;INTERVAL=1;BYMONTHDAY=20',
  }];
  const s = build(raw({ orders }), '2026-09-18');
  assert.strictEqual(s.upcoming[0].date, '2026-09-20');
  assert.strictEqual(s.upcoming[0].signed, 926.61);
});

test('the runway starts from the summed account balances', () => {
  const accounts = [
    { id: 'a1', name: 'A', isBankSync: false, balance: { currentBalance: 60 }, recordStats: {} },
    { id: 'a2', name: 'B', isBankSync: false, balance: { currentBalance: 40 }, recordStats: {} },
  ];
  const s = build(raw({ accounts }), '2026-09-18');
  // Current balance already reflects the month's records, so the series must
  // end at today on that total rather than starting from it.
  const atToday = s.runway.actual[s.runway.actual.length - 1];
  assert.strictEqual(atToday.balance, 100);
});

test('the three uncategorized category ids are exported for the records query', () => {
  assert.strictEqual(UNCATEGORIZED.length, 3);
  assert.ok(UNCATEGORIZED.includes('5c5c4e23-00c8-8000-8000-000000000000'));
});

test('an empty account produces a snapshot rather than throwing', () => {
  const s = build(raw(), '2026-09-18');
  assert.deepStrictEqual(s.budgets, []);
  assert.deepStrictEqual(s.upcoming, []);
  assert.ok(s.runway);
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npm test`
Expected: FAIL — `Cannot find module '../main/snapshot'`

- [ ] **Step 4: Write `main/snapshot.js`**

```js
const { upcoming } = require('./rrule');
const { projectBudget, runway } = require('./forecast');

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
    .reduce((sum, r) => sum + (Number(r.convertedAmount ?? r.amount) || 0), 0);
  const opening = total - monthNet;

  const sync = accounts
    .filter((a) => a.isBankSync)
    .map((a) => {
      const last = a.recordStats && a.recordStats.recordDate && a.recordStats.recordDate.max;
      const ageDays = last ? Math.round((dayOf(todayISO) - dayOf(last)) / DAY) : null;
      return {
        id: a.id,
        name: a.name,
        lastRecord: last ? fmt(dayOf(last)) : null,
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
    uncategorized: uncategorized.map((r) => ({
      id: r.id,
      date: fmt(dayOf(r.recordDate)),
      amount: Number(r.convertedAmount ?? r.amount) || 0,
      counterParty: r.counterParty || '',
      accountName: r.accountName || '',
    })),
    sync,
    orders,
    rateLimit: rawData.rateLimit || { remaining: null, limit: null },
  };
}

module.exports = { build, UNCATEGORIZED, monthBounds };
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npm test`
Expected: PASS, 102 tests total.

- [ ] **Step 6: Write `main/poll.js`** (no test — it is a timer around tested parts)

```js
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
```

- [ ] **Step 7: Write `main/notify.js`** (no test — a thin Electron wrapper)

```js
const { Notification } = require('electron');

function fire(alerts) {
  for (const a of alerts) {
    if (!Notification.isSupported()) return;
    new Notification({ title: a.title, body: a.body }).show();
  }
}

module.exports = { fire };
```

- [ ] **Step 8: Add the live fixture test deferred from Task 5**

Create `test/forecast.live.test.js`:

```js
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { build } = require('../main/snapshot');

const file = path.join(__dirname, 'fixtures', 'live.json');

test('a real captured snapshot produces finite, signed-correct projections', { skip: !fs.existsSync(file) }, () => {
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  const s = build({ ...raw, uncategorized: [] }, '2026-09-18');

  assert.ok(s.budgets.length > 0, 'fixture should carry budgets');
  for (const b of s.budgets) {
    assert.ok(Number.isFinite(b.projected), `${b.name} projected must be finite`);
    assert.ok(b.projected >= 0, `${b.name} projected must not be negative`);
    assert.ok(b.projected >= b.spent - 0.01, `${b.name} must project at least what is spent`);
    assert.ok(b.discretionary >= 0, `${b.name} discretionary must not be negative`);
  }
  assert.ok(Number.isFinite(s.runway.end), 'runway end must be finite');
  assert.ok(s.runway.actual.length > 0, 'runway must have an actual leg');
});
```

- [ ] **Step 9: Run the suite**

Run: `npm test`
Expected: PASS. The live test skips if no fixture was captured.

- [ ] **Step 10: Commit**

```bash
git add main/snapshot.js main/poll.js main/notify.js test/snapshot.test.js test/forecast.live.test.js test/fixtures/
git commit -m "feat: snapshot assembly, polling loop and notification dispatch"
```

---

### Task 8: Electron shell, window and IPC

**Files:**
- Create: `main/index.js`
- Create: `main/preload.js`

**Interfaces:**
- Consumes: everything from Tasks 1–7.
- Produces the renderer-facing `window.api`:
  - `api.onSnapshot(cb)` — a snapshot arrived
  - `api.onStatus(cb)` — `{ state: 'needs-token' | 'loading' | 'ok' | 'error', message }`
  - `api.saveToken(token) -> Promise<{ ok, message }>`
  - `api.clearToken() -> Promise<void>`
  - `api.refresh() -> Promise<void>`
  - `api.openExternal(url) -> Promise<void>`

No channel returns the token.

- [ ] **Step 1: Write `main/preload.js`**

```js
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  onSnapshot: (cb) => ipcRenderer.on('snapshot', (_e, payload) => cb(payload)),
  onStatus: (cb) => ipcRenderer.on('status', (_e, payload) => cb(payload)),
  saveToken: (token) => ipcRenderer.invoke('token:save', token),
  clearToken: () => ipcRenderer.invoke('token:clear'),
  refresh: () => ipcRenderer.invoke('refresh'),
  openExternal: (url) => ipcRenderer.invoke('open-external', url),
});
```

- [ ] **Step 2: Write `main/index.js`**

```js
const path = require('node:path');
const { app, BrowserWindow, ipcMain, shell, safeStorage } = require('electron');
const store = require('./store');
const secrets = require('./secrets');
const { createApi } = require('./api');
const poll = require('./poll');
const notify = require('./notify');
const { decide } = require('./alerts');

const DEFAULT_BOUNDS = { w: 1600, h: 950 };

let win = null;
let saveTimer = null;

function send(channel, payload) {
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
}

function persistBounds() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    if (!win || win.isDestroyed()) return;
    const { x, y, width, height } = win.getBounds();
    store.save({ ...store.load(), window: { x, y, w: width, h: height } });
  }, 500);
}

function onSnapshot(snapshot) {
  send('snapshot', snapshot);
  send('status', { state: 'ok' });

  const state = store.load();
  const { fire, notified } = decide(snapshot, state.notified || {}, snapshot.today);
  if (fire.length) notify.fire(fire);
  store.save({ ...state, notified });
}

function onError(err) {
  if (err && err.status === 401) {
    // Expired token or lapsed Premium — both need the same human action.
    poll.stop();
    send('status', { state: 'needs-token', message: 'Your API token was rejected. Paste a fresh one from Wallet web settings.' });
    return;
  }
  send('status', { state: 'error', message: err && err.message ? err.message : 'Request failed.' });
}

function startPolling() {
  const token = secrets.load();
  if (!token) {
    send('status', { state: 'needs-token', message: 'Paste your Wallet API token to begin.' });
    return;
  }
  send('status', { state: 'loading' });
  poll.start({ api: createApi({ token }), onSnapshot, onError });
}

function createWindow() {
  const saved = store.load().window;

  win = new BrowserWindow({
    width: saved?.w ?? DEFAULT_BOUNDS.w,
    height: saved?.h ?? DEFAULT_BOUNDS.h,
    x: saved?.x,
    y: saved?.y,
    minWidth: 900,
    minHeight: 600,
    backgroundColor: '#11131a',
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
  win.once('ready-to-show', () => {
    win.show();
    startPolling();
  });
  win.on('resize', persistBounds);
  win.on('move', persistBounds);
  win.on('closed', () => { win = null; });
}

ipcMain.handle('token:save', async (_e, token) => {
  try {
    secrets.save(token);
  } catch (err) {
    return { ok: false, message: err.message };
  }
  startPolling();
  return { ok: true };
});

ipcMain.handle('token:clear', async () => {
  poll.stop();
  secrets.clear();
  send('status', { state: 'needs-token', message: 'Token cleared.' });
});

ipcMain.handle('refresh', async () => {
  const token = secrets.load();
  if (!token) return;
  await poll.refreshNow({ api: createApi({ token }), onSnapshot, onError });
});

ipcMain.handle('open-external', async (_e, url) => {
  // Only ever our own web app; never a URL taken from API data.
  if (typeof url === 'string' && url.startsWith('https://web.budgetbakers.com')) {
    await shell.openExternal(url);
  }
});

app.whenReady().then(() => {
  secrets.setCrypto(safeStorage);
  createWindow();
});

app.on('window-all-closed', () => {
  poll.stop();
  app.quit();
});
```

- [ ] **Step 3: Verify the suite still passes**

Run: `npm test`
Expected: PASS, unchanged count. `main/index.js` has no tests; it is assembly.

- [ ] **Step 4: Commit**

```bash
git add main/index.js main/preload.js
git commit -m "feat: Electron shell, window state and IPC surface"
```

---

### Task 9: Renderer shell, token screen and budgets panel

**Files:**
- Create: `renderer/index.html`
- Create: `renderer/style.css`
- Create: `renderer/app.js`

**Interfaces:**
- Consumes: `window.api` from Task 8; the snapshot shape from Task 7.
- Produces: `renderBudgets(el, snapshot)` and the status/token gate, both called from the `onSnapshot`/`onStatus` handlers in `app.js`.

- [ ] **Step 1: Write `renderer/index.html`**

```html
<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta http-equiv="Content-Security-Policy"
        content="default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:;">
  <title>Wallet Budget</title>
  <link rel="stylesheet" href="style.css">
</head>
<body>
  <section id="gate" hidden>
    <div class="gate-card">
      <h1>Wallet Budget</h1>
      <p id="gate-msg">Paste your Wallet API token to begin.</p>
      <p class="hint">Wallet web &rarr; Settings &rarr; API. Requires Premium.</p>
      <input id="token" type="password" placeholder="Paste API token" autocomplete="off" spellcheck="false">
      <button id="save">Connect</button>
      <p id="gate-err" class="err"></p>
    </div>
  </section>

  <main id="dash" hidden>
    <header>
      <h1>Wallet Budget</h1>
      <span id="stamp"></span>
      <button id="refresh">Refresh</button>
    </header>
    <div class="grid">
      <section class="panel budgets"><h2>Budgets <span id="period"></span></h2><div id="budgets"></div></section>
      <section class="panel runway"><h2>Runway</h2><div id="runway"></div></section>
      <section class="panel inbox"><h2>Needs category <span id="inbox-n"></span></h2><div id="inbox"></div><div id="sync"></div></section>
      <section class="panel upcoming"><h2>Upcoming</h2><div id="upcoming"></div></section>
    </div>
  </main>

  <script src="app.js"></script>
</body>
</html>
```

- [ ] **Step 2: Write `renderer/style.css`**

```css
:root {
  --bg: #11131a;
  --panel: #191d27;
  --line: #262c3a;
  --text: #e6e9f0;
  --dim: #8b93a7;
  --ok: #4ade80;
  --warn: #fbbf24;
  --bad: #f87171;
  --accent: #60a5fa;
}

* { box-sizing: border-box; }

body {
  margin: 0;
  background: var(--bg);
  color: var(--text);
  font: 14px/1.45 "Segoe UI Variable Text", "Segoe UI", system-ui, sans-serif;
  height: 100vh;
  overflow: hidden;
}

header {
  display: flex;
  align-items: baseline;
  gap: 16px;
  padding: 14px 20px;
  border-bottom: 1px solid var(--line);
}

header h1 { font-size: 15px; font-weight: 600; margin: 0; letter-spacing: .2px; }
header #stamp { color: var(--dim); font-size: 12px; font-variant-numeric: tabular-nums; }
header button { margin-left: auto; }

button {
  background: var(--panel);
  color: var(--text);
  border: 1px solid var(--line);
  border-radius: 6px;
  padding: 6px 14px;
  cursor: pointer;
  font: inherit;
}
button:hover { border-color: var(--accent); }

.grid {
  display: grid;
  grid-template-columns: 1.35fr 1fr;
  grid-template-rows: 1fr 1fr;
  gap: 14px;
  padding: 14px 20px 20px;
  height: calc(100vh - 53px);
}

@media (max-width: 1100px) {
  .grid { grid-template-columns: 1fr; grid-template-rows: none; height: auto; overflow-y: auto; }
  body { overflow: auto; }
}

.panel {
  background: var(--panel);
  border: 1px solid var(--line);
  border-radius: 10px;
  padding: 14px 16px;
  overflow: auto;
  min-height: 0;
}

.panel h2 {
  font-size: 11px;
  text-transform: uppercase;
  letter-spacing: .09em;
  color: var(--dim);
  margin: 0 0 12px;
  font-weight: 600;
}

.panel h2 span { color: var(--dim); font-weight: 400; text-transform: none; letter-spacing: 0; }

/* ---------------------------------------------------------- budget rows */

.brow { margin-bottom: 13px; }

.btop {
  display: flex;
  justify-content: space-between;
  align-items: baseline;
  gap: 10px;
  margin-bottom: 4px;
}

.bname { font-weight: 500; }
.bnum { color: var(--dim); font-size: 12px; font-variant-numeric: tabular-nums; }
.bproj { font-variant-numeric: tabular-nums; font-size: 12px; }
.bproj.over { color: var(--bad); font-weight: 600; }
.bproj.near { color: var(--warn); }
.bproj.safe { color: var(--dim); }

/* The bar shows what is spent; the tick shows where the projection lands, so
   "under now, over by month end" reads as one glance rather than two numbers. */
.bar {
  position: relative;
  height: 7px;
  background: #0d0f15;
  border-radius: 4px;
  overflow: visible;
}

.fill {
  height: 100%;
  border-radius: 4px;
  background: var(--ok);
  transition: width .25s;
}
.fill.near { background: var(--warn); }
.fill.over { background: var(--bad); }

.tick {
  position: absolute;
  top: -3px;
  width: 2px;
  height: 13px;
  background: var(--text);
  border-radius: 1px;
}
.tick.over { background: var(--bad); }

/* ------------------------------------------------------------- lists */

.row {
  display: flex;
  gap: 10px;
  align-items: baseline;
  padding: 5px 0;
  border-bottom: 1px solid var(--line);
  font-variant-numeric: tabular-nums;
}
.row:last-child { border-bottom: 0; }
.row .d { color: var(--dim); font-size: 12px; min-width: 42px; }
.row .n { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.row .a { font-weight: 500; }
.row .a.pos { color: var(--ok); }
.row .a.neg { color: var(--text); }
.row.clickable { cursor: pointer; }
.row.clickable:hover { background: #1f2430; }

.empty { color: var(--dim); font-size: 12px; padding: 6px 0; }

#sync { margin-top: 14px; padding-top: 12px; border-top: 1px solid var(--line); }
.sync-row { display: flex; gap: 8px; font-size: 12px; padding: 3px 0; }
.sync-row .ok { color: var(--ok); }
.sync-row .stale { color: var(--warn); }
.sync-row .bad { color: var(--bad); }

/* -------------------------------------------------------------- gate */

#gate { display: grid; place-items: center; height: 100vh; }
.gate-card { width: 380px; text-align: center; }
.gate-card h1 { font-size: 18px; margin: 0 0 12px; }
.gate-card p { color: var(--dim); margin: 0 0 8px; }
.gate-card .hint { font-size: 12px; margin-bottom: 18px; }
.gate-card input {
  width: 100%;
  padding: 9px 12px;
  background: #0d0f15;
  border: 1px solid var(--line);
  border-radius: 6px;
  color: var(--text);
  font: inherit;
  margin-bottom: 10px;
}
.gate-card input:focus { outline: none; border-color: var(--accent); }
.gate-card button { width: 100%; }
.err { color: var(--bad); font-size: 12px; min-height: 16px; }
```

- [ ] **Step 3: Write `renderer/app.js` with the shell, gate and budgets panel**

```js
const $ = (id) => document.getElementById(id);

const eur = (n) => `${n < 0 ? '-' : ''}${Math.abs(n).toFixed(2)}`;
const eur0 = (n) => `${n < 0 ? '-' : ''}${Math.round(Math.abs(n))}`;

function band(ratio) {
  if (ratio >= 1) return 'over';
  if (ratio >= 0.8) return 'near';
  return 'safe';
}

function el(tag, cls, text) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined) n.textContent = text;
  return n;
}

// ------------------------------------------------------------- budgets

function renderBudgets(root, snapshot) {
  root.replaceChildren();
  if (!snapshot.budgets.length) {
    root.append(el('div', 'empty', 'No budgets found in this Wallet account.'));
    return;
  }

  for (const b of snapshot.budgets) {
    const row = el('div', 'brow');

    const top = el('div', 'btop');
    top.append(el('span', 'bname', b.name));
    top.append(el('span', 'bnum', `${eur0(b.spent)} / ${eur0(b.limit)}`));

    const projBand = band(b.ratio);
    const proj = el('span', `bproj ${projBand}`,
      projBand === 'safe'
        ? `→ ${Math.round(b.ratio * 100)}%`
        : `→ ${Math.round(b.ratio * 100)}%  (${eur0(b.projected)})`);
    proj.title = `spent ${eur(b.spent)} + scheduled ${eur(b.scheduled)} `
      + `+ rate ${eur(b.discretionary)} = ${eur(b.projected)}`;
    top.append(proj);
    row.append(top);

    const spentRatio = b.limit > 0 ? b.spent / b.limit : 0;
    const bar = el('div', 'bar');
    const fill = el('div', `fill ${band(spentRatio)}`);
    fill.style.width = `${Math.min(100, spentRatio * 100)}%`;
    bar.append(fill);

    const tick = el('div', `tick ${b.ratio >= 1 ? 'over' : ''}`);
    tick.style.left = `calc(${Math.min(100, b.ratio * 100)}% - 1px)`;
    tick.title = `projected ${Math.round(b.ratio * 100)}%`;
    bar.append(tick);

    row.append(bar);
    root.append(row);
  }
}

// --------------------------------------------------------------- shell

let lastSnapshot = null;

function showGate(message, err) {
  $('dash').hidden = true;
  $('gate').hidden = false;
  $('gate-msg').textContent = message || 'Paste your Wallet API token to begin.';
  $('gate-err').textContent = err || '';
}

function showDash() {
  $('gate').hidden = true;
  $('dash').hidden = false;
}

function render(snapshot) {
  lastSnapshot = snapshot;
  showDash();
  $('stamp').textContent = `updated ${new Date(snapshot.generatedAt).toLocaleTimeString()}`;
  $('period').textContent = snapshot.budgets[0]
    ? `${snapshot.budgets[0].periodStart} → ${snapshot.budgets[0].periodEnd}`
    : '';
  renderBudgets($('budgets'), snapshot);
  // Panels added in Tasks 10 and 11 hook in here.
  if (typeof renderRunway === 'function') renderRunway($('runway'), snapshot);
  if (typeof renderUpcoming === 'function') renderUpcoming($('upcoming'), snapshot);
  if (typeof renderInbox === 'function') renderInbox($('inbox'), $('inbox-n'), $('sync'), snapshot);
}

window.api.onSnapshot(render);

window.api.onStatus(({ state, message }) => {
  if (state === 'needs-token') showGate(message);
  else if (state === 'error' && !lastSnapshot) showGate('Could not reach Wallet.', message);
  else if (state === 'error') $('stamp').textContent = `stale — ${message}`;
});

$('save').addEventListener('click', async () => {
  const token = $('token').value.trim();
  const res = await window.api.saveToken(token);
  if (!res.ok) $('gate-err').textContent = res.message;
  else $('token').value = '';
});

$('token').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') $('save').click();
});

$('refresh').addEventListener('click', () => window.api.refresh());
```

- [ ] **Step 4: Run the app and confirm the gate appears**

Run: `npm start`
Expected: the token gate renders. Paste a valid token; within a few seconds the dashboard replaces it and the budgets panel lists all budgets with bars and projection ticks.

- [ ] **Step 5: Commit**

```bash
git add renderer/
git commit -m "feat: renderer shell, token gate and budgets panel"
```

---

### Task 10: Runway chart

**Files:**
- Modify: `renderer/app.js` (append `renderRunway`)

**Interfaces:**
- Consumes: `snapshot.runway` from Task 7.
- Produces: `renderRunway(root, snapshot)`, already called by `render()` in Task 9.

- [ ] **Step 1: Append `renderRunway` to `renderer/app.js`**

Insert immediately before the `// --------- shell` comment block:

```js
// -------------------------------------------------------------- runway

const SVG = 'http://www.w3.org/2000/svg';

function svgEl(tag, attrs) {
  const n = document.createElementNS(SVG, tag);
  for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, v);
  return n;
}

function renderRunway(root, snapshot) {
  root.replaceChildren();
  const { actual, projected, end } = snapshot.runway;
  const points = [...actual, ...projected.slice(1)];
  if (points.length < 2) {
    root.append(el('div', 'empty', 'Not enough data yet for a runway.'));
    return;
  }

  const W = 520;
  const H = 190;
  const PAD = { l: 46, r: 12, t: 12, b: 24 };

  const values = points.map((p) => p.balance);
  let lo = Math.min(...values, 0);
  let hi = Math.max(...values);
  if (hi === lo) hi = lo + 1; // a flat series still needs a non-zero range

  const x = (i) => PAD.l + (i / (points.length - 1)) * (W - PAD.l - PAD.r);
  const y = (v) => PAD.t + (1 - (v - lo) / (hi - lo)) * (H - PAD.t - PAD.b);

  const svg = svgEl('svg', { viewBox: `0 0 ${W} ${H}`, width: '100%', height: 'auto' });

  // zero line, if the range crosses it
  if (lo < 0 && hi > 0) {
    svg.append(svgEl('line', {
      x1: PAD.l, x2: W - PAD.r, y1: y(0), y2: y(0),
      stroke: '#262c3a', 'stroke-width': 1,
    }));
  }

  const path = (slice, offset, extra) => {
    const d = slice.map((p, i) => `${i === 0 ? 'M' : 'L'}${x(i + offset).toFixed(1)},${y(p.balance).toFixed(1)}`).join(' ');
    return svgEl('path', { d, fill: 'none', 'stroke-width': 2, ...extra });
  };

  svg.append(path(actual, 0, { stroke: '#60a5fa' }));
  svg.append(path(projected, actual.length - 1, { stroke: '#8b93a7', 'stroke-dasharray': '4 3' }));

  // today marker
  svg.append(svgEl('circle', {
    cx: x(actual.length - 1), cy: y(actual[actual.length - 1].balance), r: 3.5, fill: '#60a5fa',
  }));

  // axis labels
  const label = (tx, ty, text, anchor) => {
    const n = svgEl('text', { x: tx, y: ty, fill: '#8b93a7', 'font-size': 10, 'text-anchor': anchor || 'start' });
    n.textContent = text;
    return n;
  };
  svg.append(label(4, y(hi) + 4, eur0(hi)));
  svg.append(label(4, y(lo) + 4, eur0(lo)));
  svg.append(label(PAD.l, H - 6, points[0].date.slice(8) + '.' + points[0].date.slice(5, 7)));
  svg.append(label(W - PAD.r, H - 6, points[points.length - 1].date.slice(8) + '.' + points[points.length - 1].date.slice(5, 7), 'end'));

  root.append(svg);

  const foot = el('div', 'row');
  foot.append(el('span', 'n', `Projected ${points[points.length - 1].date}`));
  foot.append(el('span', `a ${end >= 0 ? 'pos' : 'neg'}`, `${eur0(end)} EUR`));
  root.append(foot);
}
```

- [ ] **Step 2: Run and confirm the chart draws**

Run: `npm start`
Expected: a solid blue line from the 1st to today, a dashed grey line continuing to month end with visible steps on standing-order dates, and a footer reading the projected closing balance.

- [ ] **Step 3: Commit**

```bash
git add renderer/app.js
git commit -m "feat: SVG month runway chart"
```

---

### Task 11: Upcoming, inbox and sync panels

**Files:**
- Modify: `renderer/app.js` (append `renderUpcoming` and `renderInbox`)

**Interfaces:**
- Consumes: `snapshot.upcoming`, `snapshot.uncategorized`, `snapshot.sync` from Task 7; `window.api.openExternal` from Task 8.
- Produces: `renderUpcoming(root, snapshot)`, `renderInbox(root, countEl, syncEl, snapshot)`.

- [ ] **Step 1: Append both renderers to `renderer/app.js`**

Insert before the `// --------- shell` block:

```js
// ------------------------------------------------- upcoming / inbox / sync

const dm = (iso) => `${iso.slice(8)}.${iso.slice(5, 7)}`;

function renderUpcoming(root, snapshot) {
  root.replaceChildren();
  if (!snapshot.upcoming.length) {
    root.append(el('div', 'empty', 'Nothing scheduled in the next 30 days.'));
    return;
  }
  for (const e of snapshot.upcoming) {
    const row = el('div', 'row');
    row.append(el('span', 'd', dm(e.date)));
    row.append(el('span', 'n', e.name));
    row.append(el('span', `a ${e.signed >= 0 ? 'pos' : 'neg'}`, eur(e.signed)));
    root.append(row);
  }
}

function renderInbox(root, countEl, syncEl, snapshot) {
  root.replaceChildren();
  syncEl.replaceChildren();

  countEl.textContent = snapshot.uncategorized.length ? `(${snapshot.uncategorized.length})` : '';

  if (!snapshot.uncategorized.length) {
    root.append(el('div', 'empty', 'Everything is categorized.'));
  } else {
    for (const r of snapshot.uncategorized) {
      const row = el('div', 'row clickable');
      row.append(el('span', 'd', dm(r.date)));
      row.append(el('span', 'n', r.counterParty || r.accountName || 'record'));
      row.append(el('span', `a ${r.amount >= 0 ? 'pos' : 'neg'}`, eur(r.amount)));
      // Read-only by design: fixing a category happens in Wallet web.
      row.title = 'Open Wallet web to categorize';
      row.addEventListener('click', () => window.api.openExternal('https://web.budgetbakers.com/records'));
      root.append(row);
    }
  }

  if (!snapshot.sync.length) return;

  for (const s of snapshot.sync) {
    const row = el('div', 'sync-row');
    row.append(el('span', 'n', s.name));
    if (s.error) {
      row.append(el('span', 'bad', s.error));
    } else if (s.stale) {
      row.append(el('span', 'stale', `no bank record for ${s.ageDays}d`));
    } else if (s.ageDays === null) {
      row.append(el('span', 'stale', 'no records yet'));
    } else {
      row.append(el('span', 'ok', s.ageDays === 0 ? 'synced today' : `${s.ageDays}d ago`));
    }
    syncEl.append(row);
  }
}
```

- [ ] **Step 2: Run and confirm all four panels populate**

Run: `npm start`
Expected: the upcoming list shows the next 30 days of standing orders with income in green; the inbox lists uncategorized records and opens Wallet web on click; sync rows show per bank account either an age or a warning.

- [ ] **Step 3: Commit**

```bash
git add renderer/app.js
git commit -m "feat: upcoming, uncategorized inbox and sync panels"
```

---

### Task 12: Windows build and README

**Files:**
- Modify: `package.json` (add the `build` block)
- Create: `README.md`

- [ ] **Step 1: Add the electron-builder block to `package.json`**

```json
  "build": {
    "appId": "com.gloopy.walletbudgetwidget",
    "productName": "Wallet Budget Widget",
    "directories": { "output": "dist" },
    "files": ["main/**", "renderer/**", "package.json"],
    "win": { "target": ["portable"], "artifactName": "WalletBudgetWidget-${version}.exe" },
    "portable": { "artifactName": "WalletBudgetWidget-${version}.exe" }
  }
```

- [ ] **Step 2: Write `README.md`**

````markdown
# Wallet Budget Widget

A desktop dashboard for BudgetBakers Wallet: budgets with end-of-period
projections, a month balance runway, upcoming standing orders, bank-sync
freshness, and an uncategorized inbox. Windows notifications for orders coming
due and budgets crossing their limits.

Read-only. It never modifies Wallet data.

## Setup

Requires a Wallet **Premium** subscription. Generate a personal API token in
Wallet web under Settings → API, then paste it on first launch. The token is
encrypted with Windows DPAPI via Electron's `safeStorage` and stored in
`%APPDATA%/wallet-budget-widget/state.json`. It is never sent anywhere except
`rest.budgetbakers.com`, and never crosses into the renderer process.

```bash
npm install
npm start
```

## Build a portable exe

```bash
npm run build      # -> dist/WalletBudgetWidget-0.1.0.exe
```

## Tests

```bash
npm test
```

Tests cover the pure modules — `rrule`, `forecast`, `alerts`, `snapshot`,
`store`, `secrets`, `api`. The Electron shell is not tested.

## How the projection works

```
projected = spent            what Wallet already reports for the period
          + scheduled        standing orders whose RRULE lands before period end
          + discretionary    mean daily non-recurring spend x days remaining
```

Keeping `scheduled` separate from `discretionary` is what makes the number
trustworthy. A budget made entirely of subscriptions has no daily burn rate —
its remaining charges are known exactly — while a food budget is nothing but
burn rate. Hover any projection to see the three terms that produced it.

This is arithmetic, not prediction. The discretionary term assumes the trailing
window is representative of the rest of the period, and it will be wrong for
irregular spending.

## Known limits

- **No bank-sync history.** The API exposes no sync log or last-sync timestamp,
  so the sync panel reports the age of each account's newest bank record as a
  proxy for freshness.
- **No server-side aggregation.** Rollups are computed locally from `/records`.
- **Rate limit.** 300 requests/hour sustained. The default 5-minute poll uses
  roughly 72/hour and backs off automatically when the remaining budget is low.
````

- [ ] **Step 3: Build and verify**

Run: `npm run build`
Expected: `dist/WalletBudgetWidget-0.1.0.exe` is produced. Launch it on Windows 11, confirm the token gate appears, paste a token, and confirm the dashboard populates and survives a restart without re-prompting.

- [ ] **Step 4: Commit**

```bash
git add package.json README.md
git commit -m "feat: Windows portable build and README"
```

---

## Self-Review

**Spec coverage.** Every spec section maps to a task: API surface → Task 4;
Electron rationale → Tasks 1, 2, 8; architecture and module table → Tasks 1–8;
forecast three-component model → Task 5; layout → Tasks 9–11; notifications →
Tasks 6, 7, 8; testing → every task; the four risks → Task 8 (401 handling
covers token expiry and Premium lapse), Task 5 (short history via the
`elapsed` floor), Task 4 and Task 7 (rate limit).

**Type consistency.** `occurrences`/`upcoming` (Task 3) are consumed with those
exact names in Tasks 5, 6, 7. `projectBudget` returns
`{spent, scheduled, discretionary, projected, limit, ratio, overshoot}` in Task
5 and is spread into the snapshot budget rows in Task 7, which Task 9 reads by
those same keys. `decide(snapshot, notified, todayISO)` returns
`{fire, notified}` in Task 6 and is destructured identically in Task 8.
`createApi({token, fetchImpl})` in Task 4 is called with `{token}` in Tasks 7
and 8.

**Deferred step.** Task 5 Step 5 depends on a fixture captured in Task 7, and
is explicitly carried to Task 7 Step 8 rather than left dangling.
