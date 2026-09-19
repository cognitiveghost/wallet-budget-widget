const $ = (id) => document.getElementById(id);

// --------------------------------------------------------------- formatting

let CURRENCY = 'EUR';

const fmtMoney = (n, digits) => new Intl.NumberFormat(undefined, {
  style: 'currency',
  currency: CURRENCY,
  minimumFractionDigits: digits,
  maximumFractionDigits: digits,
}).format(n);

const money = (n) => fmtMoney(n, 2);
const money0 = (n) => fmtMoney(n, 0);

// ISO dates are calendar days, so read and format them in UTC or a negative
// local offset silently shows the day before.
const asUTC = (iso) => new Date(`${String(iso).slice(0, 10)}T00:00:00Z`);
const dayMonth = (iso) => new Intl.DateTimeFormat(undefined, { day: 'numeric', month: 'short', timeZone: 'UTC' }).format(asUTC(iso));
// Not a numeric pair: 09/22 means September in one locale and the 9th in the
// next, and a list of due dates cannot afford that.
const shortDate = dayMonth;

const monthName = (iso) => new Intl.DateTimeFormat(undefined, { month: 'long', timeZone: 'UTC' }).format(asUTC(iso));

const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

function el(tag, cls, text) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined) n.textContent = text;
  return n;
}

const SVG = 'http://www.w3.org/2000/svg';
function svgEl(tag, attrs, text) {
  const n = document.createElementNS(SVG, tag);
  for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, v);
  if (text !== undefined) n.textContent = text;
  return n;
}

// ------------------------------------------------------------------ budgets

// Every track puts the limit at the same stop, so the panel reads as one
// graduated scale and the headroom left over is what overshoot draws into.
const LIMIT_STOP = 74;

// Over by less than the smallest figure the panel can print is not over: the
// row used to go red and then say "€0 over", which reads as a bug in the app
// rather than a budget that landed exactly on its limit.
const isOver = (b) => b.limit > 0 && b.overshoot >= 0.5;

function renderBudgets(root, snapshot) {
  root.replaceChildren();
  if (!snapshot.budgets.length) {
    root.append(el('div', 'empty', 'No budgets in this Wallet account yet.'));
    return;
  }

  const headPeriodEnd = snapshot.budgets[0].periodEnd;

  for (const b of snapshot.budgets) {
    const scale = b.limit > 0
      ? LIMIT_STOP / b.limit
      : LIMIT_STOP / Math.max(b.projected, 1);
    const at = (v) => Math.max(0, Math.min(100, v * scale));

    const spentEnd = at(b.spent);
    const dueEnd = at(b.spent + b.scheduled);
    const projEnd = at(b.projected);
    const over = isOver(b);

    const row = el('div', 'brow');

    const top = el('div', 'btop');
    top.append(el('span', 'bname', b.name));
    // The panel heading names one period, but budgets can run on their own.
    // A week-long budget reading as a month makes a normal week look alarming.
    if (b.periodEnd !== headPeriodEnd) {
      top.append(el('span', 'bperiod', `to ${dayMonth(b.periodEnd)}`));
    }
    const spent = el('span', 'bspent num');
    spent.append(el('em', null, money0(b.spent)), document.createTextNode(` of ${money0(b.limit)}`));
    top.append(spent);
    row.append(top);

    const track = el('div', 'track');

    const seg = (cls, from, to) => {
      const s = el('div', `seg ${cls}`);
      s.style.left = `${from}%`;
      s.style.width = `${Math.max(0, to - from)}%`;
      return s;
    };
    track.append(seg(`spent${b.spent > b.limit && b.limit > 0 ? ' over' : ''}`, 0, spentEnd));
    if (dueEnd > spentEnd) track.append(seg('due', spentEnd, dueEnd));
    if (projEnd > dueEnd) track.append(seg('rate', dueEnd, projEnd));

    // The bar stops where the projection lands, so the graduation is the only
    // mark needed: a bar that crosses it is a budget that ends over.
    if (b.limit > 0) track.append(el('div', `limit${over ? ' crossed' : ''}`));
    if (over) {
      const spill = el('div', 'spill');
      spill.style.left = `${LIMIT_STOP}%`;
      spill.style.width = `${Math.max(1.5, projEnd - LIMIT_STOP)}%`;
      track.append(spill);
    }
    row.append(track);

    const foot = el('div', 'bfoot');
    // "Over on the 26th" is something you can still act on; "lands at 540" is
    // only a number. The date comes from walking the days, so a lump payment
    // shows on its own day rather than smeared across the month.
    let verdict = `Lands at ${money0(b.projected)}`;
    if (over && b.spent > b.limit) verdict = `Already over by ${money0(b.spent - b.limit)}`;
    else if (over && b.crossesOn) verdict = `Over on ${dayMonth(b.crossesOn)}, by ${money0(b.overshoot)}`;
    else if (over) verdict = `Lands at ${money0(b.projected)}, ${money0(b.overshoot)} over`;
    foot.append(el('span', `lands${over ? ' over' : ''} num`, verdict));

    // The three terms the projection is made of, shown rather than hidden in a
    // tooltip — a budget of pure subscriptions and a budget of pure burn rate
    // reach the same number for very different reasons.
    const terms = el('span', 'num');
    terms.append(el('i', 'k-spent', money0(b.spent)), document.createTextNode(' spent'));
    if (b.scheduled > 0) {
      terms.append(document.createTextNode(' + '), el('i', 'k-due', money0(b.scheduled)), document.createTextNode(' due'));
    }
    if (b.discretionary > 0) {
      terms.append(document.createTextNode(' + '), el('i', null, money0(b.discretionary)), document.createTextNode(' at this rate'));
    }
    foot.append(terms);
    row.append(foot);

    root.append(row);
  }
}

