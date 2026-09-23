const assert = require('node:assert/strict');
const { mkdtempSync, writeFileSync, rmSync } = require('node:fs');
const { tmpdir } = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const test = require('node:test');

const repo = path.resolve(__dirname, '..');
const bridge = path.join(repo, 'src', 'native', 'ordinary-edge.ps1');
const startedAt = '2026-09-20T10:00:00.0000000Z';

function windowFixture(overrides = {}) {
  return {
    pid: 411,
    hwnd: '9001',
    processName: 'msedge',
    processStartedAt: startedAt,
    visible: true,
    rootAvailable: true,
    rootProcessId: 411,
    addressControls: [{
      automationId: 'view_1021',
      controlType: 'Edit',
      isPassword: false,
      isOffscreen: false,
      value: 'https://sen.eduptl.kr/login?ticket=do-not-emit',
    }],
    documents: [],
    controls: [],
    landingMarkers: [],
    systemTabs: [],
    activationResults: {},
    neisTaskRoot: null,
    certificateRegion: null,
    emptyListSemantic: null,
    minimized: false,
    foregroundActivationResult: true,
    foregroundAfter: true,
    ...overrides,
  };
}

function target(overrides = {}) {
  return { pid: 411, hwnd: '9001', processStartedAt: startedAt, ...overrides };
}

function runBridge(requestText, fixture, timeout = 20000) {
  const temp = mkdtempSync(path.join(tmpdir(), 'edudock-native-edge-'));
  const fixturePath = path.join(temp, 'fixture.json');
  writeFileSync(fixturePath, JSON.stringify(fixture), 'utf8');
  const started = Date.now();
  const result = spawnSync('powershell.exe', [
    '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
    '-File', bridge, '-FixturePath', fixturePath, '-TimeoutMs', '3000',
  ], { cwd: repo, input: requestText, encoding: 'utf8', timeout });
  const elapsedMs = Date.now() - started;
  rmSync(temp, { recursive: true, force: true });
  assert.equal(result.error, undefined, result.error?.message);
  assert.equal(result.status, 0, `exit=${result.status}\nstdout=${result.stdout}\nstderr=${result.stderr}`);
  assert.equal(result.stderr, '', `stderr must stay empty: ${result.stderr}`);
  assert.ok(result.stdout.trim().startsWith('{') && result.stdout.trim().endsWith('}'), result.stdout);
  return { output: JSON.parse(result.stdout), raw: result.stdout, elapsedMs };
}

function assertPublicWindowShape(window) {
  assert.deepEqual(Object.keys(window).sort(), [
    'actions', 'authenticated', 'availableSystems', 'certificate', 'foreground', 'hwnd', 'landing',
    'loginAvailable', 'origin', 'pid', 'processStartedAt', 'selectedSystem', 'sessionNotice',
  ]);
  assert.deepEqual(Object.keys(window.certificate).sort(), [
    'certRowCount', 'driveOptions', 'driveOptionsToken', 'hardDiskAvailable',
    'hardDiskEmpty', 'removableAvailable', 'selectedCertRowCount', 'selectedDriveId',
    'selectedStore', 'soleCertRowSelectable', 'visible',
  ]);
}

test('inspect emits only sanitized trusted-window state and exact interactive actions', () => {
  const fixture = { windows: [windowFixture({ controls: [
    { automationId: 'btnLgn', name: 'unmapped label', role: 'Button', visible: true, enabled: true, patterns: ['Invoke'], processId: 411 },
    { name: '인증서 로그인', role: 'Button', visible: true, enabled: true, patterns: ['Invoke'], processId: 411 },
    { name: 'Logout', automationId: 'btn-logout', role: 'Hyperlink', visible: true, enabled: true, patterns: ['Invoke'], processId: 411, parentRole: 'Document', parentAutomationId: 'RootWebArea' },
    { name: '', automationId: 'https://sen.neis.go.kr/cmc_fcm_lg01_000.do?fixture=redacted', className: 'menuBtn', role: 'Hyperlink', visible: true, enabled: true, patterns: ['Invoke'], processId: 411 },
    { name: 'password-contents', role: 'Edit', visible: true, enabled: true, isPassword: true, value: 'secret', processId: 411 },
  ] })] };
  const { output, raw } = runBridge(JSON.stringify({ command: 'inspect' }), fixture);
  assert.equal(output.status, 'ok');
  assert.equal(output.windows.length, 1);
  assertPublicWindowShape(output.windows[0]);
  assert.equal(output.windows[0].origin, 'https://sen.eduptl.kr');
  assert.equal(output.windows[0].authenticated, true, JSON.stringify(output));
  assert.equal(output.windows[0].loginAvailable, true);
  assert.deepEqual(output.windows[0].actions, ['login', 'portal', 'neis']);
  assert.equal(raw.includes('ticket='), false);
  assert.equal(raw.includes('password-contents'), false);
  assert.equal(raw.includes('secret'), false);
});

test('authenticated requires the observed exact Logout identity and interactive document parent', () => {
  const impostors = { windows: [windowFixture({ controls: [
    { name: 'Logout', automationId: 'wrong-id', role: 'Hyperlink', visible: true, enabled: true, patterns: ['Invoke'], processId: 411, parentRole: 'Document', parentAutomationId: 'RootWebArea' },
    { name: 'Logout', automationId: 'btn-logout', role: 'Text', visible: true, enabled: true, patterns: [], processId: 411, parentRole: 'Document', parentAutomationId: 'RootWebArea' },
  ] })] };
  assert.equal(runBridge(JSON.stringify({ command: 'inspect' }), impostors).output.windows[0].authenticated, false);
});

