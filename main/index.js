const path = require('node:path');
const { app, BrowserWindow, ipcMain, shell, safeStorage, net } = require('electron');
const store = require('./store');
const secrets = require('./secrets');
const { createApi } = require('./api');

// Chromium's stack, not Node's undici: on Windows this is what honours the
// system proxy and the OS certificate store, so TLS-inspecting antivirus and
// corporate proxies work instead of hanging the request.
const walletApi = (token) => createApi({ token, fetchImpl: (u, o) => net.fetch(u, o) });
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
  // Node's fetch reports network failures as a bare "fetch failed" and hides
  // the real reason (DNS, TLS, proxy) on .cause — surface it or the gate line
  // says nothing actionable.
  const cause = err && err.cause && err.cause.message;
  const detail = err && err.message ? err.message : 'Request failed.';
  send('status', { state: 'error', message: cause ? `${detail} (${cause})` : detail });
}

function startPolling() {
  const token = secrets.load();
  if (!token) {
    send('status', { state: 'needs-token', message: 'Paste your Wallet API token to begin.' });
    return;
  }
  send('status', { state: 'loading' });
  poll.start({ api: walletApi(token), onSnapshot, onError });
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
  await poll.refreshNow({ api: walletApi(token), onSnapshot, onError });
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