// ------------------------------------------------------------------- runway

function renderRunway(root, snapshot) {
  root.replaceChildren();
  const { actual, projected, end } = snapshot.runway;
  const points = [...actual, ...projected.slice(1)];
  if (points.length < 2) {
    root.append(el('div', 'empty', 'Not enough of this month has happened yet to draw a runway.'));
    return;
  }

  const W = Math.max(520, Math.round(root.clientWidth || 900));
  const H = 220;
  // The bottom margin carries two rows now: the payment rug, then the dates.
  const PAD = { l: 4, r: 176, t: 32, b: 48 };

  const values = points.map((p) => p.balance);
  // Scale to the money that is actually there. Anchoring the floor at zero
  // when nothing ever goes negative flattens the whole month into a strip.
  let lo = Math.min(...values);
  let hi = Math.max(...values);
  if (lo > 0 && lo / hi > 0.8) lo = 0; // a nearly flat month should look flat
  if (hi === lo) hi = lo + 1;
  const span = hi - lo;
  lo -= span * 0.16;
  hi += span * 0.16;

  const at = new Map(points.map((p, i) => [p.date, i]));
  const x = (i) => PAD.l + (i / (points.length - 1)) * (W - PAD.l - PAD.r);
  const y = (v) => PAD.t + (1 - (v - lo) / (hi - lo)) * (H - PAD.t - PAD.b);

  const svg = svgEl('svg', { viewBox: `0 0 ${W} ${H}`, role: 'img' });
  svg.append(svgEl('title', {}, `Balance from ${points[0].date} to ${points[points.length - 1].date}`));

  const todayX = x(actual.length - 1);
  const todayY = y(actual[actual.length - 1].balance);
  const endX = x(points.length - 1);
  const endY = y(end);

  // Everything right of today is arithmetic, not history. The band says so
  // once, so the dashes do not have to carry that alone.
  svg.append(svgEl('rect', {
    x: todayX, y: PAD.t - 12, width: endX - todayX, height: H - PAD.t - PAD.b + 12,
    fill: '#8a9099', opacity: .05,
  }));

  // Zero earns a line only when the month actually reaches it.
  if (lo < 0) {
    svg.append(svgEl('line', {
      x1: PAD.l, x2: endX, y1: y(0), y2: y(0),
      stroke: '#ff5c39', 'stroke-width': 1, 'stroke-dasharray': '3 4', opacity: .6,
    }));
    svg.append(svgEl('text', { x: PAD.l, y: y(0) - 6, fill: '#ff5c39', 'font-size': 11 }, 'zero'));
  }

  // ------------------------------------------------------- planned payments
  // Every step in the projected line is a dated payment, and until now the
  // plot showed the step without ever saying what it was or when. The rug
  // under the axis marks each planned day — down in brass for money out, up in
  // teal for money in, tall for a big one — and a guide runs from each mark to
  // the point on the line it bends, so a drop can be read back to its date.
  // Drawn before the line so the guides sit under it.
  const planned = (snapshot.runway.planned || []).filter((p) => at.has(p.date));
  if (planned.length) {
    const RUG = H - PAD.b + 8;
    // max(…, 1): a standing order can carry a zero amount, and a NaN tick
    // height writes an SVG attribute that drops the mark silently.
    const biggest = Math.max(1, ...planned.map((p) => Math.abs(p.signed)));
    // Only the payments that actually shape the line are captioned. Twenty
    // captions across two months is not a plot, and the due list already has
    // every date in full. The biggest payment out leads, because that is the
    // one that threatens the balance; the biggest one in gets a caption too
    // when it is far enough away to be legible beside it.
    const biggestOf = (keep) => planned
      .filter(keep)
      .sort((a, b) => Math.abs(b.signed) - Math.abs(a.signed))[0];
    const lead = biggestOf((p) => p.signed < 0) || biggestOf(() => true);
    const named = [lead];
    const other = biggestOf((p) => p.signed > 0);
    if (other && Math.abs(x(at.get(other.date)) - x(at.get(lead.date))) > 110) named.push(other);
    const isNamed = new Set(named.map((p) => p.date));

    svg.append(svgEl('line', {
      x1: todayX, x2: endX, y1: RUG, y2: RUG,
      stroke: '#8a9099', 'stroke-width': 1, opacity: .18,
    }));

    for (const p of planned) {
      const px = x(at.get(p.date));
      const out = p.signed < 0;
      const colour = out ? '#d7a94b' : '#6fd0ba';
      const tick = 3 + 6 * (Math.abs(p.signed) / biggest);
      const captioned = isNamed.has(p.date);

      const g = svgEl('g', {});
      // Hover carries the full story for the marks that have no caption.
      g.append(svgEl('title', {}, `${p.names.join(', ')} \u2014 ${money(p.signed)} on ${dayMonth(p.date)}`));
      g.append(svgEl('line', {
        x1: px, x2: px, y1: y(points[at.get(p.date)].balance), y2: RUG,
        stroke: colour, 'stroke-width': 1, opacity: captioned ? .38 : .14,
      }));
      g.append(svgEl('line', {
        x1: px, x2: px, y1: RUG, y2: out ? RUG + tick : RUG - tick,
        stroke: colour, 'stroke-width': 2, 'stroke-linecap': 'round',
      }));
      svg.append(g);
    }

    for (const p of named) {
      const px = x(at.get(p.date));
      // Anchored away from whichever edge it is near, so a payment on the last
      // day of the plot does not write itself off the side.
      const near = px > endX - 90 ? 'end' : px < 90 ? 'start' : 'middle';
      const rest = p.names.length > 1 ? ` +${p.names.length - 1}` : '';
      svg.append(svgEl('text', {
        // An `end` anchor grows leftward and a `start` anchor rightward, so
        // the nudge has to follow the anchor, not oppose it.
        x: px + (near === 'end' ? -4 : near === 'start' ? 4 : 0),
        y: RUG + 22,
        fill: p.signed < 0 ? '#d7a94b' : '#6fd0ba',
        'font-size': 11, 'text-anchor': near, class: 'plot-now',
      }, `${dayMonth(p.date)} \u00b7 ${p.names[0]}${rest} ${money0(Math.abs(p.signed))}`));
    }
  }

  const line = (slice, offset) => slice
    .map((p, i) => `${i === 0 ? 'M' : 'L'}${x(i + offset).toFixed(1)},${y(p.balance).toFixed(1)}`)
    .join(' ');

  const measured = line(actual, 0);
  svg.append(svgEl('path', {
    d: `${measured} L${todayX.toFixed(1)},${(H - PAD.b).toFixed(1)} L${x(0).toFixed(1)},${(H - PAD.b).toFixed(1)} Z`,
    fill: '#6fd0ba', opacity: .08,
  }));
  svg.append(svgEl('path', { d: measured, fill: 'none', stroke: '#6fd0ba', 'stroke-width': 2, 'stroke-linejoin': 'round' }));
  svg.append(svgEl('path', {
    d: line(projected, actual.length - 1),
    fill: 'none', stroke: '#8a9099', 'stroke-width': 2, 'stroke-dasharray': '2 5', 'stroke-linecap': 'round',
  }));

  // Two readings, taken off the line where each one happens.
  svg.append(svgEl('circle', { cx: todayX, cy: todayY, r: 4, fill: '#16171a', stroke: '#6fd0ba', 'stroke-width': 2 }));
  svg.append(svgEl('text', {
    x: todayX, y: todayY - 16, fill: '#e9eaec', 'font-size': 14, 'text-anchor': 'middle',
    class: 'plot-now',
  }, money0(actual[actual.length - 1].balance)));

  svg.append(svgEl('circle', { cx: endX, cy: endY, r: 3, fill: '#8a9099' }));
  svg.append(svgEl('text', {
    x: endX + 16, y: endY + 12,
    fill: end < 0 ? '#ff5c39' : '#e9eaec',
    'font-size': 42, 'font-weight': 600, class: 'plot-end',
  }, money0(end)));
  svg.append(svgEl('text', {
    x: endX + 17, y: endY + 32, fill: '#8a9099', 'font-size': 12,
  }, `on ${dayMonth(points[points.length - 1].date)}`));

  const foot = (tx, text, anchor) => svgEl('text', {
    x: tx, y: H - 6, fill: '#8a9099', 'font-size': 12, 'text-anchor': anchor || 'start',
  }, text);
  svg.append(foot(PAD.l, dayMonth(points[0].date)));
  svg.append(foot(todayX, 'today', 'middle'));

  // Where next month starts. The line runs across a month boundary now, so the
  // boundary has to be visible or the far half reads as more of this month.
  const nextStart = snapshot.nextMonth && snapshot.nextMonth.start;
  const nextIdx = points.findIndex((pt) => pt.date === nextStart);
  if (nextIdx > 0) {
    const nx = x(nextIdx);
    svg.append(svgEl('line', {
      x1: nx, x2: nx, y1: PAD.t - 12, y2: H - PAD.b,
      stroke: '#8a9099', 'stroke-width': 1, opacity: .25,
    }));
    svg.append(foot(nx + 5, monthName(nextStart)));

    // This month's closing balance, read where it happens. Dropped when today
    // is close enough that the two labels would sit on top of each other.
    const mEnd = snapshot.runway.monthEndDate;
    const mi = points.findIndex((pt) => pt.date === mEnd);
    if (mi > 0 && x(mi) - todayX > 54) {
      svg.append(svgEl('circle', { cx: x(mi), cy: y(points[mi].balance), r: 3, fill: '#8a9099' }));
      svg.append(svgEl('text', {
        x: x(mi), y: y(points[mi].balance) - 14, fill: '#8a9099', 'font-size': 12,
        'text-anchor': 'middle', class: 'plot-now',
      }, money0(points[mi].balance)));
    }
  }

  // Over two months the end of the line stops being the worst news: payday
  // lifts it back up and hides the week it nearly ran out. Mark the low point
  // when it is meaningfully below where the line finishes, and skip it when
  // the projection only ever falls — the end reading already is the low point.
  const ahead = points.slice(actual.length - 1);
  const low = ahead.reduce((a, b) => (b.balance < a.balance ? b : a), ahead[0]);
  if (low.balance < end - span * 0.12 && low.balance >= 0) {
    const lx = x(points.indexOf(low));
    const ly = y(low.balance);
    // Below the point by default, but a low that sits near the floor would
    // write its caption over the payment rug, so it goes above instead.
    const below = ly + 18 < H - PAD.b - 6;
    svg.append(svgEl('circle', { cx: lx, cy: ly, r: 3, fill: '#8a9099' }));
    svg.append(svgEl('text', {
      x: lx, y: below ? ly + 18 : ly - 12, fill: '#8a9099', 'font-size': 12,
      'text-anchor': 'middle', class: 'plot-now',
    }, `low ${money0(low.balance)} ${dayMonth(low.date)}`));
  }

  // The one date worth interrupting for: when the line first goes under.
  const broke = points.find((pt, i) => i >= actual.length - 1 && pt.balance < 0);
  if (broke) {
    const bx = x(points.indexOf(broke));
    svg.append(svgEl('line', {
      x1: bx, x2: bx, y1: y(0) - 7, y2: y(0) + 7, stroke: '#ff5c39', 'stroke-width': 2,
    }));
    svg.append(svgEl('text', {
      x: bx + 6, y: y(0) + 16, fill: '#ff5c39', 'font-size': 12, class: 'plot-now',
    }, `empty ${dayMonth(broke.date)}`));
  }

  root.append(svg);
}

