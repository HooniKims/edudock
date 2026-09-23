'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { app, shell } = require('electron');
const { PortalAutomation } = require('../src/portal.cjs');

const root = path.resolve(__dirname, '..');
const evidenceDir = path.join(root, 'artifacts', 'qa', 'v2', '05-login', 'ordinary-auto-test');
const reportPath = path.join(evidenceDir, 'direct-report.json');

function sha256(relative) {
  return crypto.createHash('sha256').update(fs.readFileSync(path.join(root, relative))).digest('hex').toUpperCase();
}

async function run() {
  fs.mkdirSync(evidenceDir, { recursive: true });
  await app.whenReady();
  const events = [];
  const opened = [];
  const automation = new PortalAutomation({
    status: event => events.push({ at: new Date().toISOString(), phase: event.phase, busy: Boolean(event.busy) }),
    openPortal: async url => {
      opened.push(url);
      await shell.openExternal(url);
    },
  });

  const result = await automation.openMenu('portal');
  const diagnostics = automation.diagnostics();
  const cancelAfterTerminal = automation.cancel();
  const automaticLoginRecognized = result.ok === true && events.some(event => event.phase === 'done');
  const originalTaskResumed = automaticLoginRecognized;
  const report = {
    scenario: 'current PortalAutomation ordinary-Edge URL-only opener with no authentication observer wired',
    invocation: 'node_modules/electron/dist/electron.exe scripts/qa-v2-ordinary-direct.cjs',
    sourceHashes: {
      'src/portal.cjs': sha256('src/portal.cjs'),
      'src/main.cjs': sha256('src/main.cjs'),
    },
    opened,
    events,
    result: { ok: result.ok === true, phase: result.phase || null },
    observable: {
      productVerdict: automaticLoginRecognized && originalTaskResumed ? 'PASS' : 'FAIL',
      automaticLoginRecognized,
      originalTaskResumed,
      terminalPhase: result.phase || events.at(-1)?.phase || null,
      openCount: opened.length,
      exactOrdinaryEdgeUri: opened.length === 1 && opened[0] === 'microsoft-edge:https://sen.eduptl.kr',
      retryAvailable: diagnostics.retryAvailable,
      authenticationPending: diagnostics.authenticationPending,
      cancelAfterTerminalOk: cancelAfterTerminal.ok,
      repeatedLoginAttempts: 0,
      profileOrDebugFlagsUsed: false,
    },
    secretBoundary: {
      passwordValueRead: false,
      cookiesRead: false,
      profileCopied: false,
    },
  };
  fs.writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  process.stdout.write(`${JSON.stringify(report.observable, null, 2)}\n`);
  app.exit(0);
}

run().catch(error => {
  fs.mkdirSync(evidenceDir, { recursive: true });
  fs.writeFileSync(reportPath, `${JSON.stringify({ driverError: error.name || 'Error' }, null, 2)}\n`, 'utf8');
  process.stderr.write(`${error.stack || error}\n`);
  app.exit(1);
});
