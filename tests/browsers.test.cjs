'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { mkdtempSync, readFileSync, rmSync } = require('node:fs');
const vm = require('node:vm');
const { tmpdir } = require('node:os');
const { sanitizedSettings, cleanPatch, saveSettings, loadSettings } = require('../src/settings.cjs');
const { BROWSERS, setActiveBrowser, browserProfile, findBrowserExecutable, browserAvailability, requireBrowser, openBrowserUrl } = require('../src/browsers.cjs');
const { NativeOrdinaryEdgeBridge } = require('../src/ordinary-edge.cjs');
const { NativeDraftHandoffBridge } = require('../src/draft-handoff.cjs');

const absent = { env: {}, exists: () => false, readRegistry: () => null };
const installed = { env: { PROGRAMFILES: 'C:\\Program Files' }, exists: () => true, readRegistry: () => null };

test('all three browser labels have natural Korean installation messages in errors and settings', () => {
  const source = readFileSync(path.join(__dirname, '../renderer/renderer.js'), 'utf8');
  const elements = { 'browser-select': { replaceChildren() {} }, 'browser-help': {} };
  const context = vm.createContext({ element: id => elements[id], document: { createElement: () => ({}) } });
  for (const name of ['renderBrowser', 'diagnosticLines']) {
    const start = source.indexOf(`function ${name}(`);
    assert.ok(start >= 0);
    vm.runInContext(source.slice(start, source.indexOf('\n}', start) + 2), context);
  }
  for (const { id, label } of BROWSERS) {
    assert.throws(() => requireBrowser(id, absent), { message: `${label}: 설치되지 않았습니다. 브라우저를 설치하거나 설정에서 다른 브라우저를 선택해 주세요.` });
    context.renderBrowser({ settings: { browser: id }, browsers: [{ id, label, installed: false }] });
    assert.equal(elements['browser-help'].textContent, `${label}: 설치되지 않았습니다. 설치하거나 다른 브라우저를 선택해 주세요.`);
    assert.equal(context.diagnosticLines({ browserLabel: label, browserInstalled: true })[0].title, `${label}: 설치되어 있어요.`);
    assert.equal(context.diagnosticLines({ browserLabel: label, browserInstalled: false })[0].title, `${label}: 설치되지 않았어요.`);
  }
});

test('executable launch failures do not attach a Korean particle to a browser label', async () => {
  for (const browser of ['aside', 'chrome']) {
    await assert.rejects(openBrowserUrl('https://example.com/', { browser, discovery: installed, spawnProcess: () => {
      const child = new EventEmitter();
      queueMicrotask(() => child.emit('error', new Error('test launch failure')));
      return child;
    } }), { message: `${browserProfile(browser).label} 실행에 실패했습니다. 설치 상태를 확인해 주세요.` });
  }
});

test('ordinary browser helper stays UTF-8 without a BOM', () => {
  const bytes = readFileSync(path.join(__dirname, '../src/native/ordinary-edge.ps1'));
  assert.equal(bytes.subarray(0, 3).equals(Buffer.from([0xef, 0xbb, 0xbf])), false);
});

