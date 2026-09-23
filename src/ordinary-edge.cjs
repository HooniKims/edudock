'use strict';

const path = require('node:path');
const { spawn: spawnProcess } = require('node:child_process');
const { AuthenticationCancelledError } = require('./auth.cjs');
const { NativeHelperWorker } = require('./native-worker.cjs');
const { canFillBody } = require('./draft-handoff.cjs');

const STATUSES = new Set(['ok', 'unavailable', 'stale', 'ambiguous', 'cancelled', 'error']);
const TASK_ACTIONS = new Set(['select-my-menu', 'expand-duty', 'select-attendance-tab', 'select-trip-tab', 'open-attendance', 'open-trip']);
const ACTIONS = new Set(['login', 'hard-disk', 'removable-disk', 'select-drive', 'select-certificate-row', 'submit-certificate-password', 'activate-system-tab', 'dismiss-session-notice', 'portal', 'neis', 'edufine', ...TASK_ACTIONS]);
const SESSION_NOTICES = new Set(['edufine-usetime', 'portal-session']);
const SYSTEMS = new Set(['portal', 'neis', 'edufine']);
const SYSTEM_ORIGINS = { portal: 'https://sen.eduptl.kr', neis: 'https://sen.neis.go.kr', edufine: 'https://klef.sen.go.kr' };
const MAX_OUTPUT_BYTES = 256 * 1024;
const MAX_PASSWORD_LENGTH = 256;

function resolveOrdinaryEdgeHelper({ isPackaged, resourcesPath, sourceDirectory = __dirname }) {
  if (isPackaged) return path.join(resourcesPath, 'app.asar.unpacked', 'src', 'native', 'ordinary-edge.ps1');
  return path.join(sourceDirectory, 'native', 'ordinary-edge.ps1');
}

function resolveOrdinaryEdgeServeHelper({ isPackaged, resourcesPath, sourceDirectory = __dirname }) {
  if (isPackaged) return path.join(resourcesPath, 'app.asar.unpacked', 'src', 'native', 'ordinary-edge-serve.ps1');
  return path.join(sourceDirectory, 'native', 'ordinary-edge-serve.ps1');
}

function resolveDraftHandoffHelper({ isPackaged, resourcesPath, sourceDirectory = __dirname }) {
  if (isPackaged) return path.join(resourcesPath, 'app.asar.unpacked', 'src', 'native', 'edufine-draft.ps1');
  return path.join(sourceDirectory, 'native', 'edufine-draft.ps1');
}

function validTarget(value) {
  return value && Number.isSafeInteger(value.pid) && value.pid > 0 && typeof value.hwnd === 'string' && /^\d+$/.test(value.hwnd)
    && typeof value.processStartedAt === 'string' && value.processStartedAt.length > 0 && !Number.isNaN(Date.parse(value.processStartedAt));
}

function validateRequest(request) {
  if (!request || !['inspect', 'invoke'].includes(request.command)) throw new TypeError('Invalid native ordinary Edge request.');
  if (request.target !== undefined && !validTarget(request.target)) throw new TypeError('Invalid native ordinary Edge target.');
  if (request.command === 'invoke' && (!validTarget(request.target) || !ACTIONS.has(request.action))) throw new TypeError('Invalid native ordinary Edge invocation.');
  const result = { command: request.command };
  // Only a discovery pass that a button press just started asks for this: it brings a
  // minimised browser back on screen (without focus) so the existing window is found instead
  // of a new tab being opened on top of it.
  if (request.restoreMinimised === true) result.restoreMinimised = true;
  if (request.target) result.target = { pid: request.target.pid, hwnd: request.target.hwnd, processStartedAt: request.target.processStartedAt };
  if (request.command === 'invoke') result.action = request.action;
  if (request.action === 'select-drive') {
    if (typeof request.driveId !== 'string' || !/^[A-Z]:$/.test(request.driveId) || typeof request.driveOptionsToken !== 'string' || !request.driveOptionsToken) throw new TypeError('Invalid native ordinary Edge drive selection.');
    result.driveId = request.driveId;
    result.driveOptionsToken = request.driveOptionsToken;
  }
  if (request.action === 'submit-certificate-password') {
    // Carried to the helper only; it is never echoed back, logged, or persisted here.
    if (typeof request.password !== 'string' || request.password.length === 0 || request.password.length > MAX_PASSWORD_LENGTH) {
      throw new TypeError('Invalid native ordinary Edge certificate password.');
    }
    result.password = request.password;
  }
  if (request.action === 'activate-system-tab') {
    if (!SYSTEMS.has(request.system)) throw new TypeError('Invalid native ordinary Edge system activation.');
    result.system = request.system;
    // false = only switch to the tab; the page there may be logged out or behind a notice.
    if (request.requireLanding === false) result.requireLanding = false;
  }
  return result;
}

