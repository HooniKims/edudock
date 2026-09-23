'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { _electron: electron } = require('playwright-core');

const root = path.resolve(__dirname, '..');
const evidenceRoot = path.join(root, 'artifacts', 'qa', 'v2', '06-main-menus', 'primary-ui');
const attempt = path.join(evidenceRoot, `attempt-${Date.now()}`);
const profile = path.join(attempt, 'profile');
const relative = value => path.relative(root, value).replaceAll('\\', '/');
const pause = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));

function processExists(pid) {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

async function removeOwnedProfile() {
  const resolvedProfile = path.resolve(profile);
  const resolvedAttempt = path.resolve(attempt);
  assert.ok(resolvedProfile.startsWith(`${resolvedAttempt}${path.sep}`), 'unsafe profile cleanup target');
  await fs.promises.rm(resolvedProfile, { recursive: true, force: true });
  return !fs.existsSync(resolvedProfile);
}

async function main() {
  fs.mkdirSync(profile, { recursive: true });
  const report = {
    invocation: 'node scripts/qa-v2-primary-tools-ui.cjs',
    scenario: 'isolated Electron notch shows NEIS and K-EduFine primary controls with open-menu intercepted before clicks',
    intercept: 'ipcMain.removeHandler/open-menu followed by an in-process QA handler; PortalAutomation and browser launch are bypassed',
    selectors: ['.actions [data-menu="neis"]', '.actions [data-menu="edufine"]'],
    pass: false,
    observable: {},
    cleanup: {},
  };
  let app;
  let notch;
  let electronPid;
  let scenarioError;
  try {
    app = await electron.launch({ args: ['.'], cwd: root, env: { ...process.env, EDUDOCK_QA_PROFILE: profile } });
    electronPid = await app.evaluate(() => process.pid);
    notch = app.windows().find(page => page.url().endsWith('/notch.html')) || await app.firstWindow();
    await notch.waitForSelector('.actions [data-menu="neis"]');
    await notch.waitForSelector('.actions [data-menu="edufine"]');
    await app.evaluate(({ ipcMain, shell }) => {
      ipcMain.removeHandler('open-menu');
      ipcMain.removeHandler('show-popover');
      globalThis.__primaryToolsRequests = [];
      globalThis.__primaryToolsTooltips = [];
      globalThis.__primaryToolsExternalCalls = 0;
      ipcMain.handle('open-menu', (_event, id) => {
        globalThis.__primaryToolsRequests.push(id);
        return { ok: true, phase: 'opened', message: 'QA interception: navigation suppressed.' };
      });
      ipcMain.handle('show-popover', (_event, data) => {
        globalThis.__primaryToolsTooltips.push(data);
        return { ok: true };
      });
      const originalOpenExternal = shell.openExternal.bind(shell);
      shell.openExternal = async (...args) => {
        globalThis.__primaryToolsExternalCalls += 1;
        return originalOpenExternal(...args);
      };
    });
    await app.evaluate(({ BrowserWindow }) => {
      const window = BrowserWindow.getAllWindows().find(candidate => candidate.webContents.getURL().endsWith('/notch.html'));
      window.show();
      window.focus();
    });
    await notch.evaluate(() => window.portal.notchInteraction({ type: 'pointer', value: true }));
    await pause(250);
    await notch.waitForFunction(() => document.body.dataset.state === 'expanded');
    await notch.screenshot({ path: path.join(attempt, 'primary-tools-expanded.png'), omitBackground: true });

    const surface = await notch.evaluate(() => ({
      order: [...document.querySelectorAll('.actions [data-button]')].map(button => button.dataset.button),
      settingsLast: document.querySelector('.actions button:last-child')?.dataset.auxiliary === 'settings',
      menus: [...document.querySelectorAll('.actions [data-menu]')].map(button => ({ id: button.dataset.menu, label: button.getAttribute('aria-label'), visible: button.getBoundingClientRect().width > 0 && button.getBoundingClientRect().height > 0 })),
      portalCount: document.querySelectorAll('.actions [data-menu="portal"]').length,
      neisCount: document.querySelectorAll('.actions [data-menu="neis"]').length,
      edufineCount: document.querySelectorAll('.actions [data-menu="edufine"]').length,
    }));
    await notch.locator('.actions [data-menu="neis"]').focus();
    await notch.keyboard.press('ArrowDown');
    const keyboardNext = await notch.evaluate(() => document.activeElement?.dataset.button || null);
    await notch.locator('.actions [data-menu="neis"]').hover();
    await pause(150);
    await notch.locator('.actions [data-menu="neis"]').click();
    await notch.locator('.actions [data-menu="edufine"]').click();
    const intercepted = await app.evaluate(() => ({ requests: globalThis.__primaryToolsRequests, tooltips: globalThis.__primaryToolsTooltips, externalCalls: globalThis.__primaryToolsExternalCalls }));
    const tooltip = intercepted.tooltips.find(data => data.kind === 'tooltip')?.label || null;

    report.observable = { surface, keyboardNext, tooltip, intercepted };
    report.pass = JSON.stringify(surface.order) === JSON.stringify(['neis', 'edufine', 'attendance', 'trip', 'draft', 'compose'])
      && surface.neisCount === 1
      && surface.edufineCount === 1
      && surface.portalCount === 0
      && surface.settingsLast
      && surface.menus.every(menu => menu.visible)
      && surface.menus.find(menu => menu.id === 'neis')?.label === '나이스'
      && surface.menus.find(menu => menu.id === 'edufine')?.label === 'K-에듀파인'
      && keyboardNext === 'edufine'
      && tooltip === '나이스'
      && JSON.stringify(intercepted.requests) === JSON.stringify(['neis', 'edufine'])
      && intercepted.externalCalls === 0;
    assert.equal(report.pass, true, 'primary tool UI assertions failed');
  } catch (error) {
    scenarioError = error;
    report.error = {
      name: error instanceof Error ? error.name : 'UnknownError',
      message: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack?.split(/\r?\n/).slice(0, 8) : null,
    };
  } finally {
    if (app) await app.evaluate(({ app: electronApp }) => electronApp.exit(0)).catch(() => {});
    for (let index = 0; index < 20 && electronPid && processExists(electronPid); index += 1) await pause(100);
    report.cleanup = {
      ownedElectronPid: electronPid || null,
      ownedElectronExited: electronPid ? !processExists(electronPid) : true,
      ownedProfileRemoved: await removeOwnedProfile(),
      installedAppTouched: false,
      externalBrowserLaunched: false,
    };
    fs.writeFileSync(path.join(attempt, 'report.json'), `${JSON.stringify(report, null, 2)}\n`);
    fs.mkdirSync(evidenceRoot, { recursive: true });
    fs.writeFileSync(path.join(evidenceRoot, 'latest.json'), `${JSON.stringify({ attempt: relative(attempt), report: relative(path.join(attempt, 'report.json')) }, null, 2)}\n`);
  }
  process.stdout.write(`${JSON.stringify({ pass: report.pass, report: relative(path.join(attempt, 'report.json')), cleanup: report.cleanup }, null, 2)}\n`);
  if (scenarioError) throw scenarioError;
  if (!report.pass) process.exitCode = 1;
}

main().catch(error => {
  process.stderr.write(`${error instanceof Error ? error.stack : error}\n`);
  process.exitCode = 1;
});