function renderVerdict(node, snapshot) {
  node.replaceChildren();
  const { actual, end } = snapshot.runway;
  const over = snapshot.budgets.filter(isOver);

  // The end-of-month figure is already the largest thing on the screen. This
  // line earns its place by saying what the plot cannot: who is at fault, and
  // how much still has to move.
  if (!snapshot.budgets.length) {
    node.append(document.createTextNode('No budgets are set up yet. '));
  } else if (!over.length) {
    node.append(document.createTextNode('Every budget lands inside its limit. '));
  } else {
    const names = over.map((b) => b.name);
    const shown = names.slice(0, 2);
    const rest = names.length - shown.length;
    node.append(el('b', 'over', shown.join(' and ') + (rest ? ` and ${rest} more` : '')));
    node.append(document.createTextNode(` ${over.length === 1 ? 'ends' : 'end'} over. `));
  }

  // The verdict stays on this month; the line under it does next month. Both
  // reading off the same end date would say the same thing twice.
  const today = actual.length ? actual[actual.length - 1].balance : end;
  const monthEnd = snapshot.runway.monthEnd === null || snapshot.runway.monthEnd === undefined
    ? end : snapshot.runway.monthEnd;
  const delta = monthEnd - today;
  if (Math.abs(delta) >= 1) {
    node.append(el('b', null, money0(Math.abs(delta))));
    node.append(document.createTextNode(
      `${delta < 0 ? ' leaves' : ' arrives'} before ${dayMonth(snapshot.runway.monthEndDate)}.`));
  }

  if (snapshot.excludedAccounts && snapshot.excludedAccounts.length) {
    node.append(document.createTextNode(
      ` Not counting ${snapshot.excludedAccounts.join(', ')}, held in another currency.`));
  }
}

