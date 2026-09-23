const path = require('node:path');
const { getNotchShape, placeNotch, pointInNotch } = require('./notch-geometry.cjs');
const { createInteractionController, TRANSITION_MS } = require('./notch-interaction.cjs');
const { createPlacementSession, recoverPlacement } = require('./notch-placement.cjs');

const NATIVE_MINIMUM = 64;
const FRAME_MS = 1000 / 60;

function easeTransition(elapsed) {
  const t = Math.max(0, Math.min(1, elapsed));
  return Math.max(0, Math.min(1, 1 - Math.pow(1 - t, 3) + Math.sin(t * Math.PI * 2) * (1 - t) * 0.045));
}

function unionBounds(a, b) {
  const x = Math.min(a.x, b.x);
  const y = Math.min(a.y, b.y);
  return { x, y, width: Math.max(a.x + a.width, b.x + b.width) - x, height: Math.max(a.y + a.height, b.y + b.height) - y };
}

// A transition used to resize the native window and replace its region on every tick, which
// is what made the notch stutter: each SetWindowPos/SetWindowRgn on a transparent window
// forces a full re-composite and the renderer had to re-layout at a new size 16 times per
// fold. The plan below fixes the window once at the union of both end states and hands the
// renderer every in-between shape up front, so the animation runs on the compositor's clock.
function buildTransitionPlan({ placement, workArea, from, to, durationMs, frameMs = FRAME_MS, minimum = NATIVE_MINIMUM }) {
  const geometryAt = progress => {
    const shape = getNotchShape({ edge: placement.edge, progress, scale: placement.scale, rects: false });
    const fitted = fitShapeToCanvas(shape, minimum);
    const bounds = placeNotch(workArea, { edge: shape.edge, ...fitted.canvas }, placement.offsets[shape.edge]);
    return { shape, fitted, bounds };
  };
  const start = geometryAt(from);
  const end = geometryAt(to);
  const canvas = unionBounds(start.bounds, end.bounds);
  const count = Math.max(2, Math.ceil(durationMs / frameMs) + 1);
  const frames = [];
  for (let index = 0; index < count; index += 1) {
    const t = index / (count - 1);
    const geometry = index === 0 ? start : index === count - 1 ? end : geometryAt(from + (to - from) * easeTransition(t));
    const { shape, fitted, bounds } = geometry;
    frames.push({
      at: Math.round(t * durationMs),
      state: shape.state,
      progress: shape.progress,
      depth: shape.depth,
      length: shape.length,
      curl: shape.curl,
      corner: shape.corner,
      path: shape.path,
      transform: shape.transform,
      offset: { x: bounds.x - canvas.x + fitted.offset.x, y: bounds.y - canvas.y + fitted.offset.y },
    });
  }
  return { edge: placement.edge, canvas, durationMs, frames };
}

function fitShapeToCanvas(shape, minimum = NATIVE_MINIMUM) {
  const horizontal = shape.edge === 'top' || shape.edge === 'bottom';
  const canvas = horizontal
    ? { width: shape.width, height: Math.max(minimum, shape.height) }
    : { width: Math.max(minimum, shape.width), height: shape.height };
  const offset = {
    x: shape.edge === 'right' ? canvas.width - shape.width : 0,
    y: shape.edge === 'bottom' ? canvas.height - shape.height : 0,
  };
  return {
    canvas,
    offset,
    rects: shape.rects.map(rect => ({ ...rect, x: rect.x + offset.x, y: rect.y + offset.y })),
  };
}

function isInteractivePoint(shape, bounds, point, offset = { x: 0, y: 0 }) {
  const x = point.x - bounds.x - offset.x;
  const y = point.y - bounds.y - offset.y;
  return x >= 0 && y >= 0 && x < shape.width && y < shape.height && pointInNotch(shape, x, y);
}

function shouldUseMouseFallback(platform, hasNativeShape) {
  return platform !== 'win32' || !hasNativeShape;
}

