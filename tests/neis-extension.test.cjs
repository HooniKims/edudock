const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const root = path.join(__dirname, '..', 'extension');
const source = fs.readFileSync(path.join(root, 'neis.js'), 'utf8');

function page(options = {}) {
  let calls = 0, resets = 0, secondary = 0;
  const body = { innerText: options.text || '' };
  const main = {
    id: 'app/com/main/Index$1',
    hasAppMethod: () => true,
    lookup: id => id === 'dmUserInfoSub'
      ? (options.nullInfo ? null : { getValue: () => options.minutes ?? '60' })
      : id === 'optTime' ? { value: options.timer ?? '42분 13초' } : null,
    callAppMethod(name) {
      if (name === 'set2SessionTimer') secondary++;
      if (name === 'setSessionTimerInit') resets++;
      if (options.resetError) body.innerText = '해당 프로그램의 널처리 로그를 확인해 주세요';
    }
  };
  const context = vm.createContext({
    location: { origin: options.origin || 'https://sen.neis.go.kr' }, document: { body },
    cpr: { core: { Platform: { INSTANCE: { getAllRunningAppInstances: () => options.apps || [null, main] } } } },
    AbortController, setTimeout: options.setTimeout || setTimeout, clearTimeout,
    fetch: async (url, config) => {
      calls++;
      assert.equal(url, '/sessionExtension.do');
      assert.equal(config.credentials, 'same-origin');
      assert.equal(config.method, 'POST');
      assert.equal(config.redirect, 'error');
      if (options.fetch) return options.fetch(config);
      if (options.networkError) throw new Error('private server details');
      if (options.lateError) body.innerText = '해당 프로그램의 처리 로그를 확인해 주세요';
      return { ok: options.ok ?? true, text: async () => options.answer ?? '"Y"' };
    }
  });
  vm.runInContext(source, context);
  return { run: () => vm.runInContext('extendNeisInPage()', context), counts: () => ({ calls, resets, secondary }) };
}

test('NEIS primary session resets once only after exact server acknowledgment; secondary untouched', async () => {
  const p = page();
  assert.equal((await p.run()).status, 'server-accepted');
  assert.deepEqual(p.counts(), { calls: 1, resets: 1, secondary: 0 });
});
for (const answer of ['"N"', 'Y', '<html>로그인</html>', '{"result":"Y"}', '']) {
  test(`NEIS rejects non-contract server response ${JSON.stringify(answer)}`, async () => {
    const p = page({ answer });
    assert.equal((await p.run()).status, 'server-rejected');
    assert.equal(p.counts().resets, 0);
  });
}
for (const [name, options, status] of [
  ['wrong origin', { origin: 'https://example.com' }, 'wrong-origin'],
  ['null user-info', { nullInfo: true }, 'not-ready'],
  ['missing application', { apps: [] }, 'not-ready'],
  ['invalid session duration', { minutes: 'oops' }, 'not-ready'],
  ['expired countdown', { timer: '00분 00초' }, 'expired'],
  ['null processing error', { text: '해당 프로그램의 널처리 로그를 확인해 주세요' }, 'page-error'],
  ['expired server notice', { text: '세션 DB정보가 없어 시스템을 종료합니다' }, 'expired']
]) test(`NEIS makes no request on ${name}`, async () => {
  const p = page(options);
  assert.equal((await p.run()).status, status);
  assert.deepEqual(p.counts(), { calls: 0, resets: 0, secondary: 0 });
});
test('NEIS detects page error appearing while waiting for server, even with Y response', async () => {
  const p = page({ lateError: true });
  assert.equal((await p.run()).status, 'page-error');
  assert.equal(p.counts().resets, 0);
});
test('NEIS does not report success if timer method itself produces page error', async () => {
  assert.equal((await page({ resetError: true }).run()).status, 'page-error');
});
test('HTTP error and network error do not change countdown or expose error details', async () => {
  for (const options of [{ ok: false }, { networkError: true }]) {
    const p = page(options);
    assert.match((await p.run()).status, /^(http-error|request-failed)$/);
    assert.equal(p.counts().resets, 0);
  }
});
test('timeout aborts request and cannot later reset timer', async () => {
  const p = page({
    setTimeout: fn => setTimeout(fn, 5),
    fetch: ({ signal }) => new Promise((resolve, reject) => {
      signal.addEventListener('abort', () => reject(Object.assign(new Error(), { name: 'AbortError' })));
    })
  });
  assert.equal((await p.run()).status, 'timeout');
  assert.equal(p.counts().resets, 0);
});

