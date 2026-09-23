'use strict';

const { spawn: nodeSpawn } = require('node:child_process');
const { NativeHelperWorker } = require('./native-worker.cjs');

const EXPECTED_FORM_CAPTION = '일반기안문 서식(결재4인,협조4인)';
const EXPECTED_WXS_PATH = 'c:\\program files (x86)\\kedu\\wxsclient.exe';
const REQUIRED_MARKERS = Object.freeze(['Shell Embedding', 'Shell DocObject View', 'Internet Explorer_Server', 'AfxOleControl120u', 'HwpMainEditWnd']);

class DraftHandoffError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'DraftHandoffError';
    this.code = code;
  }
}

function normalizePath(value) {
  return typeof value === 'string' ? value.replaceAll('/', '\\').toLowerCase() : '';
}

function isNonEmptyString(value) {
  return typeof value === 'string' && value.length > 0 && value.length <= 512;
}

function validateEditor(value) {
  if (!value || typeof value !== 'object' || !Number.isInteger(value.pid) || value.pid <= 0 ||
      !isNonEmptyString(value.hwnd) || !isNonEmptyString(value.processStartedAt) ||
      !isNonEmptyString(value.processPath) || typeof value.title !== 'string' || !Array.isArray(value.markers) ||
      !value.markers.every(isNonEmptyString) || !['blank', 'nonblank', 'unknown', 'closed'].includes(value.documentState) ||
      (value.dialogOpen !== undefined && typeof value.dialogOpen !== 'boolean') ||
      (value.dialogKind !== undefined && value.dialogKind !== null && !['autosave', 'close-other'].includes(value.dialogKind))) {
    throw new DraftHandoffError('invalid-response', 'Invalid native draft handoff response');
  }
  return Object.freeze({
    pid: value.pid,
    hwnd: value.hwnd,
    processStartedAt: value.processStartedAt,
    processPath: value.processPath,
    title: value.title,
    markers: Object.freeze([...value.markers]),
    documentState: value.documentState,
    dialogOpen: value.dialogOpen === true,
    // Which prompt the editor is showing: its autosave recovery, or the '열려있는 기안/결재기를
    // 닫습니다' question a second editor asks. Older helpers report neither.
    dialogKind: value.dialogOpen === true ? (value.dialogKind ?? 'autosave') : null,
  });
}

function validateNativeResponse(value) {
  if (!value || typeof value !== 'object' || !['ok', 'needs-user'].includes(value.status) || !Array.isArray(value.editors)) {
    throw new DraftHandoffError('invalid-response', 'Invalid native draft handoff response');
  }
  const result = { status: value.status, editors: value.editors.map(validateEditor) };
  if (value.invoked !== undefined) {
    if (typeof value.invoked !== 'boolean') throw new DraftHandoffError('invalid-response', 'Invalid native draft handoff response');
    result.invoked = value.invoked;
  }
  if (value.focused !== undefined) {
    if (typeof value.focused !== 'boolean') throw new DraftHandoffError('invalid-response', 'Invalid native draft handoff response');
    result.focused = value.focused;
  }
  for (const flag of ['blank', 'filled']) {
    if (value[flag] === undefined) continue;
    if (typeof value[flag] !== 'boolean') throw new DraftHandoffError('invalid-response', 'Invalid native draft handoff response');
    result[flag] = value[flag];
  }
  if (value.reason !== undefined) {
    if (!isNonEmptyString(value.reason)) throw new DraftHandoffError('invalid-response', 'Invalid native draft handoff response');
    result.reason = value.reason;
  }
  if (value.entry !== undefined) {
    if (!value.entry || !['uia', 'ocr'].includes(value.entry.selector) || value.entry.caption !== EXPECTED_FORM_CAPTION) {
      throw new DraftHandoffError('invalid-response', 'Invalid native draft handoff response');
    }
    result.entry = { selector: value.entry.selector, caption: value.entry.caption };
  }
  return Object.freeze(result);
}

function isVerifiedGeneralDraftEditor(editor) {
  return normalizePath(editor.processPath) === EXPECTED_WXS_PATH &&
    /^일반기안문 서식\(결재4인,협조4인\)_?(?:\.{3}|…)?$/.test(editor.title.trim()) &&
    REQUIRED_MARKERS.every(marker => editor.markers.includes(marker));
}

