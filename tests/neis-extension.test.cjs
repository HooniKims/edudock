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

function worker({ allowed = false } = {}) {
  const saved = { enabled: true, log: [] };
  const calls = [], listeners = {};
  const context = vm.createContext({
    URL, setTimeout, clearTimeout, console, importScripts: () => {}, extendNeisInPage() {},
    chrome: {
      storage: { local: { get: async defaults => ({ ...defaults, ...saved }), set: async value => Object.assign(saved, value) } },
      permissions: { contains: async () => allowed },
      alarms: { get: async () => ({}), onAlarm: { addListener: fn => { listeners.alarm = fn; } } },
      runtime: {
        onInstalled: { addListener() {} }, onStartup: { addListener() {} },
        onMessage: { addListener: fn => { listeners.message = fn; } }
      },
      tabs: { query: async ({ url }) => {
        calls.push({ query: url });
        return url.includes('https://sen.neis.go.kr/*') ? [{ id: 1, url: 'https://sen.neis.go.kr/', autoDiscardable: false }] : [];
      } },
      scripting: { executeScript: async args => { calls.push({ world: args.world }); return [{ result: { status: 'server-accepted' } }]; } }
    }
  });
  vm.runInContext(fs.readFileSync(path.join(root, 'background.js'), 'utf8'), context);
  return { saved, calls, context, message: msg => new Promise(resolve => listeners.message(msg, {}, resolve)) };
}
test('upgrading does not request mandatory NEIS access; existing enabled preference preserved', async () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(root, 'manifest.json'), 'utf8'));
  assert.deepEqual(manifest.host_permissions, ['https://sen.eduptl.kr/*', 'https://klef.sen.go.kr/*']);
  assert.deepEqual(manifest.optional_host_permissions, ['https://sen.neis.go.kr/*']);
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
test('concurrent manual/alarm runs share a single request and log; MAIN used for NEIS', async () => {
  const w = worker({ allowed: true, neisEnabled: true });
  await vm.runInContext('Promise.all([keepAlive("manual"), keepAlive("alarm")])', w.context);
  assert.equal(w.calls.filter(c => c.world === 'MAIN').length, 1);
  assert.equal(w.saved.log.length, 1);
  assert.equal(w.saved.log[0].status, 'server-accepted');
});