test('business actions accept only exact menuBtn URI descriptors and never emit SSO queries', () => {
  const controls = [
    { name: '나이스', automationId: 'neisNtc', className: 'active', role: 'ListItem', visible: true, enabled: true, patterns: ['Invoke'], processId: 411 },
    { name: '나이스', automationId: 'help-neis', className: 'tsBtn', role: 'Hyperlink', visible: true, enabled: true, patterns: ['Invoke'], processId: 411 },
    { name: '', automationId: 'https://sen.neis.go.kr/cmc_fcm_lg01_000.do?sso=never-emit-a', className: 'menuBtn', role: 'Hyperlink', visible: true, enabled: true, patterns: ['Invoke'], processId: 411 },
    { name: '', automationId: 'http://klef.sen.go.kr/?sso=never-emit-b', className: 'menuBtn', role: 'Hyperlink', visible: true, enabled: true, patterns: ['Invoke'], processId: 411 },
    { name: '', automationId: 'http://sen.neis.go.kr/cmc_fcm_lg01_000.do?bad=1', className: 'menuBtn', role: 'Hyperlink', visible: true, enabled: true, patterns: ['Invoke'], processId: 411 },
  ];
  const fixture = { windows: [windowFixture({ controls })] };
  const inspected = runBridge(JSON.stringify({ command: 'inspect' }), fixture);
  assert.ok(inspected.output.windows[0].actions.includes('neis'));
  assert.ok(inspected.output.windows[0].actions.includes('edufine'));
  assert.equal(inspected.raw.includes('never-emit'), false);
  const invoked = runBridge(JSON.stringify({ command: 'invoke', target: target(), action: 'neis' }), fixture).output;
  assert.equal(invoked.status, 'ok');
  assert.equal(invoked.invoked, true);
});

test('business link selection fails closed for stale owners and duplicate real launch links', () => {
  const real = { name: '', automationId: 'https://sen.neis.go.kr/cmc_fcm_lg01_000.do?dynamic=one', className: 'menuBtn', role: 'Hyperlink', visible: true, enabled: true, patterns: ['Invoke'], processId: 411 };
  const fixture = { windows: [windowFixture({ controls: [
    real,
    { ...real, automationId: 'https://sen.neis.go.kr/cmc_fcm_lg01_000.do?dynamic=two' },
    { ...real, processId: 999, automationId: 'https://sen.neis.go.kr/cmc_fcm_lg01_000.do?dynamic=stale' },
  ] })] };
  const result = runBridge(JSON.stringify({ command: 'invoke', target: target(), action: 'neis' }), fixture).output;
  assert.equal(result.status, 'ambiguous');
  assert.equal(result.invoked, false);
});

test('NEIS landing is observed from exact HTTPS origin and path with query redacted', () => {
  const fixture = { windows: [windowFixture({
    addressControls: [{ automationId: 'view_1021', controlType: 'Edit', isPassword: false, value: 'https://sen.neis.go.kr/jsp/main.jsp?sso=never-emit-landing' }],
    controls: [{ name: '로그아웃', role: 'Button', visible: true, enabled: true, patterns: ['Invoke'], processId: 411 }],
  })] };
  const result = runBridge(JSON.stringify({ command: 'inspect' }), fixture);
  assert.equal(result.output.status, 'ok');
  assert.equal(result.output.windows[0].origin, 'https://sen.neis.go.kr');
  assert.equal(result.output.windows[0].landing, 'neis');
  assert.equal(result.output.windows[0].authenticated, true);
  assert.equal(result.raw.includes('never-emit-landing'), false);

  const urlOnly = runBridge(JSON.stringify({ command: 'inspect' }), { windows: [windowFixture({
    addressControls: [{ automationId: 'view_1021', controlType: 'Edit', isPassword: false, value: 'https://sen.neis.go.kr/jsp/main.jsp' }],
  })] }).output.windows[0];
  assert.equal(urlOnly.landing, null);
  assert.equal(urlOnly.authenticated, false);
});

function neisControl(name, role, className, overrides = {}) {
  return {
    name, role, className, processId: 411, visible: true, enabled: true,
    patterns: [], selected: false, expanded: false,
    bounds: { left: 100, top: 100, width: 120, height: 30 },
    pointOwnerHwnd: '9001', ...overrides,
  };
}

function neisTaskRoot(overrides = {}) {
  return {
    processId: 411, hwnd: '9001', processStartedAt: startedAt,
    origin: 'https://sen.neis.go.kr', locked: false, cancelled: false,
    controls: [
      neisControl('나의 메뉴', 'Button', 'btn-asd mymenu', { patterns: ['SelectionItem'], selected: true }),
      neisControl('복무 0단계 메뉴항목', 'MenuItem', 'cl-folder cl-level-1 cl-sidenavigation-item', { patterns: ['ExpandCollapse'], expanded: true }),
      neisControl('개인근무상황관리', 'Group', 'cl-leaf cl-level-2 cl-sidenavigation-item', { patterns: ['ScrollItem'], privateValue: 'SECRET-NEVER-EMIT' }),
      neisControl('개인출장관리', 'Group', 'cl-leaf cl-level-2 cl-sidenavigation-item', { patterns: ['ScrollItem'] }),
    ],
    ...overrides,
  };
}

function neisWindow(overrides = {}) {
  return windowFixture({
    addressControls: [{ automationId: 'view_1021', controlType: 'Edit', isPassword: false, value: 'https://sen.neis.go.kr/jsp/main.jsp?token=discard' }],
    controls: [{ name: '로그아웃', role: 'Button', visible: true, enabled: true, patterns: ['Invoke'], processId: 411 }],
    neisTaskRoot: neisTaskRoot(),
    ...overrides,
  });
}

test('core exposes sanitized NEIS task state only on a verified NEIS landing', () => {
  const inspected = runBridge(JSON.stringify({ command: 'inspect' }), { windows: [neisWindow()] });
  assert.deepEqual(inspected.output.windows[0].neisTaskState, {
    myMenuSelected: true,
    dutyExpanded: true,
    visibleTasks: ['attendance', 'trip'],
    existingTaskTabs: [],
    activeTask: null,
    actions: ['open-attendance', 'open-trip'],
  });
  assert.equal(inspected.raw.includes('SECRET-NEVER-EMIT'), false);
  assert.equal(inspected.raw.includes('token=discard'), false);

  const portal = runBridge(JSON.stringify({ command: 'inspect' }), { windows: [windowFixture()] }).output.windows[0];
  assert.equal(Object.hasOwn(portal, 'neisTaskState'), false);
});

