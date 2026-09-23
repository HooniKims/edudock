'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { PortalAutomation, trusted } = require('../src/portal.cjs');

const root = path.resolve(__dirname, '..');
const evidenceDir = path.join(root, 'artifacts', 'qa', 'v2', '05-login', 'live');
const statePath = path.join(evidenceDir, 'state.json');
const reportPath = path.join(evidenceDir, 'report.json');
const profile = path.join(process.env.APPDATA, 'edudock', 'EdgeProfile');
const startedAt = new Date().toISOString();
const events = [];
let automation;
let readyPrinted = false;
let state = {
  phase: 'starting',
  busy: true,
  portalOrigin: null,
  authWindowReady: false,
  authenticated: false,
  logoutVisible: false,
  passwordValueRead: false,
  profilePreserved: true,
  startedAt,
};

fs.mkdirSync(evidenceDir, { recursive: true });

function persistState(patch = {}) {
  state = { ...state, ...patch, updatedAt: new Date().toISOString() };
  fs.writeFileSync(statePath, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
}

function status(event) {
  const safeEvent = {
    at: new Date().toISOString(),
    phase: event.phase,
    busy: Boolean(event.busy),
  };
  events.push(safeEvent);
  persistState({ phase: safeEvent.phase, busy: safeEvent.busy });
  process.stdout.write(`PHASE ${safeEvent.phase} busy=${safeEvent.busy}\n`);
  if (safeEvent.phase === 'awaiting-user-auth' && !readyPrinted) {
    readyPrinted = true;
    persistState({ authWindowReady: true });
    process.stdout.write('AUTH WINDOW READY\n');
  }
}

async function visibleLogout(context) {
  for (const page of context.pages()) {
    for (const frame of page.frames()) {
      if (!trusted(frame.url())) continue;
      const controls = frame.getByText('\uB85C\uADF8\uC544\uC6C3', { exact: true });
      for (let index = 0; index < await controls.count(); index += 1) {
        if (await controls.nth(index).isVisible()) return true;
      }
    }
  }
  return false;
}

async function portalOrigin(context) {
  const page = context.pages().find((candidate) => {
    try {
      return new URL(candidate.url()).origin === 'https://sen.eduptl.kr';
    } catch {
      return false;
    }
  });
  return page ? new URL(page.url()).origin : null;
}

async function closeOwnedContext() {
  if (automation?.context) await automation.context.close().catch(() => {});
}

async function main() {
  persistState();
  automation = new PortalAutomation({ profile, status });
  const result = await automation.openMenu('portal');
  const origin = automation.context ? await portalOrigin(automation.context) : null;
  const logoutVisible = automation.context ? await visibleLogout(automation.context) : false;
  const authenticatedPhase = events.some((event) => event.phase === 'authenticated');
  const authenticated = result.ok === true && authenticatedPhase && logoutVisible;
  const outcome = authenticated
    ? 'authenticated'
    : result.phase === 'cancelled'
      ? 'cancelled'
      : result.phase === 'needs-user'
        ? 'timeout'
        : 'error';

  persistState({
    phase: outcome,
    busy: false,
    portalOrigin: origin,
    authenticated,
    logoutVisible,
    outcome,
    finishedAt: new Date().toISOString(),
  });

  const report = {
    scenario: "actual PortalAutomation.openMenu('portal') with manual official certificate UI",
    invocation: 'node scripts/qa-v2-live-auth.cjs',
    profileKind: 'normal app-owned EdgeProfile',
    profilePreserved: true,
    passwordValueRead: false,
    events,
    observable: {
      resultOk: result.ok === true,
      outcome,
      portalOrigin: origin,
      logoutVisible,
      authenticated,
    },
    stateArtifact: path.relative(root, statePath),
  };
  fs.writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  process.stdout.write(`RESULT ${JSON.stringify(report.observable)}\n`);

  if (authenticated) {
    process.stdout.write('AUTHENTICATED PORTAL OBSERVED; holding owned context for 60 seconds\n');
    const closeRequest = path.join(evidenceDir, 'close.request');
    const deadline = Date.now() + 60_000;
    while (Date.now() < deadline && !fs.existsSync(closeRequest)) {
      await new Promise((resolve) => setTimeout(resolve, 1_000));
    }
  }
  await closeOwnedContext();
  persistState({ contextClosed: true, busy: false });
}

process.once('SIGINT', async () => {
  persistState({ phase: 'interrupted', busy: false });
  await closeOwnedContext();
  persistState({ contextClosed: true });
  process.exit(130);
});

main().catch(async (error) => {
  persistState({
    phase: 'driver-error',
    busy: false,
    outcome: 'error',
    errorName: error instanceof Error ? error.name : 'UnknownError',
  });
  await closeOwnedContext();
  persistState({ contextClosed: true });
  process.stderr.write(`DRIVER ERROR ${error instanceof Error ? error.name : 'UnknownError'}\n`);
  process.exitCode = 1;
});
