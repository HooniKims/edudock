'use strict';

const { getNotchShape, placeNotch } = require('./notch-geometry.cjs');

const EDGES = Object.freeze(['top', 'right', 'bottom', 'left']);
const HORIZONTAL = new Set(['top', 'bottom']);
const VERTICAL = new Set(['left', 'right']);
const SCALE_RANGE = 1.5 - 0.85;
const RESIZE_TRAVEL = getNotchShape({ edge: 'right', state: 'expanded', scale: 1 }).depth;
const SNAP_DISTANCE = 72;

function finitePoint(value) {
  return value && Number.isFinite(value.x) && Number.isFinite(value.y);
}

function displayId(display) {
  return String(display.id);
}

function contains(area, point) {
  return point.x >= area.x && point.x < area.x + area.width && point.y >= area.y && point.y < area.y + area.height;
}

function pointDistance(area, point) {
  const x = Math.max(area.x, Math.min(point.x, area.x + area.width));
  const y = Math.max(area.y, Math.min(point.y, area.y + area.height));
  return Math.hypot(point.x - x, point.y - y);
}

function displayNearestPoint(displays, point, primaryDisplay) {
  return displays.find(display => contains(display.workArea, point))
    || [...displays].sort((a, b) => pointDistance(a.workArea, point) - pointDistance(b.workArea, point))[0]
    || primaryDisplay;
}

function nearestEdge(area, point) {
  const distances = {
    top: Math.abs(point.y - area.y),
    right: Math.abs(area.x + area.width - point.x),
    bottom: Math.abs(area.y + area.height - point.y),
    left: Math.abs(point.x - area.x),
  };
  return EDGES.reduce((best, edge) => distances[edge] < distances[best] ? edge : best, 'top');
}

function edgeDistance(area, point, edge) {
  if (edge === 'top') return Math.abs(point.y - area.y);
  if (edge === 'right') return Math.abs(area.x + area.width - point.x);
  if (edge === 'bottom') return Math.abs(area.y + area.height - point.y);
  return Math.abs(point.x - area.x);
}

function fitScaleToDisplay(display, edge, scale) {
  const available = HORIZONTAL.has(edge) ? display.workArea.width : display.workArea.height;
  return Math.max(0.85, Math.min(1.5, Number.isFinite(scale) ? scale : 1, available / 394));
}

function clonePlacement(placement) {
  return {
    ...placement,
    offsets: { ...placement.offsets },
    lastEdges: { ...placement.lastEdges },
  };
}

function recoverPlacement(displays, placement, primaryDisplay) {
  const selected = displays.find(display => displayId(display) === String(placement.monitorId));
  if (selected) {
    const next = clonePlacement(placement);
    next.scale = fitScaleToDisplay(selected, next.edge, next.scale);
    return { placement: next, display: selected, recovered: next.scale !== placement.scale };
  }
  const primary = primaryDisplay || displays[0];
  if (!primary) throw new Error('No display is available for notch placement.');
  if (placement.monitorId === null || placement.monitorId === undefined) {
    const next = clonePlacement(placement);
    next.monitorId = displayId(primary);
    next.scale = fitScaleToDisplay(primary, next.edge, next.scale);
    return { placement: next, display: primary, recovered: true };
  }
  return {
    placement: {
      ...clonePlacement(placement),
      monitorId: displayId(primary),
      edge: 'right',
      offsets: { ...placement.offsets, right: 0.5 },
      lastEdges: { ...placement.lastEdges, vertical: 'right' },
      scale: fitScaleToDisplay(primary, 'right', placement.scale),
    },
    display: primary,
    recovered: true,
  };
}

function resolvePlacement(displays, placement, shape, primaryDisplay = displays[0]) {
  const recovered = recoverPlacement(displays, placement, primaryDisplay);
  return {
    displayId: displayId(recovered.display),
    recovered: recovered.recovered,
    bounds: placeNotch(recovered.display.workArea, { edge: recovered.placement.edge, ...shape }, recovered.placement.offsets[recovered.placement.edge]),
  };
}

function switchOrientation(placement, orientation) {
  const next = clonePlacement(placement);
  if (orientation === 'horizontal') {
    next.edge = HORIZONTAL.has(next.lastEdges?.horizontal) ? next.lastEdges.horizontal : 'top';
  } else if (orientation === 'vertical') {
    next.edge = VERTICAL.has(next.lastEdges?.vertical) ? next.lastEdges.vertical : 'right';
  }
  return next;
}

function resizeDelta(edge, start, point) {
  if (edge === 'right') return start.x - point.x;
  if (edge === 'left') return point.x - start.x;
  if (edge === 'bottom') return start.y - point.y;
  return point.y - start.y;
}