test('core routes one allowlisted NEIS task action and fails closed on cancel, stale root, and unsafe names', () => {
  const fixture = { windows: [neisWindow()] };
  const invoked = runBridge(JSON.stringify({ command: 'invoke', target: target(), action: 'open-attendance' }), fixture).output;
  assert.equal(invoked.status, 'ok');
  assert.equal(invoked.invoked, true);

  const cancelled = { windows: [neisWindow({ neisTaskRoot: neisTaskRoot({ cancelled: true }) })] };
  const stopped = runBridge(JSON.stringify({ command: 'invoke', target: target(), action: 'open-trip' }), cancelled).output;
  assert.equal(stopped.status, 'cancelled');
  assert.equal(stopped.invoked, false);

  const stale = { windows: [neisWindow({ neisTaskRoot: neisTaskRoot({ processStartedAt: '2026-09-20T00:00:00Z' }) })] };
  const unavailable = runBridge(JSON.stringify({ command: 'invoke', target: target(), action: 'open-trip' }), stale).output;
  assert.equal(unavailable.status, 'unavailable');
  assert.equal(unavailable.invoked, false);

  const unsafe = runBridge(JSON.stringify({ command: 'invoke', target: target(), action: 'submit-attendance' }), fixture).output;
  assert.equal(unsafe.status, 'error');
  assert.equal(unsafe.invoked, false);
});

test('K-EdYouFine landing requires exact HTTPS path and observed public document markers', () => {
  const fixture = { windows: [windowFixture({
    addressControls: [{ automationId: 'view_1021', controlType: 'Edit', isPassword: false, value: 'https://klef.sen.go.kr/keris_ui/main.do?sso=never-emit-klef' }],
    landingMarkers: [
      { kind: 'document', name: 'K-에듀파인', automationId: 'RootWebArea', role: 'Document', visible: true, processId: 411 },
      { kind: 'text', name: '문서관리', role: 'Text', visible: true, processId: 411 },
      { kind: 'text', name: '문서관리', role: 'Text', visible: true, processId: 411 },
    ],
  })] };
  const result = runBridge(JSON.stringify({ command: 'inspect' }), fixture);
  assert.equal(result.output.status, 'ok');
  assert.equal(result.output.windows[0].origin, 'https://klef.sen.go.kr');
  assert.equal(result.output.windows[0].landing, 'edufine');
  assert.equal(result.raw.includes('never-emit-klef'), false);

  const urlOnly = runBridge(JSON.stringify({ command: 'inspect' }), { windows: [windowFixture({
    addressControls: [{ automationId: 'view_1021', controlType: 'Edit', isPassword: false, value: 'https://klef.sen.go.kr/keris_ui/main.do' }],
  })] }).output.windows[0];
  assert.equal(urlOnly.landing, null);
});

test('portal action foregrounds only the exact authenticated owned window and fails on OS denial', () => {
  const authenticatedControl = { name: 'Logout', automationId: 'btn-logout', role: 'Hyperlink', visible: true, enabled: true, patterns: ['Invoke'], processId: 411, parentRole: 'Document', parentAutomationId: 'RootWebArea' };
  const allowed = { windows: [windowFixture({ controls: [authenticatedControl] })] };
  const success = runBridge(JSON.stringify({ command: 'invoke', target: target(), action: 'portal' }), allowed).output;
  assert.equal(success.status, 'ok');
  assert.equal(success.invoked, true);
  assert.ok(success.windows[0].actions.includes('portal'));

  const denied = { windows: [windowFixture({ controls: [authenticatedControl], foregroundActivationResult: false, foregroundAfter: false })] };
  const unavailable = runBridge(JSON.stringify({ command: 'invoke', target: target(), action: 'portal' }), denied).output;
  assert.equal(unavailable.status, 'unavailable');
  assert.equal(unavailable.invoked, false);

  const loggedOut = { windows: [windowFixture()] };
  const refused = runBridge(JSON.stringify({ command: 'invoke', target: target(), action: 'portal' }), loggedOut).output;
  assert.equal(refused.status, 'unavailable');
  assert.equal(refused.invoked, false);

  const cancelled = { windows: [windowFixture({ controls: [authenticatedControl], cancelledBeforeActivation: true })] };
  const stopped = runBridge(JSON.stringify({ command: 'invoke', target: target(), action: 'portal' }), cancelled).output;
  assert.equal(stopped.status, 'cancelled');
  assert.equal(stopped.invoked, false);
});

test('system-tab activation reuses one owned tab and verifies the requested landing on the same HWND', () => {
  const portalLanding = windowFixture({
    controls: [{ name: 'Logout', automationId: 'btn-logout', role: 'Hyperlink', visible: true, enabled: true, patterns: ['Invoke'], processId: 411, parentRole: 'Document', parentAutomationId: 'RootWebArea' }],
  });
  const source = windowFixture({
    addressControls: [{ automationId: 'view_1021', controlType: 'Edit', isPassword: false, value: 'https://unrelated.example/' }],
    systemTabs: [
      { system: 'portal', publicName: '업무포털 - 학교', role: 'TabItem', className: 'EdgeTab', automationId: 'view_24', visible: true, enabled: true, selectionAvailable: true, selected: false, processId: 411 },
      { system: 'neis', publicName: '나이스', role: 'TabItem', className: 'EdgeTab', automationId: 'view_24', visible: true, enabled: true, selectionAvailable: true, selected: true, processId: 411 },
      { system: 'edufine', publicName: 'K-에듀파인', role: 'TabItem', className: 'EdgeTab', automationId: 'view_24', visible: true, enabled: true, selectionAvailable: true, selected: false, processId: 411 },
    ],
    activationResults: { portal: portalLanding },
  });
  const result = runBridge(JSON.stringify({ command: 'invoke', target: target(), action: 'activate-system-tab', system: 'portal' }), { windows: [source] });
  assert.equal(result.output.status, 'ok');
  assert.equal(result.output.invoked, true);
  assert.equal(result.output.windows[0].landing, 'portal');
  assert.deepEqual(result.output.windows[0].availableSystems, []);
  assert.equal(result.raw.includes('업무포털 - 학교'), false);
});

test('system-tab activation fails closed for spoofed landing, duplicates, cancellation, and focus denial', () => {
  const tab = { system: 'neis', publicName: '나이스', role: 'TabItem', className: 'EdgeTab', automationId: 'view_24', visible: true, enabled: true, selectionAvailable: true, selected: false, processId: 411 };
  const spoof = windowFixture({
    systemTabs: [tab],
    activationResults: { neis: windowFixture({ addressControls: [{ automationId: 'view_1021', controlType: 'Edit', isPassword: false, value: 'https://evil.example/jsp/main.jsp' }] }) },
  });
  const wrong = runBridge(JSON.stringify({ command: 'invoke', target: target(), action: 'activate-system-tab', system: 'neis' }), { windows: [spoof] }).output;
  assert.equal(wrong.status, 'unavailable');
  assert.equal(wrong.invoked, false);

  for (const source of [
    windowFixture({ systemTabs: [] }),
    windowFixture({ systemTabs: [tab], cancelledBeforeActivation: true }),
  ]) {
    const output = runBridge(JSON.stringify({ command: 'invoke', target: target(), action: 'activate-system-tab', system: 'neis' }), { windows: [source] }).output;
    assert.ok(['ambiguous', 'unavailable', 'cancelled'].includes(output.status), JSON.stringify(output));
    assert.equal(output.invoked, false);
  }
});

