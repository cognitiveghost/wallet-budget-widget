# Wallet Budget Widget — Design

Date: 2026-09-18
Status: approved for implementation

## Problem

The BudgetBakers Wallet web app shows no budgets and sends no notifications.
Budgets and standing orders exist and are maintained in the mobile app, but on a
desktop they are invisible. The consequence is not missing data — it is missing
*warning*. Wallet reports that `per:my share to env:food` sits at 80% of its
limit; it does not report that on day 18 of 30 this implies 134% by month end.

## Scope

A desktop dashboard for a secondary 1920x1080 monitor that renders existing
Wallet data and raises Windows notifications. It computes projections. It does
not store financial data, does not modify it, and does not reimplement anything
the API already returns.

Out of scope: a records browser, writes of any kind, multi-user support,
regression-based forecasting, and any charting library.

## Verified API surface

Base `https://rest.budgetbakers.com/wallet/v1/api/`, spec version 2.0.0
(vendored at `docs/wallet-openapi-v2.0.0.json`).

Auth is `Authorization: Bearer <token>`, where the token is a JWT — a malformed
token returns 401 with `invalid JWT format: expected 3 parts, got 1`, so its
three-part shape is checked locally before the first request. Requires Wallet
Premium; the token is generated in Wallet web settings.

Endpoints used, all GET:

| Endpoint | Supplies |
|---|---|
| `/budgets?spending=current+2` | All budgets with server-computed `spending.current` — `spent`, `remaining`, `progress`, `effectiveLimit`, `periodStart`, `periodEnd`, `totalIncomes`, `excluded` |
| `/standing-orders` | `recurrenceRule` (RRULE), `dueDate`, `amount`, `type`, `categoryId`, `accountId`, `dueDateNotificationEnabled`, `threeDaysBeforeNotificationEnabled` |
| `/records` | `recordDate` ranges, `sortBy`, `categoryId`, `convertTo` (server-side FX), returning `convertedAmount`, `category`, `source`, `accountIsBankSync` |
| `/accounts` | `isBankSync`, `balance.currentBalance`, `recordStats.{lastUpdatedAt,error,errorAt,recordDate}` |

Two confirmed absences, which the design works around rather than pretends away:

- **No aggregation endpoint.** The MCP connector exposes one; REST does not.
  Rollups are computed client-side from `/records`. At roughly 40–80 records per
  month this is 1–3 requests for a full month, which is acceptable.
- **No bank-sync history.** No sync log, no last-sync timestamp. Sync
  *freshness* is derived from `recordStats` and from the newest record whose
  `accountIsBankSync` is true. A true history of sync events cannot be built.

Rate limiting: documented as 300/hour, observed as `X-RateLimit-Limit-Hour: 450`.
The lower figure is the planning number.

CORS is permissive — the server reflects arbitrary `Origin` and allows the
`Authorization` header — so a browser could call this API directly. The design
does not, for the reasons in the next section.

## Why Electron

A browser page would have worked for the network calls. It was rejected on two
concrete grounds and one convenience:

1. **Token storage.** In a browser the token lives in `localStorage` as
   plaintext, readable by any extension, any injected script, and any process
   that can read the profile directory. Electron's `safeStorage` encrypts via
   Windows DPAPI, scoped to the user account. Safe storage was an explicit
   requirement, and `localStorage` does not satisfy it.
2. **`file://` cannot call the API.** Its origin serializes to `null`, and this
   server reflects the `Origin` header rather than wildcarding it. A
   "just open the HTML file" build would therefore need a local HTTP server —
   which is the backend that was ruled out.
3. A working Windows Electron shell already exists in the sibling
   `sofia-stop-widget` project: vanilla renderer, `node --test`, one
   dependency, a proven `electron-builder --win portable` configuration.

## Architecture

Two processes with one invariant: **the API token never reaches the renderer.**
All HTTP happens in the main process; the renderer receives plain JSON snapshots
over IPC and renders them. `contextIsolation: true`, `nodeIntegration: false`.
This is the security boundary and the module boundary at once — the renderer
cannot leak a credential it never holds.

```
main/
  index.js      app lifecycle, BrowserWindow, IPC wiring
  secrets.js    safeStorage wrapper; JWT three-part shape check
  api.js        the five GET wrappers; rate-limit accounting
  rrule.js      expand a recurrenceRule into the next N occurrences   PURE
  forecast.js   (budgets, orders, records, today) -> projections      PURE
  alerts.js     (snapshot, lastState) -> notifications to fire        PURE
  notify.js     fires Electron Notification; persists fired markers
  poll.js       timer -> api -> snapshot -> diff -> IPC emit
renderer/
  index.html, app.css, app.js
```

The three modules marked PURE take data and return data. They perform no I/O,
touch no Electron API, and hold no state. All meaningful logic lives in them,
which is what makes the system testable without launching a browser.

### Data flow

`poll.js` runs every 5 minutes (and on demand from a refresh button). One cycle
issues roughly 6 requests, giving 72/hour against a budget of 300 — comfortable.
Each response's `X-RateLimit-Remaining-Hour` is recorded by `api.js`; when it
falls below 50 the poll interval doubles until the window resets.

A cycle produces one immutable snapshot object. That snapshot goes two places:
to the renderer for display, and to `alerts.js` along with the previous
persisted state to determine which notifications are newly warranted.

### Persistence

One file, `state.json`, in `app.getPath('userData')`: the encrypted token blob
and the "already fired" notification markers. No database. Financial data is
never written to disk — it is refetched on launch, so a stale cache can never be
mistaken for current truth.

## Forecast

