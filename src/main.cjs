const { app, BrowserWindow, ipcMain, screen, powerMonitor, dialog, clipboard, Tray, Menu, nativeImage, shell, safeStorage, net } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const { loadSettings, saveSettings, cleanPatch, sanitizedSettings } = require('./settings.cjs');
const { GuideSession, shouldAutoStart } = require('./guide.cjs');
const { SecretStore } = require('./secret-store.cjs');
const { createNotchWindow } = require('./notch-window.cjs');
const { createNotchPopover } = require('./notch-popover.cjs');
const { createPlacementGuide } = require('./placement-guide.cjs');
const { EDGES, describeDisplays, describePlacement, placementMenuTemplate } = require('./placement-menu.cjs');
const { fitScaleToDisplay, switchOrientation, nextMonitorId } = require('./notch-placement.cjs');
const { registerManagedWindow, sendToManagedWindows } = require('./window-registry.cjs');
const { generateDraft } = require('./drafts.cjs');
const { PortalAutomation } = require('./portal.cjs');
const { NativeOrdinaryEdgeBridge, OrdinaryEdgeAdapter, resolveOrdinaryEdgeHelper, resolveOrdinaryEdgeServeHelper, resolveDraftHandoffHelper } = require('./ordinary-edge.cjs');
const { DraftHandoffCoordinator, NativeDraftHandoffBridge } = require('./draft-handoff.cjs');
const { createUpdater, RELEASE_REPOSITORY } = require('./updater.cjs');
const { createSavedDrafts } = require('./saved-drafts.cjs');

let notch;
let auxiliary;
let tray;
let settings;
let automation;
let popover;
let placementGuide;
let updater;
const updateAnswered = { available: null, ready: null };
let updateQuestion = null;
let popoverHideTimer;
let quitting = false;
const roles = new Map();
let currentStatus = { phase: 'idle', label: '업무 상태', message: '현재 진행 중인 작업이 없습니다.', busy: false };

if (process.env.EDUDOCK_QA_PROFILE) app.setPath('userData', process.env.EDUDOCK_QA_PROFILE);
if (!app.requestSingleInstanceLock()) app.quit();

let guide = null;
let guideStep = null;
let secrets = null;
let storedPasswordLost = false;
let nativeBridges = [];

function guideAnchorButton(step) {
  return step?.kind === 'button' ? step.button : null;
}

// The walkthrough points at real controls, so the notch has to be visible and expanded while
// it runs; the notch renderer turns the step into an anchored popover next to its own button.
function showGuideStep() {
  guideStep = guide?.current() || null;
  if (!guideStep) return null;
  notch?.show(false);
  notch?.dispatch('expand');
  notch?.window?.webContents.send('guide-step', { ...guideStep, anchorButton: guideAnchorButton(guideStep) });
  return guideStep;
}

function finishGuide() {
  guide = null;
  guideStep = null;
  popover?.hide();
  if (settings.guideCompleted !== true) {
    settings = sanitizedSettings({ ...settings, guideCompleted: true });
    persist();
  }
  publish();
  return state();
}

function startGuide() {
  // The password offer only appears when this machine can actually protect the secret and
  // one is not already stored.
  const includePasswordOffer = Boolean(secrets?.available()) && settings.passwordSaved !== true;
  guide = new GuideSession({ buttons: settings.buttons, includePasswordOffer });
  const step = showGuideStep();
  if (!step) return finishGuide();
  return state();
}

function advanceGuide() {
  if (!guide) return state();
  if (!guide.next()) return finishGuide();
  showGuideStep();
  return state();
}

function markPasswordSaved(saved) {
  // Saving the password is what turns auto-login on; losing it turns auto-login off, because
  // without a stored password there is nothing for the automatic login to type.
  // The in-flight login is left alone when the password is dropped: after a rejected password the
  // certificate window is still open and the teacher types it by hand.
  settings = sanitizedSettings({ ...settings, passwordSaved: saved, autoLogin: saved });
  if (saved) automation?.setAutoLogin(true);
  persist();
  publish();
}

function storePassword(password) {
  if (typeof password !== 'string' || password.length === 0 || password.length > 256) throw new Error('비밀번호가 올바르지 않습니다.');
  if (!secrets?.available()) throw new Error('이 컴퓨터에서는 비밀번호를 안전하게 저장할 수 없어요.');
  secrets.save(password);
  markPasswordSaved(true);
}

