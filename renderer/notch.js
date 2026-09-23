'use strict';

const api = window.portal;
const all = selector => [...document.querySelectorAll(selector)];
let busy = false;
let currentStatus = { phase: 'idle', message: '업무를 선택하면 Edge에서 이어집니다.', busy: false };

function applyButtonOrder(settings) {
  if (!Array.isArray(settings?.buttons)) return;
  const actions = document.querySelector('.actions');
  const buttons = new Map(all('.actions [data-button]').map(button => [button.dataset.button, button]));
  const settingsButton = actions.querySelector('[data-auxiliary="settings"]');
  for (const id of settings.buttons) {
    const button = buttons.get(id);
    if (button) actions.insertBefore(button, settingsButton);
  }
}

function setBusy(next) {
  busy = next;
  document.body.dataset.busy = String(next);
  // Buttons stay clickable on purpose. Closing Edge, or the portal opening extra windows,
  // used to leave every work button dead until the five minute timeout; a second press now
  // replaces the running task instead.
}

function showStatus(update = {}) {
  currentStatus = { ...currentStatus, ...update };
  document.getElementById('live-status').textContent = currentStatus.message || '업무 상태가 변경되었습니다.';
  document.body.dataset.phase = currentStatus.phase || 'idle';
  setBusy(Boolean(currentStatus.busy));
}

// `canvas` carries the window-level facts (edge, size, interaction); `frame` the shape drawn
// inside it. A settled payload is both at once; an animation shares one canvas across frames.
function applyMetrics(canvas, frame) {
  const svg = document.getElementById('shape');
  svg.setAttribute('viewBox', `0 0 ${canvas.width} ${canvas.height}`);
  document.getElementById('shape-path').setAttribute('d', frame.path);
  document.getElementById('shape-transform').setAttribute('transform', frame.transform);
  document.getElementById('shape-offset').setAttribute('transform', `translate(${frame.offset?.x || 0} ${frame.offset?.y || 0})`);
  const scale = frame.depth / 56;
  const root = document.documentElement.style;
  root.setProperty('--notch-depth', `${frame.depth}px`);
  root.setProperty('--notch-curl', `${frame.curl}px`);
  root.setProperty('--notch-body-length', `${frame.length - 2 * frame.curl}px`);
  root.setProperty('--action-size', `${40 * scale}px`);
  root.setProperty('--action-gap', `${4 * scale}px`);
  root.setProperty('--body-inset', `${8 * scale}px`);
  root.setProperty('--action-radius', `${12 * scale}px`);
  root.setProperty('--icon-size', `${20 * scale}px`);
  root.setProperty('--status-inset', `${4 * scale}px`);
  root.setProperty('--status-along', `${24 * scale}px`);
  root.setProperty('--handle-along', `${128 * scale}px`);
  root.setProperty('--handle-rail', `${8 * scale}px`);
  root.setProperty('--shape-offset-x', `${frame.offset?.x || 0}px`);
  root.setProperty('--shape-offset-y', `${frame.offset?.y || 0}px`);
  document.body.dataset.edge = canvas.edge;
  document.body.dataset.state = frame.state;
  document.body.dataset.pinned = String(Boolean(canvas.interaction?.pinned));
  document.body.dataset.placing = String(Boolean(canvas.interaction?.placing));
  if (frame.state === 'collapsed' && document.activeElement?.matches('button')) document.activeElement.blur();
}

let playback = null;
function stopPlayback() {
  if (!playback) return;
  cancelAnimationFrame(playback.handle);
  playback = null;
}

function applyShape(shape) {
  if (!shape) return;
  stopPlayback();
  applyMetrics(shape, shape);
}

// The main process sends every keyframe of a fold at once; they are shown on the
// compositor's own clock, choosing by elapsed time so a slow frame skips ahead instead of
// stretching the animation.
function playAnimation(plan) {
  if (!plan || !Array.isArray(plan.frames) || plan.frames.length === 0) return;
  stopPlayback();
  const frames = plan.frames;
  const last = frames.length - 1;
  const started = performance.now();
  let index = 0;
  applyMetrics(plan, frames[0]);
  const session = { handle: 0 };
  const step = now => {
    if (playback !== session) return;
    const elapsed = now - started;
    let next = index;
    while (next < last && frames[next + 1].at <= elapsed) next += 1;
    if (next !== index) {
      index = next;
      applyMetrics(plan, frames[index]);
    }
    if (index < last) session.handle = requestAnimationFrame(step);
    else playback = null;
  };
  playback = session;
  session.handle = requestAnimationFrame(step);
}