test('system-tab activation succeeds on its landing even when Windows keeps the foreground elsewhere', () => {
  // The user keeps working in another window while a task runs. Windows then refuses to
  // raise Edge, but the tab is selected and the landing verified, so that is still success.
  const tab = { system: 'neis', publicName: '나이스', role: 'TabItem', className: 'EdgeTab', automationId: 'view_24', visible: true, enabled: true, selectionAvailable: true, selected: false, processId: 411 };
  const neisLanding = windowFixture({
    addressControls: [{ automationId: 'view_1021', controlType: 'Edit', isPassword: false, value: 'https://sen.neis.go.kr/jsp/main.jsp' }],
    controls: [{ name: '로그아웃', role: 'Button', visible: true, enabled: true, patterns: ['Invoke'], processId: 411 }],
    foreground: false,
  });
  const source = windowFixture({ systemTabs: [tab], foregroundActivationResult: false, foregroundAfter: false, activationResults: { neis: neisLanding } });
  const output = runBridge(JSON.stringify({ command: 'invoke', target: target(), action: 'activate-system-tab', system: 'neis' }), { windows: [source] }).output;
  assert.equal(output.status, 'ok', JSON.stringify(output));
  assert.equal(output.invoked, true);
  assert.equal(output.windows[0].landing, 'neis');
  assert.equal(output.windows[0].foreground, false, 'the helper reports the foreground honestly instead of failing');
});

test('already-selected system tab still requires exact landing and foreground verification', () => {
  const source = windowFixture({
    addressControls: [{ automationId: 'view_1021', controlType: 'Edit', isPassword: false, value: 'https://sen.neis.go.kr/jsp/main.jsp' }],
    controls: [{ name: '로그아웃', role: 'Button', visible: true, enabled: true, patterns: ['Invoke'], processId: 411 }],
    systemTabs: [{ system: 'neis', publicName: '나이스', role: 'TabItem', className: 'EdgeTab', automationId: 'view_24', visible: true, enabled: true, selectionAvailable: true, selected: true, processId: 411 }],
  });
  const output = runBridge(JSON.stringify({ command: 'invoke', target: target(), action: 'activate-system-tab', system: 'neis' }), { windows: [source] }).output;
  assert.equal(output.status, 'ok');
  assert.equal(output.invoked, true);
  assert.equal(output.windows[0].landing, 'neis');
});

test('certificate rows deduplicate header and four selectable cells into one distinct row', () => {
  const fixture = { windows: [windowFixture({
    controls: [
      { name: '이동식디스크', role: 'Button', visible: true, enabled: true, patterns: ['Invoke'], processId: 411, selected: true },
    ],
    certificateRegion: {
      verified: true,
      drives: [
        { id: 'D:', label: 'DATA(D:)', selected: true, visible: true, enabled: true, patterns: ['Invoke'], processId: 411 },
        { id: 'E:', label: 'USB(E:)', selected: false, visible: true, enabled: true, patterns: ['Invoke'], processId: 411 },
      ],
      rows: [
        { header: true, visible: true, childCellCount: 4, selectableCellCount: 0, selected: false },
        { header: false, visible: true, childCellCount: 4, selectableCellCount: 4, selected: false, selectionAvailable: true },
      ],
    },
  })] };
  const output = runBridge(JSON.stringify({ command: 'inspect' }), fixture).output;
  assert.equal(output.status, 'ok');
  assert.deepEqual(output.windows[0].certificate.driveOptions, [
    { id: 'D:', label: 'DATA(D:)', selected: true },
    { id: 'E:', label: 'USB(E:)', selected: false },
  ]);
  assert.equal(output.windows[0].certificate.driveOptionsToken, 'D:|E:');
  assert.equal(output.windows[0].certificate.selectedDriveId, 'D:');
  assert.equal(output.windows[0].certificate.certRowCount, 1);
  assert.equal(output.windows[0].certificate.selectedCertRowCount, 0);
  assert.equal(output.windows[0].certificate.soleCertRowSelectable, true);
  assert.ok(output.windows[0].actions.includes('select-drive'));
  assert.ok(output.windows[0].actions.includes('select-certificate-row'));
});

test('drive selection revalidates option token and certificate row cardinality', () => {
  const certificateRegion = {
    verified: true,
    drives: [
      { id: 'D:', label: 'DATA(D:)', selected: false, visible: true, enabled: true, patterns: ['Invoke'], processId: 411 },
      { id: 'E:', label: 'USB(E:)', selected: true, visible: true, enabled: true, patterns: ['Invoke'], processId: 411 },
    ],
    rows: [{ header: true, visible: true, childCellCount: 4, selectableCellCount: 0, selected: false }],
  };
  const fixture = { windows: [windowFixture({ certificateRegion })] };
  const selected = runBridge(JSON.stringify({
    command: 'invoke', target: target(), action: 'select-drive', driveId: 'D:', driveOptionsToken: 'D:|E:',
  }), fixture).output;
  assert.equal(selected.status, 'ok');
  assert.equal(selected.invoked, true);

  for (const request of [
    { command: 'invoke', target: target(), action: 'select-drive', driveId: '../../', driveOptionsToken: 'D:|E:' },
    { command: 'invoke', target: target(), action: 'select-drive', driveId: 'D:', driveOptionsToken: 'stale' },
    { command: 'invoke', target: target(), action: 'select-drive', driveId: 'F:', driveOptionsToken: 'D:|E:' },
  ]) {
    const result = runBridge(JSON.stringify(request), fixture).output;
    assert.ok(['error', 'stale'].includes(result.status), JSON.stringify(result));
    assert.equal(result.invoked, false);
  }

  const oneRow = { windows: [windowFixture({ certificateRegion: {
    ...certificateRegion,
    rows: [
      { header: true, visible: true, childCellCount: 4, selectableCellCount: 0, selected: false },
      { header: false, visible: true, childCellCount: 4, selectableCellCount: 4, selected: false, selectionAvailable: true },
    ],
  } })] };
  const row = runBridge(JSON.stringify({ command: 'invoke', target: target(), action: 'select-certificate-row' }), oneRow).output;
  assert.equal(row.status, 'ok');
  assert.equal(row.invoked, true);

  const multiple = { windows: [windowFixture({ certificateRegion: {
    ...certificateRegion,
    rows: [
      { header: false, visible: true, childCellCount: 4, selectableCellCount: 4, selected: false, selectionAvailable: true },
      { header: false, visible: true, childCellCount: 4, selectableCellCount: 4, selected: false, selectionAvailable: true },
    ],
  } })] };
  const refused = runBridge(JSON.stringify({ command: 'invoke', target: target(), action: 'select-certificate-row' }), multiple).output;
  assert.equal(refused.status, 'unavailable');
  assert.equal(refused.invoked, false);
});