// The WXS editor hosts its body in an embedded HWP/IE control whose contents are not
// exposed through UI Automation, so documentState is 'unknown' on real windows. Opening
// and focusing an editor never changes a document, so identity alone gates those paths.
//
// Writing is gated twice over. canFillBody is the provenance half: only a form this very
// operation opened from 공용서식, with no autosave recovery prompt or one the product itself
// declined, is a candidate. The other half runs in the helper, which asks the document
// itself - not modified, empty 결재제목, empty 본문, empty title box - immediately before it
// writes. Provenance alone can go stale between the open and the write; the document cannot.
function canFillBody(result) {
  return Boolean(result) && result.reused === false && ['none', 'declined'].includes(result.autosave)
    && isVerifiedGeneralDraftEditor(result.editor);
}

function requiresBlankBody(editor) {
  return isVerifiedGeneralDraftEditor(editor) && editor.documentState === 'blank';
}

function publicFingerprint(editor) {
  return `${editor.pid}|${editor.processStartedAt}|${editor.hwnd}`;
}

function selectPublicFormCandidate(candidates, observation = {}) {
  if (observation.cancelled === true) throw new DraftHandoffError('cancelled', 'Public form selection was cancelled');
  if (!isNonEmptyString(observation.rootFingerprint) || observation.currentRootFingerprint !== observation.rootFingerprint) {
    throw new DraftHandoffError('root-changed', 'Public form root changed after capture');
  }
  if (observation.overlayClear !== true) throw new DraftHandoffError('overlay-detected', 'Public form target is covered by an overlay');
  if (!Array.isArray(candidates)) throw new DraftHandoffError('selector-unavailable', 'Public form selector is unavailable');
  const exact = candidates.filter(candidate => candidate && candidate.caption === EXPECTED_FORM_CAPTION &&
    ['uia', 'ocr'].includes(candidate.source) && candidate.captureToken === observation.captureToken &&
    candidate.rootFingerprint === observation.rootFingerprint &&
    candidate.bounds && [candidate.bounds.x, candidate.bounds.y, candidate.bounds.width, candidate.bounds.height].every(Number.isFinite) &&
    candidate.bounds.width > 0 && candidate.bounds.height > 0);
  const staleExact = candidates.some(candidate => candidate?.caption === EXPECTED_FORM_CAPTION && candidate?.captureToken !== observation.captureToken);
  if (exact.length === 0) {
    if (staleExact) throw new DraftHandoffError('stale-capture', 'Public form selector is stale');
    throw new DraftHandoffError('selector-unavailable', 'Public form selector is unavailable');
  }
  if (exact.length !== 1) throw new DraftHandoffError('selector-ambiguous', 'Public form selector is ambiguous');
  const candidate = exact[0];
  if (candidate.source === 'ocr' && (!Number.isFinite(candidate.confidence) || candidate.confidence < 0.9)) {
    throw new DraftHandoffError('low-confidence', 'Public form OCR confidence is too low');
  }
  return Object.freeze({
    selector: candidate.source,
    caption: EXPECTED_FORM_CAPTION,
    captureToken: candidate.captureToken,
    point: Object.freeze({ x: candidate.bounds.x + candidate.bounds.width / 2, y: candidate.bounds.y + candidate.bounds.height / 2 }),
  });
}

function throwIfCancelled(operation) {
  if (operation?.cancelled) throw new DraftHandoffError('cancelled', 'Draft handoff was cancelled');
}

class DraftHandoffCoordinator {
  #runNative;
  #pause;
  #timeoutMs;
  #editorWaitMs;
  #now;
  #dialogWaitMs;
  #onDialog;
  #consumed = new WeakSet();

  constructor({ runNative, pause = ms => new Promise(resolve => setTimeout(resolve, ms)), timeoutMs = 8000, editorWaitMs = 45000, dialogWaitMs = 120000, onDialog = () => {}, now = Date.now } = {}) {
    if (typeof runNative !== 'function') throw new TypeError('runNative is required');
    this.#runNative = runNative;
    this.#pause = pause;
    this.#timeoutMs = timeoutMs;
    this.#editorWaitMs = editorWaitMs;
    this.#dialogWaitMs = dialogWaitMs;
    this.#onDialog = onDialog;
    this.#now = now;
  }

  async #run(request, operation) {
    throwIfCancelled(operation);
    const response = validateNativeResponse(await this.#runNative(request, operation));
    throwIfCancelled(operation);
    return response;
  }