// A notch that sits over the user's work should be dimmable, but never to the point where it
// disappears and cannot be clicked, so the value is clamped before it reaches the window.
function applyOpacity(window, opacity) {
  if (typeof window?.setOpacity !== 'function') return null;
  const value = Number.isFinite(opacity) ? Math.max(0.3, Math.min(1, opacity)) : 1;
  window.setOpacity(value);
  return value;
}

function displayForPlacement(screen, placement) {
  const displays = screen.getAllDisplays();
  const selected = displays.find(display => String(display.id) === placement.monitorId);
  return selected || screen.getPrimaryDisplay();
}

function createNotchWindow({ BrowserWindow, screen, powerMonitor, settings, preload, onWindow, onInteraction, onPlacementCommit, onPlacementPreview }) {
  let currentSettings = settings;
  let progress = settings.displayMode === 'expanded' ? 1 : 0;
  let currentShape = getNotchShape({ edge: settings.placement.edge, progress, scale: settings.placement.scale });
  let fitted = fitShapeToCanvas(currentShape);
  let displayListeners = [];
  let ignoreMouse = null;
  let hitTimer;
  let wakeTimer;
  let animationTimer;
  let animationToken = 0;
  let animation = null;
  let placementSession = null;
  let placementPreviewing = false;

  const window = new BrowserWindow({
    width: fitted.canvas.width,
    height: fitted.canvas.height,
    frame: false,
    transparent: true,
    resizable: false,
    maximizable: false,
    minimizable: false,
    show: false,
    skipTaskbar: true,
    alwaysOnTop: settings.alwaysOnTop,
    backgroundColor: '#00000000',
    hasShadow: false,
    webPreferences: {
      preload,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  onWindow(window, 'notch');
  const mouseFallback = shouldUseMouseFallback(process.platform, typeof window.setShape === 'function');
  window.setMenu(null);
  window.setAlwaysOnTop(settings.alwaysOnTop, 'floating');
  applyOpacity(window, settings.opacity);

  const interaction = createInteractionController({
    displayMode: settings.displayMode,
    onChange: next => {
      animateTo(next.visualState === 'expanded' ? 1 : 0, next.transitionMs);
      onInteraction?.(next);
    },
  });

  function payload() {
    return {
      edge: currentShape.edge,
      state: currentShape.state,
      width: fitted.canvas.width,
      height: fitted.canvas.height,
      depth: currentShape.depth,
      length: currentShape.length,
      curl: currentShape.curl,
      corner: currentShape.corner,
      path: currentShape.path,
      transform: currentShape.transform,
      offset: fitted.offset,
      progress: currentShape.progress,
      interaction: interaction.state(),
      placement: currentSettings.placement,
    };
  }

  function appliedGeometry(nextProgress = progress) {
    const placement = currentSettings.placement;
    currentShape = getNotchShape({ edge: placement.edge, progress: nextProgress, scale: placement.scale });
    fitted = fitShapeToCanvas(currentShape);
    const display = displayForPlacement(screen, placement);
    const bounds = placeNotch(display.workArea, { edge: currentShape.edge, ...fitted.canvas }, placement.offsets[currentShape.edge]);
    return { display, bounds, shape: currentShape };
  }

  // The progress the user currently sees: while a transition plays, that is a point along
  // its easing curve rather than the settled value a new transition must not jump from.
  function visualProgress() {
    if (!animation) return progress;
    const elapsed = Math.min(1, (Date.now() - animation.startedAt) / animation.durationMs);
    return animation.from + (animation.to - animation.from) * easeTransition(elapsed);
  }

  function settleAnimation() {
    clearTimeout(animationTimer);
    animationTimer = null;
    animation = null;
    animationToken += 1;
  }

  // A settled shape: the window takes exactly the shape's bounds and region. Any transition
  // still playing is abandoned, because the renderer treats this payload as final.
  function renderProgress(nextProgress) {
    if (window.isDestroyed()) return null;
    settleAnimation();
    progress = Math.max(0, Math.min(1, nextProgress));
    const applied = appliedGeometry(progress);
    window.setBounds(applied.bounds, false);
    if (!mouseFallback) window.setShape(fitted.rects);
    if (!window.webContents.isLoadingMainFrame()) window.webContents.send('notch-shape', payload());
    return applied;
  }

  function animateTo(target, duration = TRANSITION_MS) {
    const start = visualProgress();
    const distance = Math.abs(target - start);
    if (!duration || distance < 0.001 || window.isDestroyed()) {
      renderProgress(target);
      return;
    }
    settleAnimation();
    const token = animationToken;
    const placement = currentSettings.placement;
    const display = displayForPlacement(screen, placement);
    const plan = buildTransitionPlan({ placement, workArea: display.workArea, from: start, to: target, durationMs: Math.max(80, duration * distance) });
    animation = { from: start, to: target, startedAt: Date.now(), durationMs: plan.durationMs };
    progress = target;
    // One native resize and one region for the whole transition; the renderer animates inside.
    window.setBounds(plan.canvas, false);
    if (!mouseFallback) window.setShape([{ x: 0, y: 0, width: plan.canvas.width, height: plan.canvas.height }]);
    if (!window.webContents.isLoadingMainFrame()) {
      window.webContents.send('notch-animate', {
        edge: plan.edge,
        width: plan.canvas.width,
        height: plan.canvas.height,
        durationMs: plan.durationMs,
        frames: plan.frames,
        interaction: interaction.state(),
        placement,
      });
    }
    animationTimer = setTimeout(() => {
      if (token !== animationToken || window.isDestroyed()) return;
      animation = null;
      renderProgress(target);
    }, plan.durationMs);
    animationTimer.unref?.();
  }

  function apply(nextSettings = currentSettings) {
    if (placementSession) cancelPlacement();
    currentSettings = nextSettings;
    const recovered = recoverPlacement(screen.getAllDisplays(), currentSettings.placement, screen.getPrimaryDisplay());
    if (recovered.recovered) currentSettings = { ...currentSettings, placement: recovered.placement };
    if (window.isDestroyed()) return null;
    window.setAlwaysOnTop(nextSettings.alwaysOnTop, 'floating');
    applyOpacity(window, nextSettings.opacity);
    interaction.mode(nextSettings.displayMode);
    const applied = renderProgress(progress);
    if (recovered.recovered) onPlacementCommit?.(recovered.placement, 'placement-fit');
    return applied;
  }

  function recover() {
    if (window.isDestroyed()) return;
    if (placementSession) cancelPlacement();
    const recovered = recoverPlacement(screen.getAllDisplays(), currentSettings.placement, screen.getPrimaryDisplay());
    currentSettings = { ...currentSettings, placement: recovered.placement };
    renderProgress(progress);
    if (recovered.recovered) onPlacementCommit?.(recovered.placement, 'display-recovery');
  }

  function beginPlacement(request) {
    if (placementSession || !request || !['move', 'resize'].includes(request.mode)) return { ok: false, reason: 'invalid-request' };
    placementSession = createPlacementSession({
      displays: screen.getAllDisplays(),
      primaryDisplay: screen.getPrimaryDisplay(),
      placement: currentSettings.placement,
      persist: placement => onPlacementCommit?.(placement, request.mode),
    });
    const result = placementSession.begin(request);
    if (!result.ok) { placementSession = null; return result; }
    currentSettings = { ...currentSettings, placement: result.placement };
    interaction.placement(true);
    animateTo(1, 0);
    placementPreviewing = request.mode === 'move';
    if (placementPreviewing) onPlacementPreview?.({ active: true, placement: result.placement });
    return { ...result, bounds: window.getBounds() };
  }

  function movePlacement(request) {
    if (!placementSession) return { ok: false, reason: 'inactive' };
    const placement = placementSession.move(request?.point);
    if (placement.ok === false) return placement;
    currentSettings = { ...currentSettings, placement };
    const applied = renderProgress(1);
    if (placementPreviewing) onPlacementPreview?.({ active: true, placement });
    return { ok: true, placement, bounds: applied?.bounds };
  }

  function finishPlacement(commit) {
    if (!placementSession) return { ok: false, reason: 'inactive' };
    const session = placementSession;
    const result = commit ? session.end({ commit: true }) : session.cancel();
    placementSession = null;
    if (placementPreviewing) { placementPreviewing = false; onPlacementPreview?.({ active: false }); }
    if (result.ok) currentSettings = { ...currentSettings, placement: result.placement };
    renderProgress(1);
    interaction.placement(false);
    return { ...result, bounds: window.isDestroyed() ? null : window.getBounds() };
  }

  function cancelPlacement() { return finishPlacement(false); }

  function placement(request) {
    if (!request || typeof request.type !== 'string') return { ok: false, reason: 'invalid-request' };
    if (request.type === 'begin') return beginPlacement(request);
    if (request.type === 'move') return movePlacement(request);
    if (request.type === 'end') return finishPlacement(true);
    if (request.type === 'cancel') return cancelPlacement();
    if (request.type === 'keyboard') {
      if (placementSession || !['move', 'resize'].includes(request.mode) || typeof request.key !== 'string') return { ok: false, reason: 'invalid-request' };
      const next = { ...currentSettings.placement, offsets: { ...currentSettings.placement.offsets }, lastEdges: { ...currentSettings.placement.lastEdges } };
      if (request.mode === 'resize') {
        const delta = ['ArrowUp', 'ArrowRight', '+'].includes(request.key) ? 0.05 : ['ArrowDown', 'ArrowLeft', '-'].includes(request.key) ? -0.05 : 0;
        if (!delta) return { ok: false, reason: 'invalid-request' };
        next.scale += delta;
      } else {
        const vertical = next.edge === 'left' || next.edge === 'right';
        const along = vertical ? { ArrowUp: -0.05, ArrowDown: 0.05 } : { ArrowLeft: -0.05, ArrowRight: 0.05 };
        if (along[request.key]) next.offsets[next.edge] = Math.max(0, Math.min(1, next.offsets[next.edge] + along[request.key]));
        else {
          const edge = { ArrowUp: 'top', ArrowRight: 'right', ArrowDown: 'bottom', ArrowLeft: 'left' }[request.key];
          if (!edge) return { ok: false, reason: 'invalid-request' };
          next.edge = edge;
          next.lastEdges[['top', 'bottom'].includes(edge) ? 'horizontal' : 'vertical'] = edge;
        }
      }
      const recovered = recoverPlacement(screen.getAllDisplays(), next, screen.getPrimaryDisplay());
      currentSettings = { ...currentSettings, placement: recovered.placement };
      const applied = renderProgress(1);
      onPlacementCommit?.(recovered.placement, `keyboard-${request.mode}`);
      return { ok: true, placement: recovered.placement, bounds: applied?.bounds };
    }
    return { ok: false, reason: 'invalid-request' };
  }

  function updateMouseRegion() {
    if (!currentShape || window.isDestroyed()) return;
    const interactive = isInteractivePoint(currentShape, window.getBounds(), screen.getCursorScreenPoint(), fitted.offset);
    const nextIgnore = !interactive;
    if (ignoreMouse === nextIgnore) return;
    ignoreMouse = nextIgnore;
    window.setIgnoreMouseEvents(nextIgnore, { forward: true });
  }

  function wakeBounds() {
    const placement = currentSettings.placement;
    const collapsed = getNotchShape({ edge: placement.edge, state: 'collapsed', scale: placement.scale });
    const collapsedCanvas = fitShapeToCanvas(collapsed);
    const display = displayForPlacement(screen, placement);
    const bounds = placeNotch(display.workArea, { edge: collapsed.edge, ...collapsedCanvas.canvas }, placement.offsets[collapsed.edge]);
    const visual = { x: bounds.x + collapsedCanvas.offset.x, y: bounds.y + collapsedCanvas.offset.y, width: collapsed.width, height: collapsed.height };
    const depth = collapsed.edge === 'top' || collapsed.edge === 'bottom' ? collapsed.wakeSize.height : collapsed.wakeSize.width;
    if (collapsed.edge === 'right') return { x: display.workArea.x + display.workArea.width - depth, y: visual.y, width: depth, height: visual.height };
    if (collapsed.edge === 'left') return { x: display.workArea.x, y: visual.y, width: depth, height: visual.height };
    if (collapsed.edge === 'bottom') return { x: visual.x, y: display.workArea.y + display.workArea.height - depth, width: visual.width, height: depth };
    return { x: visual.x, y: display.workArea.y, width: visual.width, height: depth };
  }

  function observeWakeZone() {
    if (interaction.state().visualState !== 'collapsed') return;
    const point = screen.getCursorScreenPoint();
    const wake = wakeBounds();
    interaction.pointer(point.x >= wake.x && point.y >= wake.y && point.x < wake.x + wake.width && point.y < wake.y + wake.height);
  }

  window.loadFile(path.join(__dirname, '../renderer/notch.html'));
  window.webContents.on('did-finish-load', () => {
    apply(currentSettings);
    window.webContents.send('notch-shape', payload());
  });
  window.once('ready-to-show', () => {
    apply(currentSettings);
    window.showInactive();
    if (mouseFallback) {
      updateMouseRegion();
      hitTimer = setInterval(updateMouseRegion, 40);
      hitTimer.unref?.();
    }
    wakeTimer = setInterval(observeWakeZone, 32);
    wakeTimer.unref?.();
  });
  window.on('close', event => {
    if (!window.__allowClose) {
      event.preventDefault();
      window.hide();
    }
  });

  for (const event of ['display-added', 'display-removed', 'display-metrics-changed']) {
    const listener = recover;
    screen.on(event, listener);
    displayListeners.push([event, listener]);
  }
  if (powerMonitor) {
    powerMonitor.on('resume', recover);
    displayListeners.push(['power-resume', recover]);
  }

  function destroy() {
    for (const [event, listener] of displayListeners) {
      if (event === 'power-resume') powerMonitor?.removeListener('resume', listener);
      else screen.removeListener(event, listener);
    }
    displayListeners = [];
    clearInterval(hitTimer);
    clearInterval(wakeTimer);
    settleAnimation();
    interaction.destroy();
    if (!window.isDestroyed()) {
      window.__allowClose = true;
      window.destroy();
    }
  }

  function dispatch(type, value) {
    if (type === 'pointer') interaction.pointer(Boolean(value));
    else if (type === 'focus') interaction.focus(Boolean(value));
    else if (type === 'popup') interaction.popup(Boolean(value));
    else if (type === 'pin') interaction.pin(typeof value === 'boolean' ? value : undefined);
    else if (type === 'reduced-motion') interaction.reduce(Boolean(value));
    else if (type === 'escape') return interaction.escape();
    else if (type === 'expand') interaction.expand();
    return interaction.state();
  }

  function show(focus = false) {
    interaction.expand();
    if (focus) {
      window.show();
      window.focus();
      window.webContents.send('notch-focus-first');
    } else window.showInactive();
  }

  return { window, apply, destroy, dispatch, show, placement, cancelPlacement, get interaction() { return interaction.state(); }, get shape() { return currentShape; } };
}

module.exports = { createNotchWindow, displayForPlacement, fitShapeToCanvas, isInteractivePoint, shouldUseMouseFallback, applyOpacity, buildTransitionPlan, easeTransition, unionBounds };