let lastMenuPressAt = 0;
async function runMenu(id) {
  // Only an accidental double-fire is swallowed; a deliberate second press takes over.
  const now = Date.now();
  if (now - lastMenuPressAt < 1200) return;
  lastMenuPressAt = now;
  setBusy(true);
  try {
    await api.openMenu(id);
  } catch (error) {
    showStatus({ phase: 'error', message: error instanceof Error ? error.message : '업무 화면을 열지 못했습니다.' });
  } finally {
    if (!document.body.matches('[data-busy="true"][data-phase="opening"]')) setBusy(false);
  }
}

function anchorFor(element) {
  const rect = element.getBoundingClientRect();
  return { x: window.screenX + rect.x, y: window.screenY + rect.y, width: rect.width, height: rect.height };
}

function showTooltip(button) {
  if (document.body.dataset.state === 'collapsed') return;
  api.showPopover({ kind: 'tooltip', label: button.getAttribute('aria-label'), anchor: anchorFor(button) }).catch(() => {});
}

all('.actions button').forEach(button => {
  button.addEventListener('pointerenter', () => showTooltip(button));
  button.addEventListener('pointerleave', () => api.hidePopover({ delay: 250 }).catch(() => {}));
  button.addEventListener('focus', () => showTooltip(button));
  button.addEventListener('blur', () => api.hidePopover({ delay: 250 }).catch(() => {}));
});

all('[data-menu]').forEach(button => button.addEventListener('click', event => { event.stopPropagation(); runMenu(button.dataset.menu); }));
all('[data-auxiliary]').forEach(button => button.addEventListener('click', event => { event.stopPropagation(); api.openAuxiliary(button.dataset.auxiliary).catch(() => {}); }));