function validCertificate(value) {
  return value && typeof value.visible === 'boolean' && typeof value.hardDiskAvailable === 'boolean'
    && typeof value.removableAvailable === 'boolean' && [null, 'hard-disk', 'removable-disk'].includes(value.selectedStore)
    && [null, true, false].includes(value.hardDiskEmpty) && Array.isArray(value.driveOptions)
    && value.driveOptions.every(option => option && typeof option.id === 'string' && /^[A-Z]:$/.test(option.id) && typeof option.label === 'string' && typeof option.selected === 'boolean')
    && (value.driveOptionsToken === null || typeof value.driveOptionsToken === 'string')
    && (value.selectedDriveId === null || (typeof value.selectedDriveId === 'string' && /^[A-Z]:$/.test(value.selectedDriveId)))
    && (value.certRowCount === null || (Number.isSafeInteger(value.certRowCount) && value.certRowCount >= 0))
    && (value.selectedCertRowCount === null || (Number.isSafeInteger(value.selectedCertRowCount) && value.selectedCertRowCount >= 0))
    && typeof value.soleCertRowSelectable === 'boolean';
}

function validWindow(value) {
  return validTarget(value) && (value.origin === null || Object.values(SYSTEM_ORIGINS).includes(value.origin))
    && typeof value.authenticated === 'boolean' && typeof value.loginAvailable === 'boolean'
    && validCertificate(value.certificate) && Array.isArray(value.actions)
    && value.actions.every(action => ACTIONS.has(action))
    && (value.landing === null || SYSTEMS.has(value.landing))
    && Array.isArray(value.availableSystems) && value.availableSystems.every(system => SYSTEMS.has(system))
    && new Set(value.availableSystems).size === value.availableSystems.length
    && (value.landing === null || value.origin === SYSTEM_ORIGINS[value.landing])
    && (value.foreground === undefined || typeof value.foreground === 'boolean')
    && (value.sessionNotice === undefined || value.sessionNotice === null || SESSION_NOTICES.has(value.sessionNotice))
    && (value.selectedSystem === undefined || value.selectedSystem === null || SYSTEMS.has(value.selectedSystem))
    && (value.neisTaskState === undefined || (value.landing === 'neis' && validNeisTaskState(value.neisTaskState)));
}

function validNeisTaskState(value) {
  return value && typeof value.myMenuSelected === 'boolean' && typeof value.dutyExpanded === 'boolean'
    && Array.isArray(value.visibleTasks) && value.visibleTasks.every(task => ['attendance', 'trip'].includes(task))
    && Array.isArray(value.existingTaskTabs) && value.existingTaskTabs.every(task => ['attendance', 'trip'].includes(task))
    && [null, 'attendance', 'trip'].includes(value.activeTask) && Array.isArray(value.actions)
    && value.actions.every(action => TASK_ACTIONS.has(action));
}

function validateResponse(value) {
  if (!value || !STATUSES.has(value.status) || !Array.isArray(value.windows) || !value.windows.every(validWindow)) throw needsUser('invalid-response', 'Edge 화면 상태를 읽지 못했습니다. 다시 시도해 주세요.');
  if (value.invoked !== undefined && typeof value.invoked !== 'boolean') throw needsUser('invalid-response', 'Edge 화면 상태를 읽지 못했습니다. 다시 시도해 주세요.');
  return value;
}

class NativeOrdinaryEdgeBridge {
  // A cold PowerShell start compiles the helper's C# and can take several seconds; the first
  // call after install used to trip a 5s limit and greet the user with a timeout.
  constructor({ helperPath, servePath = null, spawn = spawnProcess, timeoutMs = 10000 }) {
    this.helperPath = helperPath;
    this.servePath = servePath;
    this.spawn = spawn;
    this.timeoutMs = timeoutMs;
    this.workerRunner = servePath
      ? new NativeHelperWorker({
        helperPath,
        servePath,
        spawn,
        timeoutMs,
        errors: {
          timeout: () => needsUser('helper-timeout', 'Edge 화면 상태를 확인하는 데 시간이 너무 오래 걸렸습니다. 다시 시도해 주세요.'),
          failed: () => needsUser('helper-failed', 'Edge 화면 상태를 확인하지 못했습니다. 다시 시도해 주세요.'),
          cancelled: () => new AuthenticationCancelledError(),
        },
      })
      : null;
  }

  stopWorker() {
    this.workerRunner?.stop();
  }

