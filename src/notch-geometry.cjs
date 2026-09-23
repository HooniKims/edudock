const EDGES = new Set(['top', 'right', 'bottom', 'left']);
const STATES = new Set(['expanded', 'collapsed']);

const EXPANDED = Object.freeze({ depth: 56, bodyLength: 332, curl: 31, corner: 24 });
const COLLAPSED = Object.freeze({ depth: 10, length: 79, curl: 31, corner: 24, wakeDepth: 34 });

function rounded(value) {
  return Math.round(value * 1000) / 1000;
}

function canonicalMetrics(state, scale) {
  const source = state === 'collapsed' ? COLLAPSED : EXPANDED;
  const depth = Math.max(1, Math.round(source.depth * scale));
  const wantedCorner = source.corner * scale;
  const wantedCurl = source.curl * scale;
  const rawLength = state === 'collapsed'
    ? source.length * scale
    : (source.bodyLength + 2 * source.curl) * scale;
  const length = Math.max(depth, Math.round(rawLength));
  let corner = Math.max(0, Math.min(wantedCorner, depth / 2));
  const curl = Math.max(0, Math.min(wantedCurl, length / 2, depth - corner));
  corner = Math.max(0, Math.min(corner, (length - 2 * curl) / 2));
  return { depth, length, curl: rounded(curl), corner: rounded(corner) };
}

function transitionMetrics(progress, scale) {
  const amount = Math.max(0, Math.min(1, progress));
  const source = {
    depth: COLLAPSED.depth + (EXPANDED.depth - COLLAPSED.depth) * amount,
    length: COLLAPSED.length + (EXPANDED.bodyLength + 2 * EXPANDED.curl - COLLAPSED.length) * amount,
    curl: COLLAPSED.curl + (EXPANDED.curl - COLLAPSED.curl) * amount,
    corner: COLLAPSED.corner + (EXPANDED.corner - COLLAPSED.corner) * amount,
  };
  const depth = Math.max(1, Math.round(source.depth * scale));
  const length = Math.max(depth, Math.round(source.length * scale));
  let corner = Math.max(0, Math.min(source.corner * scale, depth / 2));
  const curl = Math.max(0, Math.min(source.curl * scale, length / 2, depth - corner));
  corner = Math.max(0, Math.min(corner, (length - 2 * curl) / 2));
  return { depth, length, curl: rounded(curl), corner: rounded(corner) };
}

function canonicalPath({ depth, length, curl, corner }) {
  const bottom = length - curl;
  return [
    `M${depth} 0`,
    `A${curl} ${curl} 0 0 1 ${depth - curl} ${curl}`,
    `L${corner} ${curl}`,
    `A${corner} ${corner} 0 0 0 0 ${curl + corner}`,
    `L0 ${bottom - corner}`,
    `A${corner} ${corner} 0 0 0 ${corner} ${bottom}`,
    `L${depth - curl} ${bottom}`,
    `A${curl} ${curl} 0 0 1 ${depth} ${length}`,
    'Z',
  ].join(' ');
}

function edgeTransform(edge, depth) {
  if (edge === 'left') return `matrix(-1 0 0 1 ${depth} 0)`;
  if (edge === 'top') return `matrix(0 -1 1 0 0 ${depth})`;
  if (edge === 'bottom') return 'matrix(0 1 1 0 0 0)';
  return 'matrix(1 0 0 1 0 0)';
}

function fromCanonical(edge, depth, u, v) {
  if (edge === 'left') return { x: depth - u, y: v };
  if (edge === 'top') return { x: v, y: depth - u };
  if (edge === 'bottom') return { x: v, y: u };
  return { x: u, y: v };
}

function toCanonical(edge, depth, x, y) {
  if (edge === 'left') return { u: depth - x, v: y };
  if (edge === 'top') return { u: depth - y, v: x };
  if (edge === 'bottom') return { u: y, v: x };
  return { u: x, v: y };
}

