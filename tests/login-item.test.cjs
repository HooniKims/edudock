'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { createLoginItem, loginItemMode, launchCommand, approvedDisabled } = require('../src/login-item.cjs');
const { sanitizedSettings, cleanPatch } = require('../src/settings.cjs');

const RUN = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run';
const APPROVED = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\StartupApproved\\Run';

// A tiny in-memory registry answering reg.exe the way it does: exit 1 for a missing value.
function fakeRegistry(initial = {}) {
  const values = { ...initial };
  const calls = [];
  async function run(args) {
    calls.push(args);
    const [verb, key, , name] = args;
    const id = `${key}|${name}`;
    if (verb === 'query') {
      if (!(id in values)) return { code: 1, stdout: '' };
      const type = key === APPROVED ? 'REG_BINARY' : 'REG_SZ';
      return { code: 0, stdout: `\r\n${key}\r\n    ${name}    ${type}    ${values[id]}\r\n` };
    }
    if (verb === 'add') { values[id] = args[args.indexOf('/d') + 1]; return { code: 0, stdout: '' }; }
    if (verb === 'delete') { if (!(id in values)) return { code: 1, stdout: '' }; delete values[id]; return { code: 0, stdout: '' }; }
    throw new Error(`unexpected ${verb}`);
  }
  return { run, values, calls };
}

const COMMAND = '"C:\\Users\\김 형훈\\AppData\\Local\\Programs\\EduDock\\EduDock.exe" --autostart';

test('only the installed and portable copies register themselves', () => {
  assert.equal(loginItemMode({ platform: 'win32', isPackaged: true, windowsStore: false }), 'self');
  assert.equal(loginItemMode({ platform: 'win32', isPackaged: true, windowsStore: true }), 'store');
  assert.equal(loginItemMode({ platform: 'win32', isPackaged: false, windowsStore: false }), 'development');
  assert.equal(loginItemMode({ platform: 'darwin', isPackaged: true, windowsStore: false }), 'development');
});

test('the Run entry names the exe the teacher keeps, quoted, with the autostart marker', () => {
  assert.equal(launchCommand({ execPath: 'C:\\Programs\\EduDock\\EduDock.exe', env: {} }), '"C:\\Programs\\EduDock\\EduDock.exe" --autostart');
  // A portable copy runs from a temporary folder; the entry must point at the exe itself.
  assert.equal(launchCommand({ execPath: 'C:\\Temp\\x\\EduDock.exe', env: { PORTABLE_EXECUTABLE_FILE: 'D:\\도구\\EduDock-Portable.exe' } }), '"D:\\도구\\EduDock-Portable.exe" --autostart');
});

test('Task Manager "disabled" is an odd first byte in StartupApproved', () => {
  assert.equal(approvedDisabled('    EduDock    REG_BINARY    030000000000000000000000'), true);
  assert.equal(approvedDisabled('    EduDock    REG_BINARY    020000000000000000000000'), false);
  assert.equal(approvedDisabled(null), false);
});

test('launch sync writes the entry and reports it enabled', async () => {
  const registry = fakeRegistry();
  const item = createLoginItem({ mode: 'self', command: COMMAND, run: registry.run });
  assert.deepEqual(await item.sync(true), { mode: 'self', enabled: true });
  assert.equal(registry.values[`${RUN}|EduDock`], COMMAND);
});

test('launch sync keeps an entry the teacher switched off in Task Manager switched off', async () => {
  const registry = fakeRegistry({ [`${RUN}|EduDock`]: '"C:\\old\\EduDock.exe" --autostart', [`${APPROVED}|EduDock`]: '030000000000000000000000' });
  const item = createLoginItem({ mode: 'self', command: COMMAND, run: registry.run });
  assert.deepEqual(await item.sync(true), { mode: 'self', enabled: false });
  assert.equal(registry.values[`${RUN}|EduDock`], COMMAND, 'the path is still brought up to date');
  assert.equal(registry.values[`${APPROVED}|EduDock`], '030000000000000000000000');
});

test('the settings switch is explicit: on clears a Task Manager "disabled", off removes the entry', async () => {
  const registry = fakeRegistry({ [`${APPROVED}|EduDock`]: '030000000000000000000000' });
  const item = createLoginItem({ mode: 'self', command: COMMAND, run: registry.run });
  assert.deepEqual(await item.set(true), { mode: 'self', enabled: true });
  assert.equal(`${APPROVED}|EduDock` in registry.values, false);
  assert.deepEqual(await item.set(false), { mode: 'self', enabled: false });
  assert.equal(`${RUN}|EduDock` in registry.values, false);
});

test('the Store and development copies never touch the registry', async () => {
  for (const mode of ['store', 'development']) {
    const registry = fakeRegistry();
    const item = createLoginItem({ mode, command: COMMAND, run: registry.run });
    assert.deepEqual(await item.sync(true), { mode, enabled: false });
    assert.deepEqual(await item.set(true), { mode, enabled: false });
    assert.deepEqual(registry.calls, []);
  }
});

test('starting with Windows is on by default, also for settings saved before it existed', () => {
  assert.equal(sanitizedSettings({}).launchAtLogin, true);
  assert.equal(sanitizedSettings({ schemaVersion: 4, autoLogin: true }).launchAtLogin, true);
  assert.equal(sanitizedSettings({ schemaVersion: 4, launchAtLogin: false }).launchAtLogin, false);
  assert.equal(cleanPatch({ launchAtLogin: 'yes' }).launchAtLogin, undefined);
});

test('main syncs at launch, switches through its own request, and the uninstaller removes the entry', () => {
  const main = fs.readFileSync(path.join(__dirname, '../src/main.cjs'), 'utf8');
  assert.match(main, /loginItem\.sync\(settings\.launchAtLogin === true\)/);
  assert.match(main, /handle\('launch-at-login', \['auxiliary'\]/);
  assert.match(main, /delete cleaned\.launchAtLogin;/);
  const nsh = fs.readFileSync(path.join(__dirname, '../build/installer.nsh'), 'utf8');
  const uninstall = nsh.slice(nsh.indexOf('!macro customUnInstall'));
  assert.ok(uninstall.indexOf('${ifNot} ${isUpdated}') < uninstall.indexOf('DeleteRegValue HKCU "Software\\Microsoft\\Windows\\CurrentVersion\\Run" "EduDock"'));
  const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '../package.json'), 'utf8'));
  assert.equal(pkg.build.appx.addAutoLaunchExtension, true);
});