function createPlacementSession(options) {
  const persist = typeof options.persist === 'function' ? options.persist : () => {};
  let current = clonePlacement(options.placement);
  let active = null;

  function begin(request) {
    if (active || !request || !['move', 'resize'].includes(request.mode) || !finitePoint(request.point)) return { ok: false, reason: 'invalid-request' };
    const recovered = recoverPlacement(options.displays, current, options.primaryDisplay);
    current = recovered.placement;
    const shape = getNotchShape({ edge: current.edge, state: 'expanded', scale: current.scale });
    const resolved = resolvePlacement(options.displays, current, shape, options.primaryDisplay);
    const horizontal = HORIZONTAL.has(current.edge);
    const bounds = resolved.bounds;
    const localAlong = horizontal ? request.point.x - bounds.x : request.point.y - bounds.y;
    active = {
      mode: request.mode,
      start: { ...request.point },
      original: clonePlacement(current),
      originalAlongStart: horizontal ? bounds.x : bounds.y,
      grabFraction: Math.max(0, Math.min(1, localAlong / (horizontal ? shape.width : shape.height))),
    };
    return { ok: true, placement: clonePlacement(current), recovered: recovered.recovered };
  }

  function move(point) {
    if (!active || !finitePoint(point)) return { ok: false, reason: 'inactive' };
    if (active.mode === 'resize') {
      const display = options.displays.find(candidate => displayId(candidate) === String(active.original.monitorId)) || options.primaryDisplay;
      const scale = fitScaleToDisplay(display, active.original.edge, active.original.scale + resizeDelta(active.original.edge, active.start, point) / RESIZE_TRAVEL * SCALE_RANGE);
      const shape = getNotchShape({ edge: active.original.edge, state: 'expanded', scale });
      const horizontal = HORIZONTAL.has(active.original.edge);
      const available = horizontal ? display.workArea.width - shape.width : display.workArea.height - shape.height;
      const areaStart = horizontal ? display.workArea.x : display.workArea.y;
      const offset = available > 0 ? Math.max(0, Math.min(1, (active.originalAlongStart - areaStart) / available)) : 0.5;
      current = { ...clonePlacement(active.original), scale, offsets: { ...active.original.offsets, [active.original.edge]: offset } };
      return clonePlacement(current);
    }
    const display = displayNearestPoint(options.displays, point, options.primaryDisplay);
    if (!display) return { ok: false, reason: 'no-display' };
    const candidate = nearestEdge(display.workArea, point);
    const edge = edgeDistance(display.workArea, point, candidate) <= SNAP_DISTANCE ? candidate : current.edge;
    const scale = fitScaleToDisplay(display, edge, current.scale);
    const shape = getNotchShape({ edge, state: 'expanded', scale });
    const horizontal = HORIZONTAL.has(edge);
    const available = (horizontal ? display.workArea.width - shape.width : display.workArea.height - shape.height);
    const cursorAlong = horizontal ? point.x - display.workArea.x : point.y - display.workArea.y;
    const size = horizontal ? shape.width : shape.height;
    const sameAxis = HORIZONTAL.has(active.original.edge) === horizontal;
    const grabFraction = sameAxis ? active.grabFraction : 0.5;
    const offset = available > 0 ? Math.max(0, Math.min(1, (cursorAlong - size * grabFraction) / available)) : 0.5;
    const orientation = horizontal ? 'horizontal' : 'vertical';
    current = {
      ...clonePlacement(current),
      monitorId: displayId(display),
      edge,
      scale,
      offsets: { ...current.offsets, [edge]: offset },
      lastEdges: { ...current.lastEdges, [orientation]: edge },
    };
    return clonePlacement(current);
  }

  function cancel() {
    if (!active) return { ok: false, reason: 'inactive' };
    current = clonePlacement(active.original);
    active = null;
    return { ok: true, placement: clonePlacement(current) };
  }

  function end(request = {}) {
    if (!active) return { ok: false, reason: 'inactive' };
    if (!request.commit) return cancel();
    active = null;
    persist(clonePlacement(current));
    return { ok: true, placement: clonePlacement(current) };
  }

  return { begin, move, cancel, end, get active() { return Boolean(active); }, get placement() { return clonePlacement(current); } };
}

// Monitors are ordered left-to-right, then top-to-bottom, so "next monitor" matches how the
// displays are physically arranged rather than however the OS happens to enumerate them.
function orderedDisplays(displays) {
  return [...displays].sort((left, right) => (left.bounds.x - right.bounds.x) || (left.bounds.y - right.bounds.y) || String(left.id).localeCompare(String(right.id)));
}

function nextMonitorId(displays, currentId) {
  const ordered = orderedDisplays(Array.isArray(displays) ? displays.filter(display => display?.bounds) : []);
  if (ordered.length === 0) return null;
  const index = ordered.findIndex(display => displayId(display) === String(currentId));
  return displayId(ordered[(index + 1) % ordered.length]);
}

module.exports = { createPlacementSession, fitScaleToDisplay, recoverPlacement, resolvePlacement, switchOrientation, nextMonitorId, orderedDisplays };