// Next month is arithmetic on this month's closing balance, so it is written
// out as arithmetic: every term that moved the number is on the line.
function renderNext(node, snapshot) {
  node.replaceChildren();
  const n = snapshot.nextMonth;
  if (!n || n.opening === null) return;

  const term = (label, value, cls) => {
    node.append(el('span', `term ${cls || ''}`.trim(),
      `${label} ${cls === 'op' ? '' : money0(Math.abs(value))}`.trim()));
  };

  node.append(el('span', 'term head', monthName(n.start)));
  term('from', n.opening);
  if (n.income > 0) { node.append(el('span', 'op', '+')); term('planned in', n.income); }
  if (n.expense > 0) { node.append(el('span', 'op', '\u2212')); term('planned out', n.expense); }
  if (Math.abs(n.rate) >= 1) {
    node.append(el('span', 'op', n.rate < 0 ? '\u2212' : '+'));
    term('at this rate', Math.abs(n.rate));
  }
  node.append(el('span', 'op', '='));
  node.append(el('b', `close num${n.closing < 0 ? ' over' : ''}`, money0(n.closing)));
  node.append(el('span', 'term', `on ${dayMonth(n.end)}`));
}

// ----------------------------------------------------- upcoming / inbox / sync

function renderUpcoming(root, snapshot) {
  root.replaceChildren();
  if (!snapshot.upcoming.length) {
    root.append(el('div', 'empty', 'Nothing is due in the next 30 days.'));
    return;
  }
  for (const e of snapshot.upcoming) {
    const row = el('div', 'row');
    row.append(el('span', 'd', shortDate(e.date)));
    row.append(el('span', 'n', e.name));
    row.append(el('span', `a ${e.signed >= 0 ? 'pos' : ''}`, money(e.signed)));
    root.append(row);
  }
}

