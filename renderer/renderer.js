'use strict';

const api = window.portal;
const params = new URLSearchParams(location.search);
const isAuxiliary = params.has('auxiliary');
const element = (id) => document.getElementById(id);
const all = (selector) => [...document.querySelectorAll(selector)];
let activeView = 'home';
let activeKind = 'official';
let generatedKind = 'official';
let busy = false;
let resizePoint = null;
let state = { settings: { orientation: 'vertical', alwaysOnTop: false } };


function status(message, phase = 'idle', working = false) {
  element('status-message').textContent = message;
  const region = document.querySelector('.connection');
  region.dataset.phase = phase;
  region.dataset.busy = String(working);
  busy = working;
  element('cancel-auth').hidden = !working;
  element('retry-auth').hidden = phase !== 'needs-user';
  all('[data-menu]').forEach((button) => { button.disabled = working; });
  element('open-draft-menu').disabled = working;
}

async function invoke(method, ...args) {
  if (!api || typeof api[method] !== 'function') throw new Error('이 기능은 설치한 데스크톱 앱에서 사용할 수 있어요.');
  return api[method](...args);
}

function report(error) {
  status(error instanceof Error ? error.message : '작업을 완료하지 못했어요. 연결 상태를 확인해주세요.', 'error');
}

function renderState(next) {
  if (!next || !next.settings) return;
  state = next;
  const edge = next.settings.placement?.edge || 'top';
  const orientation = edge === 'left' || edge === 'right' ? 'vertical' : 'horizontal';
  document.body.dataset.orientation = orientation;
  document.body.dataset.dock = edge;
  element('always-on-top').checked = Boolean(next.settings.alwaysOnTop);
  element('auto-login').checked = Boolean(next.settings.autoLogin);
  const opacityPercent = Math.round((Number.isFinite(next.settings.opacity) ? next.settings.opacity : 1) * 100);
  element('opacity').value = String(opacityPercent);
  element('opacity-value').textContent = `${opacityPercent}%`;
  const passwordSaved = next.settings.passwordSaved === true;
  const canStorePassword = next.passwordStorageAvailable !== false;
  element('saved-password-row').hidden = !passwordSaved;
  element('password-setup').hidden = passwordSaved || !canStorePassword;
  element('password-unavailable').hidden = passwordSaved || canStorePassword;
  // Auto-login only has something to type once a password is stored, so it unlocks after step 1.
  element('auto-login').disabled = !passwordSaved;
  element('auto-login-row').dataset.locked = String(!passwordSaved);
  element('auto-login-help').textContent = !passwordSaved
    ? '먼저 위에서 인증서 비밀번호를 저장하면 켤 수 있어요.'
    : next.settings.autoLogin
      ? '켜짐 · 앱을 켤 때 Edge에서 인증서 로그인까지 자동으로 진행해요.'
      : '꺼짐 · 업무 버튼을 누를 때 로그인해요.';
  document.querySelector('.pin-button').setAttribute('aria-pressed', String(Boolean(next.settings.alwaysOnTop)));
  renderMonitorMap(next);
  renderUpdate(next.update, next.version);
  all('button[data-display-mode]').forEach((button) => button.setAttribute('aria-pressed', String(button.dataset.displayMode === (next.settings.displayMode || 'auto'))));
  const scale = Math.round((next.settings.placement?.scale || 1) * 100);
  const maximumScale = Math.round((next.placementMaxScale || 1.5) * 100);
  element('placement-scale').max = String(maximumScale);
  element('placement-scale').value = String(Math.min(scale, maximumScale));
  element('placement-scale-value').textContent = `${Math.min(scale, maximumScale)}%`;
  element('login-status-label').textContent = next.authenticationPending ? '공식 인증서 로그인을 기다리는 중' : 'Edge에서 안전하게 로그인';
  element('version').textContent = `업무 곁 · ${next.version || '0.1.0'}`;
}