  runOnce(body, operation) {
    return new Promise((resolve, reject) => {
      let settled = false;
      let stdout = Buffer.alloc(0);
      let stderr = Buffer.alloc(0);
      let child;
      const finish = (error, value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (error) reject(error); else resolve(value);
      };
      const stop = error => {
        if (settled) return;
        try { child?.kill(); } catch {}
        finish(error);
      };
      let timer;
      try {
        child = this.spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', this.helperPath], {
          shell: false,
          windowsHide: true,
          stdio: ['pipe', 'pipe', 'pipe'],
        });
      } catch (error) {
        finish(error);
        return;
      }
      timer = setTimeout(() => stop(needsUser('helper-timeout', 'Edge 화면 상태를 확인하는 데 시간이 너무 오래 걸렸습니다. 다시 시도해 주세요.')), this.timeoutMs);
      operation?.cancellation?.then(() => stop(new AuthenticationCancelledError()), () => {});
      child.on('error', error => finish(error));
      child.stdin.on?.('error', error => stop(error));
      child.stdout.on('data', chunk => {
        stdout = Buffer.concat([stdout, Buffer.from(chunk)]);
        if (stdout.length > MAX_OUTPUT_BYTES) stop(needsUser('invalid-response', 'Edge 화면 상태를 읽지 못했습니다. 다시 시도해 주세요.'));
      });
      child.stderr.on('data', chunk => {
        stderr = Buffer.concat([stderr, Buffer.from(chunk)]);
        if (stderr.length > MAX_OUTPUT_BYTES) stop(needsUser('helper-failed', 'Edge 화면 상태를 확인하지 못했습니다. 다시 시도해 주세요.'));
      });
      child.on('close', code => {
        if (settled) return;
        if (operation?.cancelled) return finish(new AuthenticationCancelledError());
        if (code !== 0) return finish(needsUser('helper-failed', 'Edge 화면 상태를 확인하지 못했습니다. 다시 시도해 주세요.'));
        try {
          const text = stdout.toString('utf8').trim();
          if (!text) throw new Error('empty');
          finish(null, validateResponse(JSON.parse(text)));
        } catch {
          finish(needsUser('invalid-response', 'Edge 화면 상태를 읽지 못했습니다. 다시 시도해 주세요.'));
        }
      });
      try { child.stdin.end(body); } catch (error) { stop(error); }
    });
  }

  run(request, operation) {
    const body = JSON.stringify(validateRequest(request));
    if (operation?.cancelled) return Promise.reject(new AuthenticationCancelledError());
    if (!this.workerRunner) return this.runOnce(body, operation);
    return this.workerRunner.run(body, operation)
      .then(line => {
        try {
          return validateResponse(JSON.parse(line));
        } catch {
          this.workerRunner.stop();
          throw needsUser('invalid-response', 'Edge 화면 상태를 읽지 못했습니다. 다시 시도해 주세요.');
        }
      })
      .catch(error => {
        if (!error || error.workerFault !== true || operation?.cancelled) throw error;
        return this.runOnce(body, operation);
      });
  }
}

function targetOf(window) {
  return { pid: window.pid, hwnd: window.hwnd, processStartedAt: window.processStartedAt };
}

function sameTarget(window, target) {
  return window.pid === target.pid && window.hwnd === target.hwnd && window.processStartedAt === target.processStartedAt;
}

const SYSTEM_LABELS = { portal: '업무포털', neis: '나이스', edufine: 'K-에듀파인' };
const TASK_LABELS = { attendance: '개인근무상황', trip: '출장' };

// The notch shows a thrown message verbatim, so every failure that can reach a button press
// is phrased in Korean and says what the user can do next.
function needsUser(reason, message) {
  return Object.assign(new Error(message), { code: 'needs-user', reason });
}

// Draft handoff failures carry internal English codes. The notch shows the thrown message
// verbatim, so translate the known ones into Korean guidance and mark them retryable.
const DRAFT_HANDOFF_MESSAGES = {
  'focus-failed': '이미 열려 있는 일반기안문 창을 앞으로 가져오지 못했습니다. 기안창을 한 번 클릭한 뒤 다시 시도해 주세요.',
  'unsafe-existing-editor': '열려 있는 기안 창이 일반기안문 서식으로 확인되지 않아 그대로 두었습니다. 해당 창을 확인해 주세요.',
  'unsafe-new-editor': '새로 열린 창이 일반기안문 서식으로 확인되지 않았습니다. 열린 화면을 확인해 주세요.',
  'ambiguous-editors': '공용서식을 연 뒤 새 기안 창이 한 번에 여러 개 나타나 어느 창인지 확정할 수 없습니다. 새로 뜬 창을 확인한 뒤 다시 시도해 주세요.',
  'not-invoked': '공용서식에서 일반기안문을 열지 못했습니다. K-에듀파인 화면을 확인해 주세요.',
  'needs-user': '공용서식에서 일반기안문 서식을 찾지 못했습니다. 문서관리 > 기안 > 공용서식 화면을 연 뒤 다시 시도해 주세요.',
  'timeout': '기안 창이 열리기를 기다렸지만 확인하지 못했습니다. 잠시 뒤 다시 시도해 주세요.',
  'stale-editor': '기존에 열려 있던 기안 창만 확인되어 새 기안 창을 확정하지 못했습니다. 다시 시도해 주세요.',
  'reused-process-identity': '기안 프로그램 창을 안전하게 구분하지 못했습니다. 기안 창을 닫고 다시 시도해 주세요.',
  'root-changed': '공용서식 화면이 바뀌어 선택을 취소했습니다. 화면을 그대로 둔 채 다시 시도해 주세요.',
  'overlay-detected': '공용서식 목록이 다른 창에 가려져 있습니다. 가린 창을 치운 뒤 다시 시도해 주세요.',
  'selector-unavailable': '공용서식 목록에서 일반기안문 서식을 찾지 못했습니다. 목록을 연 뒤 다시 시도해 주세요.',
  'selector-ambiguous': '공용서식 목록에서 같은 이름이 여러 개 보여 선택하지 않았습니다. 화면을 확인해 주세요.',
  'stale-capture': '공용서식 화면 정보가 오래되어 선택을 취소했습니다. 다시 시도해 주세요.',
  'low-confidence': '공용서식 이름을 충분히 또렷하게 읽지 못했습니다. 목록을 키운 뒤 다시 시도해 주세요.',
  'invalid-response': '기안 창 상태를 확인하지 못했습니다. 다시 시도해 주세요.',
  'helper-failed': '기안 창 상태를 확인하는 프로그램이 응답하지 않았습니다. 다시 시도해 주세요.',
  'editor-dialog': '기안 창에 확인이 필요한 안내창이 떠 있습니다. 자동저장 문서를 불러올지 직접 선택한 뒤 다시 눌러 주세요.',
  'not-fillable': '이미 손댄 기안 창이라 초안을 넣지 않았습니다. 새 기안문을 연 뒤 다시 시도해 주세요.',
  'not-filled': '초안을 기안문에 넣지 못했습니다. 열린 기안 창을 확인해 주세요.',
  'invalid-content': '넣을 초안 내용이 비어 있거나 너무 깁니다.',
};

