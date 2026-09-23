'use strict';

// Does one press of a notch button start the work, or does it take several?
// Counts the open-menu IPC calls the main process actually receives and measures the gap
// between the click and the first status the widget publishes. No Edge work is required:
// the operation may fail later, the question here is only what the first click does.

const fs = require('node:fs');
const path = require('node:path');
const { _electron: electron } = require('playwright-core');

const root = path.resolve(__dirname, '..');
const executablePath = path.join(process.env.LOCALAPPDATA || '', 'Programs', 'EduDock', 'EduDock.exe');
const evidence = path.join(root, 'artifacts', 'qa', 'v2', '15-click', `attempt-${Date.now()}`);
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

(async () => {
  fs.mkdirSync(evidence, { recursive: true });
  const report = { invocation: 'node scripts/qa-v2-click-latency.cjs', presses: [], pass: false };
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.EDUDOCK_QA_PROFILE;
  const app = await electron.launch({ executablePath, args: [], env });
  try {
    const first = await app.firstWindow();
    await first.waitForLoadState('domcontentloaded');
    const notch = app.windows().find(page => page.url().endsWith('/notch.html')) || first;
    await notch.waitForFunction(() => Boolean(window.portal));

    // Count what the main process receives, so a click that never became a request is visible.
    await app.evaluate(({ ipcMain }) => {
      globalThis.__menuCalls = [];
      const handlers = ipcMain._invokeHandlers;
      const original = handlers.get('open-menu');
      handlers.delete('open-menu');
      ipcMain.handle('open-menu', (event, value) => {
        globalThis.__menuCalls.push({ at: Date.now(), id: typeof value === 'string' ? value : value?.id });
        return original(event, value);
      });
    });

    // Let the automatic start-up operation finish; a press on top of it is refused by design.
    for (let attempt = 0; attempt < 240; attempt += 1) {
      const current = await notch.evaluate(() => window.portal.getState());
      if (attempt > 8 && !current.operation?.busy && !current.authenticationPending) break;
      await pause(250);
    }

    for (const menu of ['neis', 'edufine', 'attendance']) {
      await notch.evaluate(() => window.portal.notchInteraction({ type: 'expand' }));
      await notch.waitForFunction(() => document.body.dataset.state === 'expanded', undefined, { timeout: 5000 });
      await app.evaluate(() => { globalThis.__menuCalls = []; });
      // Watch the status stream from inside the renderer so the timestamp is the widget's own.
      await notch.evaluate(() => {
        window.__seen = [];
        window.__t0 = performance.now();
        window.portal.onStatus(status => window.__seen.push({ ms: Math.round(performance.now() - window.__t0), phase: status.phase }));
      });
      const clickedAt = Date.now();
      await notch.locator(`button[data-menu="${menu}"]`).click({ timeout: 5000 });
      await notch.waitForFunction(() => window.__seen.length > 0, undefined, { timeout: 10000 }).catch(() => {});
      await pause(400);
      const seen = await notch.evaluate(() => window.__seen);
      const calls = await app.evaluate(() => globalThis.__menuCalls);
      report.presses.push({
        menu, clicks: 1, ipcCalls: calls.length, ipcIds: calls.map(call => call.id),
        firstStatusMs: seen[0]?.ms ?? null, firstPhase: seen[0]?.phase ?? null,
        ipcDelayMs: calls[0] ? calls[0].at - clickedAt : null,
      });
      // Stop the operation so the next press is not refused as '이전 작업이 진행 중'.
      await notch.evaluate(() => window.portal.cancelAuth()).catch(() => {});
      await pause(1500);
    }
    report.pass = report.presses.every(press => press.ipcCalls === 1 && press.firstStatusMs !== null && press.firstStatusMs < 500);
  } catch (error) {
    report.error = String(error.stack || error).slice(0, 600);
  } finally {
    fs.writeFileSync(path.join(evidence, 'report.json'), JSON.stringify(report, null, 2));
    await app.close().catch(() => {});
  }
  process.stdout.write(JSON.stringify(report, null, 2) + String.fromCharCode(10));
  process.exitCode = report.pass ? 0 : 1;
})();
