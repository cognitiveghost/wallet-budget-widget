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