test('browser settings keep Edge for old, absent and invalid choices and persist each valid choice', () => {
  for (const browser of [undefined, null, '', 'firefox', 'Chrome', {}, 1]) {
    assert.equal(sanitizedSettings({ browser }).browser, 'edge');
    assert.equal(cleanPatch({ browser }).browser, 'edge');
  }
  assert.equal(sanitizedSettings().browser, 'edge');
  assert.equal(Object.hasOwn(cleanPatch({ opacity: 0.5 }), 'browser'), false);
  const directory = mkdtempSync(path.join(tmpdir(), 'edudock-browsers-'));
  try {
    assert.equal(loadSettings(directory).browser, 'edge');
    for (const { id } of BROWSERS) {
      saveSettings(directory, sanitizedSettings({ browser: id }));
      assert.equal(loadSettings(directory).browser, id);
    }
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('discovery supports registry commands and normal install paths without substituting Edge', () => {
  const executable = 'D:\\Apps\\Chrome\\chrome.exe';
  const seen = [];
  assert.equal(findBrowserExecutable('chrome', { env: {}, exists: file => file === executable, readRegistry: key => {
    seen.push(key);
    return key === 'HKLM\\Software\\Clients\\StartMenuInternet\\Google Chrome\\shell\\open\\command' ? `"${executable}" --single-argument %1` : null;
  } }), executable);
  assert.ok(seen.includes('HKCU\\Software\\Clients\\StartMenuInternet\\Google Chrome\\shell\\open\\command'));
  assert.equal(findBrowserExecutable('aside', installed), path.join('C:\\Program Files', 'Aside', 'Application', 'Aside.exe'));
  assert.equal(browserAvailability(absent).every(browser => browser.installed === false), true);
  assert.throws(() => requireBrowser('aside', absent), /Aside.*설치되지 않았습니다/);
  assert.throws(() => requireBrowser('chrome', absent), /Chrome.*설치되지 않았습니다/);
});

test('URL launch preserves Edge protocol and launches only the selected executable in a new tab', async () => {
  for (const browser of ['edge', 'aside', 'chrome']) {
    const calls = [];
    await openBrowserUrl('https://example.com/', { browser, discovery: installed,
      openExternal: async url => calls.push(url),
      spawnProcess: (executable, args, options) => {
        calls.push({ executable, args, options });
        const child = new EventEmitter(); child.unref = () => {};
        queueMicrotask(() => child.emit('spawn'));
        return child;
      },
    });
    if (browser === 'edge') assert.deepEqual(calls, ['microsoft-edge:https://example.com/']);
    else {
      assert.equal(path.basename(calls[0].executable), browserProfile(browser).executable);
      assert.deepEqual(calls[0].args, ['--new-tab', 'https://example.com/']);
      assert.equal(calls[0].options.shell, false);
    }
  }
  await assert.rejects(openBrowserUrl('https://example.com/', { browser: 'chrome', discovery: absent, openExternal: () => assert.fail('must not fall back') }), /Chrome.*설치되지 않았습니다/);
});

test('both native bridges send the active browser on one-shot and reused-worker requests', async () => {
  for (const Bridge of [NativeOrdinaryEdgeBridge, NativeDraftHandoffBridge]) {
    const ordinary = Bridge === NativeOrdinaryEdgeBridge;
    const response = ordinary ? { status: 'ok', windows: [] } : { status: 'ok', editors: [] };
    const requests = [];
    const bridge = new Bridge({ helperPath: 'helper.ps1', spawn: () => {
      const child = new EventEmitter();
      child.stdout = new EventEmitter(); child.stderr = new EventEmitter(); child.kill = () => {};
      child.stdin = new EventEmitter();
      child.stdin.end = line => {
        const json = line.trim().startsWith('{') ? line : Buffer.from(line.trim().split('.')[0], 'base64').toString('utf8');
        requests.push(JSON.parse(json));
        queueMicrotask(() => { child.stdout.emit('data', JSON.stringify(response)); child.emit('close', 0); });
      };
      return child;
    } });
    try {
      for (const id of ['aside', 'chrome', 'edge']) {
        setActiveBrowser(id);
        await bridge.run({ command: ordinary ? 'inspect' : 'inspect-editors' });
        assert.equal(requests.at(-1).browser, id);
      }
      bridge.workerRunner = { run: async body => { requests.push(JSON.parse(body)); return JSON.stringify(response); }, stop() {} };
      for (const id of ['chrome', 'aside']) {
        setActiveBrowser(id);
        await bridge.run({ command: ordinary ? 'inspect' : 'inspect-editors' });
        assert.equal(requests.at(-1).browser, id);
      }
    } finally { setActiveBrowser('edge'); bridge.stopWorker(); }
  }
});
