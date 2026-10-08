'use strict';

const { execFile } = require('node:child_process');

// Starting with Windows. The installed and portable copies keep a per-user Run entry; the Store
// package has its own startup task (Windows Settings > Apps > Startup) and a development run never
// registers. Written with reg.exe rather than Electron's login-item API, whose read-back misses an
// entry whose path has a space and drops its arguments.
const RUN_KEY = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run';
const APPROVED_KEY = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\StartupApproved\\Run';
const ENTRY = 'EduDock';
const AUTOSTART_ARG = '--autostart';

function loginItemMode({ platform, isPackaged, windowsStore }) {
  if (platform !== 'win32' || !isPackaged) return 'development';
  return windowsStore ? 'store' : 'self';
}

// A portable copy runs from a temporary folder; the Run entry has to name the exe the teacher keeps.
function launchCommand({ execPath, env = {} }) {
  return `"${env.PORTABLE_EXECUTABLE_FILE || execPath}" ${AUTOSTART_ARG}`;
}

// StartupApproved holds what Task Manager or Settings > Startup decided: an odd first byte means the
// teacher switched the entry off there.
function approvedDisabled(output) {
  const match = /REG_BINARY\s+([0-9A-Fa-f]{2})/.exec(output || '');
  return Boolean(match) && (parseInt(match[1], 16) & 1) === 1;
}

function runReg(args) {
  return new Promise(resolve => {
    execFile('reg.exe', args, { windowsHide: true, timeout: 5000, encoding: 'latin1' }, (error, stdout) => {
      resolve({ code: error ? (Number.isInteger(error.code) ? error.code : 1) : 0, stdout: stdout || '' });
    });
  });
}

function createLoginItem({ mode, command, run = runReg }) {
  let state = { mode, enabled: false };

  async function query(key) {
    const result = await run(['query', key, '/v', ENTRY]);
    return result.code === 0 ? result.stdout : null;
  }

  async function refresh() {
    const entry = await query(RUN_KEY);
    const approval = await query(APPROVED_KEY);
    state = { mode, enabled: Boolean(entry) && !approvedDisabled(approval) };
    return state;
  }

  async function write(wanted) {
    if (wanted) await run(['add', RUN_KEY, '/v', ENTRY, '/t', 'REG_SZ', '/d', command, '/f']);
    else await run(['delete', RUN_KEY, '/v', ENTRY, '/f']);
  }

  // At launch: keeps the entry pointing at this copy (a moved portable exe, a reinstall elsewhere)
  // without turning back on an entry the teacher switched off in Task Manager.
  async function sync(wanted) {
    if (mode !== 'self') return state;
    await write(wanted);
    return refresh();
  }

  // The settings switch is an explicit choice, so it also clears a "disabled" left by Task Manager.
  async function set(wanted) {
    if (mode !== 'self') return state;
    await write(wanted);
    await run(['delete', APPROVED_KEY, '/v', ENTRY, '/f']);
    return refresh();
  }

  return { sync, set, get state() { return { ...state }; } };
}

module.exports = { createLoginItem, loginItemMode, launchCommand, approvedDisabled, AUTOSTART_ARG, ENTRY };