let placementGesture = null;
const screenPoint = event => ({ x: event.screenX, y: event.screenY });
function queuePlacementMove(gesture, point) {
  gesture.latest = point;
  if (!gesture.drain) {
    gesture.drain = (async () => {
      const began = await gesture.beginPromise;
      if (!began?.ok) return;
      while (placementGesture === gesture && gesture.latest) {
        const latest = gesture.latest;
        gesture.latest = null;
        await api.notchPlacement({ type: 'move', point: latest });
      }
    })().finally(() => { gesture.drain = null; });
  }
  return gesture.drain;
}
async function cancelPlacement() {
  const gesture = placementGesture;
  if (!gesture) return false;
  placementGesture = null;
  gesture.latest = null;
  const began = await gesture.beginPromise.catch(() => null);
  await gesture.drain?.catch(() => {});
  if (began?.ok) await api.notchPlacement({ type: 'cancel' });
  return true;
}
const HANDLE_TIPS = { move: '끌어서 위치 옮기기', resize: '끌어서 크기 조절' };
all('.placement-handle').forEach(handle => {
  handle.addEventListener('pointerenter', () => {
    if (placementGesture || document.body.dataset.state === 'collapsed') return;
    api.showPopover({ kind: 'tooltip', label: HANDLE_TIPS[handle.dataset.placementMode], anchor: anchorFor(handle) }).catch(() => {});
  });
  handle.addEventListener('pointerleave', () => { if (!placementGesture) api.hidePopover({ delay: 250 }).catch(() => {}); });
  handle.addEventListener('pointerdown', event => {
    api.hidePopover().catch(() => {});
    if (placementGesture || event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    const gesture = { pointerId: event.pointerId, handle, latest: null, drain: null, ending: false };
    placementGesture = gesture;
    try { handle.setPointerCapture(event.pointerId); } catch { placementGesture = null; return; }
    gesture.beginPromise = api.notchPlacement({ type: 'begin', mode: handle.dataset.placementMode, point: screenPoint(event) });
    gesture.beginPromise.then(result => {
      if (result?.ok || placementGesture !== gesture) return;
      placementGesture = null;
      if (handle.hasPointerCapture(event.pointerId)) handle.releasePointerCapture(event.pointerId);
    }).catch(() => { if (placementGesture === gesture) placementGesture = null; });
  });
  handle.addEventListener('pointermove', event => {
    if (!placementGesture || placementGesture.pointerId !== event.pointerId) return;
    void queuePlacementMove(placementGesture, screenPoint(event));
  });
  handle.addEventListener('pointerup', async event => {
    const gesture = placementGesture;
    if (!gesture || gesture.pointerId !== event.pointerId) return;
    gesture.ending = true;
    await queuePlacementMove(gesture, screenPoint(event));
    const began = await gesture.beginPromise;
    if (placementGesture !== gesture) return;
    placementGesture = null;
    if (began?.ok) await api.notchPlacement({ type: 'end' });
  });
  handle.addEventListener('lostpointercapture', () => { if (!placementGesture?.ending) void cancelPlacement(); });
  handle.addEventListener('keydown', event => {
    if (!['ArrowUp', 'ArrowRight', 'ArrowDown', 'ArrowLeft', '+', '-'].includes(event.key)) return;
    event.preventDefault();
    api.notchPlacement({ type: 'keyboard', mode: handle.dataset.placementMode, key: event.key }).catch(() => {});
  });
});

const statusButton = document.getElementById('status-button');
statusButton.addEventListener('pointerenter', () => showTooltip(statusButton));
statusButton.addEventListener('pointerleave', () => api.hidePopover({ delay: 250 }).catch(() => {}));
statusButton.addEventListener('click', event => {
  event.stopPropagation();
  api.showPopover({ kind: 'status', label: '현재 작업 상태', anchor: anchorFor(statusButton), focus: true, status: currentStatus }).catch(() => {});
});

document.body.addEventListener('pointerenter', () => api.notchInteraction({ type: 'pointer', value: true }));
document.body.addEventListener('pointerleave', () => api.notchInteraction({ type: 'pointer', value: false }));
document.addEventListener('focusin', () => api.notchInteraction({ type: 'focus', value: true }));
document.addEventListener('focusout', () => setTimeout(() => {
  if (!document.hasFocus() || !document.activeElement?.matches('button')) api.notchInteraction({ type: 'focus', value: false });
}, 0));
window.addEventListener('blur', () => api.notchInteraction({ type: 'focus', value: false }));
document.body.addEventListener('click', event => { if (event.target === document.body) api.notchInteraction({ type: 'pin' }); });
document.body.addEventListener('contextmenu', event => { event.preventDefault(); api.notchContextMenu().catch(() => {}); });

document.addEventListener('keydown', event => {
  const buttons = all('.actions button:not(:disabled),#status-button');
  const index = buttons.indexOf(document.activeElement);
  if (event.key === 'Escape') {
    event.preventDefault();
    cancelPlacement().then(cancelled => cancelled ? api.hidePopover() : api.notchInteraction({ type: 'escape' }).then(() => api.hidePopover()));
    return;
  }
  if (!['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(event.key) || index < 0) return;
  event.preventDefault();
  const delta = event.key === 'ArrowUp' || event.key === 'ArrowLeft' ? -1 : 1;
  buttons[(index + delta + buttons.length) % buttons.length].focus();
});
window.addEventListener('blur', () => { void cancelPlacement(); });

if (api?.onNotchShape) api.onNotchShape(applyShape);
if (api?.onNotchAnimate) api.onNotchAnimate(playAnimation);
if (api?.onStatus) api.onStatus(showStatus);
api?.getState().then(state => {
  applyButtonOrder(state.settings);
  showStatus(state.operation || { busy: Boolean(state.authenticationPending) });
}).catch(() => {});
if (api?.onState) api.onState(state => {
  applyButtonOrder(state.settings);
  showStatus(state.operation || { busy: Boolean(state.authenticationPending) });
});
if (api?.onNotchFocusFirst) api.onNotchFocusFirst(() => all('.actions button:not(:disabled)')[0]?.focus({ preventScroll: true }));
if (api?.onGuideStep) api.onGuideStep(step => {
  if (!step) return;
  const target = step.anchorButton
    ? document.querySelector(`.actions [data-button="${step.anchorButton}"]`) || document.querySelector(`.actions [data-auxiliary="${step.anchorButton}"]`)
    : null;
  // The password step belongs to no single button, so it hangs off the status indicator.
  const anchorElement = target || document.getElementById('status-button');
  if (!anchorElement) return;
  api.showPopover({ kind: 'guide', label: step.title, anchor: anchorFor(anchorElement), focus: true }).catch(() => {});
});
const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)');
const reportReducedMotion = () => api?.notchInteraction({ type: 'reduced-motion', value: reducedMotion.matches }).catch(() => {});
reportReducedMotion();
reducedMotion.addEventListener('change', reportReducedMotion);
