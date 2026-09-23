const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const path = require('node:path');
const test = require('node:test');

const repo = path.resolve(__dirname, '..');
const modulePath = path.join(repo, 'src', 'native', 'neis-tasks.ps1');
const startedAt = '2026-09-20T06:44:33.4035062Z';

function control(name, role, className, overrides = {}) {
  return {
    name, role, className, processId: 20996, visible: true, enabled: true,
    patterns: [], selected: false, expanded: false,
    bounds: { left: 100, top: 100, width: 120, height: 30 },
    pointOwnerHwnd: '98112254', ...overrides,
  };
}

function fixture(overrides = {}) {
  return {
    processId: 20996,
    hwnd: '98112254',
    processStartedAt: startedAt,
    origin: 'https://sen.neis.go.kr',
    locked: false,
    cancelled: false,
    controls: [
      control('나의 메뉴', 'Button', 'btn-asd mymenu', { patterns: ['SelectionItem'], selected: true }),
      control('복무 0단계 메뉴항목', 'MenuItem', 'cl-folder cl-level-1 cl-sidenavigation-item', { patterns: ['ExpandCollapse'], expanded: true }),
      control('개인근무상황관리', 'Group', 'cl-leaf cl-level-2 cl-sidenavigation-item', { patterns: ['ScrollItem'] }),
      control('개인출장관리', 'Group', 'cl-leaf cl-level-2 cl-sidenavigation-item', { patterns: ['ScrollItem'], bounds: { left: 100, top: 140, width: 120, height: 30 } }),
    ],
    ...overrides,
  };
}

function target(overrides = {}) {
  return { pid: 20996, hwnd: '98112254', processStartedAt: startedAt, origin: 'https://sen.neis.go.kr', ...overrides };
}

function run(operation, root = fixture(), selectedTarget = target()) {
  const payload = Buffer.from(JSON.stringify({ operation, root, target: selectedTarget }), 'utf8').toString('base64');
  const escapedPath = modulePath.replaceAll("'", "''");
  const script = [
    '[Console]::InputEncoding=[Text.UTF8Encoding]::new($false)',
    '[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false)',
    `. '${escapedPath}'`,
    `$request=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${payload}')) | ConvertFrom-NeisTaskFixtureJson`,
    "if($request.operation -eq 'state'){$result=Get-NeisTaskState -Root $request.root -Target $request.target}else{$result=Invoke-NeisTaskAction -Root $request.root -Target $request.target -Action $request.operation}",
    '$result | ConvertTo-Json -Depth 8 -Compress',
  ].join(';');
  const encoded = Buffer.from(script, 'utf16le').toString('base64');
  const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded], { cwd: repo, encoding: 'utf8' });
  assert.equal(result.status, 0, `exit=${result.status}\nstdout=${result.stdout}\nstderr=${result.stderr}`);
  return JSON.parse(result.stdout.trim());
}

test('state exposes the deterministic personal task path and only one-step safe actions', () => {
  const state = run('state');
  assert.deepEqual(state, {
    myMenuSelected: true,
    dutyExpanded: true,
    visibleTasks: ['attendance', 'trip'],
    existingTaskTabs: [],
    activeTask: null,
    actions: ['open-attendance', 'open-trip'],
  });
});

test('arrival requires both a selected exact task tab and one exact app title heading', () => {
  const controls = fixture().controls.concat([
    control('개인근무상황관리 - 열림', 'TabItem', 'task-tab', { patterns: ['SelectionItem'], selected: true }),
    control('개인근무상황관리', 'Group', 'app-tit'),
  ]);
  assert.equal(run('state', fixture({ controls })).activeTask, 'attendance');

  const falseTab = controls.map(item => item.role === 'Group' && item.className === 'app-tit' ? { ...item, visible: false } : item);
  assert.equal(run('state', fixture({ controls: falseTab })).activeTask, null);

  const duplicateHeading = controls.concat(control('개인근무상황관리', 'Group', 'app-tit'));
  assert.equal(run('state', fixture({ controls: duplicateHeading })).activeTask, null);
});