function minimumU(metrics, v) {
  const { depth, length, curl, corner } = metrics;
  if (v < 0 || v > length) return Infinity;
  if (v < curl) {
    const square = Math.max(0, curl * curl - v * v);
    return depth - curl + Math.sqrt(square);
  }
  if (v < curl + corner) {
    const delta = v - (curl + corner);
    return corner - Math.sqrt(Math.max(0, corner * corner - delta * delta));
  }
  if (v <= length - curl - corner) return 0;
  if (v <= length - curl) {
    const delta = v - (length - curl - corner);
    return corner - Math.sqrt(Math.max(0, corner * corner - delta * delta));
  }
  const delta = length - v;
  return depth - curl + Math.sqrt(Math.max(0, curl * curl - delta * delta));
}

function containsCanonical(metrics, u, v) {
  return u >= minimumU(metrics, v) && u <= metrics.depth;
}

function buildScanlines(shape) {
  const rows = [];
  for (let y = 0; y < shape.height; y += 1) {
    let start = -1;
    let end = -1;
    for (let x = 0; x < shape.width; x += 1) {
      if (pointInNotch(shape, x + 0.5, y + 0.5)) {
        if (start < 0) start = x;
        end = x + 1;
      }
    }
    if (start >= 0) rows.push({ x: start, y, width: end - start, height: 1 });
  }

  const merged = [];
  for (const row of rows) {
    const previous = merged[merged.length - 1];
    if (previous && previous.x === row.x && previous.width === row.width && previous.y + previous.height === row.y) {
      previous.height += 1;
    } else {
      merged.push({ ...row });
    }
  }
  return merged;
}

function getNotchShape(options = {}) {
  const edge = EDGES.has(options.edge) ? options.edge : 'top';
  const hasProgress = Number.isFinite(options.progress);
  const progress = hasProgress ? Math.max(0, Math.min(1, options.progress)) : null;
  const state = hasProgress ? (progress === 0 ? 'collapsed' : progress === 1 ? 'expanded' : 'transition') : (STATES.has(options.state) ? options.state : 'expanded');
  const scale = Number.isFinite(options.scale) ? Math.max(0.85, Math.min(1.5, options.scale)) : 1;
  const metrics = hasProgress ? transitionMetrics(progress, scale) : canonicalMetrics(state, scale);
  const horizontal = edge === 'top' || edge === 'bottom';
  const shape = {
    edge,
    state,
    progress: hasProgress ? progress : state === 'expanded' ? 1 : 0,
    scale,
    ...metrics,
    width: horizontal ? metrics.length : metrics.depth,
    height: horizontal ? metrics.depth : metrics.length,
    path: canonicalPath(metrics),
    transform: edgeTransform(edge, metrics.depth),
    wakeSize: horizontal
      ? { width: metrics.length, height: Math.round(COLLAPSED.wakeDepth * scale) }
      : { width: Math.round(COLLAPSED.wakeDepth * scale), height: metrics.length },
  };
  // Scanlines only matter when the shape becomes the native window region; animation
  // keyframes are drawn by the renderer alone and skip that work.
  shape.rects = options.rects === false ? [] : buildScanlines(shape);
  return shape;
}

function pointInNotch(shape, x, y) {
  const { u, v } = toCanonical(shape.edge, shape.depth, x, y);
  return containsCanonical(shape, u, v);
}

function placeNotch(workArea, shape, offset = 0.5) {
  const relative = Math.max(0, Math.min(1, Number.isFinite(offset) ? offset : 0.5));
  let x = workArea.x;
  let y = workArea.y;
  if (shape.edge === 'top' || shape.edge === 'bottom') {
    x += Math.round((workArea.width - shape.width) * relative);
    if (shape.edge === 'bottom') y += workArea.height - shape.height;
  } else {
    y += Math.round((workArea.height - shape.height) * relative);
    if (shape.edge === 'right') x += workArea.width - shape.width;
  }
  return { x, y, width: shape.width, height: shape.height };
}

module.exports = {
  EXPANDED,
  COLLAPSED,
  getNotchShape,
  pointInNotch,
  placeNotch,
  fromCanonical,
  toCanonical,
};
