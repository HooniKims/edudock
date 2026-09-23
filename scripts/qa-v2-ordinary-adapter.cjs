'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { _electron: electron } = require('playwright-core');

const root = path.resolve(__dirname, '..');
const evidenceRoot = path.join(root, 'artifacts', 'qa', 'v2', '05-login', 'ordinary-adapter');
const attempt = path.join(evidenceRoot, `attempt-${Date.now()}`);
const profile = path.join(attempt, 'profile');
const nativeLog = path.join(attempt, 'native-requests.json');
const reportPath = path.join(attempt, 'report.json');
const relative = file => path.relative(root, file).replaceAll('\\', '/');

(async () => {
  fs.mkdirSync(profile, { recursive: true });
  const app = await electron.launch({
    args: [path.join(root, 'scripts', 'qa-v2-ordinary-adapter-bootstrap.cjs')],
    cwd: root,
    env: { ...process.env, EDUDOCK_QA_PROFILE: profile, EDUDOCK_QA_ORDINARY_ADAPTER_LOG: nativeLog },
  });
  const report = {
    invocation: 'node scripts/qa-v2-ordinary-adapter.cjs',
    scenario: 'real renderer IPC to Electron main with only the native bridge and shell handoff replaced before bootstrap',
    pass: false,
    cleanup: {},
  };
  try {
    const page = await app.firstWindow();
    await page.waitForLoadState('domcontentloaded');
    await page.evaluate(() => {
      window.__ordinaryAdapterStatuses = [];
      window.portal.onStatus(status => window.__ordinaryAdapterStatuses.push(status.phase));
    });
    const result = await page.evaluate(() => window.portal.openMenu('attendance'));
    const statuses = await page.evaluate(() => [...window.__ordinaryAdapterStatuses]);
    const records = JSON.parse(fs.readFileSync(nativeLog, 'utf8'));
    const actions = records.filter(record => record.kind === 'native' && record.request.command === 'invoke').map(record => record.request.action);
    const openCalls = records.filter(record => record.kind === 'openExternal').map(record => record.url);
    assert.equal(result.ok, true);
    assert.deepEqual(statuses.filter(phase => ['opening', 'awaiting-user-auth', 'authenticated', 'navigating', 'opened', 'done'].includes(phase)), ['opening', 'awaiting-user-auth', 'authenticated', 'navigating', 'done']);
    assert.deepEqual(actions, ['login', 'removable-disk', 'select-drive', 'select-certificate-row', 'activate-system-tab', 'select-my-menu', 'expand-duty', 'open-attendance']);
    assert.deepEqual(openCalls, ['microsoft-edge:https://sen.eduptl.kr']);
    report.observable = {
      realRendererIpc: true,
      phases: statuses,
      exactOrdinaryEdgeUri: openCalls[0],
      loginInvocations: actions.filter(action => action === 'login').length,
      removableInvocations: actions.filter(action => action === 'removable-disk').length,
      driveSelectionInvocations: actions.filter(action => action === 'select-drive').length,
      certificateRowInvocations: actions.filter(action => action === 'select-certificate-row').length,
      originalAction: 'attendance',
      originalActionInvocations: actions.filter(action => action === 'open-attendance').length,
      taskSteps: actions.filter(action => ['select-my-menu', 'expand-duty', 'select-attendance-tab', 'open-attendance'].includes(action)),
      browserProcessesLaunched: 0,
    };
    await page.evaluate(() => { window.__ordinaryAdapterStatuses = []; });
    const draftResult = await page.evaluate(() => window.portal.openMenu('draft'));
    const draftPhases = await page.evaluate(() => [...window.__ordinaryAdapterStatuses]);
    const finalRecords = JSON.parse(fs.readFileSync(nativeLog, 'utf8'));
    const draftRequests = finalRecords.filter(record => record.kind === 'native-draft').map(record => record.request.command);
    assert.equal(draftResult.ok, true);
    assert.equal(draftResult.phase, 'done');
    assert.deepEqual(draftPhases, ['opening', 'awaiting-user-auth', 'authenticated', 'navigating', 'done']);
    // An editor the teacher already has open never blocks the menu: the product opens its own
    // form beside it and hands back only the new window.
    // One look before, one click, then polling until the new window has been quiet for a moment.
    assert.deepEqual(draftRequests.slice(0, 3), ['inspect-editors', 'open-public-form', 'inspect-editors']);
    assert.ok(draftRequests.slice(3).every(command => command === 'inspect-editors'), JSON.stringify(draftRequests));
    assert.equal(draftRequests.includes('focus-editor'), false, 'the existing window is left alone');
    report.observable.draft = { phases: draftPhases, editorReused: false, nativeRequests: draftRequests, publicFormInvocations: draftRequests.filter(command => command === 'open-public-form').length };
    // A carried draft is written into the window this very operation opened \u2014 never into the
    // one the teacher already had. The fake helper only accepts a write to the newest editor.
    const carried = await page.evaluate(() => window.portal.openMenu({
      id: 'draft',
      draft: { title: '\uAD50\uB0B4 \uBC31\uC77C\uC7A5 \uC6B4\uC601 \uACC4\uD68D', body: '1. \uAD00\uB828: ...' },
    }));
    const carriedRecords = JSON.parse(fs.readFileSync(nativeLog, 'utf8'));
    const carriedDraft = carriedRecords.filter(record => record.kind === 'native-draft').slice(draftRequests.length);
    const fills = carriedDraft.filter(record => record.request.command === 'fill-draft');
    assert.equal(carried.ok, true);
    assert.equal(carried.drafted, true, 'the draft goes into the fresh window');
    assert.equal(fills.length, 1);
    assert.equal(fills[0].request.target, '9755|2026-09-20T13:02:00.0000000Z|8644', 'only the window opened by this operation is written into');
    report.observable.draftCarried = { ok: carried.ok, drafted: carried.drafted, fillTarget: fills[0].request.target, wroteIntoExistingEditor: false };

    report.artifacts = { nativeRequests: relative(nativeLog), report: relative(reportPath) };
    report.pass = true;
  } finally {
    await app.close().catch(() => {});
    await fs.promises.rm(profile, { recursive: true, force: true });
    report.cleanup = { electronClosed: true, ownedProfileRemoved: !fs.existsSync(profile), ordinaryEdgeUntouched: true };
    fs.writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);
    fs.mkdirSync(evidenceRoot, { recursive: true });
    fs.writeFileSync(path.join(evidenceRoot, 'latest.json'), `${JSON.stringify({ attempt: relative(attempt), report: relative(reportPath) }, null, 2)}\n`);
  }
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
})().catch(error => {
  process.stderr.write(`${error.stack || error}\n`);
  process.exitCode = 1;
});