function state() {
  let placementMaxScale = 1.5;
  if (settings?.placement && screen.getAllDisplays().length) {
    const display = screen.getAllDisplays().find(candidate => String(candidate.id) === settings.placement.monitorId) || screen.getPrimaryDisplay();
    placementMaxScale = fitScaleToDisplay(display, settings.placement.edge, 1.5);
  }
  const displays = screen.getAllDisplays().length ? describeDisplays(screen.getAllDisplays(), screen.getPrimaryDisplay().id) : [];
  const placementLabel = settings?.placement && displays.length ? describePlacement(displays, settings.placement, screen.getPrimaryDisplay().id) : '';
  return { settings, placementMaxScale, displays, placementLabel, authenticationPending: Boolean(automation?.operation), passwordStorageAvailable: Boolean(secrets?.available()), update: updater?.state || null, operation: currentStatus, interaction: notch?.interaction || null, version: app.getVersion() };
}

function registerWindow(window, role) {
  registerManagedWindow(window, role, roles);
}

function sendManaged(channel, value) {
  sendToManagedWindows(BrowserWindow.getAllWindows(), roles, channel, value);
}

function publish() {
  refreshTrayMenu();
  sendManaged('state-update', state());
}

function persist() {
  saveSettings(app.getPath('userData'), settings);
}

function clampToWorkArea(bounds) {
  const area = screen.getDisplayMatching(bounds).workArea;
  const width = Math.min(bounds.width, area.width);
  const height = Math.min(bounds.height, area.height);
  return {
    width,
    height,
    x: Math.max(area.x, Math.min(bounds.x, area.x + area.width - width)),
    y: Math.max(area.y, Math.min(bounds.y, area.y + area.height - height)),
  };
}

function centeredBounds(width, height) {
  const area = screen.getDisplayNearestPoint(screen.getCursorScreenPoint()).workArea;
  const size = { width: Math.min(width, area.width), height: Math.min(height, area.height) };
  return {
    ...size,
    x: area.x + Math.round((area.width - size.width) / 2),
    y: area.y + Math.round((area.height - size.height) / 2),
  };
}

