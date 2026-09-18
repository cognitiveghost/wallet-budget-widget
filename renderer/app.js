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