function showView(name) {
  const next = element(`${name}-view`);
  if (!next) return;
  all('.view').forEach((view) => { view.hidden = view !== next; });
  activeView = name;
  document.querySelector('.content').scrollTop = 0;
  document.title = `${name === 'draft' ? '초안 만들기' : name === 'settings' ? '내 업무 환경' : '업무 곁'} · 업무포털 도우미`;
  const heading = next.querySelector('h1');
  if (heading) {
    heading.tabIndex = -1;
    heading.focus({ preventScroll: true });
  }
}

function selectKind(kind) {
  activeKind = kind;
  element('draft-form').elements.namedItem('kind').value = kind;
  all('[data-kind]').forEach((button) => button.setAttribute('aria-pressed', String(button.dataset.kind === kind)));
  all('[data-kinds]').forEach((item) => {
    item.hidden = !item.dataset.kinds.split(' ').includes(kind);
    item.querySelectorAll('input,textarea,select').forEach((field) => { field.disabled = item.hidden; });
  });
  const titleField = element('draft-form').elements.namedItem('title');
  const examples = { official: '예: 2학기 학년 협의회 운영 계획', trip: '예: 수업 나눔 연수 참석', attendance: '예: 개인 사유에 따른 연가 신청' };
  titleField.placeholder = examples[kind];
}

async function openMenu(id) {
  if (busy) return;
  status('Edge에서 업무 화면을 여는 중이에요.', 'opening', true);
  try {
    const result = await invoke('openMenu', id);
    status(result.message || (result.ok ? '업무 화면을 열었어요. 로그인 상태는 브라우저에서 확인해주세요.' : '업무 화면을 열지 못했어요.'), result.phase || (result.ok ? 'success' : 'error'));
  } catch (error) { report(error); }
}

all('[data-view]').forEach((button) => button.addEventListener('click', () => {
  if (isAuxiliary && button.dataset.view === 'home') invoke('window', 'close').catch(report);
  else showView(button.dataset.view);
}));
all('[data-menu]').forEach((button) => button.addEventListener('click', () => openMenu(button.dataset.menu)));
all('[data-kind]').forEach((button) => button.addEventListener('click', () => selectKind(button.dataset.kind)));
all('[data-window]').forEach((button) => button.addEventListener('click', async () => {
  try {
    const result = await invoke('window', button.dataset.window);
    if (result?.settings) renderState(result);
    else if (!['close', 'minimize'].includes(button.dataset.window)) renderState(await invoke('getState'));
  } catch (error) { report(error); }
}));

async function updateSettings(patch) {
  try { renderState(await invoke('settings', patch)); }
  catch (error) { renderState(state); report(error); }
}
element('always-on-top').addEventListener('change', (event) => updateSettings({ alwaysOnTop: event.target.checked }));
element('auto-login').addEventListener('change', async (event) => {
  const enabled = event.target.checked;
  await updateSettings({ autoLogin: enabled });
  if (state.settings.autoLogin === enabled) status(enabled ? '자동 로그인을 켰어요. 다음에 앱을 켤 때부터 적용돼요.' : '자동 로그인을 껐어요. 업무 버튼을 누를 때 로그인해요.', 'success');
});
element('opacity').addEventListener('input', (event) => { element('opacity-value').textContent = `${event.target.value}%`; });
element('opacity').addEventListener('change', (event) => updateSettings({ opacity: Number(event.target.value) / 100 }));
element('guide-replay').addEventListener('click', async () => { try { await api.guideStart(); } catch (error) { report(error); } });
element('clear-password').addEventListener('click', async () => {
  try {
    renderState(await api.clearPassword());
    status('저장된 비밀번호를 지웠어요. 자동 로그인도 함께 꺼졌어요.', 'success');
  } catch (error) { report(error); }
});