function renderInbox(root, countEl, syncEl, snapshot) {
  root.replaceChildren();
  syncEl.replaceChildren();

  const items = snapshot.unchecked || [];
  countEl.textContent = items.length || '';

  if (!items.length) {
    root.append(el('div', 'empty', snapshot.reviewStateSeen === false
      ? 'Wallet is not reporting review state for these accounts.'
      : 'Every record has been checked.'));
  } else {
    for (const r of items) {
      const row = el('div', 'row clickable');
      row.tabIndex = 0;
      row.append(el('span', 'd', shortDate(r.date)));
      row.append(el('span', 'n', r.counterParty || r.accountName || 'Record'));
      row.append(el('span', `a ${r.amount >= 0 ? 'pos' : ''}`, money(r.amount)));
      // Read-only by design: fixing a category happens in Wallet web.
      row.title = 'Open Wallet web to check this record';
      const open = () => window.api.openExternal('https://web.budgetbakers.com/records');
      row.addEventListener('click', open);
      row.addEventListener('keydown', (e) => { if (e.key === 'Enter') open(); });
      root.append(row);
    }
  }

  if (!snapshot.sync.length) return;
  syncEl.append(el('div', 'sync-head', 'Bank sync'));

  for (const s of snapshot.sync) {
    const row = el('div', 'sync-row');
    row.append(el('span', 'n', s.name));
    if (s.error) row.append(el('span', 'bad', s.error));
    else if (s.stale) row.append(el('span', 'stale', `quiet for ${plural(s.ageDays, 'day')}`));
    else if (s.ageDays === null) row.append(el('span', 'stale', 'no records yet'));
    else row.append(el('span', null, s.ageDays === 0 ? 'today' : `${plural(s.ageDays, 'day')} ago`));
    syncEl.append(row);
  }
}

