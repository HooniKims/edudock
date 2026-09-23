'use strict';
const api = window.portal;
const element = id => document.getElementById(id);
const all = selector => [...document.querySelectorAll(selector)];
let currentData = { kind: 'tooltip', edge: 'right', label: '', status: null, guide: null };

function passwordsReady() {
  const first = element('pw-first').value;
  const second = element('pw-second').value;
  if (!first) return { ok: false, hint: '' };
  if (!second) return { ok: false, hint: '한 번 더 입력해 주세요.' };
  if (first !== second) return { ok: false, hint: '두 번 입력한 비밀번호가 달라요.' };
  return { ok: true, hint: '확인됐어요.', password: first };
}

function refreshPasswordState() {
  const step = currentData.guide;
  if (step?.kind !== 'password-offer') return;
  const result = passwordsReady();
  element('pw-hint').textContent = result.hint;
  element('pw-hint').dataset.tone = result.ok ? 'ok' : (result.hint ? 'warn' : '');
  element('guide-next').disabled = !result.ok;
  element('guide-next').textContent = '저장하고 시작';
}

function render(data) {
  currentData = { ...currentData, ...data };
  data = currentData;
  document.body.dataset.kind = data.kind;
  document.body.dataset.edge = data.edge;
  element('label').textContent = data.label;
  element('status').hidden = data.kind !== 'status';
  element('guide').hidden = data.kind !== 'guide';
  if (data.kind === 'status') {
    const status = data.status || {};
    element('phase').textContent = status.label || '업무 상태';
    element('message').textContent = status.message || '현재 진행 중인 작업이 없습니다.';
    element('cancel').hidden = !status.busy;
    element('retry').hidden = status.phase !== 'needs-user';
    if (status.busy) element('cancel').focus({ preventScroll: true });
  }
  if (data.kind === 'guide') {
    const step = data.guide || {};
    const offering = step.kind === 'password-offer';
    element('guide-body').textContent = step.body || '';
    element('guide-password').hidden = !offering;
    element('guide-progress').textContent = Number.isFinite(step.index) && Number.isFinite(step.total) ? `${step.index + 1} / ${step.total}` : '';
    element('guide-skip').textContent = offering ? '나중에' : '건너뛰기';
    element('guide-next').textContent = offering ? '저장하고 시작' : (step.last ? '완료' : '다음');
    element('guide-next').disabled = false;
    if (offering) {
      element('pw-first').value = '';
      element('pw-second').value = '';
      element('pw-hint').textContent = '';
      element('pw-hint').dataset.tone = '';
      refreshPasswordState();
      element('pw-first').focus({ preventScroll: true });
    } else element('guide-next').focus({ preventScroll: true });
  }
}

api.onPopoverData(render);
api.onStatus(status => { if (currentData.kind === 'status') render({ status }); });
api.onState(state => { if (currentData.kind === 'status' && state.operation) render({ status: state.operation }); });
if (api.onGuideStep) api.onGuideStep(step => { if (step) render({ kind: 'guide', label: step.title, guide: step }); });

document.body.addEventListener('pointerenter', () => api.notchInteraction({ type: 'popup', value: true }));
document.body.addEventListener('pointerleave', () => {
  if (document.hasFocus() || currentData.kind === 'guide') return;
  api.notchInteraction({ type: 'popup', value: false });
  api.hidePopover({ delay: 250 });
});
window.addEventListener('focus', () => api.notchInteraction({ type: 'popup', value: true }));
window.addEventListener('blur', () => api.notchInteraction({ type: 'popup', value: false }));
element('cancel').addEventListener('click', async () => { await api.cancelAuth(); await api.hidePopover(); });
element('retry').addEventListener('click', async () => { await api.retryAuth(); await api.hidePopover(); });

all('.pw-eye').forEach(button => button.addEventListener('click', () => {
  const field = element(button.dataset.for);
  const reveal = field.type === 'password';
  field.type = reveal ? 'text' : 'password';
  button.setAttribute('aria-pressed', String(reveal));
  button.setAttribute('aria-label', reveal ? '비밀번호 숨기기' : '비밀번호 보기');
  field.focus({ preventScroll: true });
}));
['pw-first', 'pw-second'].forEach(id => element(id).addEventListener('input', refreshPasswordState));
element('guide-password').addEventListener('submit', event => event.preventDefault());

element('guide-skip').addEventListener('click', async () => {
  try { await api.guideSkip(); } catch {}
  await api.hidePopover();
});
element('guide-next').addEventListener('click', async () => {
  const step = currentData.guide;
  if (step?.kind === 'password-offer') {
    const result = passwordsReady();
    if (!result.ok) { refreshPasswordState(); return; }
    try {
      await api.guideSavePassword(result.password);
    } catch (error) {
      element('pw-hint').dataset.tone = 'warn';
      element('pw-hint').textContent = error instanceof Error ? error.message : '비밀번호를 저장하지 못했어요.';
      return;
    } finally {
      element('pw-first').value = '';
      element('pw-second').value = '';
    }
    await api.hidePopover();
    return;
  }
  try { await api.guideNext(); } catch {}
});
document.addEventListener('keydown', event => {
  if (event.key !== 'Escape') return;
  if (currentData.kind === 'guide') { api.guideSkip().catch(() => {}).then(() => api.hidePopover()); return; }
  api.notchInteraction({ type: 'escape' }).then(() => api.hidePopover());
});
