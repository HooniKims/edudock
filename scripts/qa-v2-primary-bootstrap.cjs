'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { app, ipcMain, shell } = require('electron');
const { NativeOrdinaryEdgeBridge, resolveOrdinaryEdgeHelper } = require('../src/ordinary-edge.cjs');

const reportPath = process.env.EDUDOCK_QA_PRIMARY_REPORT;
if (!reportPath) throw new Error('EDUDOCK_QA_PRIMARY_REPORT is required.');

let shellOpenExternalCount = 0;
const originalOpenExternal = shell.openExternal.bind(shell);
shell.openExternal = async (...args) => {
  shellOpenExternalCount += 1;
  return originalOpenExternal(...args);
};

function writeReport(value) {
  fs.mkdirSync(path.dirname(reportPath), { recursive: true });
  fs.writeFileSync(reportPath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

const originalHandle = ipcMain.handle.bind(ipcMain);
ipcMain.handle = (channel, listener) => originalHandle(channel, async (...args) => {
  if (channel !== 'open-menu') return listener(...args);
  const menu = args[1];
  const startedAt = new Date().toISOString();
  try {
    const result = await listener(...args);
    const bridge = new NativeOrdinaryEdgeBridge({
      helperPath: resolveOrdinaryEdgeHelper({ isPackaged: app.isPackaged, resourcesPath: process.resourcesPath }),
    });
    const native = await bridge.run({ command: 'inspect' });
    const landing = native.windows.filter(window => window.landing === menu).map(window => ({
      pid: window.pid,
      hwnd: window.hwnd,
      origin: window.origin,
      landing: window.landing,
      authenticated: window.authenticated,
    }));
    writeReport({
      menu,
      startedAt,
      finishedAt: new Date().toISOString(),
      result: { ok: result?.ok === true, phase: result?.phase || null },
      shellOpenExternalCount,
      native: { status: native.status, landing },
    });
    return result;
  } catch (error) {
    writeReport({
      menu,
      startedAt,
      finishedAt: new Date().toISOString(),
      result: { ok: false, phase: null },
      shellOpenExternalCount,
      errorName: error instanceof Error ? error.name : 'UnknownError',
    });
    throw error;
  }
});

require('../src/main.cjs');

process.stdin.setEncoding('utf8');
process.stdin.on('data', data => {
  if (data.trim().toLowerCase() === 'close') app.exit(0);
});

app.whenReady().then(() => {
  process.stdout.write(`${JSON.stringify({ type: 'APP_READY', pid: process.pid })}\n`);
});