// The helper's own reasons for a refused write are more specific than the coordinator's
// 'needs-user' and get their own guidance; 'draft-write-incomplete:<flags>' keeps its flags.
const HELPER_REASON_MESSAGES = {
  'not-blank': '기안창에 이미 내용이 있어 초안을 넣지 않았습니다. 빈 일반기안문 창에서 다시 시도해 주세요.',
  'draft-write-incomplete': '초안을 기안창에 넣었지만 제목이나 본문이 온전히 들어가지 않았습니다. 기안창을 확인하고, 필요하면 새 창에서 다시 시도해 주세요.',
  'editor-document-unavailable': '기안창 문서에 연결하지 못했습니다. 기안창이 완전히 열린 뒤 다시 시도해 주세요.',
  'editor-script-unavailable': '기안창이 초안 입력에 응답하지 않았습니다. 기안창이 완전히 열린 뒤 다시 시도해 주세요.',
  'editor-api-missing': '기안창이 예상한 편집 기능을 제공하지 않아 초안을 넣지 않았습니다.',
  'body-field-unreachable': '기안창의 본문 칸으로 이동하지 못해 본문을 넣지 않았습니다. 기안창을 확인한 뒤 다시 시도해 주세요.',
  'unexpected-form': '열린 기안창이 일반기안문 서식이 아니어서 초안을 넣지 않았습니다.',
  'editor-not-found': '초안을 넣을 기안창을 찾지 못했습니다. 다시 시도해 주세요.',
  'draft-content-empty': '넣을 초안의 제목이나 본문이 비어 있습니다.',
  'browser-or-menu-unavailable': 'K-에듀파인 화면이 Edge 앞에 보이지 않아 기안 메뉴를 열지 못했습니다. K-에듀파인 탭이 열려 있는지 확인한 뒤 다시 시도해 주세요.',
  'menu-not-actionable': 'K-에듀파인 상단 메뉴가 아직 반응하지 않았습니다. 화면이 다 열린 뒤 다시 시도해 주세요.',
  'left-tree-unavailable': 'K-에듀파인 왼쪽 메뉴를 찾지 못했습니다. 문서관리 화면인지 확인한 뒤 다시 시도해 주세요.',
  'menu-path-ambiguous': 'K-에듀파인 왼쪽 메뉴에서 기안 > 공용서식 경로를 확정하지 못했습니다. 화면을 확인한 뒤 다시 시도해 주세요.',
  'exact-form-not-actionable': '공용서식 목록에서 일반기안문 서식을 눌렀지만 반응이 없었습니다. 다시 시도해 주세요.',
  'ocr-point-not-actionable': '공용서식 목록에서 일반기안문 서식을 눌렀지만 반응이 없었습니다. 다시 시도해 주세요.',
  'verified-window-capture-unavailable': 'K-에듀파인 화면을 읽지 못했습니다. Edge 창이 화면에 보이는지 확인한 뒤 다시 시도해 주세요.',
  'korean-ocr-unavailable': '이 PC에 한국어 화면 인식 기능이 없어 공용서식 목록을 읽지 못했습니다. Windows 언어 설정에서 한국어 광학 문자 인식을 설치해 주세요.',
};

function translateDraftHandoffError(error) {
  const code = error?.code;
  if (!code || code === 'cancelled') return error;
  if (code === 'needs-user' && typeof error.message === 'string') {
    const key = Object.keys(HELPER_REASON_MESSAGES).find(name => error.message === name || error.message.startsWith(`${name}:`));
    if (key) return Object.assign(new Error(HELPER_REASON_MESSAGES[key]), { code: 'needs-user', reason: error.message });
  }
  if (!Object.hasOwn(DRAFT_HANDOFF_MESSAGES, code)) return error;
  return Object.assign(new Error(DRAFT_HANDOFF_MESSAGES[code]), { code: 'needs-user', reason: code });
}