function setupPasswords() {
  const first = element('setup-pw-first').value;
  const second = element('setup-pw-second').value;
  if (!first) return { ok: false, hint: '' };
  if (!second) return { ok: false, hint: '한 번 더 입력해 주세요.' };
  if (first !== second) return { ok: false, hint: '두 번 입력한 비밀번호가 달라요.' };
  return { ok: true, hint: '확인됐어요.', password: first };
}
function setupHint(text, tone) {
  element('setup-pw-hint').textContent = text;
  element('setup-pw-hint').dataset.tone = tone;
}
function refreshSetupPassword() {
  const result = setupPasswords();
  setupHint(result.hint, result.ok ? 'ok' : (result.hint ? 'warn' : ''));
  element('save-password').disabled = !result.ok;
}
['setup-pw-first', 'setup-pw-second'].forEach((id) => element(id).addEventListener('input', refreshSetupPassword));
all('#password-setup .pw-eye').forEach((button) => button.addEventListener('click', () => {
  const field = element(button.dataset.for);
  const reveal = field.type === 'password';
  field.type = reveal ? 'text' : 'password';
  button.setAttribute('aria-pressed', String(reveal));
  button.setAttribute('aria-label', reveal ? '비밀번호 숨기기' : '비밀번호 보기');
  field.focus({ preventScroll: true });
}));
element('password-setup').addEventListener('submit', async (event) => {
  event.preventDefault();
  const result = setupPasswords();
  if (!result.ok) { refreshSetupPassword(); return; }
  element('save-password').disabled = true;
  try {
    renderState(await invoke('savePassword', result.password));
    setupHint('', '');
    status('비밀번호를 저장하고 자동 로그인을 켰어요. 원하지 않으면 아래에서 끌 수 있어요.', 'success');
  } catch (error) {
    setupHint(error instanceof Error ? error.message : '비밀번호를 저장하지 못했어요.', 'warn');
  } finally {
    // The plain password never lingers in the form, whether or not the save succeeded.
    element('setup-pw-first').value = '';
    element('setup-pw-second').value = '';
    all('#password-setup .pw-eye').forEach((button) => {
      element(button.dataset.for).type = 'password';
      button.setAttribute('aria-pressed', 'false');
      button.setAttribute('aria-label', '비밀번호 보기');
    });
  }
});
// The button changes with the updater's phase: check → (downloading) → restart to install, or
// for the portable copy, open the download page.
function renderUpdate(update, version) {
  const button = element('update-action');
  const bar = element('update-progress');
  const current = `현재 ${version || ''}`.trim();
  if (!update || update.mode === 'development') {
    element('update-message').textContent = `${current} · 개발 실행에서는 업데이트를 확인하지 않아요.`;
    button.hidden = true; bar.hidden = true; return;
  }
  const phase = update.phase;
  element('update-message').textContent = `${current} · ${update.message || '업데이트를 확인할 수 있어요.'}`;
  bar.hidden = phase !== 'downloading';
  element('update-progress-bar').style.width = `${Math.max(4, Math.min(100, update.progress || 0))}%`;
  button.hidden = phase === 'downloading' || phase === 'checking';
  button.dataset.action = phase === 'ready' ? 'install' : phase === 'available' ? 'page' : 'check';
  button.textContent = phase === 'ready' ? '재시작하여 설치' : phase === 'available' ? '내려받기' : '업데이트 확인';
  button.className = phase === 'ready' || phase === 'available' ? 'primary small' : 'secondary small';
}
element('update-action').addEventListener('click', async () => {
  const action = element('update-action').dataset.action;
  try {
    if (action === 'install') {
      status('앱을 닫고 새 버전을 설치해요. 잠시 뒤 자동으로 다시 열려요.', 'opening', true);
      await invoke('updateInstall');
    } else if (action === 'page') await invoke('updateOpenPage');
    else await invoke('updateCheck');
  } catch (error) { report(error); }
});

