'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { mkdtempSync, writeFileSync, rmSync } = require('node:fs');
const { tmpdir } = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const helper = path.join(__dirname, '../src/native/ordinary-edge.ps1');
// Observed 2026-10-27 on Aside HTTPS/HTTP and Chrome HTTPS. The first parent
// is a native HWND; iframe/SidePanel documents have different direct ancestry.
function document(url, parentClasses = ['Chrome_RenderWidgetHostHWND', 'Chrome_WidgetWin_1', 'MultiContentsView', 'BrowserView']) {
  return {
    controlType: 'Document', className: '', automationId: 'RootWebArea',
    processId: 411, isOffscreen: false, isPassword: false, value: url,
    parents: parentClasses.map((className, index) => ({ className, controlType: 'Pane', processId: 411, nativeWindowHandle: index === 0 ? 9010 : 0 })),
  };
}
function address(value) {
  return { controlType: 'Edit', className: 'OmniboxViewViews', automationId: 'view_1012', name: '주소창 및 검색창',
    processId: 411, parentClassName: 'LocationBarView', parentControlType: 'Group', parentProcessId: 411,
    isOffscreen: false, isPassword: false, value };
}
function window(browser, patch = {}) {
  return {
    pid: 411, hwnd: '9001', processName: browser === 'aside' ? 'Aside' : browser === 'edge' ? 'msedge' : 'chrome',
    processStartedAt: '2026-09-20T10:00:00.0000000Z', visible: true, rootAvailable: true, rootProcessId: 411,
    addressControls: [address('sen.eduptl.kr/bpm_lgn_lg00_001.do?noEpSession')],
    documents: [document('https://sen.eduptl.kr/bpm_lgn_lg00_001.do?noEpSession')],
    controls: [], landingMarkers: [], systemTabs: [], certificateRegion: null, ...patch,
  };
}
function inspect(browser, windows) {
  const temp = mkdtempSync(path.join(tmpdir(), 'edudock-document-origin-'));
  try {
    const fixture = path.join(temp, 'fixture.json');
    writeFileSync(fixture, JSON.stringify({ windows }));
    const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
      '-File', helper, '-FixturePath', fixture, '-TimeoutMs', '10000'],
    { input: JSON.stringify({ command: 'inspect', browser }), encoding: 'utf8', timeout: 20000 });
    assert.equal(result.error, undefined, result.error?.message);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stderr, '');
    assert.equal(result.stdout.includes('private-token'), false);
    return JSON.parse(result.stdout);
  } finally { rmSync(temp, { recursive: true, force: true }); }
}