// Background worker in a VM with a fake chrome. `granted` lists the host patterns the browser
// allows; `tabs` are the open tabs.
const SEOUL_REQUIRED = ['https://sen.eduptl.kr/*', 'https://klef.sen.go.kr/*'];
function worker({ allowed = false, granted = null, tabs = null, saved: initial = {} } = {}) {
  const grantedPatterns = granted || [...SEOUL_REQUIRED, ...(allowed ? ['https://sen.neis.go.kr/*'] : [])];
  const openTabs = tabs || [{ id: 1, url: 'https://sen.neis.go.kr/', autoDiscardable: false }];
  const saved = { enabled: true, log: [], ...initial };
  const calls = [], listeners = {}, created = [], badge = {};
  const context = vm.createContext({
    URL, setTimeout, clearTimeout, console, extendNeisInPage() {},
    importScripts: (...files) => { for (const file of files) if (file === 'regions.js') vm.runInContext(fs.readFileSync(path.join(root, file), 'utf8'), context); },
    chrome: {
      storage: { local: { get: async defaults => ({ ...(typeof defaults === 'string' ? {} : defaults), ...saved }), set: async value => Object.assign(saved, value) } },
      permissions: { contains: async ({ origins }) => origins.every(origin => grantedPatterns.includes(origin)), onAdded: { addListener() {} }, onRemoved: { addListener() {} } },
      alarms: { get: async () => ({}), onAlarm: { addListener: fn => { listeners.alarm = fn; } } },
      action: { setBadgeText: async ({ text }) => { badge.text = text; }, setBadgeBackgroundColor: async () => {}, setTitle: async ({ title }) => { badge.title = title; } },
      runtime: {
        getURL: file => `chrome-extension://id/${file}`,
        onInstalled: { addListener: fn => { listeners.installed = fn; } }, onStartup: { addListener() {} },
        onMessage: { addListener: fn => { listeners.message = fn; } }
      },
      tabs: {
        create: async ({ url }) => { created.push(url); },
        update: async () => {},
        query: async ({ url }) => {
          calls.push({ query: url });
          return openTabs.filter(tab => url.some(pattern => tab.url.startsWith(pattern.slice(0, -1))));
        }
      },
      scripting: { executeScript: async args => { calls.push({ world: args.world, tabId: args.target.tabId }); return [{ result: args.world === 'MAIN' ? { status: 'server-accepted' } : { clicked: '세션 시간 초기화' } }]; } }
    }
  });
  vm.runInContext(fs.readFileSync(path.join(root, 'background.js'), 'utf8'), context);
  return {
    saved, calls, context, created, badge,
    message: msg => new Promise(resolve => listeners.message(msg, {}, resolve)),
    installed: async details => { listeners.installed(details); await new Promise(resolve => setTimeout(resolve, 20)); },
  };
}
test('upgrading keeps the two required 서울 hosts; every other office is optional', async () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(root, 'manifest.json'), 'utf8'));
  assert.deepEqual(manifest.host_permissions, SEOUL_REQUIRED);
  assert.equal(manifest.optional_host_permissions.length, 17 * 3 - 2);
  for (const host of ['https://sen.neis.go.kr/*', 'https://gwe.eduptl.kr/*', 'https://klef.gwe.go.kr/*', 'https://gwe.neis.go.kr/*', 'https://klef.gbe.kr/*', 'https://jje.neis.go.kr/*']) {
    assert.ok(manifest.optional_host_permissions.includes(host), host);
  }
  const w = worker();
  await w.message({ type: 'run-now' });
  assert.equal(w.saved.enabled, true);
  assert.equal(w.calls[0].query.includes('https://sen.neis.go.kr/*'), false);
});
test('NEIS is included by default with permission; revocation prevents injection', async () => {
  const allowed = worker({ allowed: true });
  await allowed.message({ type: 'run-now' });
  assert.equal(allowed.calls.filter(c => c.world === 'MAIN').length, 1);
  const revoked = worker({ allowed: false });
  await revoked.message({ type: 'run-now' });
  assert.equal(revoked.calls.some(c => c.world), false);
});