// --------------------------------------------------------------------- shell

let lastSnapshot = null;

function showGate(message, err) {
  $('dash').hidden = true;
  $('gate').hidden = false;
  $('gate-msg').textContent = message || 'Paste your Wallet API token to begin.';
  $('gate-err').textContent = err || '';
}

function render(snapshot) {
  lastSnapshot = snapshot;
  CURRENCY = snapshot.currency || 'EUR';

  $('gate').hidden = true;
  $('dash').hidden = false;

  $('stamp').className = '';
  $('stamp').textContent = `updated ${new Date(snapshot.generatedAt).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })}`;

  // Budgets can run on different periods, so the panel names the one the rows
  // are actually sorted by rather than claiming a single period for all.
  const b0 = snapshot.budgets[0];
  $('period').textContent = b0 ? `${dayMonth(b0.periodStart)} – ${dayMonth(b0.periodEnd)}` : '';

  renderRunway($('runway'), snapshot);
  renderVerdict($('verdict'), snapshot);
  renderNext($('next'), snapshot);
  renderBudgets($('budgets'), snapshot);
  renderUpcoming($('upcoming'), snapshot);
  renderInbox($('inbox'), $('inbox-n'), $('sync'), snapshot);
  markScrollable();
}

function markScrollable() {
  for (const p of document.querySelectorAll('.panel')) {
    p.classList.toggle('scrolls', p.scrollHeight - p.clientHeight > 4 && p.scrollTop === 0);
  }
}
document.addEventListener('scroll', (e) => {
  if (e.target.classList && e.target.classList.contains('panel')) {
    e.target.classList.toggle('scrolls', e.target.scrollHeight - e.target.scrollTop - e.target.clientHeight > 4);
  }
}, true);

window.api.onSnapshot(render);

window.api.onStatus(({ state, message }) => {
  if (state === 'needs-token') { showGate(message); resetSave(); }
  // Without this branch the click produced no visible change at all while the
  // first poll ran, which reads as a dead button.
  else if (state === 'loading' && !lastSnapshot) showGate('Connecting to Wallet…', '');
  else if (state === 'ok') resetSave();
  else if (state === 'error' && !lastSnapshot) { showGate('Could not reach Wallet.', message); resetSave(); }
  else if (state === 'error') {
    $('stamp').className = 'stale';
    $('stamp').textContent = `stale — ${message}`;
  }
});

function resetSave() {
  $('save').disabled = false;
  $('save').textContent = 'Connect';
}

$('gate-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const token = $('token').value.trim();
  $('save').disabled = true;
  $('save').textContent = 'Connecting…';
  try {
    const res = await window.api.saveToken(token);
    if (!res || !res.ok) {
      $('gate-err').textContent = (res && res.message) || 'That token could not be saved.';
      resetSave();
    } else {
      $('token').value = '';
    }
  } catch (err) {
    // An IPC rejection used to surface as nothing whatsoever.
    $('gate-err').textContent = err && err.message ? err.message : String(err);
    resetSave();
  }
});

// refresh() resolves when the poll cycle is done, so the button can say so
// instead of looking dead for however long the round trip takes.
$('refresh').addEventListener('click', async () => {
  const btn = $('refresh');
  btn.disabled = true;
  btn.textContent = 'Refreshing…';
  try {
    await window.api.refresh();
  } finally {
    btn.disabled = false;
    btn.textContent = 'Refresh';
  }
});

// The runway plot is sized in real pixels, so it has to be redrawn at a new
// window width rather than stretched.
let resizeTimer = null;
window.addEventListener('resize', () => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => { if (lastSnapshot) renderRunway($('runway'), lastSnapshot); }, 120);
});