  // A look at the editors, retried while the deadline allows. The editor stops answering
  // window messages for a moment as it loads its document, and one helper timeout there used
  // to end the whole handoff with '기안 창이 열리기를 기다렸지만' although the window was fine.
  async #poll(operation, deadline) {
    for (let attempt = 0; ; attempt += 1) {
      try {
        return await this.#run({ command: 'inspect-editors' }, operation);
      } catch (error) {
        throwIfCancelled(operation);
        const transient = error instanceof DraftHandoffError && ['timeout', 'helper-failed'].includes(error.code);
        if (!transient || this.#now() >= deadline) throw error;
        await this.#pause(400);
      }
    }
  }

  #liveEditors(response) {
    return response.editors.filter(item => item.documentState !== 'closed' && normalizePath(item.processPath) === EXPECTED_WXS_PATH);
  }

  // The editor raises its own modal (autosave recovery) before it is usable. 취소 declines the
  // recovery without deleting anything, which is the normal answer, so the product may press
  // it — but only on a dialog positively identified by its autosave text, and never 확인.
  // Settles the autosave prompt of one specific editor — the one this operation opened. Other
  // editors on the desktop belong to the user and are never touched.
  //
  // Two prompts are known, and both are answered with 취소: the autosave recovery (declining
  // keeps the autosave file) and '열려있는 기안/결재기를 닫습니다' (취소 keeps the user's other
  // editor and still lets this one open; 확인 would close theirs). They can appear one after
  // the other, so each is settled in turn.
  async #settleDialog(response, operation, fingerprint) {
    const pick = value => this.#liveEditors(value).filter(item => publicFingerprint(item) === fingerprint);
    let editors = pick(response);
    let autosave = 'none';
    const deadline = this.#now() + this.#dialogWaitMs;
    for (let prompts = 0; editors.length === 1 && editors[0].dialogOpen === true; prompts += 1) {
      if (prompts >= 3) throw new DraftHandoffError('editor-dialog', 'The WXS editor keeps raising prompts');
      const kind = editors[0].dialogKind;
      this.#onDialog(editors[0]);
      const declined = await this.#run({ command: 'decline-editor-dialog', target: fingerprint }, operation);
      if (kind === 'autosave') autosave = declined.invoked === true ? 'declined' : 'user-answered';
      let current = editors;
      while (current.length === 1 && current[0].dialogOpen === true && current[0].dialogKind === kind) {
        if (this.#now() >= deadline) throw new DraftHandoffError('editor-dialog', 'The WXS editor is waiting on its own dialog');
        await this.#pause(400);
        throwIfCancelled(operation);
        current = pick(await this.#run({ command: 'inspect-editors' }, operation));
      }
      editors = current;
    }
    return { editors, autosave };
  }

  // Always opens a fresh form from 공용서식. Editors that are already open — the user's own
  // documents, or a blank template they left there — are neither reused nor written into; they
  // only serve to tell the new window apart, by the identity it did not have before the click.
  async open(operation = {}) {
    if ((typeof operation !== 'object' && typeof operation !== 'function') || operation === null) throw new TypeError('operation is required');
    if (this.#consumed.has(operation)) throw new DraftHandoffError('already-consumed', 'Draft handoff operation was already consumed');
    this.#consumed.add(operation);
    const before = await this.#run({ command: 'inspect-editors' }, operation);
    const beforeFingerprints = new Set(before.editors.map(publicFingerprint));
    const beforeIdentities = new Map(before.editors.map(item => [`${item.pid}|${item.processStartedAt}`, item.processPath]));

    const opened = await this.#run({ command: 'open-public-form', caption: EXPECTED_FORM_CAPTION }, operation);
    if (opened.status === 'needs-user') throw new DraftHandoffError('needs-user', opened.reason || 'Public form selection needs user input');
    if (opened.invoked !== true) throw new DraftHandoffError('not-invoked', 'Public form was not invoked');
    const seenPidStarts = new Map(beforeIdentities);
    // The wait for the editor starts after the form click. Sharing one budget with the menu
    // walk and OCR left almost no time for the editor to actually appear.
    const editorDeadline = this.#now() + this.#editorWaitMs;
    let unverified = null;
    while (this.#now() <= editorDeadline) {
      await this.#pause(25);
      const observed = await this.#poll(operation, editorDeadline);
      const live = this.#liveEditors(observed);
      for (const item of live) {
        // pid alone can be recycled, so identity is pid + process start time. The window handle
        // deliberately is not part of it: it legitimately changes while the editor shows its
        // modal, and treating that as a reused identity aborted a perfectly normal open.
        const key = `${item.pid}|${item.processStartedAt}`;
        if (seenPidStarts.has(key) && seenPidStarts.get(key) !== item.processPath) {
          throw new DraftHandoffError('reused-process-identity', 'Detected reused process identity');
        }
        seenPidStarts.set(key, item.processPath);
      }
      const fresh = live.filter(item => !beforeFingerprints.has(publicFingerprint(item)));
      if (fresh.length > 1) throw new DraftHandoffError('ambiguous-editors', 'More than one new WXS editor appeared after the public form click');
      if (fresh.length === 1) {
        const fingerprint = publicFingerprint(fresh[0]);
        const settled = await this.#settleDialog(observed, operation, fingerprint);
        if (settled.editors.length !== 1) throw new DraftHandoffError('stale-editor', 'The editor disappeared while its dialog was open');
        // A window that has only just appeared has not finished taking its title and controls,
        // so keep waiting for it to become recognisable rather than condemning it immediately.
        if (!isVerifiedGeneralDraftEditor(settled.editors[0])) { unverified = settled.editors[0]; continue; }
        // The editor raises its prompts one after another with a pause in between: the
        // autosave question arrived a second after '열려있는 기안/결재기를 닫습니다' was answered,
        // and a write that had already started ran into that modal. Wait until no prompt has
        // shown for a moment before handing the window over.
        const quiet = await this.#awaitQuiet(fingerprint, operation, settled.autosave);
        return Object.freeze({ editor: quiet.editor, reused: false, autosave: quiet.autosave });
      }
    }
    throwIfCancelled(operation);
    if (unverified) throw new DraftHandoffError('unsafe-new-editor', 'New WXS editor is not a verified general draft form');
    throw new DraftHandoffError('timeout', 'Draft handoff timed out');
  }

  async #awaitQuiet(fingerprint, operation, autosave, { quietPolls = 3, pollMs = 400, maxMs = 15000 } = {}) {
    const deadline = this.#now() + maxMs;
    let editor = null;
    let calm = 0;
    while (calm < quietPolls) {
      if (this.#now() >= deadline) throw new DraftHandoffError('editor-dialog', 'The WXS editor kept raising prompts');
      await this.#pause(pollMs);
      throwIfCancelled(operation);
      const observed = await this.#poll(operation, deadline);
      const current = this.#liveEditors(observed).filter(item => publicFingerprint(item) === fingerprint);
      if (current.length !== 1) throw new DraftHandoffError('stale-editor', 'The editor disappeared while settling');
      if (current[0].dialogOpen === true) {
        const settled = await this.#settleDialog(observed, operation, fingerprint);
        if (settled.autosave !== 'none') autosave = settled.autosave;
        if (settled.editors.length !== 1) throw new DraftHandoffError('stale-editor', 'The editor disappeared while its dialog was open');
        editor = settled.editors[0];
        calm = 0;
        continue;
      }
      editor = current[0];
      calm += 1;
    }
    if (!isVerifiedGeneralDraftEditor(editor)) throw new DraftHandoffError('unsafe-new-editor', 'New WXS editor is not a verified general draft form');
    return { editor, autosave };
  }

  // Places a generated draft into a form this coordinator just opened. The helper re-checks
  // that the document is still untouched and reads both fields back, so a partial write is
  // reported as a failure rather than announced as a finished draft.
  async fill(opened, content, operation = {}) {
    if (!canFillBody(opened)) throw new DraftHandoffError('not-fillable', 'This editor must not be written into');
    const title = content?.title;
    const body = content?.body;
    if (!isNonEmptyString(title) || typeof body !== 'string' || body.trim().length === 0 || body.length > 20000) {
      throw new DraftHandoffError('invalid-content', 'Draft content is missing or too large');
    }
    // A prompt that surfaced since the open would swallow the write; settle it first.
    const fingerprint = publicFingerprint(opened.editor);
    const before = await this.#run({ command: 'inspect-editors' }, operation);
    const current = this.#liveEditors(before).filter(item => publicFingerprint(item) === fingerprint);
    if (current.length !== 1) throw new DraftHandoffError('stale-editor', 'The editor disappeared before the draft was written');
    if (current[0].dialogOpen === true) {
      const settled = await this.#settleDialog(before, operation, fingerprint);
      if (settled.autosave === 'user-answered') throw new DraftHandoffError('not-fillable', 'The autosave prompt was answered by the user');
    }
    const response = await this.#run({ command: 'fill-draft', target: fingerprint, title, body }, operation);
    if (response.status === 'needs-user') throw new DraftHandoffError('needs-user', response.reason || 'The draft could not be written');
    if (response.filled !== true) throw new DraftHandoffError('not-filled', 'The draft was not written');
    return Object.freeze({ editor: opened.editor, filled: true });
  }
}

class NativeDraftHandoffBridge {
  constructor({ helperPath, servePath = null, spawn = nodeSpawn, timeoutMs = 10000 } = {}) {
    if (!isNonEmptyString(helperPath)) throw new TypeError('helperPath is required');
    this.helperPath = helperPath;
    this.servePath = servePath;
    this.spawn = spawn;
    this.timeoutMs = timeoutMs;
    // The draft handoff polls for the editor window, so it needs the same long-lived helper.
    this.workerRunner = servePath
      ? new NativeHelperWorker({
        helperPath,
        servePath,
        spawn,
        timeoutMs,
        errors: {
          timeout: () => new DraftHandoffError('timeout', 'Native draft handoff helper timed out'),
          failed: () => new DraftHandoffError('helper-failed', 'Native draft handoff helper failed'),
          cancelled: () => new DraftHandoffError('cancelled', 'Native draft handoff was cancelled'),
        },
      })
      : null;
  }

  stopWorker() {
    this.workerRunner?.stop();
  }

  run(request, operation = {}) {
    if (operation.cancelled === true) return Promise.reject(new DraftHandoffError('cancelled', 'Native draft handoff was cancelled'));
    if (this.workerRunner) {
      const body = JSON.stringify(request);
      return this.workerRunner.run(body, operation)
        .then(line => {
          try {
            return validateNativeResponse(JSON.parse(line));
          } catch {
            this.workerRunner.stop();
            throw new DraftHandoffError('invalid-response', 'Invalid native draft handoff response');
          }
        })
        .catch(error => {
          if (!error || error.workerFault !== true || operation.cancelled === true) throw error;
          return this.runOnce(request, operation);
        });
    }
    return this.runOnce(request, operation);
  }

  runOnce(request, operation = {}) {
    return new Promise((resolve, reject) => {
      let child;
      let settled = false;
      let stdout = '';
      let stderr = '';
      let timer = null;
      let unsubscribe = null;
      const finish = (error, value) => {
        if (settled) return;
        settled = true;
        if (timer !== null) clearTimeout(timer);
        unsubscribe?.();
        if (error) reject(error); else resolve(value);
      };
      try {
        child = this.spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', this.helperPath], { shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
      } catch (error) { reject(error); return; }
      child.stdout.on('data', chunk => { stdout += chunk.toString('utf8'); });
      child.stderr.on('data', chunk => { stderr += chunk.toString('utf8'); });
      child.on('error', error => finish(error));
      child.on('close', code => {
        if (code !== 0) { finish(new DraftHandoffError('helper-failed', `Native draft handoff helper failed (${code}): ${stderr.trim()}`)); return; }
        try {
          const trimmed = stdout.trim();
          if (!trimmed || trimmed.split(/\r?\n/).length !== 1) throw new Error('invalid output');
          finish(null, validateNativeResponse(JSON.parse(trimmed)));
        } catch { finish(new DraftHandoffError('invalid-response', 'Invalid native draft handoff response')); }
      });
      const cancelOwnedHelper = () => {
        if (settled) return;
        child.kill();
        finish(new DraftHandoffError('cancelled', 'Native draft handoff was cancelled'));
      };
      timer = setTimeout(() => { child.kill(); finish(new DraftHandoffError('timeout', 'Native draft handoff helper timed out')); }, this.timeoutMs);
      unsubscribe = typeof operation.onCancel === 'function' ? operation.onCancel(cancelOwnedHelper) : null;
      if (operation.cancellationPromise && typeof operation.cancellationPromise.then === 'function') {
        Promise.resolve(operation.cancellationPromise).then(cancelOwnedHelper, cancelOwnedHelper);
      }
      child.stdin.on?.('error', error => { child.kill(); finish(error); });
      child.stdin.end(JSON.stringify(request));
    });
  }
}

module.exports = {
  EXPECTED_FORM_CAPTION,
  REQUIRED_MARKERS,
  DraftHandoffCoordinator,
  DraftHandoffError,
  isVerifiedGeneralDraftEditor,
  requiresBlankBody,
  canFillBody,
  NativeDraftHandoffBridge,
  selectPublicFormCandidate,
  validateNativeResponse,
};
