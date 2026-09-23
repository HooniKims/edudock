'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { _electron: electron } = require('playwright-core');

const root = path.resolve(__dirname, '..');
const evidence = path.join(root, 'artifacts', 'qa', 'v2', '04-placement', `tray-attempt-${Date.now()}`);
const profile = path.join(evidence, 'profile');
const errorFile = path.join(evidence, 'bootstrap-error.txt');
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

function powershell(script) {
  return new Promise((resolve, reject) => {
    const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-Command', script], { windowsHide: true });
    let stderr = '';
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.once('error', reject);
    child.once('exit', code => code === 0 ? resolve() : reject(new Error(`PowerShell ${code}: ${stderr}`)));
  });
}

(async () => {
  fs.mkdirSync(profile, { recursive: true });
  fs.writeFileSync(path.join(profile, 'settings.json'), JSON.stringify({ schemaVersion: 4, alwaysOnTop: true, displayMode: 'expanded', placement: { edge: 'right', monitorId: null, offsets: { top: 0.5, right: 0.5, bottom: 0.5, left: 0.5 }, scale: 1, lastEdges: { horizontal: 'top', vertical: 'right' } }, buttons: ['portal', 'neis', 'attendance', 'trip', 'draft', 'compose'] }, null, 2));
  const entry = path.join(__dirname, 'qa-v2-tray-entry.cjs');
  const app = await electron.launch({ args: [entry], cwd: root, env: { ...process.env, EDUDOCK_QA_PROFILE: profile, EDUDOCK_QA_TRAY_ERROR: errorFile } });
  const report = { invocation: 'node scripts/qa-v2-tray.cjs', nativeMenuInput: false, capturedProductionMenuCallback: true, errors: [], cleanup: {} };
  try {
    const notch = await app.firstWindow();
    await notch.waitForLoadState('domcontentloaded');
    await notch.waitForFunction(() => document.body.dataset.state === 'expanded');
    const menu = await app.evaluate(() => ({ labels: globalThis.__edudockQaTrayMenu?.items.map(item => item.label || item.type), tray: Boolean(globalThis.__edudockQaTray) }));
    assert.equal(menu.tray, true);
    assert.deepEqual(menu.labels.slice(0, 2), ['노치 보이기', '노치 숨기기']);
    const handle = await notch.locator('.move-handle').boundingBox();
    const bounds = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find(window => window.webContents.getURL().endsWith('/notch.html')).getBounds());
    await notch.evaluate(point => window.portal.notchPlacement({ type: 'begin', mode: 'move', point }), { x: bounds.x + handle.x + handle.width / 2, y: bounds.y + handle.y + handle.height / 2 });
    await notch.locator('#status-button').click();
    await pause(120);
    await app.evaluate(() => globalThis.__edudockQaTrayMenu.items[1].click());
    await pause(300);
    const hidden = await app.evaluate(({ BrowserWindow }) => {
      const windows = BrowserWindow.getAllWindows();
      const notchWindow = windows.find(window => window.webContents.getURL().endsWith('/notch.html'));
      const popup = windows.find(window => window.webContents.getURL().endsWith('/popup.html'));
      return { visible: notchWindow.isVisible(), popupVisible: Boolean(popup?.isVisible()) };
    });
    assert.deepEqual(hidden, { visible: false, popupVisible: false });
    const interaction = await notch.evaluate(() => window.portal.getState()).then(value => value.interaction);
    assert.equal(interaction.placing, false);
    await pause(700);
    assert.equal(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find(window => window.webContents.getURL().endsWith('/notch.html')).isVisible()), false);
    await app.evaluate(() => globalThis.__edudockQaTrayMenu.items[0].click());
    await pause(300);
    assert.equal(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find(window => window.webContents.getURL().endsWith('/notch.html')).isVisible()), true);
    assert.equal(fs.existsSync(errorFile), false);
    report.menu = menu;
    report.hide = { ...hidden, placementCancelled: true, remainedHiddenAfter700ms: true };
    report.show = { visible: true };
    report.pass = true;
  } finally {
    await app.close().catch(() => {});
    await pause(500);
    if (fs.existsSync(profile)) await powershell(`$target=[IO.Path]::GetFullPath('${profile.replaceAll("'", "''")}');[IO.Directory]::Delete($target,$true)`);
    report.cleanup = { appClosed: true, profileRemoved: !fs.existsSync(profile), bootstrapError: fs.existsSync(errorFile) ? fs.readFileSync(errorFile, 'utf8') : null };
    fs.writeFileSync(path.join(evidence, 'report.json'), JSON.stringify(report, null, 2));
  }
  assert.equal(report.cleanup.profileRemoved, true);
  console.log(JSON.stringify({ pass: report.pass, report: path.relative(root, path.join(evidence, 'report.json')) }, null, 2));
})().catch(error => { console.error(error); process.exitCode = 1; });
