'use strict';

const fs = require('node:fs');
const { EventEmitter } = require('node:events');
const childProcess = require('node:child_process');
const { shell } = require('electron');

const logPath = process.env.EDUDOCK_QA_ORDINARY_ADAPTER_LOG;
if (!process.env.EDUDOCK_QA_PROFILE || !logPath) throw new Error('Ordinary adapter QA requires an owned profile and log.');

const target = { pid: 24680, hwnd: '13579', processStartedAt: '2026-09-20T12:00:00.0000000Z' };
let discovered = false;
let authenticated = false;
let loginInvoked = false;
let removableInvoked = false;
let selectedDriveId = 'D:';
let certificateSelected = false;
let authenticateOnInspect = false;
let currentSystem = 'portal';
let neisTaskStage = 0;
let publicFormsOpened = 0;
const records = [];
const persist = () => fs.writeFileSync(logPath, JSON.stringify(records, null, 2));
const certificateState = () => {
  const hidden = { visible: false, hardDiskAvailable: false, removableAvailable: false, selectedStore: null, hardDiskEmpty: null, driveOptions: [], driveOptionsToken: null, selectedDriveId: null, certRowCount: null, selectedCertRowCount: null, soleCertRowSelectable: false };
  if (!loginInvoked || authenticated) return hidden;
  if (!removableInvoked) return { ...hidden, visible: true, hardDiskAvailable: true, removableAvailable: true, selectedStore: 'hard-disk', hardDiskEmpty: true, certRowCount: 0, selectedCertRowCount: 0 };
  const options = [{ id: 'D:', label: 'DATA(D:)', selected: selectedDriveId === 'D:' }, { id: 'E:', label: 'USB(E:)', selected: selectedDriveId === 'E:' }];
  const count = selectedDriveId === 'E:' ? 1 : 0;
  return { ...hidden, visible: true, removableAvailable: true, selectedStore: 'removable-disk', driveOptions: options, driveOptionsToken: `options-${selectedDriveId}`, selectedDriveId, certRowCount: count, selectedCertRowCount: certificateSelected ? 1 : 0, soleCertRowSelectable: count === 1 };
};
const neisTaskState = () => neisTaskStage === 0
  ? { myMenuSelected: false, dutyExpanded: false, visibleTasks: [], existingTaskTabs: [], activeTask: null, actions: ['select-my-menu'] }
  : neisTaskStage === 1
    ? { myMenuSelected: true, dutyExpanded: false, visibleTasks: [], existingTaskTabs: [], activeTask: null, actions: ['expand-duty'] }
    : neisTaskStage === 2
      ? { myMenuSelected: true, dutyExpanded: true, visibleTasks: ['attendance', 'trip'], existingTaskTabs: [], activeTask: null, actions: ['open-attendance', 'open-trip'] }
      : { myMenuSelected: true, dutyExpanded: true, visibleTasks: ['attendance', 'trip'], existingTaskTabs: ['attendance'], activeTask: 'attendance', actions: [] };
const windowState = () => ({
  ...target,
  origin: currentSystem === 'neis' ? 'https://sen.neis.go.kr' : currentSystem === 'edufine' ? 'https://klef.sen.go.kr' : 'https://sen.eduptl.kr',
  authenticated,
  loginAvailable: !loginInvoked,
  certificate: certificateState(),
  actions: authenticated ? ['neis'] : [],
  landing: currentSystem === 'portal' ? (authenticated ? 'portal' : null) : currentSystem,
  availableSystems: ['portal', 'neis', 'edufine'],
  ...(currentSystem === 'neis' ? { neisTaskState: neisTaskState() } : {}),
});

shell.openExternal = async url => {
  records.push({ kind: 'openExternal', url: String(url) });
  // Edge exists from here on: before this, no window and no tab strip can be found, so the
  // product's "switch to an existing portal tab" path has nothing to switch to.
  discovered = true;
  persist();
};