for (const browser of ['aside', 'chrome']) {
  test(`${browser}: top-level HTTPS URL supplies origin and landing, excluding iframe and SidePanel`, () => {
    const portal = window(browser);
    portal.documents.push(document('https://klef.sen.go.kr/iframe?private-token', ['', 'active', 'nt-in-bd', 'active']),
      document('chrome-extension://example/sidepanel.html', ['Chrome_RenderWidgetHostHWND', 'ContentParentView', 'SidePanel', 'BrowserView']));
    // An iframe may itself be a RootWebArea, but its parent is still a Document.
    portal.documents[1].parents[0].controlType = 'Document';
    portal.controls = [{ name: 'Logout', automationId: 'btn-logout', role: 'Hyperlink', visible: true, enabled: true,
      patterns: ['Invoke'], processId: 411, parentRole: 'Document', parentAutomationId: 'RootWebArea' }];
    const neis = window(browser, {
      addressControls: [address('sen.neis.go.kr/jsp/main.jsp?private-token')],
      documents: [document('https://sen.neis.go.kr/jsp/main.jsp?private-token')],
      controls: [{ name: '로그아웃', role: 'Button', visible: true, enabled: true, patterns: ['Invoke'], processId: 411 }],
    });
    const edufine = window(browser, {
      addressControls: [address('klef.sen.go.kr/keris_ui/main.do')], documents: [document('https://klef.sen.go.kr/keris_ui/main.do')],
      landingMarkers: [
        { kind: 'document', name: 'K-에듀파인', automationId: 'RootWebArea', role: 'Document', visible: true, processId: 411 },
        { kind: 'text', name: '문서관리', role: 'Text', visible: true, processId: 411 },
      ],
    });
    const explicit = window(browser, { addressControls: [address('https://sen.eduptl.kr/')] });
    const result = inspect(browser, [portal, neis, edufine, explicit]);
    assert.equal(result.status, 'ok');
    assert.deepEqual(result.windows.map(w => w.origin), ['https://sen.eduptl.kr', 'https://sen.neis.go.kr', 'https://klef.sen.go.kr', 'https://sen.eduptl.kr']);
    assert.deepEqual(result.windows.map(w => w.landing), ['portal', 'neis', 'edufine', null]);
  });

  test(`${browser}: HTTP, mismatched host, missing/duplicate body and unverified structure fail closed`, () => {
    const cases = [
      ['HTTP body', w => { w.documents[0].value = 'http://sen.eduptl.kr/'; }],
      ['foreign host', w => { w.documents[0].value = 'https://other.example/'; w.addressControls[0].value = 'other.example'; }],
      ['host mismatch', w => { w.addressControls[0].value = 'other.example/'; }],
      ['explicit HTTP address', w => { w.addressControls[0].value = 'http://sen.eduptl.kr/'; }],
      ['missing body', w => { w.documents = []; }],
      ['duplicate body, same origin', w => { w.documents.push(document('https://sen.eduptl.kr/')); }],
      ['duplicate body, different origin', w => { w.documents.push(document('https://other.example/')); }],
      ['ValuePattern unavailable', w => { w.documents[0].value = null; w.documents[0].legacyValue = 'https://sen.eduptl.kr/'; }],
      ['relative document URL', w => { w.documents[0].value = 'sen.eduptl.kr/'; }],
      ['wrong root identity', w => { w.documents[0].automationId = 'another-root'; }],
      ['unknown hierarchy', w => { w.documents[0].parents[2].className = 'UnknownContentsView'; }],
      ['HTML class spoof', w => { w.documents[0].parents[0].nativeWindowHandle = 0; }],
      ['document ancestor spoof', w => { w.documents[0].parents[0].controlType = 'Document'; }],
      ['stale document owner', w => { w.documents[0].processId = 999; }],
      ['stale parent owner', w => { w.documents[0].parents[0].processId = 999; }],
      ['hidden body', w => { w.documents[0].isOffscreen = true; }],
      ['missing address', w => { w.addressControls = []; }],
      ['duplicate address', w => { w.addressControls.push(address('sen.eduptl.kr')); }],
      ['page edit spoof', w => { w.addressControls[0].parentClassName = 'RootWebArea'; }],
      ['stale address owner', w => { w.addressControls[0].processId = 999; }],
      ['hidden address', w => { w.addressControls[0].isOffscreen = true; }],
      ['password address', w => { w.addressControls[0].isPassword = true; }],
      ['address userinfo', w => { w.addressControls[0].value = 'https://other.example@sen.eduptl.kr/'; }],
      ['document userinfo', w => { w.documents[0].value = 'https://other.example@sen.eduptl.kr/'; }],
      ['port mismatch', w => { w.addressControls[0].value = 'sen.eduptl.kr:444/'; }],
      ['nondefault port', w => { w.addressControls[0].value = 'sen.eduptl.kr:444/'; w.documents[0].value = 'https://sen.eduptl.kr:444/'; }],
      ['side panel only', w => { w.documents[0].parents[1].className = 'ContentParentView'; w.documents[0].parents[2].className = 'SidePanel'; }],
    ];
    const windows = cases.map(([, change]) => { const w = window(browser); change(w); return w; });
    const result = inspect(browser, windows);
    assert.equal(result.status, 'unavailable');
    assert.equal(result.windows.length, cases.length);
    result.windows.forEach((w, index) => {
      assert.equal(w.origin, null, cases[index][0]);
      assert.equal(w.landing, null, cases[index][0]);
      assert.deepEqual(w.actions, [], cases[index][0]);
    });
  });
}

test('Edge keeps its explicit-address and legacy-evidence behavior regardless of document ValuePattern', () => {
  const explicit = window('edge', { addressControls: [{ controlType: 'Edit', automationId: 'view_1017', value: 'https://sen.eduptl.kr/' }], documents: [document('http://other.example/')] });
  assert.equal(inspect('edge', [explicit]).windows[0].origin, 'https://sen.eduptl.kr');
  const schemeless = window('edge', { addressControls: [{ controlType: 'Edit', automationId: 'view_1017', value: 'sen.eduptl.kr/' }] });
  assert.equal(inspect('edge', [schemeless]).status, 'unavailable');
  const legacy = window('edge', { addressControls: [], documents: [{ controlType: 'Document', legacyValue: 'https://sen.eduptl.kr/' }] });
  assert.equal(inspect('edge', [legacy]).windows[0].origin, 'https://sen.eduptl.kr');
  explicit.documents = [{ controlType: 'Document', legacyValue: 'https://other.example/' }];
  assert.equal(inspect('edge', [explicit]).status, 'ambiguous');
});
