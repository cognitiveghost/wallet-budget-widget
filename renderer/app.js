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

function renderBudgets(root, snapshot) {
  root.replaceChildren();
  if (!snapshot.budgets.length) {
    root.append(el('div', 'empty', 'No budgets in this Wallet account yet.'));
    return;
  }

  for (const b of snapshot.budgets) {
    const scale = b.limit > 0
      ? LIMIT_STOP / b.limit
      : LIMIT_STOP / Math.max(b.projected, 1);
    const at = (v) => Math.max(0, Math.min(100, v * scale));

    const spentEnd = at(b.spent);
    const dueEnd = at(b.spent + b.scheduled);
    const projEnd = at(b.projected);
    const over = b.limit > 0 && b.ratio >= 1;

    const row = el('div', 'brow');

    const top = el('div', 'btop');
    top.append(el('span', 'bname', b.name));
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
    foot.append(el('span', `lands${over ? ' over' : ''} num`,
      over
        ? `Lands at ${money0(b.projected)}, ${money0(b.overshoot)} over`
        : `Lands at ${money0(b.projected)}`));

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
  const H = 198;
  const PAD = { l: 4, r: 176, t: 32, b: 26 };

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
    x: tx, y: H - 8, fill: '#8a9099', 'font-size': 12, 'text-anchor': anchor || 'start',
  }, text);
  svg.append(foot(PAD.l, dayMonth(points[0].date)));
  svg.append(foot(todayX, 'today', 'middle'));

  root.append(svg);
}

function renderVerdict(node, snapshot) {
  node.replaceChildren();
  const { actual, projected, end } = snapshot.runway;
  const over = snapshot.budgets.filter((b) => b.limit > 0 && b.ratio >= 1);

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

  const today = actual.length ? actual[actual.length - 1].balance : end;
  const delta = end - today;
  const last = projected[projected.length - 1];
  if (last && Math.abs(delta) >= 1) {
    node.append(el('b', null, money0(Math.abs(delta))));
    node.append(document.createTextNode(
      `${delta < 0 ? ' leaves' : ' arrives'} before ${dayMonth(last.date)}.`));
  }

  if (snapshot.excludedAccounts && snapshot.excludedAccounts.length) {
    node.append(document.createTextNode(
      ` Not counting ${snapshot.excludedAccounts.join(', ')}, held in another currency.`));
  }
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

  countEl.textContent = snapshot.uncategorized.length || '';

  if (!snapshot.uncategorized.length) {
    root.append(el('div', 'empty', 'Everything is categorized.'));
  } else {
    for (const r of snapshot.uncategorized) {
      const row = el('div', 'row clickable');
      row.tabIndex = 0;
      row.append(el('span', 'd', shortDate(r.date)));
      row.append(el('span', 'n', r.counterParty || r.accountName || 'Record'));
      row.append(el('span', `a ${r.amount >= 0 ? 'pos' : ''}`, money(r.amount)));
      // Read-only by design: fixing a category happens in Wallet web.
      row.title = 'Open Wallet web to categorize';
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
