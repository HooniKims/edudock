'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { PortalAutomation } = require('../src/portal.cjs');
const { allowPortalHelper } = require('../src/certificate.cjs');

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function page(url = 'https://sen.eduptl.kr/') {
  return {
    url: () => url,
    frames: () => [],
    bringToFront: async () => {},
    goto: async () => {},
    locator: () => ({ count: async () => 1 }),
  };
}

function context(initialPages = [page()]) {
  const emitter = new EventEmitter();
  emitter.pages = () => initialPages;
  emitter.grantPermissions = async () => {};
  emitter.newPage = async () => page('about:blank');
  emitter.close = async () => emitter.emit('close');
  return emitter;
}

function automation(overrides = {}) {
  const events = [];
  const instance = new PortalAutomation({
    profile: 'fixture',
    status: event => events.push(event),
    connectionTimeoutMs: 100,
    authTimeoutMs: 30,
    ...overrides,
  });
  instance.readyPortal = async () => {};
  instance.login = async () => true;
  return { instance, events };
}

test('cancel releases the operation immediately and stale launch completion cannot clear a newer operation', async () => {
  const first = deferred();
  const second = deferred();
  let launches = 0;
  const { instance, events } = automation({ launchContext: () => (++launches === 1 ? first.promise : second.promise) });

  const oldResultPromise = instance.openMenu('portal');
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(instance.cancel().ok, true);
  assert.equal(instance.busy, false);
  assert.equal(instance.operation, null);
  assert.deepEqual(await oldResultPromise, { ok: false, phase: 'cancelled', message: '로그인 대기를 취소했습니다.' });

  const newResultPromise = instance.openMenu('portal');
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(instance.busy, true);
  first.resolve(context());
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(instance.busy, true);
  assert.notEqual(instance.operation, null);
  assert.notEqual(events.at(-1).phase, 'done');

  second.resolve(context());
  assert.equal((await newResultPromise).ok, true);
  assert.equal(instance.busy, false);
});

test('cancel wins while portal navigation is pending', async () => {
  const navigation = deferred();
  const blank = page('about:blank');
  blank.goto = () => navigation.promise;
  const ctx = context([]);
  ctx.newPage = async () => blank;
  const { instance } = automation({ launchContext: async () => ctx });

  const resultPromise = instance.openMenu('portal');
  await new Promise(resolve => setImmediate(resolve));
  instance.cancel();
  assert.equal((await resultPromise).phase, 'cancelled');
  navigation.resolve();
});

test('one total connection deadline covers launch and navigation', async () => {
  const slow = deferred();
  const { instance } = automation({ launchContext: () => slow.promise, connectionTimeoutMs: 15 });
  const started = Date.now();
  const result = await instance.openMenu('portal');
  assert.equal(result.ok, false);
  assert.equal(result.phase, 'needs-user');
  assert.match(result.message, /연결.*다시/);
  assert.ok(Date.now() - started < 80);
  slow.resolve(context());
});

test('authentication timeout preserves the original action for one explicit retry and duplicate retry is guarded', async () => {
  const { instance } = automation({ launchContext: async () => context() });
  let logins = 0;
  instance.login = async () => {
    logins += 1;
    if (logins === 1) {
      const { AuthenticationTimeoutError } = require('../src/auth.cjs');
      throw new AuthenticationTimeoutError();
    }
    return true;
  };

  assert.equal((await instance.openMenu('portal')).phase, 'needs-user');
  const retry = instance.retry();
  const duplicate = await instance.retry();
  assert.equal(duplicate.ok, false);
  assert.match(duplicate.message, /진행 중/);
  assert.equal((await retry).ok, true);
  assert.equal(logins, 2);
  assert.equal((await instance.retry()).ok, false);
  assert.match((await instance.retry()).message, /다시 시도할 작업/);
});

test('an old context close event cannot clear a newer owned context', async () => {
  const oldContext = context();
  const newContext = context();
  const { instance } = automation({ launchContext: async () => oldContext });
  instance.context = oldContext;
  instance.observeContext(oldContext);
  instance.context = newContext;
  instance.observeContext(newContext);
  oldContext.emit('close');
  assert.equal(instance.context, newContext);
  newContext.emit('close');
  assert.equal(instance.context, null);
});

test('visible logout text without an interactive control is not accepted as authenticated', async () => {
  const falseText = {
    url: () => 'https://sen.eduptl.kr/main',
    locator: () => ({ count: async () => 0 }),
    frames: () => [{
      url: () => 'https://sen.eduptl.kr/main',
      getByRole: () => ({ count: async () => 0 }),
      getByText: () => ({ count: async () => 1, nth: () => ({ isVisible: async () => true }) }),
    }],
  };
  const { instance } = automation();
  assert.equal(await instance.authenticated(falseText), false);
});

test('local-network permission is approved only for the exact portal origin', async () => {
  let approvals = 0;
  const permissionPage = text => ({
    url: () => 'edge://permission-request-dialog/',
    locator: selector => selector === 'body'
      ? { innerText: async () => text }
      : { click: async () => { approvals += 1; } },
  });
  await allowPortalHelper({ pages: () => [permissionPage('https://sen.eduptl.kr.evil.example 이 장치에서 다른 앱 및 서비스에 액세스')] });
  assert.equal(approvals, 0);
  await allowPortalHelper({ pages: () => [permissionPage('https://sen.eduptl.kr 이 장치에서 다른 앱 및 서비스에 액세스')] });
  assert.equal(approvals, 1);
});

test('product wiring uses ordinary Edge handoff without an automation profile or debugging flags', () => {
  const fs = require('node:fs');
  const main = fs.readFileSync('src/main.cjs', 'utf8');
  const portal = fs.readFileSync('src/portal.cjs', 'utf8');
  assert.doesNotMatch(main, /EdgeProfile|launchPersistentContext|--remote-debugging/);
  assert.doesNotMatch(portal, /launchPersistentContext|--user-data-dir|--remote-debugging/);
  assert.match(main + portal, /microsoft-edge:https:\/\/sen\.eduptl\.kr/);
});

test('diagnostics never scans certificate store paths or private-key locations', () => {
  const fs = require('node:fs');
  const certificate = fs.readFileSync('src/certificate.cjs', 'utf8');
  assert.doesNotMatch(certificate, /LocalLow\\NPKI|C:\\\\GPKI|C:\\\\NPKI|certificateStores/);
});