function createAuxiliaryWindow() {
  if (auxiliary && !auxiliary.isDestroyed()) return auxiliary;
  auxiliary = new BrowserWindow({
    ...centeredBounds(960, 720),
    minWidth: 640,
    minHeight: 480,
    frame: false,
    // Opaque on purpose: Chromium drops ClearType (subpixel) text on transparent windows, which
    // made every small label look smeared at 100% scaling. Windows 11 still rounds the corners.
    transparent: false,
    resizable: true,
    show: false,
    alwaysOnTop: false,
    backgroundColor: '#f1f4f9',
    icon: path.join(__dirname, '../assets/app-icon.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  registerWindow(auxiliary, 'auxiliary');
  auxiliary.setMenu(null);
  auxiliary.loadFile(path.join(__dirname, '../renderer/index.html'), { query: { auxiliary: '1', view: 'draft' } });
  auxiliary.on('close', event => {
    if (!quitting) {
      event.preventDefault();
      auxiliary.hide();
    }
  });
  return auxiliary;
}

function showAuxiliary(view, section = null) {
  const target = view === 'settings' ? 'settings' : 'draft';
  // Anything about an update opens settings on the update row itself; so does opening settings
  // while an update is waiting to be fetched, fetched or installed.
  const pending = ['available', 'downloading', 'ready'].includes(updater?.state.phase);
  const requested = typeof section === 'string' ? section : null;
  const focusSection = target === 'settings' ? (requested || (pending ? 'update' : null)) : null;
  clearTimeout(popoverHideTimer);
  popover?.hide();
  notch?.dispatch('focus', false);
  const window = createAuxiliaryWindow();
  const open = () => {
    if (!window || window.isDestroyed() || window.webContents.isDestroyed()) return;
    if (target === 'settings') {
      window.setMinimumSize(440, 480);
      window.setBounds(centeredBounds(480, 720));
    } else {
      window.setMinimumSize(640, 480);
      const bounds = window.getBounds();
      if (bounds.width < 640 || bounds.height < 480) window.setBounds(centeredBounds(960, 720));
    }
    window.webContents.send('aux-view', target);
    if (focusSection) window.webContents.send('aux-section', focusSection);
    window.webContents.send('status', currentStatus);
    window.show();
    window.focus();
  };
  if (window.webContents.isLoadingMainFrame()) window.webContents.once('did-finish-load', open);
  else open();
  return { ok: true, view: target };
}

function hideNotch() {
  clearTimeout(popoverHideTimer);
  popover?.hide();
  if (!notch?.window || notch.window.isDestroyed()) return { ok: false };
  notch.cancelPlacement();
  notch.dispatch('focus', false);
  notch.dispatch('pointer', false);
  notch.window.hide();
  return { ok: true };
}

function applySettings(patch) {
  const cleaned = cleanPatch(patch);
  if (cleaned.autoLogin === true && settings.passwordSaved !== true) throw new Error('먼저 인증서 비밀번호를 저장해 주세요. 저장하면 자동 로그인이 켜집니다.');
  const cleanedPlacement = cleaned.placement || {};
  settings = sanitizedSettings({
    ...settings,
    ...cleaned,
    placement: {
      ...settings.placement,
      ...cleanedPlacement,
      offsets: { ...settings.placement.offsets, ...(cleanedPlacement.offsets || {}) },
      lastEdges: { ...settings.placement.lastEdges, ...(cleanedPlacement.lastEdges || {}) },
    },
  });
  persist();
  if (Object.hasOwn(cleaned, 'autoLogin')) {
    automation?.setAutoLogin(settings.autoLogin);
  }
  notch.apply(settings);
  publish();
  return state();
}

function cycleEdge() {
  const edges = ['top', 'right', 'bottom', 'left'];
  const edge = edges[(edges.indexOf(settings.placement.edge) + 1) % edges.length];
  const orientation = ['top', 'bottom'].includes(edge) ? 'horizontal' : 'vertical';
  return applySettings({ placement: { edge, lastEdges: { [orientation]: edge } } });
}

function cycleMonitor() {
  const monitorId = nextMonitorId(screen.getAllDisplays(), settings.placement.monitorId);
  if (!monitorId || monitorId === String(settings.placement.monitorId)) return state();
  return applySettings({ placement: { monitorId } });
}

// Direct jump used by the settings monitor map, the notch's right-click menu and the tray.
function moveNotch(request) {
  const edge = request?.edge;
  if (!EDGES.includes(edge)) throw new Error('붙일 가장자리가 올바르지 않습니다.');
  const displays = screen.getAllDisplays();
  const monitorId = request.monitorId === undefined || request.monitorId === null ? String(settings.placement.monitorId ?? screen.getPrimaryDisplay().id) : String(request.monitorId);
  if (!displays.some(display => String(display.id) === monitorId)) throw new Error('선택한 모니터를 찾을 수 없어요. 모니터 연결을 확인해주세요.');
  const orientation = ['top', 'bottom'].includes(edge) ? 'horizontal' : 'vertical';
  return applySettings({ placement: { monitorId, edge, lastEdges: { [orientation]: edge } } });
}

function placementItems() {
  return placementMenuTemplate({
    displays: screen.getAllDisplays(),
    primaryId: screen.getPrimaryDisplay().id,
    placement: settings.placement,
    onMove: target => { try { moveNotch(target); } catch {} },
  });
}

function buildTrayMenu() {
  return Menu.buildFromTemplate([
    { label: '노치 보이기', click: () => notch.show(true) },
    { label: '노치 숨기기', click: hideNotch },
    { label: '초안 열기', click: () => showAuxiliary('draft') },
    { label: '설정 열기', click: () => showAuxiliary('settings') },
    { label: '사용 안내 다시 보기', click: () => { try { startGuide(); } catch {} } },
    { type: 'separator' },
    { label: '위젯 위치', submenu: placementItems() },
    updater?.state.phase === 'ready'
      ? { label: `재시작하여 새 버전 ${updater.state.available || ''} 설치`, click: installUpdate }
      : updater?.state.phase === 'available'
        ? { label: `새 버전 ${updater.state.available || ''} 내려받기`, click: () => { if (updater.state.mode === 'portable') updater.openReleasePage(); else { showAuxiliary('settings', 'update'); void updater.download(); } } }
        : { label: '업데이트 확인', enabled: Boolean(updater) && !['development', 'store'].includes(updater.state.mode), click: () => { showAuxiliary('settings', 'update'); void updater?.check(); } },
    { type: 'separator' },
    { label: '종료', click: () => { quitting = true; app.quit(); } },
  ]);
}

// The tray menu is a snapshot, so it is rebuilt only when what it shows (monitors, the current
// spot) actually changes rather than on every status publish.
let trayMenuKey = '';
function refreshTrayMenu() {
  if (!tray || tray.isDestroyed()) return;
  const key = JSON.stringify([screen.getAllDisplays().map(display => [display.id, display.bounds]), settings.placement.monitorId, settings.placement.edge, updater?.state.phase]);
  if (key === trayMenuKey) return;
  trayMenuKey = key;
  tray.setContextMenu(buildTrayMenu());
}

// A small arrow bubble next to the widget at launch. It keeps the widget expanded while shown
// (popover presence) and goes away by itself; any other popover simply replaces it.
let launchHintTimer = null;
function showLaunchHint() {
  if (!notch?.window || notch.window.isDestroyed() || !notch.window.isVisible() || guide || updateQuestion) return;
  const bounds = notch.window.getBounds();
  // A stored password that could not be opened at start-up is said once, in place of the usual hint.
  const label = storedPasswordLost
    ? '저장해 둔 비밀번호를 이 PC에서 열 수 없어 자동 로그인을 껐어요. 설정에서 비밀번호를 한 번 다시 저장해 주세요.'
    : '버튼을 누르시면 해당 메뉴로 바로 이동합니다.';
  popover.show({ kind: 'hint', label, anchor: bounds, notchBounds: bounds, edge: settings.placement.edge });
  clearTimeout(launchHintTimer);
  launchHintTimer = setTimeout(() => { if (popover.kind === 'hint') popover.hide(); }, storedPasswordLost ? 15000 : 8000);
  storedPasswordLost = false;
  launchHintTimer.unref?.();
}

function installUpdate() {
  if (updater?.state.phase !== 'ready') return { ok: false };
  quitting = true;
  return { ok: updater.install() };
}

// Asks before downloading and again before installing, in the widget's own popover (same frame
// as the guide), once per version per run: "나중에" is respected until the next launch, and
// settings can still start either step. The question only ever acts on one of its two buttons.
// It never interrupts a login, a screen move or the guide; it waits until the widget is idle.
function promptForUpdate(update) {
  const step = update?.phase === 'available' ? 'available' : update?.phase === 'ready' ? 'ready' : null;
  if (!step || !update.available || updateAnswered[step] === update.available) return;
  if (updateQuestion?.step === step && updateQuestion.version === update.available && popover?.kind === 'update') return;
  if (automation?.busy || guide || !notch?.window || notch.window.isDestroyed() || !notch.window.isVisible()) {
    const retry = setTimeout(() => promptForUpdate(updater?.state), 10000);
    retry.unref?.();
    return;
  }
  const portable = update.mode === 'portable';
  const question = step === 'available'
    ? {
      body: portable
        ? `새 버전 ${update.available}이 나왔어요.
포터블 버전은 새 exe를 받아 바꿔 써야 해요. 내려받기 페이지를 열까요?`
        : `새 버전 ${update.available}이 나왔어요.
지금 내려받을까요? 받는 동안에도 계속 쓸 수 있어요.`,
      yes: portable ? '페이지 열기' : '지금 내려받기',
    }
    : { body: `새 버전 ${update.available}을 받았어요.
지금 재시작해서 설치할까요? "나중에"를 누르면 종료할 때 설치돼요.`, yes: '지금 재시작' };
  updateQuestion = { step, version: update.available, portable };
  const bounds = notch.window.getBounds();
  clearTimeout(popoverHideTimer);
  popover.show({ kind: 'update', label: '업데이트', anchor: bounds, notchBounds: bounds, edge: settings.placement.edge, focus: true, update: { step, no: '나중에', ...question } });
}

function answerUpdate(answer) {
  const question = updateQuestion;
  updateQuestion = null;
  if (!question || answer?.step !== question.step) return { ok: false };
  updateAnswered[question.step] = question.version;
  if (answer.accepted !== true) return { ok: true, accepted: false };
  if (question.step === 'ready') installUpdate();
  else if (question.portable) void updater?.openReleasePage();
  else { showAuxiliary('settings', 'update'); void updater?.download(); }
  return { ok: true, accepted: true };
}

function commitPlacement(placement) {
  settings = sanitizedSettings({ ...settings, placement });
  persist();
  publish();
  return state();
}

function handle(channel, allowedRoles, fn) {
  ipcMain.handle(channel, async (event, value) => {
    const role = roles.get(event.sender.id);
    if (!allowedRoles.includes(role) || event.senderFrame !== event.sender.mainFrame) throw new Error('허용되지 않은 요청입니다.');
    return fn(value, event, role);
  });
}

app.on('second-instance', () => {
  if (notch?.window && !notch.window.isDestroyed()) notch.window.showInactive();
});

app.whenReady().then(() => {
  settings = loadSettings(app.getPath('userData'));
  if (settings.autoLogin && settings.passwordSaved !== true) settings = sanitizedSettings({ ...settings, autoLogin: false });
  try { secrets = new SecretStore({ directory: app.getPath('userData'), safeStorage }); } catch { secrets = null; }
  // A stored password this copy can no longer open (its key lives in this folder's Local State,
  // so a copied or restored folder, or another Windows account, loses it) must not keep claiming
  // "saved": auto-login then waited at the certificate window until it timed out. Show the
  // teacher the save box again instead.
  if (settings.passwordSaved === true && secrets?.available() && secrets.load() === null) {
    secrets.clear();
    settings = sanitizedSettings({ ...settings, passwordSaved: false, autoLogin: false });
    storedPasswordLost = true;
  }
  persist();

  notch = createNotchWindow({
    BrowserWindow,
    screen,
    powerMonitor,
    settings,
    preload: path.join(__dirname, 'preload.cjs'),
    onWindow: registerWindow,
    onInteraction: publish,
    onPlacementCommit: commitPlacement,
    onPlacementPreview: preview => {
      if (preview.active) placementGuide?.show(preview.placement);
      else placementGuide?.hide();
    },
  });
  placementGuide = createPlacementGuide({
    BrowserWindow,
    screen,
    describe: displays => describeDisplays(displays, screen.getPrimaryDisplay().id),
    keepAbove: () => { if (!notch.window.isDestroyed()) notch.window.moveTop(); },
  });
  for (const event of ['display-added', 'display-removed', 'display-metrics-changed']) {
    screen.on(event, () => { placementGuide?.hide(); publish(); });
  }

  popover = createNotchPopover({
    BrowserWindow,
    screen,
    preload: path.join(__dirname, 'preload.cjs'),
    onWindow: registerWindow,
    onPresence: open => notch.dispatch('popup', open),
  });

  const ordinaryEdgeBridge = new NativeOrdinaryEdgeBridge({
    helperPath: resolveOrdinaryEdgeHelper({ isPackaged: app.isPackaged, resourcesPath: process.resourcesPath }),
    servePath: resolveOrdinaryEdgeServeHelper({ isPackaged: app.isPackaged, resourcesPath: process.resourcesPath }),
  });
  const draftHandoffBridge = new NativeDraftHandoffBridge({
    helperPath: resolveDraftHandoffHelper({ isPackaged: app.isPackaged, resourcesPath: process.resourcesPath }),
    servePath: resolveOrdinaryEdgeServeHelper({ isPackaged: app.isPackaged, resourcesPath: process.resourcesPath }),
  });
  const draftHandoff = new DraftHandoffCoordinator({
    runNative: (request, operation) => draftHandoffBridge.run(request, operation),
  });
  nativeBridges = [ordinaryEdgeBridge, draftHandoffBridge];

  const ordinaryEdge = new OrdinaryEdgeAdapter({
    runNative: (request, operation) => ordinaryEdgeBridge.run(request, operation),
    openExternal: url => shell.openExternal(url),
    draftHandoff,
    // The auto-login switch decides whether the saved password is typed in: on, every button logs
    // in by itself; off, the certificate window waits for the teacher.
    getStoredPassword: () => (settings.passwordSaved === true && settings.autoLogin === true ? secrets?.load() ?? null : null),
    onPasswordRejected: () => { secrets?.clear(); markPasswordSaved(false); },
    getDriveHint: () => settings.certificateDriveHint,
    saveDriveHint: driveId => {
      settings = sanitizedSettings({ ...settings, certificateDriveHint: driveId });
      persist();
    },
  });
  automation = new PortalAutomation({
    openPortal: (url, operation) => ordinaryEdge.openOfficialPortal(url, operation),
    observeAuthenticated: operation => ordinaryEdge.observeAuthenticated(operation),
    resumeAction: (action, operation, options) => ordinaryEdge.resumeAction(action, operation, options),
    autoLogin: settings.autoLogin,
    status: data => {
      const labels = { opening: '업무 화면 여는 중', certificate: '인증서 연결 중', 'awaiting-user-auth': '사용자 인증 필요', authenticated: '로그인 확인', navigating: '업무 화면 이동 중', done: '완료', opened: '화면 열림', cancelled: '취소됨', 'needs-user': '확인 필요', error: '오류' };
      currentStatus = { phase: data.phase || 'idle', label: labels[data.phase] || '업무 상태', message: data.message || '업무 상태가 변경되었습니다.', busy: Boolean(data.busy) };
      sendManaged('status', currentStatus);
      publish();
    },
  });

  const icon = nativeImage.createFromPath(path.join(__dirname, '../assets/app-icon.png')).resize({ width: 16, height: 16 });
  if (shouldAutoStart(settings)) setTimeout(() => { try { startGuide(); } catch {} }, 1200);

  tray = new Tray(icon);
  tray.setToolTip('업무포털 도우미');
  refreshTrayMenu();
  tray.on('double-click', () => notch.show(true));

  handle('state', ['notch', 'auxiliary'], state);
  handle('settings', ['notch', 'auxiliary'], applySettings);
  // Only the view name crosses IPC. Passing showAuxiliary itself handed it the IPC event as its
  // second argument, which was then sent to the renderer and crashed the app (0.10.5–0.10.7).
  handle('open-auxiliary', ['notch', 'auxiliary'], view => showAuxiliary(view));
  handle('notch-interaction', ['notch', 'popover'], request => {
    if (!request || typeof request.type !== 'string') throw new Error('상호작용 요청이 올바르지 않습니다.');
    if (request.type === 'popup' && request.value) clearTimeout(popoverHideTimer);
    if (request.type === 'escape') {
      const cancelled = notch.cancelPlacement();
      if (cancelled.ok) return 'placement';
    }
    const result = notch.dispatch(request.type, request.value);
    if (request.type === 'escape' && result === 'popup') popover.hide();
    return result;
  });
  handle('notch-placement', ['notch'], request => notch.placement(request));
  handle('notch-move', ['notch', 'auxiliary'], moveNotch);
  handle('notch-context-menu', ['notch'], () => {
    clearTimeout(popoverHideTimer);
    popover.hide();
    // Right-click used to toggle "stay expanded" on its own; that choice now lives in the menu.
    const menu = Menu.buildFromTemplate([
      { label: '위젯 위치', enabled: false },
      ...placementItems(),
      { type: 'separator' },
      { label: '펼친 채로 고정', type: 'checkbox', checked: Boolean(notch.interaction?.pinned), click: () => notch.dispatch('pin') },
      { label: '설정 열기', click: () => showAuxiliary('settings') },
      { label: '노치 숨기기', click: hideNotch },
      { type: 'separator' },
      { label: '종료', click: () => { quitting = true; app.quit(); } },
    ]);
    // The notch stays open while the menu is up, as it does for its own popovers.
    notch.dispatch('popup', true);
    menu.popup({ window: notch.window, callback: () => notch.dispatch('popup', false) });
    return { ok: true };
  });
  handle('placement-orientation', ['auxiliary'], orientation => {
    if (!['horizontal', 'vertical'].includes(orientation)) throw new Error('Invalid placement orientation.');
    return applySettings({ placement: switchOrientation(settings.placement, orientation) });
  });
  handle('show-popover', ['notch'], request => {
    if (!request || !['tooltip', 'status', 'guide'].includes(request.kind)) throw new Error('팝오버 요청이 올바르지 않습니다.');
    // Hover tooltips never cover an unanswered update question; a deliberate status click may,
    // and then the question is asked again on the next check.
    // Judged by what is on screen: a question closed some other way (a button press hides the
    // popover) must not keep blocking every tooltip afterwards.
    if (popover.kind === 'update' && request.kind === 'tooltip') return { ok: false, reason: 'update-question-open' };
    updateQuestion = null;
    const anchor = request.anchor;
    if (!anchor || !['x', 'y', 'width', 'height'].every(key => Number.isFinite(anchor[key]))) throw new Error('팝오버 위치가 올바르지 않습니다.');
    clearTimeout(popoverHideTimer);
    return popover.show({
      kind: request.kind,
      label: request.label,
      status: currentStatus,
      anchor,
      notchBounds: notch.window.getBounds(),
      edge: settings.placement.edge,
      guide: request.kind === 'guide' ? guideStep : null,
      focus: (request.kind === 'guide') || (request.kind === 'status' && Boolean(request.focus)),
    });
  });
  handle('hide-popover', ['notch', 'popover'], request => {
    clearTimeout(popoverHideTimer);
    const delay = Number.isFinite(request?.delay) ? Math.max(0, Math.min(1000, request.delay)) : 0;
    const close = () => {
      const returnFocus = Boolean(popover.window && !popover.window.isDestroyed() && popover.window.isFocused());
      popover.hide();
      if (returnFocus) notch.show(true);
    };
    if (delay) popoverHideTimer = setTimeout(close, delay); else close();
    return { ok: true };
  });
  handle('window', ['notch', 'auxiliary'], (action, event, role) => {
    if (action === 'pin') return applySettings({ alwaysOnTop: !settings.alwaysOnTop });
    if (action === 'rotate' || action === 'dock') return cycleEdge();
    if (action === 'monitor') return cycleMonitor();
    const window = BrowserWindow.fromWebContents(event.sender);
    if (role === 'auxiliary' && action === 'minimize') window.minimize();
    if (action === 'close') window.hide();
    return state();
  });
  handle('resize', ['auxiliary'], (delta, event) => {
    if (!Number.isFinite(delta?.dx) || !Number.isFinite(delta?.dy)) return;
    const window = BrowserWindow.fromWebContents(event.sender);
    const bounds = window.getBounds();
    window.setBounds(clampToWorkArea({
      ...bounds,
      width: bounds.width + Math.round(Math.max(-100, Math.min(100, delta.dx))),
      height: bounds.height + Math.round(Math.max(-100, Math.min(100, delta.dy))),
    }));
  });
  // A bare menu id opens the menu. { id, draft } additionally hands 초안 만들기's result to
  // 일반기안문, so the teacher goes from generated text to a filled form in one press.
  handle('open-menu', ['notch', 'auxiliary'], request => {
    clearTimeout(popoverHideTimer);
    popover.hide();
    notch.dispatch('focus', false);
    if (typeof request === 'string') return automation.openMenu(request);
    const id = request?.id;
    const draft = request?.draft;
    if (typeof id !== 'string') throw new Error('지원하지 않는 메뉴입니다.');
    if (draft === undefined || draft === null) return automation.openMenu(id);
    if (id !== 'draft' || typeof draft.title !== 'string' || typeof draft.body !== 'string') throw new Error('초안이 올바르지 않습니다.');
    const title = draft.title.trim();
    if (title.length === 0 || title.length > 200 || draft.body.trim().length === 0 || draft.body.length > 20000) throw new Error('초안이 올바르지 않습니다.');
    return automation.openMenu(id, { draft: { title, body: draft.body } });
  });
  handle('guide-start', ['notch', 'auxiliary', 'popover'], () => startGuide());
  handle('guide-next', ['popover'], () => advanceGuide());
  handle('guide-skip', ['popover'], () => { guide?.skip(); return finishGuide(); });
  handle('guide-save-password', ['popover'], password => {
    storePassword(password);
    return finishGuide();
  });
  // Settings offers the same save after the stored password was cleared, so the teacher does
  // not have to replay the whole walkthrough to get to the last step.
  handle('save-password', ['auxiliary'], password => {
    storePassword(password);
    return state();
  });
  handle('clear-password', ['auxiliary', 'popover'], () => {
    secrets?.clear();
    markPasswordSaved(false);
    return state();
  });
  handle('cancel-auth', ['notch', 'auxiliary', 'popover'], () => automation.cancel());
  handle('retry-auth', ['notch', 'auxiliary', 'popover'], () => automation.retry());
  handle('generate-draft', ['auxiliary'], input => generateDraft(input));
  const savedDrafts = createSavedDrafts({ directory: app.getPath('userData') });
  handle('drafts-list', ['auxiliary'], () => savedDrafts.list());
  handle('drafts-save', ['auxiliary'], draft => savedDrafts.save(draft));
  handle('drafts-remove', ['auxiliary'], id => savedDrafts.remove(typeof id === 'string' ? id : ''));
  handle('copy', ['auxiliary'], text => {
    if (typeof text !== 'string' || text.length > 200000) throw new Error('복사할 내용이 올바르지 않습니다.');
    clipboard.writeText(text);
  });
  handle('save-draft', ['auxiliary'], async draft => {
    if (typeof draft?.title !== 'string' || typeof draft.body !== 'string' || draft.body.length > 200000) throw new Error('초안이 올바르지 않습니다.');
    const name = draft.title.replace(/[<>:"/\\|?*\x00-\x1F]/g, '_').slice(0, 100) || '초안';
    const parent = auxiliary && !auxiliary.isDestroyed() ? auxiliary : notch.window;
    const file = await dialog.showSaveDialog(parent, { defaultPath: path.join(app.getPath('documents'), name + '.txt'), filters: [{ name: '텍스트 초안', extensions: ['txt'] }] });
    if (file.canceled) return { ok: false, message: '저장을 취소했습니다.' };
    fs.writeFileSync(file.filePath, '\uFEFF' + draft.title + '\r\n\r\n' + draft.body.replace(/\r?\n/g, '\r\n'), 'utf8');
    return { ok: true, message: '초안을 파일로 저장했습니다.' };
  });
  // The 초안 window asks for the height its content needs; it grows or shrinks to that, stays on
  // screen, and keeps its width. Settings keeps its own fixed size.
  handle('fit-window', ['auxiliary'], request => {
    if (!auxiliary || auxiliary.isDestroyed() || !Number.isFinite(request?.height)) return { ok: false };
    const bounds = auxiliary.getBounds();
    const area = screen.getDisplayMatching(bounds).workArea;
    const height = Math.round(Math.max(480, Math.min(area.height, request.height)));
    const y = Math.max(area.y, Math.min(bounds.y, area.y + area.height - height));
    auxiliary.setBounds({ x: bounds.x, y, width: bounds.width, height });
    return { ok: true, height };
  });
  handle('update-check', ['auxiliary'], () => updater?.check() ?? null);
  handle('update-download', ['auxiliary'], () => updater?.download() ?? false);
  handle('update-answer', ['popover'], answerUpdate);
  handle('update-install', ['auxiliary'], () => installUpdate());
  handle('update-open-page', ['auxiliary'], () => updater?.openReleasePage());
  handle('diagnostics', ['auxiliary'], () => {
    const { browserConnected, ...checks } = automation.diagnostics();
    return {
      ...checks,
      passwordStored: settings.passwordSaved === true,
      passwordStorageAvailable: Boolean(secrets?.available()),
      autoLogin: settings.autoLogin === true,
      lastStatus: currentStatus ? { label: currentStatus.label, message: currentStatus.message } : null,
    };
  });
  // Updates are optional: whatever goes wrong here must not stop the rest of startup.
  try {
    updater = createUpdater({
      app,
      shell,
      net,
      repository: RELEASE_REPOSITORY,
      loadAutoUpdater: () => require('electron-updater').autoUpdater,
      onChange: update => { promptForUpdate(update); publish(); },
    });
    updater.start();
    // Waking from sleep or unlocking is when a PC left on overnight most likely missed a release.
    for (const event of ['resume', 'unlock-screen']) powerMonitor.on(event, () => { void updater?.check(); });
  } catch (error) {
    updater = null;
    console.error('updater unavailable', error);
  }
  publish();
  // Nothing opens by itself at launch: logging in happens when a button is pressed. The widget
  // only points at itself so the teacher knows where to press.
  if (!shouldAutoStart(settings)) setTimeout(showLaunchHint, 1500);
  // The native helpers (PowerShell + compiled UI Automation types) cost about two seconds to
  // start, which used to land on the first button press. A read-only look at the Edge windows
  // and the open 기안창 shortly after launch starts them in the background instead.
  const prewarm = setTimeout(() => {
    for (const [bridge, request] of [[ordinaryEdgeBridge, { command: 'inspect' }], [draftHandoffBridge, { command: 'inspect-editors' }]]) {
      Promise.resolve().then(() => bridge.run(request, { cancelled: false })).catch(() => {});
    }
  }, 2500);
  prewarm.unref?.();
});

app.on('before-quit', () => {
  quitting = true;
  automation?.cancel();
  // Otherwise the long-lived helper processes outlive the app.
  for (const bridge of nativeBridges) { try { bridge.stopWorker?.(); } catch {} }
  clearTimeout(popoverHideTimer);
  popover?.destroy();
  if (auxiliary && !auxiliary.isDestroyed()) auxiliary.destroy();
  notch?.destroy();
});
app.on('window-all-closed', () => {});