test('malformed input, untrusted origins, and ambiguous address evidence fail closed', () => {
  assert.deepEqual(runBridge('{oops', { windows: [] }).output, { status: 'error', windows: [] });

  const wrong = runBridge(JSON.stringify({ command: 'inspect' }), {
    windows: [windowFixture({ addressControls: [{ automationId: 'view_1021', controlType: 'Edit', isPassword: false, value: 'https://evil.example/?secret=x' }] })],
  });
  assert.equal(wrong.output.status, 'unavailable');
  assert.equal(wrong.output.windows[0].origin, null);
  assert.equal(wrong.raw.includes('evil.example'), false);
  assert.equal(wrong.raw.includes('secret=x'), false);

  const ambiguous = runBridge(JSON.stringify({ command: 'inspect' }), {
    windows: [windowFixture({ documents: [{ controlType: 'Document', isPassword: false, legacyValue: 'https://other.example/' }] })],
  }).output;
  assert.equal(ambiguous.status, 'ambiguous');
  assert.equal(ambiguous.windows[0].origin, null);
});

test('target identity revalidation rejects stale pid, hwnd, start time, and closed windows', () => {
  const fixture = { windows: [windowFixture()] };
  for (const staleTarget of [
    target({ pid: 412 }),
    target({ hwnd: '9002' }),
    target({ processStartedAt: '2026-09-20T10:00:01.0000000Z' }),
  ]) {
    assert.equal(runBridge(JSON.stringify({ command: 'inspect', target: staleTarget }), fixture).output.status, 'stale');
  }
  assert.equal(runBridge(JSON.stringify({ command: 'inspect', target: target() }), {
    windows: [windowFixture({ visible: false })],
  }).output.status, 'stale');
});

test('invoke requires one exact visible enabled owned control with Invoke or SelectionItem', () => {
  const unique = { windows: [windowFixture({ controls: [
    { name: '하드디스크', role: 'RadioButton', visible: true, enabled: true, patterns: ['SelectionItem'], processId: 411, selected: false },
  ] })] };
  const invoked = runBridge(JSON.stringify({ command: 'invoke', target: target(), action: 'hard-disk' }), unique).output;
  assert.equal(invoked.status, 'ok');
  assert.equal(invoked.invoked, true);

  const duplicate = { windows: [windowFixture({ controls: [
    { name: '하드디스크', role: 'RadioButton', visible: true, enabled: true, patterns: ['SelectionItem'], processId: 411 },
    { name: '하드디스크', role: 'Button', visible: true, enabled: true, patterns: ['Invoke'], processId: 411 },
  ] })] };
  const refused = runBridge(JSON.stringify({ command: 'invoke', target: target(), action: 'hard-disk' }), duplicate).output;
  assert.equal(refused.status, 'ambiguous');
  assert.equal(refused.invoked, false);
});

test('certificate emptiness is true only for explicit official semantics and cross-process controls are ignored', () => {
  const explicit = runBridge(JSON.stringify({ command: 'inspect' }), { windows: [windowFixture({
    controls: [{ name: '하드디스크', role: 'RadioButton', visible: true, enabled: true, patterns: ['SelectionItem'], processId: 411, selected: true }],
    certificateRegion: {
      verified: true,
      drives: [],
      rows: [{ header: true, visible: true, childCellCount: 4, selectableCellCount: 0, selected: false }],
    },
  })] }).output.windows[0];
  assert.equal(explicit.certificate.hardDiskEmpty, true);
  assert.equal(explicit.certificate.selectedStore, 'hard-disk');

  const absent = runBridge(JSON.stringify({ command: 'inspect' }), { windows: [windowFixture({ controls: [
    { name: '이동식디스크', role: 'RadioButton', visible: true, enabled: true, patterns: ['SelectionItem'], processId: 999 },
  ] })] }).output.windows[0];
  assert.equal(absent.certificate.hardDiskEmpty, null);
  assert.equal(absent.certificate.visible, false);
  assert.equal(absent.actions.includes('removable-disk'), false);
});

test('password address values are never read and bounded worker timeout leaves sanitized output', () => {
  const passwordTrap = { windows: [windowFixture({
    addressControls: [{ automationId: 'view_1021', controlType: 'Edit', isPassword: true, value: 'https://evil.example/password-secret' }],
    documents: [{ controlType: 'Document', isPassword: false, legacyValue: 'https://sen.eduptl.kr/home?private=discard' }],
  })] };
  const clean = runBridge(JSON.stringify({ command: 'inspect' }), passwordTrap);
  assert.equal(clean.output.status, 'ok');
  assert.equal(clean.output.windows[0].origin, 'https://sen.eduptl.kr');
  assert.equal(clean.raw.includes('password-secret'), false);
  assert.equal(clean.raw.includes('private=discard'), false);

  const timed = runBridge(JSON.stringify({ command: 'inspect' }), { delayMs: 5000, windows: [windowFixture()] });
  assert.equal(timed.output.status, 'cancelled');
  assert.deepEqual(timed.output.windows, []);
  assert.ok(timed.elapsedMs < 5000, `elapsed ${timed.elapsedMs}ms`);
});