test('returning to an open task tab counts as arrival on its 선택됨 marker alone', () => {
  // The live page drops the name from its app-tit element once the tab already exists, so a
  // task switched back to reported no arrival at all and the walk failed on a correct screen.
  const withoutHeading = fixture().controls.concat([
    control('선택됨, 개인근무상황관리', 'TabItem', 'task-tab', { patterns: ['SelectionItem'], selected: true }),
  ]);
  assert.equal(run('state', fixture({ controls: withoutHeading })).activeTask, 'attendance');

  // An unselected tab is still no arrival, marker or not.
  const unselected = withoutHeading.map(item => item.role === 'TabItem' ? { ...item, selected: false } : item);
  assert.equal(run('state', fixture({ controls: unselected })).activeTask, null);

  // Without the marker and without a heading there is no second witness, so nothing is claimed.
  const unmarked = fixture().controls.concat([
    control('개인근무상황관리 - 열림', 'TabItem', 'task-tab', { patterns: ['SelectionItem'], selected: true }),
  ]);
  assert.equal(run('state', fixture({ controls: unmarked })).activeTask, null);
});

test('existing inactive task tab is preferred over sidebar navigation', () => {
  const controls = fixture().controls.concat(control('개인출장관리', 'TabItem', 'task-tab', { patterns: ['SelectionItem'] }));
  const state = run('state', fixture({ controls }));
  assert.deepEqual(state.existingTaskTabs, ['trip']);
  assert.deepEqual(state.actions, ['select-trip-tab']);
  assert.deepEqual(run('select-trip-tab', fixture({ controls })), { status: 'invoked', action: 'select-trip-tab', method: 'SelectionItem' });
});

test('each navigation action performs one fixture step only', () => {
  const selected = fixture();
  assert.deepEqual(run('open-attendance', selected), { status: 'invoked', action: 'open-attendance', method: 'default-action' });
  const unselected = fixture({ controls: fixture().controls.map((item, index) => index === 0 ? { ...item, selected: false } : item) });
  assert.deepEqual(run('select-my-menu', unselected), { status: 'invoked', action: 'select-my-menu', method: 'SelectionItem' });
  const collapsed = fixture({ controls: fixture().controls.map(item => item.role === 'MenuItem' ? { ...item, expanded: false } : item.role === 'Group' ? { ...item, visible: false } : item) });
  assert.deepEqual(run('state', collapsed).actions, ['expand-duty']);
  assert.deepEqual(run('expand-duty', collapsed), { status: 'invoked', action: 'expand-duty', method: 'ExpandCollapse' });
});

test('stale identity, wrong origin, occlusion, and locked session fail honestly', () => {
  assert.equal(run('open-attendance', fixture(), target({ processStartedAt: '2026-09-20T00:00:00Z' })).status, 'unavailable');
  assert.equal(run('open-attendance', fixture(), target({ origin: 'http://sen.neis.go.kr' })).status, 'unavailable');
  const occluded = fixture({ controls: fixture().controls.map(item => item.name === '개인근무상황관리' ? { ...item, pointOwnerHwnd: '7' } : item) });
  assert.equal(run('open-attendance', occluded).status, 'unavailable');
  assert.equal(run('open-attendance', fixture({ locked: true })).status, 'unavailable');
});

test('disabled and ambiguous semantic targets are never actionable', () => {
  const disabled = fixture({ controls: fixture().controls.map(item => item.name === '개인출장관리' ? { ...item, enabled: false } : item) });
  assert.equal(run('state', disabled).actions.includes('open-trip'), false);
  const duplicate = fixture({ controls: fixture().controls.concat(control('개인근무상황관리', 'Group', 'cl-leaf cl-level-2 cl-sidenavigation-item', { patterns: ['ScrollItem'] })) });
  assert.equal(run('state', duplicate).actions.includes('open-attendance'), false);
  assert.equal(run('open-attendance', duplicate).status, 'unavailable');
});

test('cancellation and unsafe action names cause no input', () => {
  assert.equal(run('open-trip', fixture({ cancelled: true })).status, 'cancelled');
  assert.equal(run('submit-attendance').status, 'unsafe-action');
});

test('fixture parser rejects malformed or extra sensitive-shaped input', () => {
  assert.throws(() => run('state', fixture({ controls: 'not-an-array' })), /exit=/);
  assert.throws(() => run('state', fixture({ password: 'must-not-be-accepted' })), /exit=/);
});