function requireAuthenticationIfReturned(window) {
  if (window?.origin === SYSTEM_ORIGINS.portal && window.loginAvailable === true && window.authenticated === false && window.landing === null) {
    throw Object.assign(new Error('업무포털 로그인이 필요합니다. 공식 로그인 화면에서 로그인한 뒤 다시 시도해 주세요.'), {
      code: 'needs-user', reason: 'authentication-required',
    });
  }
}

class OrdinaryEdgeAdapter {
  constructor({ runNative, openExternal, getDriveHint = () => null, saveDriveHint = () => {}, getStoredPassword = () => null, onPasswordRejected = () => {}, draftHandoff = null, pause = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds)), landingTimeoutMs = 15000, surfaceLostMs = 15000, surfaceMissingMs = 45000, now = Date.now }) {
    this.runNative = runNative;
    this.openExternal = openExternal;
    this.getDriveHint = getDriveHint;
    this.saveDriveHint = saveDriveHint;
    this.getStoredPassword = getStoredPassword;
    this.onPasswordRejected = onPasswordRejected;
    this.draftHandoff = draftHandoff;
    this.pause = pause;
    this.landingTimeoutMs = landingTimeoutMs;
    this.surfaceLostMs = surfaceLostMs;
    this.surfaceMissingMs = surfaceMissingMs;
    this.now = now;
    this.operations = new WeakMap();
  }

  state(operation) {
    let state = this.operations.get(operation);
    if (!state) {
      state = { target: null, window: null, loginAttempted: false, hardDiskAttempted: false, removableAttempted: false, attemptedDrives: new Set(), certificateSelections: new Set(), observedDriveId: null, driveHintSaved: false, resumed: false, lostSince: null, requestedAt: null, passwordSubmitted: false, dismissedNotices: new Set() };
      this.operations.set(operation, state);
    }
    return state;
  }

  assertActive(operation) {
    if (!operation || operation.cancelled) throw new AuthenticationCancelledError();
  }

  async inspect(operation, target = null, desiredSystem = null, { restoreMinimised = false } = {}) {
    this.assertActive(operation);
    const response = validateResponse(await this.runNative({ command: 'inspect', ...(target ? { target } : {}), ...(restoreMinimised ? { restoreMinimised: true } : {}) }, operation));
    this.assertActive(operation);
    if (response.status !== 'ok') return null;
    let candidates = target ? response.windows.filter(window => sameTarget(window, target)) : response.windows;
    if (!target && desiredSystem) {
      const landed = candidates.filter(window => window.landing === desiredSystem);
      const capable = candidates.filter(window => window.availableSystems.includes(desiredSystem));
      const portal = candidates.filter(window => window.landing === 'portal');
      // Before login the portal window has no verified landing, so the three filters above all
      // miss it and the login could never be started. The official portal origin is the surface
      // every business action has to authenticate on, so fall back to it last.
      const portalSurface = candidates.filter(window => window.origin === SYSTEM_ORIGINS.portal);
      candidates = landed.length ? landed : capable.length ? capable : portal.length ? portal : portalSurface;
    }
    if (candidates.length > 1) {
      // The portal itself opens extra windows, so prefer the one in front rather than refusing.
      const focused = candidates.filter(window => window.foreground === true);
      if (focused.length !== 1) throw needsUser('ambiguous-window', '업무 화면이 열린 Edge 창이 여러 개여서 어느 창인지 확정할 수 없습니다. 쓰려는 창을 클릭한 뒤 다시 시도해 주세요.');
      candidates = focused;
    }
    if (candidates.length !== 1) return null;
    const window = candidates[0];
    return window;
  }

  // The helper only reads the page of the tab in front, so a logged-in portal sitting in
  // another tab is invisible to inspect(). The tab strip is not: any Edge window listing a
  // portal tab is returned here, the one in front first, even when the visible page is
  // something unrelated or the helper found no trusted page at all.
  async findSystemTabWindow(operation, system) {
    this.assertActive(operation);
    const response = validateResponse(await this.runNative({ command: 'inspect', restoreMinimised: true }, operation));
    this.assertActive(operation);
    if (!['ok', 'unavailable', 'ambiguous'].includes(response.status)) return null;
    const tabbed = response.windows.filter(window => window.availableSystems.includes(system));
    if (tabbed.length === 0) return null;
    return tabbed.find(window => window.foreground === true) || tabbed[0];
  }

  async openOfficialPortal(url, operation) {
    this.assertActive(operation);
    const state = this.state(operation);
    state.desiredSystem = systemForAction(operation.action);
    const existing = await this.inspect(operation, null, state.desiredSystem, { restoreMinimised: true });
    if (existing) {
      state.target = targetOf(existing);
      state.window = existing;
      return { opened: false };
    }
    // Already logged in, or at least already open: switch back to the portal tab instead of
    // opening yet another one. Every launch used to add a tab and log in again from scratch.
    const tabbed = await this.findSystemTabWindow(operation, 'portal');
    if (tabbed) {
      state.target = targetOf(tabbed);
      state.requestedAt = this.now();
      try {
        await this.invoke(state, 'activate-system-tab', operation, { system: 'portal', requireLanding: false });
        return { opened: false, activatedTab: true };
      } catch (error) {
        if (error instanceof AuthenticationCancelledError) throw error;
        // The tab could not be switched to (closed meanwhile, or the window vanished): fall
        // through and open the portal afresh rather than failing the whole task.
        state.target = null;
      }
    }
    state.requestedAt = this.now();
    await this.openExternal(url);
    this.assertActive(operation);
    return { opened: true };
  }

  // A session notice ('사용시간이 종료되었습니다', '세션이 만료되었습니다') is acknowledged once per
  // kind; pressing it is never taken as login — the caller re-observes the page afterwards.
  async dismissNotice(window, operation, state) {
    if (!window?.sessionNotice || state.dismissedNotices.has(window.sessionNotice)) return false;
    state.dismissedNotices.add(window.sessionNotice);
    await this.invoke(state, 'dismiss-session-notice', operation);
    await this.pause(400);
    return true;
  }

  async invoke(state, action, operation, details = {}) {
    this.assertActive(operation);
    const response = validateResponse(await this.runNative({ command: 'invoke', target: state.target, action, ...details }, operation));
    this.assertActive(operation);
    if (response.status !== 'ok' || response.invoked !== true) throw needsUser('not-invoked', '열린 Edge 화면에서 요청한 동작을 실행하지 못했습니다. 화면을 확인한 뒤 다시 시도해 주세요.');
    return response;
  }

  async observeAuthenticated(operation) {
    const state = this.state(operation);
    const window = state.window || await this.inspect(operation, state.target, state.desiredSystem);
    state.window = null;
    if (!window) {
      // Navigation briefly leaves no recognisable portal surface, but a closed Edge used to
      // leave the user staring at a spinner until the five minute authentication timeout.
      if (!state.target) {
        // Edge may still be starting, but a flow that never reaches the portal has to end.
        if (state.requestedAt !== null && this.now() - state.requestedAt > this.surfaceMissingMs) {
          throw needsUser('surface-missing', '업무포털 화면을 열지 못했습니다. Edge가 열렸는지 확인한 뒤 다시 시도해 주세요.');
        }
        return false;
      }
      state.lostSince = state.lostSince ?? this.now();
      if (this.now() - state.lostSince < this.surfaceLostMs) return false;
      throw needsUser('surface-lost', '업무포털 화면을 더 이상 찾을 수 없습니다. Edge 창이 닫혔는지 확인한 뒤 다시 시도해 주세요.');
    }
    state.lostSince = null;
    state.target = targetOf(window);
    if (await this.dismissNotice(window, operation, state)) return false;
    // A page anywhere inside 나이스 or K-에듀파인 (a sub-screen, not their front page) carries no
    // logout control and no landing, yet being there is itself proof of login. Without this
    // the widget spun on a teacher already working in K-에듀파인 until the five minute timeout.
    if (window.authenticated || window.landing !== null || insideAnyBusinessSystem(window)) {
      if (window.authenticated && state.observedDriveId && !state.driveHintSaved) {
        this.saveDriveHint(state.observedDriveId);
        state.driveHintSaved = true;
      }
      return true;
    }
    if (window.loginAvailable && !state.loginAttempted) {
      state.loginAttempted = true;
      await this.invoke(state, 'login', operation);
      return false;
    }
    const certificate = window.certificate;
    if (certificate.selectedDriveId) state.observedDriveId = certificate.selectedDriveId;
    if (certificate.visible && certificate.certRowCount === 1 && certificate.selectedCertRowCount === 0 && certificate.soleCertRowSelectable) {
      const key = `${certificate.selectedStore || 'unknown'}:${certificate.selectedDriveId || ''}`;
      if (!state.certificateSelections.has(key)) {
        state.certificateSelections.add(key);
        await this.invoke(state, 'select-certificate-row', operation);
      }
      return false;
    }
    if (certificate.visible && certificate.certRowCount === 1 && certificate.selectedCertRowCount === 1 && !state.passwordSubmitted) {
      const stored = this.getStoredPassword();
      if (typeof stored === 'string' && stored.length > 0 && stored.length <= MAX_PASSWORD_LENGTH) {
        // Exactly one attempt per operation. A stored password that has gone stale must not be
        // replayed against the certificate over and over.
        state.passwordSubmitted = true;
        try {
          await this.invoke(state, 'submit-certificate-password', operation, { password: stored });
        } catch (error) {
          if (error instanceof AuthenticationCancelledError) throw error;
          this.onPasswordRejected();
          throw needsUser('stored-password-failed', '저장해 둔 비밀번호로 로그인하지 못했어요. 인증서 창에서 직접 입력해 주세요. 저장된 비밀번호는 지웠습니다.');
        }
        return false;
      }
    }
    if (certificate.visible && certificate.certRowCount !== null && certificate.certRowCount > 0) return false;
    if (certificate.visible && certificate.selectedStore === null && certificate.hardDiskAvailable && !state.hardDiskAttempted) {
      state.hardDiskAttempted = true;
      await this.invoke(state, 'hard-disk', operation);
      return false;
    }
    if (certificate.visible && certificate.selectedStore === 'hard-disk' && certificate.hardDiskEmpty === true && certificate.removableAvailable && !state.removableAttempted) {
      state.removableAttempted = true;
      await this.invoke(state, 'removable-disk', operation);
      return false;
    }
    if (certificate.visible && certificate.selectedStore === 'removable-disk' && certificate.certRowCount === 0 && certificate.driveOptionsToken) {
      if (certificate.selectedDriveId) state.attemptedDrives.add(certificate.selectedDriveId);
      const hint = this.getDriveHint();
      const candidates = certificate.driveOptions.filter(option => !state.attemptedDrives.has(option.id));
      candidates.sort((left, right) => Number(right.id === hint) - Number(left.id === hint));
      const next = candidates[0];
      if (next) {
        state.attemptedDrives.add(next.id);
        await this.invoke(state, 'select-drive', operation, { driveId: next.id, driveOptionsToken: certificate.driveOptionsToken });
      }
    }
    return false;
  }

  async resumeAction(action, operation, options = {}) {
    this.assertActive(operation);
    const state = this.state(operation);
    if (state.resumed) throw new Error('Ordinary Edge operation already resumed.');
    const system = systemForAction(action);
    if (!system) throw needsUser('unsupported-action', '지원하지 않는 업무입니다.');
    state.resumed = true;
    const deepActionUnsupported = !['portal', 'neis', 'edufine'].includes(action);
    let window = state.target ? await this.inspect(operation, state.target, system) : null;
    requireAuthenticationIfReturned(window);
    // A page deep inside a business system reports authenticated=false, because that flag comes
    // from the portal's own logout control. Being inside the system is itself proof that login
    // already happened, so it must not be mistaken for a logged-out portal.
    // Sitting in one business system is proof of login even when another one was asked for:
    // the tab switch below is what takes the teacher there. Requiring the visible page to be
    // an authenticated portal refused 나이스 outright whenever K-에듀파인 was the tab on screen.
    if (!window || (!window.authenticated && window.landing === null && !insideSystem(window, system) && !insideAnyBusinessSystem(window))) {
      throw needsUser('portal-unavailable', `로그인된 업무포털 화면을 찾지 못해 ${SYSTEM_LABELS[system]}(으)로 이동하지 못했습니다. 업무포털에 로그인한 뒤 다시 시도해 주세요.`);
    }
    const needsLaunch = !insideSystem(window, system) && !window.availableSystems.includes(system);
    const launched = needsLaunch && window.landing === 'portal' && window.authenticated === true && window.actions.includes(system);
    if (launched) window = await this.launchSystem(system, operation, state, window);
    if (!window || (!insideSystem(window, system) && !window.availableSystems.includes(system))) throw needsUser(launched ? 'launch-not-arrived' : 'launch-unavailable', launched
      ? `${SYSTEM_LABELS[system]} 화면이 열리기를 기다렸지만 도착을 확인하지 못했습니다. 새로 열린 Edge 탭의 오류 메시지를 확인한 뒤 다시 시도해 주세요.`
      : `업무포털 화면에서 ${SYSTEM_LABELS[system]} 바로가기를 찾지 못했습니다. 업무포털 메인 화면인지 확인한 뒤 다시 시도해 주세요.`);
    state.window = window;
    if (window.availableSystems.includes(system)) await this.invoke(state, 'activate-system-tab', operation, { system });
    const deadline = this.now() + this.landingTimeoutMs;
    let landingWindow = null;
    while (this.now() < deadline) {
      const landed = await this.inspect(operation, state.target, system);
      // K-에듀파인 shows '사용시간이 종료되었습니다' after idling; 확인 reloads it through the
      // portal session, so the arrival check simply continues afterwards.
      if (await this.dismissNotice(landed, operation, state)) continue;
      requireAuthenticationIfReturned(landed);
      // Being anywhere inside the system counts as arrival for the actions that go on to
      // navigate it themselves (draft) and for the plain system buttons: a teacher sitting in
      // 공용서식 who presses K-에듀파인 is already where they asked to be, and demanding the
      // front page reported '도착을 확인하지 못했습니다' on a perfectly good screen.
      // 개인근무상황·출장 still need the real NEIS front page, because the menu walk that
      // follows reads its task state. A tab launched just now is the other exception: its page
      // is still loading, so a fresh launch waits for the front page rather than racing it.
      const insideCounts = !launched && ['draft', 'neis', 'edufine'].includes(action);
      if (landed && (readyForSystem(landed, system) || (insideCounts && showingSystem(landed, system)))) { landingWindow = landed; break; }
      await this.pause(100);
    }
    if (!landingWindow) throw needsUser('landing-unverified', `${SYSTEM_LABELS[system]} 화면으로 이동했지만 도착을 확인하지 못했습니다. 열린 화면을 확인해 주세요.`);
    if (deepActionUnsupported && ['attendance', 'trip'].includes(action)) return this.navigateNeisTask(action, operation, state, landingWindow, deadline);
    if (action === 'draft') {
      if (!this.draftHandoff) throw needsUser('draft-unavailable', '기안 창 연결이 구성되지 않았습니다.');
      let result;
      try {
        result = await this.draftHandoff.open(operation);
      } catch (error) {
        throw translateDraftHandoffError(error);
      }
      // The draft is written in the same operation as the open it belongs to. Filling later
      // would mean finding the window again, and by then it could be the teacher's own work.
      let drafted = false;
      if (options.draft && canFillBody(result)) {
        try {
          await this.draftHandoff.fill(result, options.draft, operation);
          drafted = true;
        } catch (error) {
          throw translateDraftHandoffError(error);
        }
      }
      return { verified: true, system: 'edufine', editorReused: result.reused === true, drafted };
    }
    return { verified: !deepActionUnsupported, system, deepActionUnsupported };
  }

  async launchSystem(system, operation, state, window) {
    if (window.landing !== 'portal' || window.authenticated !== true || !window.actions.includes(system)) return null;
    await this.invoke(state, system, operation);
    const deadline = this.now() + this.landingTimeoutMs;
    while (this.now() < deadline) {
      await this.pause(250);
      const opened = await this.inspect(operation, state.target, system);
      if (await this.dismissNotice(opened, operation, state)) continue;
      requireAuthenticationIfReturned(opened);
      // After clicking the launch link we must see real arrival, not just the right host.
      if (opened && (readyForSystem(opened, system) || opened.availableSystems.includes(system))) return opened;
    }
    return null;
  }

  async navigateNeisTask(task, operation, state, window, deadline) {
    const attempted = new Set();
    while (this.now() < deadline) {
      this.assertActive(operation);
      const taskState = window.neisTaskState;
      if (!taskState) throw needsUser('task-state-unavailable', `나이스 화면에서 ${TASK_LABELS[task]} 메뉴 상태를 읽지 못했습니다. 나이스 메인 화면인지 확인해 주세요.`);
      if (taskState.activeTask === task) return { verified: true, system: 'neis', activeTask: task };
      const tabAction = `select-${task}-tab`;
      const openAction = `open-${task}`;
      const action = taskState.actions.includes(tabAction) ? tabAction
        : taskState.actions.includes('select-my-menu') ? 'select-my-menu'
          : taskState.actions.includes('expand-duty') ? 'expand-duty'
            : taskState.actions.includes(openAction) ? openAction : null;
      if (!action) throw needsUser('task-unavailable', `나이스 화면에서 ${TASK_LABELS[task]} 메뉴를 찾지 못했습니다. 나의 메뉴에 복무 항목이 있는지 확인해 주세요.`);
      if (attempted.has(action)) throw needsUser('task-stalled', `${TASK_LABELS[task]} 메뉴로 이동하는 중 화면이 더 진행되지 않았습니다. 나이스 화면을 확인한 뒤 다시 시도해 주세요.`);
      attempted.add(action);
      await this.invoke(state, action, operation);
      await this.pause(100);
      window = await this.inspect(operation, state.target, 'neis');
      requireAuthenticationIfReturned(window);
      if (!window || window.landing !== 'neis') throw needsUser('task-landing-lost', `${TASK_LABELS[task]} 메뉴로 이동하는 중 나이스 화면을 놓쳤습니다. 나이스 화면을 확인한 뒤 다시 시도해 주세요.`);
    }
    throw needsUser('task-timeout', `${TASK_LABELS[task]} 화면으로 이동하기를 기다렸지만 도착을 확인하지 못했습니다. 다시 시도해 주세요.`);
  }
}

