'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { _electron: electron } = require('playwright-core');
const { sanitizedSettings } = require('../src/settings.cjs');

const root = path.resolve(__dirname, '..');
const evidenceRoot = path.join(root, 'artifacts', 'qa', 'v2', '05-login', 'auto-setting');
const attempt = path.join(evidenceRoot, `attempt-${Date.now()}`);
const profile = path.join(attempt, 'profile');
const relative = file => path.relative(root, file).replaceAll('\\', '/');
const sha256 = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');

async function startupScenario(autoLogin, name) {
  const log = path.join(attempt, `${name}-open-external.json`);
  fs.writeFileSync(path.join(profile, 'settings.json'), JSON.stringify({ ...sanitizedSettings({}), autoLogin }, null, 2));
  const instance = await electron.launch({
    args: [path.join(root, 'scripts', 'qa-v2-auth-setting-bootstrap.cjs')],
    cwd: root,
    env: { ...process.env, EDUDOCK_QA_PROFILE: profile, EDUDOCK_QA_OPEN_EXTERNAL_LOG: log },
  });
  try {
    await instance.firstWindow();
    await new Promise(resolve => setTimeout(resolve, 800));
    return fs.existsSync(log) ? JSON.parse(fs.readFileSync(log, 'utf8')) : [];
  } finally {
    await instance.close().catch(() => {});
  }
}

async function capture(page, name) {
  const file = path.join(attempt, name);
  await page.screenshot({ path: file });
  const bytes = fs.readFileSync(file);
  assert.ok(bytes.length > 100);
  return { file: relative(file), bytes: bytes.length, sha256: sha256(file) };
}