test('the official store buttons mark their selection only by class name, and that drives selectedStore', () => {
  const store = (name, className) => ({ name, automationId: '', className, role: 'Button', visible: true, enabled: true, patterns: ['Invoke'], processId: 411 });
  const region = { verified: true, drives: [], rows: [{ header: true, visible: true, childCellCount: 4, selectableCellCount: 0, selected: false, selectionAvailable: false, actionElement: null }] };

  const hard = runBridge(JSON.stringify({ command: 'inspect' }), {
    windows: [windowFixture({ certificateRegion: region, controls: [store('하드디스크', 'kc-rbg-pressed'), store('이동식디스크', 'kc-rbg-normal')] })],
  }).output;
  assert.equal(hard.windows[0].certificate.selectedStore, 'hard-disk');
  assert.equal(hard.windows[0].certificate.hardDiskEmpty, true, 'an empty hard disk must be reported so the removable fallback can run');

  const removable = runBridge(JSON.stringify({ command: 'inspect' }), {
    windows: [windowFixture({ certificateRegion: region, controls: [store('하드디스크', 'kc-rbg-normal'), store('이동식디스크', 'kc-rbg-pressed')] })],
  }).output;
  assert.equal(removable.windows[0].certificate.selectedStore, 'removable-disk');

  const none = runBridge(JSON.stringify({ command: 'inspect' }), {
    windows: [windowFixture({ certificateRegion: region, controls: [store('하드디스크', 'kc-rbg-normal'), store('이동식디스크', 'kc-rbg-normal')] })],
  }).output;
  assert.equal(none.windows[0].certificate.selectedStore, null);
  assert.equal(none.windows[0].certificate.hardDiskEmpty, null);
});

test('the certificate password request is refused unless it carries a usable secret', () => {
  const region = { verified: true, drives: [], rows: [{ header: true, visible: true, childCellCount: 4, selectableCellCount: 0, selected: false, selectionAvailable: false, actionElement: null }] };
  const fixture = { windows: [windowFixture({ certificateRegion: region })] };
  for (const request of [
    { command: 'invoke', target: target(), action: 'submit-certificate-password' },
    { command: 'invoke', target: target(), action: 'submit-certificate-password', password: '' },
    { command: 'invoke', target: target(), action: 'submit-certificate-password', password: 'x'.repeat(257) },
    { command: 'invoke', target: target(), action: 'submit-certificate-password', password: 12345 },
  ]) {
    const result = runBridge(JSON.stringify(request), fixture).output;
    assert.equal(result.status, 'error');
    assert.equal(result.invoked, false);
  }
});

test('a certificate password is never echoed back in the helper response', () => {
  const region = { verified: true, drives: [], rows: [{ header: true, visible: true, childCellCount: 4, selectableCellCount: 0, selected: false, selectionAvailable: false, actionElement: null }] };
  const fixture = { windows: [windowFixture({ certificateRegion: region })] };
  const { raw } = runBridge(JSON.stringify({ command: 'invoke', target: target(), action: 'submit-certificate-password', password: 'sup3r-s3cret' }), fixture);
  assert.equal(raw.includes('sup3r-s3cret'), false, 'the secret must not appear in helper output');
});

test('a real run compiles its interop type, so inspect never reports a crash', () => {
  // Fixture runs skip Get-RealWindows and therefore never compile the embedded C#. A C# 7
  // construct once broke every live Edge feature while this suite stayed green, so this
  // exercises the real path: with or without Edge open, 'error' means the helper threw.
  const run = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', bridge,
    '-RequestBase64', Buffer.from(JSON.stringify({ command: 'inspect' }), 'utf8').toString('base64'), '-TimeoutMs', '10000'],
  { encoding: 'utf8', timeout: 60000 });
  assert.equal(run.status, 0, run.stderr);
  const parsed = JSON.parse(run.stdout.trim());
  assert.notEqual(parsed.status, 'error', 'the helper threw; check the embedded C# and UIA calls');
  assert.ok(['ok', 'unavailable', 'ambiguous'].includes(parsed.status), `unexpected status ${parsed.status}`);
});