function systemForAction(action) {
  if (['portal', 'neis', 'edufine'].includes(action)) return action;
  if (['attendance', 'trip'].includes(action)) return 'neis';
  if (action === 'draft') return 'edufine';
  return null;
}

// Arrival: the system's own front page, which is what we report as success. An error page on
// the right host must never count.
function readyForSystem(window, system) {
  if (!system || window.landing !== system) return false;
  return system === 'portal' ? window.authenticated === true : true;
}

// Presence: already somewhere inside the system. Used to decide whether a launch is needed and
// for actions that navigate onwards themselves, so a screen already in use is not re-opened.
function insideSystem(window, system) {
  if (!system || !window) return false;
  return readyForSystem(window, system) || (system !== 'portal' && window.origin === SYSTEM_ORIGINS[system]);
}

// Being on a business system's own host is proof that the portal login already happened: those
// pages carry no logout control of their own, so authenticated/landing stay false there. It
// says nothing about which system was asked for — only that no fresh login is needed.
function insideAnyBusinessSystem(window) {
  return Boolean(window) && (window.origin === SYSTEM_ORIGINS.neis || window.origin === SYSTEM_ORIGINS.edufine);
}

// Showing: the system's own tab is the one on screen, not merely its host in the address bar.
// A browser error page keeps the host but loses the system's name from the tab, so this is
// what lets a sub-screen (공용서식, a NEIS task) count as arrival without letting a failure in.
function showingSystem(window, system) {
  if (!system || !window || system === 'portal') return false;
  return window.origin === SYSTEM_ORIGINS[system] && window.selectedSystem === system;
}

module.exports = { NativeOrdinaryEdgeBridge, OrdinaryEdgeAdapter, resolveOrdinaryEdgeHelper, resolveOrdinaryEdgeServeHelper, resolveDraftHandoffHelper, validateResponse, translateDraftHandoffError };
