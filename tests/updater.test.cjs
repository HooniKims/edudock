'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { createUpdater, isNewer, RELEASE_REPOSITORY } = require('../src/updater.cjs');

const repository = { owner: 'someone', repo: 'edudock' };
const app = (packaged = true, version = '1.0.0') => ({ isPackaged: packaged, getVersion: () => version });

test('version comparison ignores a leading v and compares numerically', () => {
  assert.equal(isNewer('v1.0.10', '1.0.9'), true);
  assert.equal(isNewer('1.0.0', '1.0.0'), false);
  assert.equal(isNewer('0.9.30', '1.0.0'), false);
  assert.equal(isNewer('garbage', '1.0.0'), false);
});

test('development runs never check', async () => {
  let loaded = false;
  const updater = createUpdater({ app: app(false), repository, env: {}, loadAutoUpdater: () => { loaded = true; } });
  assert.equal(updater.state.phase, 'disabled');
  await updater.check();
  assert.equal(loaded, false);
});

test('portable copy reports a newer GitHub release and links only to github.com', async () => {
  const net = { fetch: async url => { assert.match(url, /api\.github\.com\/repos\/someone\/edudock\/releases\/latest/); return { ok: true, json: async () => ({ tag_name: 'v1.2.0', html_url: 'https://github.com/someone/edudock/releases/tag/v1.2.0' }) }; } };
  const opened = [];
  const updater = createUpdater({ app: app(true, '1.0.0'), repository, net, shell: { openExternal: url => opened.push(url) }, env: { PORTABLE_EXECUTABLE_DIR: 'C:/x' } });
  const state = await updater.check();
  assert.equal(state.mode, 'portable');
  assert.equal(state.phase, 'available');
  assert.equal(state.available, '1.2.0');
  await updater.openReleasePage();
  assert.deepEqual(opened, ['https://github.com/someone/edudock/releases/tag/v1.2.0']);
  assert.equal(updater.install(), false);
});

test('portable copy ignores a non-GitHub page link and stays calm offline', async () => {
  const hostile = createUpdater({ app: app(true, '1.0.0'), repository, net: { fetch: async () => ({ ok: true, json: async () => ({ tag_name: '2.0.0', html_url: 'https://evil.example/' }) }) }, shell: {}, env: { PORTABLE_EXECUTABLE_DIR: 'C:/x' } });
  assert.equal((await hostile.check()).releaseUrl, 'https://github.com/someone/edudock/releases/latest');
  const offline = createUpdater({ app: app(true), repository, net: { fetch: async () => { throw new Error('net::ERR_INTERNET_DISCONNECTED'); } }, env: { PORTABLE_EXECUTABLE_DIR: 'C:/x' } });
  const state = await offline.check();
  assert.equal(state.phase, 'error');
  assert.match(state.message, /인터넷/);
});

test('installed copy asks first: nothing downloads until download(), nothing installs until install()', async () => {
  const fake = new EventEmitter();
  let downloads = 0;
  let installed = null;
  fake.checkForUpdates = async () => { fake.emit('checking-for-update'); fake.emit('update-available', { version: '1.1.0' }); };
  fake.downloadUpdate = async () => {
    downloads += 1;
    fake.emit('download-progress', { percent: 42.4 });
    fake.emit('update-downloaded', { version: '1.1.0' });
  };
  fake.quitAndInstall = (silent, relaunch) => { installed = { silent, relaunch }; };
  const phases = [];
  const updater = createUpdater({ app: app(true, '1.0.0'), repository, env: {}, loadAutoUpdater: () => fake, onChange: state => phases.push(state.phase) });
  const found = await updater.check();
  assert.equal(fake.autoDownload, false, 'electron-updater must not download on its own');
  assert.equal(fake.autoInstallOnAppQuit, true);
  assert.equal(found.phase, 'available');
  assert.equal(found.available, '1.1.0');
  assert.equal(downloads, 0);
  assert.equal(updater.install(), false, 'nothing to install before a download');

  // A later periodic check while the question is still open keeps the same offer.
  assert.equal((await updater.check()).phase, 'available');

  assert.equal(await updater.download(), true);
  assert.equal(downloads, 1);
  assert.equal(updater.state.phase, 'ready');
  assert.equal(await updater.download(), false, 'no second download once ready');
  assert.deepEqual([...new Set(phases)], ['checking', 'available', 'downloading', 'ready']);
  assert.equal(updater.install(), true);
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(installed, { silent: true, relaunch: true });
});

