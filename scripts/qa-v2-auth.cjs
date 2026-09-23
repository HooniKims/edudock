'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { PortalAutomation } = require('../src/portal.cjs');

function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

async function run() {
  const events = [];
  const opened = [];
  const handoff = deferred();
  const automation = new PortalAutomation({
    status: event => events.push(event),
    openPortal: async url => { opened.push(url); await handoff.promise; },
    connectionTimeoutMs: 1000,
  });

  const pending = automation.openMenu('attendance');
  await new Promise(resolve => setImmediate(resolve));
  const cancelResult = automation.cancel();
  const cancelled = await pending;
  assert.equal(cancelResult.ok, true);
  assert.equal(cancelled.phase, 'cancelled');
  assert.equal(automation.busy, false);
  assert.equal(automation.operation, null);
  handoff.resolve();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(events.at(-1).phase, 'cancelled');

  const manualEvents = [];
  const manual = new PortalAutomation({
    status: event => manualEvents.push(event),
    openPortal: async url => { opened.push(url); },
  });
  const needsUser = await manual.openMenu('trip');
  assert.equal(needsUser.phase, 'needs-user');
  assert.equal(manual.retryAction, 'trip');
  const retry = await manual.retry();
  assert.equal(retry.phase, 'needs-user');
  assert.deepEqual(opened, [
    'microsoft-edge:https://sen.eduptl.kr',
    'microsoft-edge:https://sen.eduptl.kr',
    'microsoft-edge:https://sen.eduptl.kr',
  ]);
  assert.equal(manualEvents.filter(event => event.phase === 'opening').length, 2);

  const source = fs.readFileSync(path.join(__dirname, '../src/portal.cjs'), 'utf8');
  const main = fs.readFileSync(path.join(__dirname, '../src/main.cjs'), 'utf8');
  assert.doesNotMatch(source + main, /launchPersistentContext|EdgeProfile|--user-data-dir|--remote-debugging/);

  const report = {
    pass: true,
    surface: 'controlled ordinary-Edge handoff fixture; no browser or GUI launched',
    scenarios: {
      immediateCancel: { pass: true, busy: automation.busy, operation: automation.operation, terminalPhase: events.at(-1).phase },
      staleCompletion: { pass: events.at(-1).phase === 'cancelled' },
      retryOriginalAction: { pass: true, action: manual.retryAction, openingCount: 2 },
      verifiedOriginOnly: { pass: opened.every(url => url === 'microsoft-edge:https://sen.eduptl.kr') },
      ordinaryEdgeOnly: { pass: true, profileFlagsFound: false },
    },
    limitations: ['No GUI was launched in this worker lane.', 'Ordinary Edge authentication observation needs the separately investigated Windows UI Automation adapter.'],
  };
  const output = path.resolve(process.argv[2] || '.omo/evidence/v2-stage5-auth-engine/qa-v2-auth-report.json');
  fs.mkdirSync(path.dirname(output), { recursive: true });
  fs.writeFileSync(output, JSON.stringify(report, null, 2));
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
}

run().catch(error => {
  process.stderr.write(`${error.stack || error}\n`);
  process.exitCode = 1;
});