const EDGE_NAMES = { top: '위', right: '오른쪽', bottom: '아래', left: '왼쪽' };
// Monitors are drawn in their real arrangement, so "the left screen" is simply the one on the left.
function renderMonitorMap(next) {
  const map = element('monitor-map');
  const displays = Array.isArray(next.displays) ? next.displays : [];
  element('placement-caption').textContent = next.placementLabel ? `지금 위치: ${next.placementLabel}` : '';
  if (!displays.length) { map.replaceChildren(); map.hidden = true; return; }
  map.hidden = false;
  const placement = next.settings.placement || {};
  const current = displays.some((display) => display.id === String(placement.monitorId)) ? String(placement.monitorId) : (displays.find((display) => display.primary) || displays[0]).id;
  const left = Math.min(...displays.map((display) => display.bounds.x));
  const top = Math.min(...displays.map((display) => display.bounds.y));
  const width = Math.max(...displays.map((display) => display.bounds.x + display.bounds.width)) - left;
  const height = Math.max(...displays.map((display) => display.bounds.y + display.bounds.height)) - top;
  map.style.aspectRatio = `${width} / ${height}`;
  map.style.width = `min(100%, ${Math.round((190 * width) / height)}px)`;
  map.replaceChildren(...displays.map((display) => {
    const screen = document.createElement('div');
    screen.className = 'map-screen';
    screen.dataset.current = String(display.id === current);
    screen.style.left = `calc(${((display.bounds.x - left) / width) * 100}% + 4px)`;
    screen.style.top = `calc(${((display.bounds.y - top) / height) * 100}% + 4px)`;
    screen.style.width = `calc(${(display.bounds.width / width) * 100}% - 8px)`;
    screen.style.height = `calc(${(display.bounds.height / height) * 100}% - 8px)`;
    const name = document.createElement('span');
    name.className = 'map-name';
    name.textContent = displays.length > 1 ? (display.name || display.label) : '이 모니터';
    if (displays.length > 1 && display.detail) {
      const detail = document.createElement('small');
      detail.textContent = display.detail;
      name.append(detail);
    }
    screen.append(name);
    for (const edge of ['top', 'right', 'bottom', 'left']) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'map-edge';
      button.dataset.edge = edge;
      const selected = display.id === current && placement.edge === edge;
      button.setAttribute('aria-pressed', String(selected));
      button.setAttribute('aria-label', `${displays.length > 1 ? display.label : '모니터'} ${EDGE_NAMES[edge]} 가장자리`);
      button.title = `${EDGE_NAMES[edge]} 가장자리에 붙이기`;
      button.addEventListener('click', () => moveWidget(display.id, edge));
      screen.append(button);
    }
    return screen;
  }));
}
async function moveWidget(monitorId, edge) {
  try {
    renderState(await invoke('notchMove', { monitorId, edge }));
    status(`위젯을 ${state.placementLabel || '선택한 자리'}로 옮겼어요.`, 'success');
  } catch (error) { report(error); }
}
element('placement-scale').addEventListener('input', event => { element('placement-scale-value').textContent = `${event.target.value}%`; });
element('placement-scale').addEventListener('change', event => updateSettings({ placement: { scale: Number(event.target.value) / 100 } }));
all('button[data-display-mode]').forEach((button) => button.addEventListener('click', () => updateSettings({ displayMode: button.dataset.displayMode })));
element('cancel-auth').addEventListener('click', async () => {
  try {
    const result = await invoke('cancelAuth');
    status(result.message || '로그인 대기를 취소했습니다.', result.ok ? 'cancelled' : 'idle');
  } catch (error) { report(error); }
});
element('retry-auth').addEventListener('click', async () => {
  if (busy) return;
  status('원래 업무를 다시 시작하고 있어요.', 'opening', true);
  try {
    const result = await invoke('retryAuth');
    status(result.message || (result.ok ? '업무 화면을 열었어요.' : '다시 시도하지 못했어요.'), result.phase || (result.ok ? 'success' : 'error'));
  } catch (error) { report(error); }
});