The projection is arithmetic, decomposed into three independently explainable
components:

```
projected = spent_so_far
          + scheduled       sum of standing-order occurrences falling in
                            (today, periodEnd], expanded from RRULE, signed by type
          + discretionary   mean daily spend of non-recurring expenses over a
                            trailing 90-day window, times days remaining
```

Keeping `scheduled` distinct from `discretionary` is not decoration; it is the
correctness of the model. A budget whose spending consists entirely of standing
orders — `subscriptions`, at 61% on day 18 — would extrapolate under a naive
daily rate to 102%, which is wrong. Its remaining charges are known exactly.
Conversely a food budget has no scheduled component and is purely a burn rate.
Most budgets are a mixture, and the split handles all three cases with one
formula.

Classifying a record as recurring, for the purpose of excluding it from the
discretionary rate: a record is attributed to a standing order when its
`accountId` matches, its amount is within 1% of the order's `amount`, and its
`recordDate` falls within 3 days of an expected occurrence. `/standing-orders/items`
also links generated records to their parent order and is preferred where
present; the heuristic covers orders with `manualPayment: true`, whose records
are entered by hand and carry no such link.

The same function serves both consumers: the balance runway (whole account set,
calendar month) and per-budget projection (that budget's scope, that budget's
period — which may be weekly, as `env:food weekly shared` is).

Worked against live data on day 18 of 30, September 2026:

| Budget | Current | Projected |
|---|---|---|
| per:my share to env:food | 80.5% | 134% |
| per:total | 73.9% | 123% |
| per:bills | 67.6% | 113% |
| per:food personal | 60.6% | 101% |
| env:food monthly shared | 44.1% | 73% |
| env:food weekly shared | 38.7% | within period |
| subscriptions | 61.1% | scheduled-only |

Four budgets currently reading as under-limit project past it. Surfacing that is
the point of the application.

### Honest limits

The discretionary term assumes the trailing 90-day mean is representative. It
will be wrong for irregular spending, and the record history only begins in
August 2026, so early windows are short. The projection is presented as an
arithmetic consequence of current rate — never as a prediction of what will
happen — and the three components are displayed separately so an implausible
number can be traced to the term that produced it.

## Layout

A single resizable window, designed at 1920x1080, degrading to one column below
1100px.

```
+--------------------------------+--------------------+
| BUDGETS              Sep 2026  | SEPTEMBER RUNWAY   |
|  all 7, sorted by projected     |  actual to today,  |
|  overshoot descending           |  projected to end  |
|  bar shows current; tick shows  |  Sep 30: +2,150    |
|  projected                      |                    |
+--------------------------------+--------------------+
| NEEDS CATEGORY (n)             | UPCOMING           |
|  uncategorized, newest first   |  next 30 days from |
| SYNC: per bank account         |  expanded RRULEs   |
+--------------------------------+--------------------+
```

Budgets occupy the dominant half because all seven must be visible without
scrolling or truncation. They sort by projected overshoot, so whatever is about
to go wrong is at the top. Each row carries a filled bar for current spend and a
tick mark for the projection, making "under now, over by month end" a single
visual rather than two numbers to compare.

The runway is hand-rolled SVG: one polyline for actual, one dashed for
projected, one marker at today. No charting library — the chart is a path
element and an axis.

The uncategorized inbox is read-only. Clicking a record opens Wallet web to
correct it there.

Sync status shows, per bank-synced account, the age of its newest bank record
and any `recordStats.error`. It does not notify.

## Notifications

Native Windows notifications via Electron's `Notification`. Three triggers:

1. **Standing order due** — honoring each order's existing
   `dueDateNotificationEnabled` and `threeDaysBeforeNotificationEnabled` flags.
   These are already configured per order in Wallet, so the widget adds no
   settings screen and no second source of truth.
2. **Budget threshold crossed** — once at 80%, once at 100%, per budget per
   period, keyed on `budgetId + periodStart` so a new period re-arms cleanly.
3. **New uncategorized records** — batched to one digest per day, since bank
   sync can deliver several at once.

Sync staleness is displayed but does not notify, by decision.

`alerts.js` is pure: it receives the snapshot and the previously fired markers
and returns the list to fire. Suppression is therefore a testable property
rather than an emergent behavior of the timer.

## Testing

`node --test`, no framework, no fixtures directory beyond real captured JSON —
matching the sibling project's convention.

Tests cover the pure modules only:

- `rrule.js` — monthly `BYMONTHDAY` expansion, `UNTIL` termination (the Gym
  order carries `UNTIL=20270101T100000Z`), month-length clamping, and orders
  with no `recurrenceRule` at all (`yettel: close contract` is a one-off).
- `forecast.js` — the three components in isolation and combined; a
  scheduled-only budget must not be extrapolated by daily rate; a weekly period;
  a period with zero elapsed days must not divide by zero.
- `alerts.js` — fires once per threshold per period; does not re-fire on the
  next poll; re-arms on a new period; the daily digest batches.

The Electron shell is not tested. It is assembly, and testing it would require
machinery disproportionate to what it does.

## Risks

- **Token expiry.** The JWT presumably expires. Its lifetime is undocumented. A
  401 mid-session must surface as a clear "re-enter your token" state rather
  than an empty dashboard.
- **Premium lapse.** The API is Premium-gated; losing Premium returns 401 or 403
  and must be distinguishable from a bad token.
- **Short history.** Records begin August 2026, so the 90-day discretionary
  window is not yet full. The forecast must state the window it actually used.
- **Rate limit disagreement.** Documented 300/hour versus observed 450. Planning
  against 300 leaves headroom if the server tightens to its documented figure.
