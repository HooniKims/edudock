'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { loadSettings, saveSettings, cleanPatch, sanitizedSettings } = require('../src/settings.cjs');
const { PortalAutomation } = require('../src/portal.cjs');

function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

test('auto-login defaults off and valid booleans survive save and reload', () => {
  assert.equal(sanitizedSettings({}).autoLogin, false);
  assert.deepEqual(cleanPatch({ autoLogin: true }), { autoLogin: true });
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'edudock-auto-login-'));
  try {
    saveSettings(directory, { ...sanitizedSettings({}), autoLogin: true });
    assert.equal(loadSettings(directory).autoLogin, true);
    saveSettings(directory, { ...sanitizedSettings({}), autoLogin: false });
    assert.equal(loadSettings(directory).autoLogin, false);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('malformed auto-login values are ignored and resolve to the safe off default', () => {
  for (const value of ['true', 1, null, {}, []]) {
    assert.deepEqual(cleanPatch({ autoLogin: value }), {});
    assert.equal(sanitizedSettings({ autoLogin: value }).autoLogin, false);
  }
});

test('last successful certificate drive persists only as a normalized non-secret hint', () => {
  assert.equal(sanitizedSettings({ schemaVersion: 4, certificateDriveHint: 'D:' }).certificateDriveHint, 'D:');
  for (const value of ['DATA(D:)', 'd:', 'D:\\', '', 4, null]) assert.equal(sanitizedSettings({ schemaVersion: 4, certificateDriveHint: value }).certificateDriveHint, null);
});

test('disabled auto-login does not open Edge or report authentication success', async () => {
  const opened = [];
  const events = [];
  const automation = new PortalAutomation({
    status: event => events.push(event),
    autoLogin: false,
    openPortal: async url => { opened.push(url); },
  });
  const result = await automation.startAutoLogin();
  assert.equal(result.ok, false);
  assert.equal(result.phase, 'disabled');
  assert.deepEqual(opened, []);
  assert.equal(events.some(event => event.phase === 'authenticated' || event.phase === 'done'), false);
});

test('turning auto-login off cancels an in-flight automatic wait immediately', async () => {
  const handoff = deferred();
  const events = [];
  const automation = new PortalAutomation({
    status: event => events.push(event),
    autoLogin: true,
    openPortal: () => handoff.promise,
  });
  const pending = automation.startAutoLogin();
  await new Promise(resolve => setImmediate(resolve));
  const disabled = automation.setAutoLogin(false);
  assert.equal(disabled.autoLogin, false);
  assert.equal(disabled.cancelled, true);
  assert.equal((await pending).phase, 'cancelled');
  assert.equal(automation.busy, false);
  assert.equal(events.at(-1).phase, 'cancelled');
  handoff.resolve();
});

test('enabled auto-login permits the existing ordinary-Edge flow without inventing observer success', async () => {
  const opened = [];
  const automation = new PortalAutomation({
    status: () => {},
    autoLogin: true,
    openPortal: async url => { opened.push(url); },
  });
  const result = await automation.startAutoLogin();
  assert.deepEqual(opened, ['microsoft-edge:https://sen.eduptl.kr']);
  assert.equal(result.ok, false);
  assert.equal(result.phase, 'needs-user');
});

test('auto-login follows the stored password: saving turns it on, clearing turns it off, no password blocks it', () => {
  const fs = require('node:fs');
  const main = fs.readFileSync('src/main.cjs', 'utf8');
  assert.match(main, /passwordSaved: saved, autoLogin: saved/);
  assert.match(main, /cleaned\.autoLogin === true && settings\.passwordSaved !== true\) throw/);
  assert.match(main, /settings\.autoLogin && settings\.passwordSaved !== true\) settings = sanitizedSettings\(\{ \.\.\.settings, autoLogin: false \}\)/);
  const renderer = fs.readFileSync('renderer/renderer.js', 'utf8');
  assert.match(renderer, /element\('auto-login'\)\.disabled = !passwordSaved/);
});

test('a button pressed during the background login takes it over at once, without a "cancelled" flash', async () => {
  const events = [];
  let observations = 0;
  const automation = new PortalAutomation({
    status: event => events.push(event),
    autoLogin: true,
    openPortal: async () => {},
    observeAuthenticated: async () => { observations += 1; return observations > 3; },
    resumeAction: async id => ({ verified: true, id }),
    pause: () => new Promise(resolve => setImmediate(resolve)),
  });
  const background = automation.startAutoLogin();
  await new Promise(resolve => setImmediate(resolve));
  const pressed = await automation.openMenu('neis');
  assert.equal(pressed.ok, true, 'no "이전 작업이 진행 중" refusal inside the takeover grace');
  assert.equal(pressed.phase, 'done');
  assert.equal((await background).ok, false);
  assert.equal(events.some(event => event.phase === 'cancelled'), false);
});

test('the saved password is typed in only while auto-login is on, and nothing logs in until a button is pressed', () => {
  const main = fs.readFileSync('src/main.cjs', 'utf8');
  assert.match(main, /getStoredPassword: \(\) => \(settings\.passwordSaved === true && settings\.autoLogin === true \?/);
  // Launching the app, switching auto-login on or saving the password opens nothing by itself.
  assert.doesNotMatch(main, /startAutoLogin|startBackgroundLogin/);
  assert.match(main, /if \(!shouldAutoStart\(settings\)\) setTimeout\(showLaunchHint, 1500\);/);
  assert.match(main, /label: '버튼을 누르시면 해당 메뉴로 바로 이동합니다\.'/);
});