test('all 17 office portal main URLs are selected only with site permission', async () => {
  const codes = ['sen', 'pen', 'dge', 'ice', 'gen', 'dje', 'use', 'sje', 'goe', 'gwe', 'cbe', 'cne', 'jbe', 'jne', 'gbe', 'gne', 'jje'];
  const tabs = codes.map((code, index) => ({ id: index + 1, url: `https://${code}.eduptl.kr/bpm_man_mn00_001.do` }));
  tabs.push({ id: 99, url: 'https://sen.eduptl.kr.evil.example/bpm_man_mn00_001.do' });
  const w = worker({ granted: codes.map(code => `https://${code}.eduptl.kr/*`), tabs });
  const selected = await vm.runInContext('sessionTabs()', w.context);
  assert.deepEqual(Array.from(selected, tab => tab.id), codes.map((_, i) => i + 1));
  const limited = worker({ granted: ['https://sen.eduptl.kr/*'], tabs });
  assert.deepEqual(Array.from(await vm.runInContext('sessionTabs()', limited.context), tab => tab.id), [1]);
});
test('concurrent manual/alarm runs share a single request and log; MAIN used for NEIS', async () => {
  const w = worker({ allowed: true, neisEnabled: true });
  await vm.runInContext('Promise.all([keepAlive("manual"), keepAlive("alarm")])', w.context);
  assert.equal(w.calls.filter(c => c.world === 'MAIN').length, 1);
  assert.equal(w.saved.log.length, 1);
  assert.equal(w.saved.log[0].status, 'server-accepted');
});
test('a 강원 teacher who allowed 강원 gets all three 강원 tabs extended, and nothing else', async () => {
  const gangwon = ['https://gwe.eduptl.kr/*', 'https://klef.gwe.go.kr/*', 'https://gwe.neis.go.kr/*'];
  const w = worker({
    granted: [...SEOUL_REQUIRED, ...gangwon], saved: { region: 'gwe' },
    tabs: [
      { id: 1, url: 'https://gwe.eduptl.kr/bpm_man_mn00_001.do' },
      { id: 2, url: 'https://klef.gwe.go.kr/keris_ui/main.do' },
      { id: 3, url: 'https://gwe.neis.go.kr/jsp/main.jsp' },
      { id: 4, url: 'https://goe.eduptl.kr/bpm_man_mn00_001.do' },
    ],
  });
  await w.message({ type: 'run-now' });
  assert.deepEqual([...new Set(w.calls.filter(c => c.tabId).map(c => c.tabId))].sort(), [1, 2, 3]);
  assert.equal(w.calls.filter(c => c.world === 'MAIN').length, 1, '나이스 uses its own session request');
  assert.equal(w.calls.some(c => c.tabId === 4), false, 'an office that was never allowed is never touched');
  const state = await w.message({ type: 'state' });
  assert.equal(state.ready, true);
});
test('a new install opens the setup page and marks the icon until an office is allowed', async () => {
  const w = worker({ saved: { enabled: false } });
  await w.installed({ reason: 'install' });
  assert.deepEqual(w.created, ['chrome-extension://id/setup.html']);
  assert.equal(w.badge.text, '!');
  assert.equal((await w.message({ type: 'set-region', region: 'evil' })).ok, false);
  assert.equal((await w.message({ type: 'set-region', region: 'gwe' })).ok, true);
  assert.equal(w.saved.region, 'gwe');
  assert.equal(w.badge.text, '!', '강원 sites are still not allowed');
});
test('an update from the 서울-only version keeps 서울 and asks only when 나이스 was never allowed', async () => {
  const done = worker({ allowed: true, saved: {} });
  await done.installed({ reason: 'update' });
  assert.equal(done.saved.region, 'sen');
  assert.deepEqual(done.created, []);
  assert.equal(done.badge.text, '');
  const pending = worker({ allowed: false, saved: {} });
  await pending.installed({ reason: 'update' });
  assert.equal(pending.saved.region, 'sen');
  assert.deepEqual(pending.created, ['chrome-extension://id/setup.html']);
  const chosen = worker({ allowed: false, saved: { region: 'gwe' } });
  await chosen.installed({ reason: 'update' });
  assert.deepEqual(chosen.created, [], 'a later update never reopens the page');
});
test('나이스 runs on any office\'s 나이스 host and nowhere else', async () => {
  const p = page({ origin: 'https://gwe.neis.go.kr' });
  assert.equal((await p.run()).status, 'server-accepted');
  for (const origin of ['https://gwe.neis.go.kr.evil.example', 'http://gwe.neis.go.kr', 'https://neis.go.kr']) {
    assert.equal((await page({ origin }).run()).status, 'wrong-origin', origin);
  }
});