(async () => {
  fs.mkdirSync(profile, { recursive: true });
  const app = await electron.launch({
    args: ['.'],
    cwd: root,
    env: { ...process.env, EDUDOCK_QA_PROFILE: profile },
  });
  await app.evaluate(({ shell }) => {
    globalThis.__autoLoginQaOriginalOpenExternal = shell.openExternal.bind(shell);
    globalThis.__autoLoginQaOpenExternalCalls = [];
    shell.openExternal = async url => { globalThis.__autoLoginQaOpenExternalCalls.push(String(url)); };
  });
  const report = {
    invocation: 'node scripts/qa-v2-auth-setting.cjs',
    pageClickSelector: '#auto-login',
    scenarios: {},
    screenshots: [],
    limitations: ['This setting-surface run did not launch or inspect ordinary Edge.', 'Automatic session observation remains unavailable and is not claimed.'],
    cleanup: {},
  };
  try {
    const first = await app.firstWindow();
    await first.waitForLoadState('domcontentloaded');
    const notch = app.windows().find(page => page.url().endsWith('/notch.html')) || first;
    await notch.evaluate(() => window.portal.openAuxiliary('settings'));
    let settingsPage;
    for (let attemptIndex = 0; attemptIndex < 50 && !settingsPage; attemptIndex += 1) {
      settingsPage = app.windows().find(page => page.url().includes('/index.html') && page.url().includes('auxiliary=1'));
      if (!settingsPage) await new Promise(resolve => setTimeout(resolve, 100));
    }
    assert.ok(settingsPage, 'settings auxiliary window did not open');
    await settingsPage.waitForSelector('#settings-view:not([hidden])');
    await new Promise(resolve => setTimeout(resolve, 600));
    const toggle = settingsPage.locator('#auto-login');
    await settingsPage.evaluate(() => {
      window.__autoLoginQaStatuses = [];
      window.portal.onStatus(status => window.__autoLoginQaStatuses.push({ phase: status.phase, busy: status.busy }));
    });
    assert.equal(await toggle.isChecked(), false);
    const initialState = await settingsPage.evaluate(() => window.portal.getState());
    assert.equal(initialState.settings.autoLogin, false);
    assert.equal(await app.evaluate(() => globalThis.__autoLoginQaOpenExternalCalls.length), 0);
    report.screenshots.push(await capture(settingsPage, '01-auto-login-off.png'));

    await toggle.click();
    await settingsPage.waitForFunction(() => window.portal.getState().then(state => state.settings.autoLogin === true));
    const persistedOn = JSON.parse(fs.readFileSync(path.join(profile, 'settings.json'), 'utf8'));
    assert.equal(persistedOn.autoLogin, true);
    const phasesBeforeReload = await settingsPage.evaluate(() => window.__autoLoginQaStatuses.map(status => status.phase));
    report.screenshots.push(await capture(settingsPage, '02-auto-login-on.png'));

    await settingsPage.reload({ waitUntil: 'domcontentloaded' });
    await settingsPage.evaluate(() => window.portal.openAuxiliary('settings'));
    await settingsPage.waitForSelector('#settings-view:not([hidden])');
    await settingsPage.evaluate(() => {
      window.__autoLoginQaStatuses = [];
      window.portal.onStatus(status => window.__autoLoginQaStatuses.push({ phase: status.phase, busy: status.busy }));
    });
    assert.equal(await settingsPage.locator('#auto-login').isChecked(), true);
    const reloadedState = await settingsPage.evaluate(() => window.portal.getState());
    assert.equal(reloadedState.settings.autoLogin, true);

    await settingsPage.locator('#auto-login').click();
    await settingsPage.waitForFunction(() => window.portal.getState().then(state => state.settings.autoLogin === false));
    const persistedOff = JSON.parse(fs.readFileSync(path.join(profile, 'settings.json'), 'utf8'));
    assert.equal(persistedOff.autoLogin, false);
    const phasesAfterReload = await settingsPage.evaluate(() => window.__autoLoginQaStatuses.map(status => status.phase));
    const statusPhases = [...phasesBeforeReload, ...phasesAfterReload];
    const externalCalls = await app.evaluate(() => [...globalThis.__autoLoginQaOpenExternalCalls]);
    assert.deepEqual(externalCalls, []);
    assert.equal(statusPhases.includes('opening'), false);
    assert.equal(statusPhases.includes('authenticated'), false);
    report.scenarios = {
      defaultOff: { pass: true },
      exactPageClick: { selector: '#auto-login', pass: true },
      ipcRoundtripOn: { state: true, persisted: persistedOn.autoLogin, pass: true },
      rendererReload: { checked: true, state: reloadedState.settings.autoLogin, pass: true },
      disableAndPersist: { state: false, persisted: persistedOff.autoLogin, pass: true },
      toggleDoesNotInitiateLogin: { observedPhases: statusPhases, openingObserved: false, pass: true },
      shellOpenExternal: { calls: externalCalls, callCount: externalCalls.length, pass: externalCalls.length === 0 },
      noLoginClaim: { authenticatedStatusObserved: false, pass: true },
    };
    await app.close();
    const enabledStartupCalls = await startupScenario(true, 'startup-enabled');
    const disabledStartupCalls = await startupScenario(false, 'startup-disabled');
    assert.deepEqual(enabledStartupCalls, ['microsoft-edge:https://sen.eduptl.kr']);
    assert.deepEqual(disabledStartupCalls, []);
    report.scenarios.enabledFreshProcess = { calls: enabledStartupCalls, callCount: enabledStartupCalls.length, pass: true };
    report.scenarios.disabledFreshProcess = { calls: disabledStartupCalls, callCount: disabledStartupCalls.length, pass: true };
    report.pass = true;
  } finally {
    await app.evaluate(({ shell }) => {
      if (globalThis.__autoLoginQaOriginalOpenExternal) shell.openExternal = globalThis.__autoLoginQaOriginalOpenExternal;
    }).catch(() => {});
    await app.close().catch(() => {});
    await fs.promises.rm(profile, { recursive: true, force: true });
    report.cleanup = { electronClosed: true, ownedProfileRemoved: !fs.existsSync(profile), ordinaryEdgeUntouched: true };
    fs.mkdirSync(evidenceRoot, { recursive: true });
    fs.writeFileSync(path.join(attempt, 'report.json'), JSON.stringify(report, null, 2));
    fs.writeFileSync(path.join(evidenceRoot, 'latest.json'), JSON.stringify({ attempt: relative(attempt), report: relative(path.join(attempt, 'report.json')) }, null, 2));
  }
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
})().catch(error => {
  process.stderr.write(`${error.stack || error}\n`);
  process.exitCode = 1;
});