// The product talks to its PowerShell helpers two ways: a one-shot spawn that gets the
// request on stdin and closes, and a long-lived worker that gets one base64 line per request
// and answers with one JSON line. The fake speaks both, so this harness exercises whichever
// transport the product actually chose instead of silently missing the worker path.
childProcess.spawn = (_file, args) => {
  const isDraftHandoff = String(args?.at(-1)).endsWith('edufine-draft.ps1');
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.kill = () => true;

  const answer = requestText => {
    const request = JSON.parse(requestText);
    records.push({ kind: isDraftHandoff ? 'native-draft' : 'native', request });
    let response;
    if (isDraftHandoff) {
      // One editor is already open (the teacher's); every public-form click adds a fresh one.
      // The product must hand back only the fresh window and write only into that one.
      const editorAt = index => ({ pid: 9753 + index, hwnd: String(8642 + index), processStartedAt: `2026-09-20T13:0${index}:00.0000000Z`, processPath: 'C:\\Program Files (x86)\\kedu\\WXSClient.exe', title: `${EXPECTED_FORM_CAPTION}...`, markers: [...REQUIRED_MARKERS], documentState: 'blank' });
      const editors = Array.from({ length: publicFormsOpened + 1 }, (_, index) => editorAt(index));
      if (request.command === 'open-public-form') { publicFormsOpened += 1; response = { status: 'ok', editors, invoked: true, entry: { selector: 'uia', caption: EXPECTED_FORM_CAPTION } }; }
      else if (request.command === 'focus-editor') response = { status: 'ok', editors, focused: true };
      else if (request.command === 'fill-draft') {
        const newest = editors[editors.length - 1];
        const fresh = request.target === `${newest.pid}|${newest.processStartedAt}|${newest.hwnd}` && publicFormsOpened > 0;
        response = fresh ? { status: 'ok', editors, filled: true } : { status: 'needs-user', editors, filled: false, reason: 'not-the-fresh-editor' };
      } else response = { status: 'ok', editors };
    } else if (request.command === 'inspect' && !request.target && !discovered) {
      if (authenticateOnInspect) { authenticated = true; authenticateOnInspect = false; }
      response = { status: 'ok', windows: [] };
    } else {
      if (request.command === 'inspect' && authenticateOnInspect) { authenticated = true; authenticateOnInspect = false; }
      if (request.command === 'invoke' && request.action === 'login') {
        loginInvoked = true;
        response = { status: 'ok', windows: [windowState()], invoked: true };
      } else if (request.command === 'invoke' && request.action === 'removable-disk') {
        removableInvoked = true;
        response = { status: 'ok', windows: [windowState()], invoked: true };
      } else if (request.command === 'invoke' && request.action === 'select-drive') {
        selectedDriveId = request.driveId;
        response = { status: 'ok', windows: [windowState()], invoked: true };
      } else if (request.command === 'invoke' && request.action === 'select-certificate-row') {
        certificateSelected = true;
        authenticateOnInspect = true;
        response = { status: 'ok', windows: [windowState()], invoked: true };
      } else if (request.command === 'invoke' && request.action === 'activate-system-tab') {
        currentSystem = request.system;
        response = { status: 'ok', windows: [windowState()], invoked: true };
      } else if (request.command === 'invoke' && ['select-my-menu', 'expand-duty', 'open-attendance'].includes(request.action)) {
        response = { status: 'ok', windows: [windowState()], invoked: true };
        neisTaskStage += 1;
      } else {
        response = { status: 'ok', windows: [windowState()] };
      }
    }
    persist();
    return response;
  };

  child.stdin = {
    // One-shot transport: the whole request arrives as JSON, the helper answers and exits.
    end(value) {
      const response = answer(String(value));
      setImmediate(() => {
        child.stdout.emit('data', Buffer.from(JSON.stringify(response)));
        child.emit('close', 0);
      });
    },
    // Worker transport: one base64 line in, one JSON line out, process stays alive.
    write(line) {
      const response = answer(Buffer.from(String(line).trim(), 'base64').toString('utf8'));
      setImmediate(() => { child.stdout.emit('data', Buffer.from(JSON.stringify(response) + String.fromCharCode(10))); });
    },
    on() {},
  };
  return child;
};

// Required only after childProcess.spawn is replaced below: src/native-worker.cjs binds
// spawn when it is first loaded, so importing any product module earlier left the draft
// helper talking to a real PowerShell process on the tester's machine.
const { EXPECTED_FORM_CAPTION, REQUIRED_MARKERS } = require('../src/draft-handoff.cjs');


require('../src/main.cjs');
