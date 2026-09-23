'use strict';

const { openCertificateDialog, diagnostics, delay, allowPortalHelper } = require('./certificate.cjs');
const { waitForUserAuthentication, AuthenticationCancelledError, AuthenticationTimeoutError, ConnectionTimeoutError } = require('./auth.cjs');
const menus = { portal: '업무포털', neis: '나이스', attendance: '개인근무상황', trip: '출장', edufine: 'K-에듀파인', draft: '일반기안문' };
const CANCELLED = Symbol('cancelled');

function trusted(url) {
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'https:' && (parsed.hostname === 'sen.eduptl.kr' || parsed.hostname.endsWith('.sen.go.kr') || parsed.hostname.endsWith('.neis.go.kr') || parsed.hostname.endsWith('.edufine.go.kr'));
  } catch { return false; }
}

class PortalAutomation {
  constructor({ status, launchContext = null, openPortal = null, observeAuthenticated = null, resumeAction = null, autoLogin = false, connectionTimeoutMs = 45000, authTimeoutMs = 300000, takeoverGraceMs = 1500, pause = delay, now = Date.now }) {
    this.report = status; this.connectionTimeoutMs = connectionTimeoutMs; this.authTimeoutMs = authTimeoutMs; this.pause = pause; this.now = now;
    this.launchContext = launchContext; this.openPortal = openPortal; this.observeAuthenticated = observeAuthenticated; this.resumeAction = resumeAction;
    this.autoLogin = autoLogin === true; this.takeoverGraceMs = takeoverGraceMs;
    this.context = null; this.busy = false; this.operation = null; this.retryAction = null; this.generation = 0;
  }
  status(phase, message, busy = true) { this.report({ phase, message, busy }); }
  statusFor(operation, phase, message, busy = true) { if (this.operation === operation && !operation.cancelled) this.status(phase, message, busy); }
  diagnostics() { return { ...diagnostics(), browserConnected: Boolean(this.context), authenticationPending: Boolean(this.operation), retryAvailable: Boolean(this.retryAction) }; }
  createOperation(action, automatic = false) {
    let resolveCancellation;
    const listeners = new Set();
    const cancellation = new Promise(resolve => { resolveCancellation = resolve; });
    const operation = { action, automatic, generation: ++this.generation, cancelled: false, cancellation, startedAt: this.now(), connectionDeadline: this.now() + this.connectionTimeoutMs };
    let notified = false;
    operation.cancel = () => {
      if (notified) return;
      notified = true;
      resolveCancellation(CANCELLED);
      for (const listener of listeners) listener();
      listeners.clear();
    };
    operation.onCancel = listener => {
      if (typeof listener !== 'function') return () => {};
      if (operation.cancelled || notified) { listener(); return () => {}; }
      listeners.add(listener);
      return () => listeners.delete(listener);
    };
    return operation;
  }
  assertActive(operation) { if (operation.cancelled || this.operation !== operation) throw new AuthenticationCancelledError(); }
  async wait(operation, promise, deadline = Infinity) {
    this.assertActive(operation);
    let timer;
    const racers = [Promise.resolve(promise), operation.cancellation];
    if (Number.isFinite(deadline)) {
      const remaining = deadline - this.now();
      if (remaining <= 0) throw new ConnectionTimeoutError();
      racers.push(new Promise(resolve => { timer = setTimeout(() => resolve(ConnectionTimeoutError), remaining); }));
    }
    try {
      const result = await Promise.race(racers);
      if (result === CANCELLED) throw new AuthenticationCancelledError();
      if (result === ConnectionTimeoutError) throw new ConnectionTimeoutError();
      this.assertActive(operation);
      return result;
    } finally { if (timer) clearTimeout(timer); }
  }
  cancel() {
    const operation = this.operation;
    if (!operation) return { ok: false, message: '취소할 로그인 작업이 없습니다.' };
    operation.cancelled = true; operation.cancel();
    if (this.operation === operation) { this.operation = null; this.busy = false; }
    this.status('cancelled', '로그인 대기를 취소했습니다.', false);
    return { ok: true, message: '로그인 대기를 취소했습니다.' };
  }
  retry() {
    if (this.busy) return Promise.resolve({ ok: false, message: '이전 작업이 진행 중입니다.' });
    if (!this.retryAction) return Promise.resolve({ ok: false, message: '다시 시도할 작업이 없습니다.' });
    const action = this.retryAction; this.retryAction = null;
    return this.openMenu(action, { retry: true });
  }
  setAutoLogin(enabled) {
    this.autoLogin = enabled === true;
    const cancelled = !this.autoLogin && Boolean(this.operation?.automatic);
    if (cancelled) this.cancel();
    return { autoLogin: this.autoLogin, cancelled };
  }
  startAutoLogin() {
    if (!this.autoLogin) return Promise.resolve({ ok: false, phase: 'disabled', message: '자동 로그인이 꺼져 있습니다.' });
    return this.openMenu('portal', { automatic: true });
  }
  observeContext(context) { context.on('close', () => { if (this.context === context) this.context = null; }); }
  async browser(operation) {
    if (this.context) return this.context;
    if (!this.launchContext) throw new Error('브라우저 자동화 연결이 구성되지 않았습니다.');
    const candidatePromise = Promise.resolve(this.launchContext()).then(async candidate => {
      await candidate.grantPermissions(['local-network-access'], { origin: 'https://sen.eduptl.kr' });
      if (operation.cancelled || this.operation !== operation || this.now() >= operation.connectionDeadline) {
        await candidate.close().catch(() => {});
        if (operation.cancelled || this.operation !== operation) throw new AuthenticationCancelledError();
        throw new ConnectionTimeoutError();
      }
      this.context = candidate; this.observeContext(candidate); return candidate;
    });
    return this.wait(operation, candidatePromise, operation.connectionDeadline);
  }
  async readyPortal(page, context, operation) {
    while (this.now() < operation.connectionDeadline) {
      await this.wait(operation, allowPortalHelper(context), operation.connectionDeadline);
      const atPortal = new URL(page.url()).origin === 'https://sen.eduptl.kr';
      const ready = await this.wait(operation, Promise.all([page.locator('#btnLgn:visible').count(), this.authenticated(page)]), operation.connectionDeadline);
      if (atPortal && (ready[0] || ready[1])) return;
      await this.wait(operation, this.pause(500), operation.connectionDeadline);
    }
    throw new ConnectionTimeoutError();
  }
  async authenticated(page) {
    if (await page.locator('#btnLgn:visible').count()) return false;
    for (const frame of page.frames()) {
      if (!trusted(frame.url())) continue;
      for (const role of ['button', 'link']) {
        const controls = frame.getByRole(role, { name: '로그아웃', exact: true });
        for (let index = 0; index < await controls.count(); index += 1) if (await controls.nth(index).isVisible()) return true;
      }
    }
    return false;
  }
  async login(page, context, operation) {
    if (await this.wait(operation, this.authenticated(page), operation.connectionDeadline)) return true;
    this.statusFor(operation, 'certificate', '교육행정 전자서명 인증서 창을 열고 있습니다.');
    const shown = await this.wait(operation, openCertificateDialog(page, context, (phase, message) => this.statusFor(operation, phase, message), () => operation.cancelled || this.operation !== operation, operation.connectionDeadline), operation.connectionDeadline);
    if (!shown) throw new AuthenticationCancelledError();
    this.statusFor(operation, 'awaiting-user-auth', 'Edge의 공식 인증서 창에서 인증서를 선택하고 암호를 입력해 주세요.');
    await this.wait(operation, waitForUserAuthentication({ isAuthenticated: () => this.authenticated(page), isCancelled: () => operation.cancelled || this.operation !== operation, pause: this.pause, timeoutMs: this.authTimeoutMs }));
    this.statusFor(operation, 'authenticated', '업무포털 로그인을 확인했습니다.');
    return true;
  }
  async clickText(page, labels, operation) {
    for (const frame of page.frames()) {
      if (!trusted(frame.url())) continue;
      for (const label of labels) for (const kind of ['link', 'button']) {
        this.assertActive(operation);
        const control = frame.getByRole(kind, { name: label, exact: true });
        if (await this.wait(operation, control.count()) === 1 && await this.wait(operation, control.isVisible())) { await this.wait(operation, control.click({ timeout: 8000 })); return true; }
      }
    }
    return false;
  }
  async openMenu(id, options = {}) {
    if (!Object.hasOwn(menus, id)) return { ok: false, message: '지원하지 않는 메뉴입니다.' };
    // A press while something is running replaces it. Waiting out the previous task was the
    // whole reason the buttons felt dead after closing Edge.
    if (this.busy && this.operation && this.now() - this.operation.startedAt < this.takeoverGraceMs) {
      return { ok: false, message: '이전 작업이 진행 중입니다.' };
    }
    if (this.busy) this.cancel();
    if (!options.retry) this.retryAction = null;
    const operation = this.createOperation(id, options.automatic === true); this.busy = true; this.operation = operation;
    try {
      this.statusFor(operation, 'opening', `${menus[id]}을(를) Edge에서 여는 중입니다.`);
      if (this.openPortal) {
        await this.wait(operation, this.openPortal('microsoft-edge:https://sen.eduptl.kr', operation), operation.connectionDeadline);
        if (!this.observeAuthenticated) {
          const message = '일반 Edge에서 공식 로그인을 마친 뒤 다시 시도를 눌러 주세요.';
          this.retryAction = id; this.statusFor(operation, 'needs-user', message, false);
          return { ok: false, phase: 'needs-user', message };
        }
        this.statusFor(operation, 'awaiting-user-auth', '일반 Edge의 공식 인증서 창에서 인증서를 선택하고 암호를 입력해 주세요.');
        await this.wait(operation, waitForUserAuthentication({ isAuthenticated: () => this.observeAuthenticated(operation), isCancelled: () => operation.cancelled || this.operation !== operation, pause: this.pause, timeoutMs: this.authTimeoutMs }));
        this.statusFor(operation, 'authenticated', '업무포털 로그인을 확인했습니다.');
        if (id !== 'portal' && !this.resumeAction) throw new Error('일반 Edge에서 원래 업무를 이어가는 연결이 아직 구성되지 않았습니다.');
        if (id !== 'portal') this.statusFor(operation, 'navigating', `${menus[id]} 화면으로 이동하고 있습니다.`);
        const resumed = this.resumeAction ? await this.wait(operation, this.resumeAction(id, operation, { draft: options.draft ?? null })) : null;
        if (resumed?.verified === true) {
          const message = resumed.drafted === true ? '기안문에 초안을 넣었습니다. 내용을 확인하고 상신해 주세요.' : `${menus[id]} 화면을 확인했습니다.`;
          this.statusFor(operation, 'done', message, false);
          return { ok: true, phase: 'done', message, drafted: resumed.drafted === true };
        }
        const message = `${menus[id]} 이동을 요청했습니다. 열린 화면을 확인해 주세요.`;
        this.statusFor(operation, 'opened', message, false);
        return { ok: true, phase: 'opened', message };
      }
      const context = await this.browser(operation);
      let portal = context.pages().find(candidate => candidate.url().startsWith('https://sen.eduptl.kr/'));
      if (!portal) {
        portal = await this.wait(operation, context.newPage(), operation.connectionDeadline);
        await this.wait(operation, portal.goto('https://sen.eduptl.kr', { waitUntil: 'domcontentloaded', timeout: Math.max(1, operation.connectionDeadline - this.now()) }), operation.connectionDeadline);
      }
      await this.readyPortal(portal, context, operation);
      await this.wait(operation, portal.bringToFront(), operation.connectionDeadline);
      await this.login(portal, context, operation);
      this.assertActive(operation);
      if (id === 'portal') { this.statusFor(operation, 'done', '로그인된 업무포털을 열었습니다.', false); return { ok: true, message: '로그인된 업무포털을 열었습니다.' }; }
      const before = new Set(context.pages());
      const target = ['edufine', 'draft'].includes(id) ? ['K-에듀파인'] : ['나이스', 'NEIS'];
      if (!await this.clickText(portal, target, operation)) throw new Error(`${target[0]} 진입 메뉴를 확인하지 못했습니다. 열린 Edge 화면에서 메뉴 구조 확인이 필요합니다.`);
      let destination = portal;
      for (let index = 0; index < 30; index += 1) {
        await this.wait(operation, this.pause(300));
        const added = context.pages().find(candidate => !before.has(candidate) && trusted(candidate.url()));
        if (added) { destination = added; break; }
        if (!portal.url().includes('sen.eduptl.kr')) break;
      }
      await this.wait(operation, destination.waitForLoadState('domcontentloaded', { timeout: 20000 }));
      await this.wait(operation, destination.bringToFront());
      const paths = id === 'attendance' ? [['나의 메뉴', '나의메뉴'], ['복무'], ['개인근무상황관리', '개인근무상황신청', '개인근무상황']]
        : id === 'trip' ? [['나의 메뉴', '나의메뉴'], ['복무'], ['출장신청', '출장관리', '출장']]
          : id === 'draft' ? [['문서관리'], ['기안'], ['공용서식'], ['일반기안문 서식(결재4칸 작성4칸)', '일반기안문']] : [];
      for (const labels of paths) {
        if (!await this.clickText(destination, labels, operation)) throw new Error(`${labels[0]} 메뉴를 현재 화면에서 찾지 못했습니다. 열린 Edge 화면에서 메뉴 구조 확인이 필요합니다.`);
        await this.wait(operation, this.pause(600));
      }
      const message = `${menus[id]} 메뉴 선택을 마쳤습니다. 열린 화면을 확인해 주세요.`;
      this.statusFor(operation, 'opened', message, false); return { ok: true, message };
    } catch (error) {
      if (error instanceof AuthenticationCancelledError || error?.code === 'cancelled') return { ok: false, phase: 'cancelled', message: error.message };
      if (error?.code === 'needs-user') {
        if (!operation.cancelled) { this.retryAction = id; this.statusFor(operation, 'needs-user', error.message, false); }
        return { ok: false, phase: 'needs-user', message: error.message };
      }
      if (error instanceof AuthenticationTimeoutError || error instanceof ConnectionTimeoutError) {
        if (!operation.cancelled) { this.retryAction = id; this.statusFor(operation, 'needs-user', error.message, false); }
        return { ok: false, phase: 'needs-user', message: error.message };
      }
      const message = error instanceof Error && !/locator\.|browserType\.|page\./.test(error.message) ? error.message : 'Edge 연결 또는 화면 대기 시간이 초과되었습니다. 열린 화면과 연결 상태를 확인해 주세요.';
      this.statusFor(operation, 'error', message, false); return { ok: false, message };
    } finally { if (this.operation === operation) { this.operation = null; this.busy = false; } }
  }
}
module.exports = { PortalAutomation, trusted };
