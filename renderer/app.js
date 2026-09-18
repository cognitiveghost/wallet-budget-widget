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
  if (state === 'needs-token') { showGate(message); resetSave(); }
  // Without this branch the click produced no visible change at all while the
  // first poll ran, which reads as a dead button.
  else if (state === 'loading' && !lastSnapshot) showGate('Connecting to Wallet…', '');
  else if (state === 'ok') resetSave();
  else if (state === 'error' && !lastSnapshot) { showGate('Could not reach Wallet.', message); resetSave(); }
  else if (state === 'error') $('stamp').textContent = `stale — ${message}`;
});

function resetSave() {
  $('save').disabled = false;
  $('save').textContent = 'Connect';
}

$('save').addEventListener('click', async () => {
  const token = $('token').value.trim();
  $('save').disabled = true;
  $('save').textContent = 'Connecting…';
  try {
    const res = await window.api.saveToken(token);
    if (!res || !res.ok) {
      $('gate-err').textContent = (res && res.message) || 'Could not save the token.';
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

$('token').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') $('save').click();
});

$('refresh').addEventListener('click', () => window.api.refresh());