test('a failed download is reported and the offer can be retried by checking again', async () => {
  const fake = new EventEmitter();
  fake.checkForUpdates = async () => { fake.emit('update-available', { version: '1.1.0' }); };
  fake.downloadUpdate = async () => { throw new Error('net::ERR_CONNECTION_RESET'); };
  const updater = createUpdater({ app: app(true, '1.0.0'), repository, env: {}, loadAutoUpdater: () => fake });
  await updater.check();
  assert.equal(await updater.download(), false);
  assert.equal(updater.state.phase, 'error');
  assert.match(updater.state.message, /인터넷/);
  assert.equal((await updater.check()).phase, 'available');
});

test('updates are checked every 15 minutes and the widget asks before downloading and before installing', () => {
  const fs = require('node:fs');
  const source = fs.readFileSync('src/updater.cjs', 'utf8');
  assert.match(source, /const CHECK_INTERVAL_MS = 15 \* 60 \* 1000;/);
  const main = fs.readFileSync('src/main.cjs', 'utf8');
  assert.doesNotMatch(main, /showMessageBox/, 'asked in the widget popover, not a system dialog');
  assert.match(main, /popover\.show\(\{ kind: 'update'/);
  assert.match(main, /if \(automation\?\.busy \|\| guide \|\|/, 'never interrupts a login or the guide');
  assert.match(main, /if \(answer\.accepted !== true\) return \{ ok: true, accepted: false \};/, 'only an explicit yes acts');
  assert.match(main, /if \(updateQuestion && request\.kind === 'tooltip'\) return/);
  const popup = fs.readFileSync('renderer/popup.js', 'utf8');
  assert.match(popup, /element\('update-yes'\)\.addEventListener\('click', \(\) => answerUpdate\(true\)\)/);
  assert.match(popup, /if \(currentData\.kind === 'update'\) \{ answerUpdate\(false\); return; \}/, 'Escape means later');
});

test('release config publishes both exe targets to GitHub', () => {
  const manifest = require('../package.json');
  assert.equal(manifest.build.publish.provider, 'github');
  assert.deepEqual(manifest.build.win.target.map(item => item.target), ['nsis', 'portable']);
  assert.ok(manifest.dependencies['electron-updater']);
});

test('runtime update source matches the publish config and main never reads the build section', () => {
  const fs = require('node:fs');
  const manifest = require('../package.json');
  assert.equal(RELEASE_REPOSITORY.owner, manifest.build.publish.owner);
  assert.equal(RELEASE_REPOSITORY.repo, manifest.build.publish.repo);
  // electron-builder strips "build" from the packaged package.json.
  const main = fs.readFileSync('src/main.cjs', 'utf8');
  assert.doesNotMatch(main, /manifest\.build|package\.json'\)\.build/);
  assert.match(main, /try \{\s*updater = createUpdater/);
});

test('a release that is not there yet is explained plainly, not as a failure', async () => {
  const fake = new EventEmitter();
  fake.checkForUpdates = async () => { throw new Error('Cannot find latest.yml in the latest release artifacts (https://github.com/x/y/releases/download/v1/latest.yml): HttpError: 404'); };
  const updater = createUpdater({ app: app(true, '1.0.0'), repository, env: {}, loadAutoUpdater: () => fake, now: () => 1234 });
  const state = await updater.check();
  assert.equal(state.phase, 'error');
  assert.equal(state.message, '아직 받을 수 있는 새 버전이 없어요.');
  assert.equal(state.checkedAt, 1234);
});

test('update actions open settings scrolled to the update row', () => {
  const fs = require('node:fs');
  const main = fs.readFileSync('src/main.cjs', 'utf8');
  assert.match(main, /else \{ showAuxiliary\('settings', 'update'\); void updater\?\.download\(\); \}/);
  assert.match(main, /if \(focusSection\) window\.webContents\.send\('aux-section', focusSection\);/);
  const renderer = fs.readFileSync('renderer/renderer.js', 'utf8');
  assert.match(renderer, /row\.scrollIntoView\(\{ block: 'center'/);
});