element('draft-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const button = element('generate-button');
  const input = Object.fromEntries(new FormData(event.target).entries());
  button.disabled = true;
  button.textContent = '초안을 정리하고 있어요…';
  try {
    const result = await invoke('generateDraft', input);
    generatedKind = activeKind;
    element('result-title').value = result.title || input.title;
    element('result-body').value = result.body || '';
    element('draft-empty').hidden = true;
    element('draft-output').hidden = false;
    element('fill-draft').hidden = generatedKind !== 'official';
    const warnings = Array.isArray(result.warnings) ? result.warnings.filter(Boolean).join('\n') : '';
    element('draft-warnings').textContent = warnings;
    element('draft-warnings').hidden = !warnings;
    status('초안이 준비되었어요. 내용을 확인하고 다듬어주세요.', 'success');
    element('draft-result').scrollIntoView({ behavior: 'instant', block: 'start' });
    element('result-body').focus({ preventScroll: true });
  } catch (error) { report(error); }
  finally { button.disabled = false; button.textContent = '초안 다시 생성'; }
});

function draftContents() { return { title: element('result-title').value.trim(), body: element('result-body').value }; }
element('copy-draft').addEventListener('click', async () => {
  try {
    const draft = draftContents();
    await invoke('copy', `${draft.title}\n\n${draft.body}`);
    status('초안을 클립보드에 복사했어요.', 'success');
  } catch (error) { report(error); }
});
element('save-draft').addEventListener('click', async () => {
  try {
    const result = await invoke('saveDraft', draftContents());
    if (result) status(result.message || (result.ok ? '초안을 파일로 저장했어요.' : '저장을 취소했어요.'), result.ok ? 'success' : 'idle');
  } catch (error) { report(error); }
});
element('open-draft-menu').addEventListener('click', () => openMenu({ official: 'draft', trip: 'trip', attendance: 'attendance' }[generatedKind]));
// Only 일반기안 has a form to write into; 출장·근무상황 are filled on their own screens.
element('fill-draft').addEventListener('click', async () => {
  const button = element('fill-draft');
  const draft = draftContents();
  if (!draft.title || !draft.body.trim()) { status('제목과 내용을 채운 뒤 눌러주세요.', 'idle'); return; }
  button.disabled = true;
  try {
    const result = await invoke('openMenu', { id: 'draft', draft });
    if (result) status(result.message || '기안문을 열었어요.', result.ok ? 'success' : 'idle');
  } catch (error) { report(error); }
  finally { button.disabled = false; }
});
// Each check becomes one sentence a teacher can act on; raw field names never reach the screen.
function diagnosticLines(result) {
  const lines = [];
  lines.push(result.edgeInstalled
    ? { tone: 'ok', title: 'Microsoft Edge가 설치되어 있어요.', detail: '업무 화면은 평소 쓰는 Edge에서 열립니다.' }
    : { tone: 'warn', title: 'Microsoft Edge를 찾지 못했어요.', detail: 'Edge를 설치하거나 업데이트한 뒤 다시 확인해주세요.' });
  lines.push(result.helperInstalled
    ? { tone: 'ok', title: '인증서 프로그램(KCase)이 설치되어 있어요.', detail: '업무포털 인증서 로그인을 쓸 수 있습니다.' }
    : { tone: 'warn', title: '인증서 프로그램(KCase)을 찾지 못했어요.', detail: '업무포털 로그인 화면의 안내에 따라 보안 프로그램을 설치해주세요.' });
  if (result.passwordStored) lines.push({ tone: 'ok', title: '인증서 비밀번호가 저장되어 있어요.', detail: '로그인할 때 자동으로 입력합니다.' });
  else if (result.passwordStorageAvailable === false) lines.push({ tone: 'warn', title: '이 컴퓨터에서는 비밀번호를 저장할 수 없어요.', detail: '인증서 창에서 직접 입력해주세요.' });
  else lines.push({ tone: 'info', title: '저장된 인증서 비밀번호가 없어요.', detail: '위의 "인증서 비밀번호 저장"에서 저장하면 자동으로 입력합니다.' });
  lines.push(result.autoLogin
    ? { tone: 'ok', title: '앱을 켤 때 자동으로 로그인해요.', detail: '' }
    : { tone: 'info', title: '앱을 켤 때 자동 로그인은 꺼져 있어요.', detail: '업무 버튼을 누르면 그때 로그인합니다.' });
  if (result.authenticationPending) lines.push({ tone: 'info', title: '지금 로그인을 진행하고 있어요.', detail: '인증서 창이 떠 있으면 확인해주세요.' });
  if (result.retryAvailable) lines.push({ tone: 'warn', title: '마치지 못한 업무가 있어요.', detail: '아래쪽 "다시 시도"를 누르면 이어서 엽니다.' });
  if (result.lastStatus?.message) lines.push({ tone: 'info', title: `최근 상태: ${result.lastStatus.label || '업무 상태'}`, detail: result.lastStatus.message });
  return lines;
}
function renderDiagnostics(result) {
  const list = element('diagnostics-output');
  list.replaceChildren(...diagnosticLines(result || {}).map((line) => {
    const item = document.createElement('li');
    item.dataset.tone = line.tone;
    const mark = document.createElement('span');
    mark.className = 'mark';
    mark.setAttribute('aria-hidden', 'true');
    mark.textContent = line.tone === 'ok' ? '✓' : line.tone === 'warn' ? '!' : 'i';
    const text = document.createElement('span');
    const title = document.createElement('strong');
    title.textContent = line.title;
    text.append(title);
    if (line.detail) {
      const detail = document.createElement('small');
      detail.textContent = line.detail;
      text.append(detail);
    }
    item.append(mark, text);
    return item;
  }));
  list.hidden = false;
}
element('diagnostics-button').addEventListener('click', async () => {
  try {
    renderDiagnostics(await invoke('getDiagnostics'));
  } catch (error) { report(error); }
});