test('the live side menu marks selection with a class token, not a pattern', () => {
  // 나의 메뉴 exposes neither SelectionItem nor Toggle; only the class carries 'selected'.
  // Without this the walk offered select-my-menu forever and never reached 복무.
  const byClass = fixture({ controls: [
    control('', 'Button', 'btn-asd cl-button mymenu selected', { patterns: ['Invoke'] }),
    control('복무 0단계 메뉴항목', 'MenuItem', 'cl-folder cl-level-1 cl-sidenavigation-item', { patterns: ['ExpandCollapse'], expanded: true }),
    control('개인근무상황관리', 'Group', 'cl-leaf cl-level-2 cl-sidenavigation-item', { patterns: ['ScrollItem'] }),
  ] });
  assert.equal(run('state', byClass).myMenuSelected, true);

  const withoutToken = fixture({ controls: [
    control('', 'Button', 'btn-asd cl-button mymenu', { patterns: ['Invoke'] }),
  ] });
  const plain = run('state', withoutToken);
  assert.equal(plain.myMenuSelected, false);
  assert.deepEqual(plain.actions, ['select-my-menu']);
});

test('a work tab titled 선택됨, <메뉴> counts as that task, but a browser tab never does', () => {
  const base = [
    control('', 'Button', 'btn-asd cl-button mymenu selected', { patterns: ['Invoke'] }),
    control('복무 0단계 메뉴항목', 'MenuItem', 'cl-folder cl-level-1 cl-sidenavigation-item', { patterns: ['ExpandCollapse'], expanded: true }),
    control('개인근무상황관리', 'Group', 'cl-leaf cl-level-2 cl-sidenavigation-item', { patterns: ['ScrollItem'] }),
    control('개인근무상황관리', 'Group', 'app-tit cl-control cl-output', { patterns: ['ScrollItem'] }),
  ];
  const workTab = control('선택됨, 개인근무상황관리', 'TabItem', 'cl-text', { patterns: ['SelectionItem', 'ScrollItem'], selected: true });
  const active = run('state', fixture({ controls: [...base, workTab] }));
  assert.equal(active.activeTask, 'attendance');
  assert.deepEqual(active.existingTaskTabs, ['attendance']);

  const browserTab = control('선택됨, 개인근무상황관리', 'TabItem', 'EdgeTab', { patterns: ['SelectionItem', 'ScrollItem'], selected: true });
  const spoofed = run('state', fixture({ controls: [...base, browserTab] }));
  assert.equal(spoofed.activeTask, null);
  assert.deepEqual(spoofed.existingTaskTabs, []);
});

test('with one task already open the other is still reachable', () => {
  // Suppressing every action whenever something was active made 개인근무상황 -> 출장 impossible.
  const base = [
    control('', 'Button', 'btn-asd cl-button mymenu selected', { patterns: ['Invoke'] }),
    control('복무 0단계 메뉴항목', 'MenuItem', 'cl-folder cl-level-1 cl-sidenavigation-item', { patterns: ['ExpandCollapse'], expanded: true }),
    control('개인근무상황관리', 'Group', 'cl-leaf cl-level-2 cl-sidenavigation-item', { patterns: ['ScrollItem'] }),
    control('개인출장관리', 'Group', 'cl-leaf cl-level-2 cl-sidenavigation-item', { patterns: ['ScrollItem'] }),
    control('개인근무상황관리', 'Group', 'app-tit cl-control cl-output', { patterns: ['ScrollItem'] }),
    control('선택됨, 개인근무상황관리', 'TabItem', 'cl-text', { patterns: ['SelectionItem', 'ScrollItem'], selected: true }),
  ];
  const state = run('state', fixture({ controls: base }));
  assert.equal(state.activeTask, 'attendance');
  assert.deepEqual(state.actions, ['open-trip'], 'the other task must stay reachable');
  assert.equal(state.actions.includes('open-attendance'), false, 'never re-open the task already shown');

  // Once its tab exists but is not selected, selecting it wins over opening it again.
  const withTripTab = [...base, control('개인출장관리', 'TabItem', 'cl-text', { patterns: ['SelectionItem', 'ScrollItem'], selected: false })];
  const switching = run('state', fixture({ controls: withTripTab }));
  assert.deepEqual(switching.actions, ['select-trip-tab']);
});