test('native scripts never assign to a read-only PowerShell automatic variable', () => {
  // `$pid = ...` threw at runtime and broke the whole public-form walk while every
  // fixture test stayed green, because fixtures never reach that code path.
  const { readFileSync, readdirSync } = require('node:fs');
  const nativeDir = path.join(repo, 'src', 'native');
  const reserved = ['pid', 'host', 'true', 'false', 'null', 'error', 'args', 'input', 'matches', 'psitem'];
  const offences = [];
  for (const file of readdirSync(nativeDir).filter(name => name.endsWith('.ps1'))) {
    const text = readFileSync(path.join(nativeDir, file), 'utf8');
    text.split(/\r?\n/).forEach((line, index) => {
      const withoutComment = line.replace(/#.*$/, '');
      for (const name of reserved) {
        if (new RegExp(`\$${name}\s*=[^=]`, 'i').test(withoutComment)) offences.push(`${file}:${index + 1} $${name}`);
      }
    });
  }
  assert.deepEqual(offences, [], `assigning to these automatic variables fails at runtime: ${offences.join(', ')}`);
});

test('native helpers never move or press the real mouse', () => {
  // Every press now goes through the page (UIA patterns, the accessibility default action,
  // or messages to Edge\'s render surface). Moving the cursor and clicking the pixel only
  // worked while nothing covered it, and it stole the pointer from the user mid-task.
  const { readFileSync, readdirSync } = require('node:fs');
  const nativeDir = path.join(repo, 'src', 'native');
  const forbidden = [/SetCursorPos/, /mouse_event/, /MOUSEEVENTF/, /INPUT_MOUSE/, /SendInput\([^)]*MOUSEINPUT/];
  for (const file of readdirSync(nativeDir).filter(name => name.endsWith('.ps1'))) {
    const text = readFileSync(path.join(nativeDir, file), 'utf8');
    for (const pattern of forbidden) assert.doesNotMatch(text, pattern, `${file} synthesizes mouse input`);
  }
});

const edufineAddress = [{ automationId: 'view_1021', controlType: 'Edit', isPassword: false, isOffscreen: false, value: 'https://klef.sen.go.kr/keris_ui/main.do' }];
const usetimeNotice = [
  { role: 'Text', name: '사용시간이 종료되었습니다.', className: '', automationId: '', visible: true, enabled: true, patterns: [], processId: 411 },
  { role: 'Button', name: '확인 ', className: 'Button btn_POP_Confirm', automationId: 'mainframe.MainVFrameSet.TopFrame.KAA0028.form.btnOk', visible: true, enabled: true, patterns: ['Invoke'], processId: 411 },
];
const portalNotice = [
  { role: 'Text', name: '세션이 만료되었습니다. 다시 접속해주십시오.', className: '', automationId: '', visible: true, enabled: true, patterns: [], processId: 411 },
  { role: 'Button', name: 'OK', className: 'swal2-confirm swal2-styled', automationId: '', visible: true, enabled: true, patterns: ['Invoke'], processId: 411 },
];

test('the two session notices seen live are reported by kind, and nothing else is', () => {
  // K-에듀파인 '사용시간이 종료되었습니다' (Nexacro KAA0028 / btnOk) and the portal's SweetAlert2
  // '세션이 만료되었습니다' (swal2-confirm) each need their own sentence and their own button.
  const edufine = runBridge(JSON.stringify({ command: 'inspect' }), { windows: [windowFixture({ addressControls: edufineAddress, noticeControls: usetimeNotice })] }).output;
  assert.equal(edufine.windows[0].sessionNotice, 'edufine-usetime');
  const portal = runBridge(JSON.stringify({ command: 'inspect' }), { windows: [windowFixture({ noticeControls: portalNotice })] }).output;
  assert.equal(portal.windows[0].sessionNotice, 'portal-session');
  for (const controls of [
    [],
    [usetimeNotice[0]],
    [usetimeNotice[1]],
    [usetimeNotice[0], { ...usetimeNotice[1], processId: 9 }],
    [usetimeNotice[0], { ...usetimeNotice[1], patterns: [] }],
    [portalNotice[0], { ...portalNotice[1], className: 'swal2-cancel swal2-styled' }],
    [{ ...usetimeNotice[0], name: '안내 문구' }, usetimeNotice[1]],
  ]) {
    const none = runBridge(JSON.stringify({ command: 'inspect' }), { windows: [windowFixture({ addressControls: edufineAddress, noticeControls: controls })] }).output;
    assert.equal(none.windows[0].sessionNotice, null, JSON.stringify(controls));
  }
});

test('dismiss-session-notice presses only a recognised notice and reports which one', () => {
  const present = runBridge(JSON.stringify({ command: 'invoke', target: target(), action: 'dismiss-session-notice' }), { windows: [windowFixture({ addressControls: edufineAddress, noticeControls: usetimeNotice })] }).output;
  assert.equal(present.status, 'ok');
  assert.equal(present.invoked, true);
  assert.equal(present.notice, 'edufine-usetime');
  const absent = runBridge(JSON.stringify({ command: 'invoke', target: target(), action: 'dismiss-session-notice' }), { windows: [windowFixture({ addressControls: edufineAddress })] }).output;
  assert.equal(absent.status, 'unavailable');
  assert.equal(absent.invoked, false);
});

test('several tabs of the same system are not ambiguous: the showing one wins, else the leftmost', () => {
  // Each launch used to add another 업무포털 tab, and three of them then made every
  // activation 'ambiguous' — right after a successful login.
  const tab = index => ({ system: 'portal', publicName: `업무포털 메인 ${index}`, role: 'TabItem', className: 'EdgeTab', automationId: 'view_24', visible: true, enabled: true, selectionAvailable: true, selected: false, processId: 411 });
  const portalMain = windowFixture({
    controls: [{ name: 'Logout', automationId: 'btn-logout', role: 'Hyperlink', visible: true, enabled: true, patterns: ['Invoke'], processId: 411, parentRole: 'Document', parentAutomationId: 'RootWebArea' }],
  });
  const source = windowFixture({ systemTabs: [tab(1), tab(2), { ...tab(3), selected: true }], activationResults: { portal: portalMain }, ...portalMain, systemTabs: [tab(1), tab(2), { ...tab(3), selected: true }] });
  const output = runBridge(JSON.stringify({ command: 'invoke', target: target(), action: 'activate-system-tab', system: 'portal' }), { windows: [source] }).output;
  assert.equal(output.status, 'ok', JSON.stringify(output));
  assert.equal(output.invoked, true);
});

test('activate-system-tab with requireLanding=false only switches the tab', () => {
  // Getting back to a portal tab that is logged out or behind a session notice: landing
  // cannot be verified there yet, and that must not be a failure.
  const tab = { system: 'portal', publicName: '업무포털 메인', role: 'TabItem', className: 'EdgeTab', automationId: 'view_24', visible: true, enabled: true, selectionAvailable: true, selected: false, processId: 411 };
  const loggedOut = windowFixture({ controls: [{ name: '인증서 로그인', automationId: 'btnLgn', role: 'Button', visible: true, enabled: true, patterns: ['Invoke'], processId: 411 }] });
  const source = windowFixture({ systemTabs: [tab], activationResults: { portal: loggedOut } });
  const strict = runBridge(JSON.stringify({ command: 'invoke', target: target(), action: 'activate-system-tab', system: 'portal' }), { windows: [source] }).output;
  assert.equal(strict.status, 'unavailable');
  const loose = runBridge(JSON.stringify({ command: 'invoke', target: target(), action: 'activate-system-tab', system: 'portal', requireLanding: false }), { windows: [source] }).output;
  assert.equal(loose.status, 'ok', JSON.stringify(loose));
  assert.equal(loose.invoked, true);
  assert.equal(loose.windows[0].loginAvailable, true);
  const malformed = runBridge(JSON.stringify({ command: 'invoke', target: target(), action: 'activate-system-tab', system: 'portal', requireLanding: 'no' }), { windows: [source] }).output;
  assert.equal(malformed.status, 'error');
});

test('selectedSystem names the system whose tab is on screen, and nothing else', () => {
  const tab = (system, name, selected) => ({ system, publicName: name, role: 'TabItem', className: 'EdgeTab', automationId: 'view_24', visible: true, enabled: true, selectionAvailable: true, selected, processId: 411 });
  const showing = runBridge(JSON.stringify({ command: 'inspect' }), {
    windows: [windowFixture({ addressControls: edufineAddress, systemTabs: [tab('portal', '업무포털 메인', false), tab('edufine', 'K-에듀파인 공용서식', true)] })],
  }).output;
  assert.equal(showing.windows[0].selectedSystem, 'edufine');
  // A browser error page keeps the host but its tab no longer carries the system's name.
  const broken = runBridge(JSON.stringify({ command: 'inspect' }), {
    windows: [windowFixture({ addressControls: edufineAddress, systemTabs: [tab('portal', '업무포털 메인', false)] })],
  }).output;
  assert.equal(broken.windows[0].selectedSystem, null);
  const none = runBridge(JSON.stringify({ command: 'inspect' }), { windows: [windowFixture({ addressControls: edufineAddress })] }).output;
  assert.equal(none.windows[0].selectedSystem, null);
});

test('an activation whose landing is not visible yet is given a moment before failing', () => {
  // Edge switches tabs asynchronously. Reading the address bar once, 150ms after the click,
  // reported the previous tab's page and a good switch came back 'unavailable'.
  const tab = { system: 'neis', publicName: '나이스', role: 'TabItem', className: 'EdgeTab', automationId: 'view_24', visible: true, enabled: true, selectionAvailable: true, selected: false, processId: 411 };
  const arrived = windowFixture({
    addressControls: [{ automationId: 'view_1021', controlType: 'Edit', isPassword: false, isOffscreen: false, value: 'https://sen.neis.go.kr/jsp/main.jsp' }],
    controls: [{ name: '로그아웃', role: 'Button', visible: true, enabled: true, patterns: ['Invoke'], processId: 411 }],
  });
  const source = windowFixture({ systemTabs: [tab], activationResults: { neis: arrived } });
  const output = runBridge(JSON.stringify({ command: 'invoke', target: target(), action: 'activate-system-tab', system: 'neis' }), { windows: [source] }).output;
  assert.equal(output.status, 'ok', JSON.stringify(output));
  assert.equal(output.windows[0].landing, 'neis');

  // A tab that never shows the system still fails, and the wait stays bounded.
  const never = windowFixture({ systemTabs: [tab], activationResults: { neis: windowFixture() } });
  const start = Date.now();
  const stuck = runBridge(JSON.stringify({ command: 'invoke', target: target(), action: 'activate-system-tab', system: 'neis' }), { windows: [never] }).output;
  assert.equal(stuck.status, 'unavailable');
  assert.ok(Date.now() - start < 30000, 'the presence wait must stay bounded');
});

test('a logout link scrolled out of view still proves the portal session', () => {
  // Chromium marks a control offscreen when it is merely clipped or scrolled out. Dropping it
  // made a logged-in 업무포털 메인 report 'not authenticated', and the widget then sat at
  // '인증서 창에서 암호를 입력해 주세요' for three minutes while the teacher was already in.
  const logout = visible => ({ name: 'Logout', automationId: 'btn-logout', role: 'Hyperlink', visible, enabled: true, patterns: ['Invoke'], processId: 411, parentRole: 'Document', parentAutomationId: 'RootWebArea' });
  const loginButton = { automationId: 'btnLgn', name: '인증서 로그인', role: 'Button', visible: true, enabled: true, patterns: ['Invoke'], processId: 411 };

  const onScreen = runBridge(JSON.stringify({ command: 'inspect' }), { windows: [windowFixture({ controls: [logout(true)] })] }).output;
  assert.equal(onScreen.windows[0].authenticated, true);

  const scrolledOut = runBridge(JSON.stringify({ command: 'inspect' }), { windows: [windowFixture({ controls: [logout(false)] })] }).output;
  assert.equal(scrolledOut.windows[0].authenticated, true, 'a clipped logout link is still a session');
  assert.equal(scrolledOut.windows[0].landing, 'portal');

  // A logged-out portal offers the certificate login button, and that outranks a hidden or
  // stale logout element, so the relaxation cannot invent a session.
  const loggedOut = runBridge(JSON.stringify({ command: 'inspect' }), { windows: [windowFixture({ controls: [logout(false), loginButton] })] }).output;
  assert.equal(loggedOut.windows[0].authenticated, false);
  assert.equal(loggedOut.windows[0].loginAvailable, true);
});

test('an offscreen control is never something the product acts on', () => {
  // Authentication may read a clipped element; clicking one must still be refused.
  const hiddenNeis = { name: '', automationId: 'https://sen.neis.go.kr/cmc_fcm_lg01_000.do?x=1', className: 'menuBtn', role: 'Hyperlink', visible: false, enabled: true, patterns: ['Invoke'], processId: 411 };
  const authenticated = { name: 'Logout', automationId: 'btn-logout', role: 'Hyperlink', visible: true, enabled: true, patterns: ['Invoke'], processId: 411, parentRole: 'Document', parentAutomationId: 'RootWebArea' };
  const fixture = { windows: [windowFixture({ controls: [authenticated, hiddenNeis] })] };
  const inspected = runBridge(JSON.stringify({ command: 'inspect' }), fixture).output;
  assert.equal(inspected.windows[0].actions.includes('neis'), false, 'a clipped launch link is not offered');
  const invoked = runBridge(JSON.stringify({ command: 'invoke', target: target(), action: 'neis' }), fixture).output;
  assert.equal(invoked.status, 'unavailable');
  assert.equal(invoked.invoked, false);
});

test('the helper restores a minimised target without taking the foreground', () => {
  // A minimised window renders nothing and Chromium exposes no page for it, so the NEIS walk
  // stalled whenever the teacher had put Edge away. The fix must not steal focus while doing it.
  const { readFileSync } = require('node:fs');
  const source = readFileSync(bridge, 'utf8');
  assert.match(source, /function Restore-TargetWindow/);
  // SW_SHOWNOACTIVATE (4), never SW_RESTORE (9), which activates.
  assert.match(source, /ShowWindowAsync\(\$Handle, 4\)/);
  assert.match(source, /IsIconic\(\$Handle\)/);
  // Only for a window an operation already targets; plain discovery must stay passive.
  assert.match(source, /if \(\$null -ne \$request\.target\) \{ \$null = Restore-TargetWindow/);
});

test('restoreMinimised is a boolean the helper accepts and nothing else', () => {
  const fixture = { windows: [windowFixture()] };
  assert.equal(runBridge(JSON.stringify({ command: 'inspect', restoreMinimised: true }), fixture).output.status, 'ok');
  assert.equal(runBridge(JSON.stringify({ command: 'inspect', restoreMinimised: false }), fixture).output.status, 'ok');
  assert.equal(runBridge(JSON.stringify({ command: 'inspect', restoreMinimised: 'yes' }), fixture).output.status, 'error');
  const { readFileSync } = require('node:fs');
  const source = readFileSync(bridge, 'utf8');
  // Restoring must never activate: SW_SHOWNOACTIVATE (4), not SW_RESTORE (9).
  assert.match(source, /function Restore-MinimisedEdgeWindows/);
  assert.match(source, /ShowWindowAsync\(\$Handle, 4\)/);
});
