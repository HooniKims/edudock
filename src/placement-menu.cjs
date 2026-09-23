'use strict';

const { orderedDisplays } = require('./notch-placement.cjs');

// One vocabulary for every place a teacher can move the widget from: the right-click menu on
// the notch, the tray menu and the monitor map in settings all name monitors the same way.

const EDGES = Object.freeze(['top', 'right', 'bottom', 'left']);
const EDGE_LABELS = Object.freeze({ top: '위', right: '오른쪽', bottom: '아래', left: '왼쪽' });

// Where a monitor sits relative to the primary one, so "모니터 1" also says which physical screen.
function relativePosition(display, primary) {
  if (!primary || display === primary) return null;
  const a = display.bounds;
  const p = primary.bounds;
  if (a.x + a.width <= p.x) return '왼쪽';
  if (a.x >= p.x + p.width) return '오른쪽';
  if (a.y + a.height <= p.y) return '위쪽';
  if (a.y >= p.y + p.height) return '아래쪽';
  return null;
}

function describeDisplays(displays, primaryId) {
  const valid = (Array.isArray(displays) ? displays : []).filter(display => display?.bounds && display?.workArea);
  const primary = valid.find(display => String(display.id) === String(primaryId)) || null;
  return orderedDisplays(valid).map((display, position) => {
    const index = position + 1;
    const isPrimary = display === primary;
    const where = relativePosition(display, primary);
    const detail = isPrimary ? '주 모니터' : where ? `${where} 모니터` : '';
    return {
      id: String(display.id),
      index,
      primary: isPrimary,
      name: `모니터 ${index}`,
      detail,
      label: detail ? `모니터 ${index} (${detail})` : `모니터 ${index}`,
      bounds: { ...display.bounds },
      workArea: { ...display.workArea },
    };
  });
}

function currentMonitorId(described, placement, primaryId) {
  const saved = String(placement?.monitorId ?? '');
  if (described.some(display => display.id === saved)) return saved;
  const primary = described.find(display => display.id === String(primaryId));
  return primary ? primary.id : described[0]?.id ?? null;
}

function describePlacement(described, placement, primaryId) {
  const id = currentMonitorId(described, placement, primaryId);
  const display = described.find(candidate => candidate.id === id);
  const edge = EDGE_LABELS[placement?.edge] || EDGE_LABELS.right;
  if (!display || described.length < 2) return `화면 ${edge} 가장자리`;
  return `${display.label} ${edge} 가장자리`;
}

// Electron menu template. Clicking an item calls onMove({ monitorId, edge }).
function placementMenuTemplate({ displays, primaryId, placement, onMove }) {
  const described = describeDisplays(displays, primaryId);
  const selected = currentMonitorId(described, placement, primaryId);
  const edgeItems = monitorId => EDGES.map(edge => ({
    label: `${EDGE_LABELS[edge]} 가장자리`,
    type: 'radio',
    checked: monitorId === selected && edge === placement?.edge,
    click: () => onMove({ monitorId, edge }),
  }));
  if (described.length < 2) return edgeItems(selected);
  return described.map(display => ({
    label: display.id === selected ? `${display.label} · 지금 여기` : display.label,
    submenu: edgeItems(display.id),
  }));
}

module.exports = { EDGES, EDGE_LABELS, describeDisplays, describePlacement, currentMonitorId, placementMenuTemplate };