const resizeHandle = document.querySelector('.resize-handle');
resizeHandle.addEventListener('pointerdown', (event) => {
  if (!api?.resize) return;
  resizePoint = { x: event.screenX, y: event.screenY };
  resizeHandle.setPointerCapture(event.pointerId);
});
resizeHandle.addEventListener('pointermove', (event) => {
  if (!resizePoint) return;
  const delta = { dx: event.screenX - resizePoint.x, dy: event.screenY - resizePoint.y };
  resizePoint = { x: event.screenX, y: event.screenY };
  if (delta.dx || delta.dy) Promise.resolve(api.resize(delta)).catch(report);
});
resizeHandle.addEventListener('pointerup', () => { resizePoint = null; });
resizeHandle.addEventListener('lostpointercapture', () => { resizePoint = null; });
resizeHandle.addEventListener('keydown', (event) => {
  const sizes = { ArrowRight: [20, 0], ArrowLeft: [-20, 0], ArrowDown: [0, 20], ArrowUp: [0, -20] };
  if (!sizes[event.key] || !api?.resize) return;
  event.preventDefault();
  const [dx, dy] = sizes[event.key];
  Promise.resolve(api.resize({ dx, dy })).catch(report);
});
document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && isAuxiliary) invoke('window', 'close').catch(report);
  else if (event.key === 'Escape' && activeView !== 'home') showView('home');
});

async function initialize() {
  const today = new Date();
  element('today').textContent = new Intl.DateTimeFormat('ko-KR', { month: 'long', day: 'numeric', weekday: 'long' }).format(today);
  selectKind('official');
  if (params.has('showcase')) showView('showcase');
  else if (isAuxiliary) showView(params.get('view') === 'settings' ? 'settings' : 'draft');
  if (!api) { status('화면 미리보기 · 실제 업무는 설치한 앱에서 실행해주세요.'); renderState(state); return; }
  try {
    renderState(await invoke('getState'));
    if (typeof api.onState === 'function') api.onState(renderState);
    if (typeof api.onStatus === 'function') api.onStatus((update) => status(update.message, update.phase, Boolean(update.busy)));
    if (isAuxiliary && typeof api.onAuxView === 'function') api.onAuxView(showView);
  } catch (error) { report(error); }
}
initialize();
