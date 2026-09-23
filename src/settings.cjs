const fs = require('node:fs');
const path = require('node:path');
const EDGES = ['top', 'right', 'bottom', 'left'];
const BUTTONS = ['neis', 'edufine', 'attendance', 'trip', 'draft', 'compose'];
const defaultOffsets = () => ({ top: 0.5, right: 0.5, bottom: 0.5, left: 0.5 });
const defaults = () => ({
  schemaVersion: 4,
  autoLogin: false,
  guideCompleted: false,
  passwordSaved: false,
  certificateDriveHint: null,
  alwaysOnTop: true,
  opacity: 1,
  placement: { edge: 'right', monitorId: null, offsets: defaultOffsets(), scale: 1, lastEdges: { horizontal: 'top', vertical: 'right' } },
  displayMode: 'auto',
  buttons: [...BUTTONS],
});

function finiteInRange(value, minimum, maximum, fallback) {
  return Number.isFinite(value) ? Math.max(minimum, Math.min(maximum, value)) : fallback;
}

function cleanPlacement(value = {}) {
  const placement = {};
  if (EDGES.includes(value.edge)) placement.edge = value.edge;
  if (typeof value.monitorId === 'string' && value.monitorId.length <= 200) placement.monitorId = value.monitorId;
  if (value.monitorId === null) placement.monitorId = null;
  if (Number.isFinite(value.scale)) placement.scale = finiteInRange(value.scale, 0.85, 1.5, 1);
  if (value.offsets && typeof value.offsets === 'object') {
    placement.offsets = {};
    for (const edge of EDGES) {
      if (Number.isFinite(value.offsets[edge])) placement.offsets[edge] = finiteInRange(value.offsets[edge], 0, 1, 0.5);
    }
  }
  if (value.lastEdges && typeof value.lastEdges === 'object') {
    const horizontal = ['top', 'bottom'].includes(value.lastEdges.horizontal) ? value.lastEdges.horizontal : null;
    const vertical = ['left', 'right'].includes(value.lastEdges.vertical) ? value.lastEdges.vertical : null;
    if (horizontal || vertical) placement.lastEdges = { ...(horizontal ? { horizontal } : {}), ...(vertical ? { vertical } : {}) };
  }
  return placement;
}
function cleanButtons(value) {
  if (!Array.isArray(value)) return null;
  const buttons = [];
  for (const id of value) {
    const migrated = id === 'portal' ? 'edufine' : id;
    if (BUTTONS.includes(migrated) && !buttons.includes(migrated)) buttons.push(migrated);
  }
  return [...buttons, ...BUTTONS.filter(id => !buttons.includes(id))];
}
function cleanPatch(patch) {
  if (!patch || typeof patch !== 'object') throw new Error('설정값이 올바르지 않습니다.');
  const result = {};
  if (typeof patch.alwaysOnTop === 'boolean') result.alwaysOnTop = patch.alwaysOnTop;
  // Kept above 0.3 so the notch can never become invisible and unclickable.
  if (Number.isFinite(patch.opacity)) result.opacity = Math.round(finiteInRange(patch.opacity, 0.3, 1, 1) * 100) / 100;
  if (typeof patch.autoLogin === 'boolean') result.autoLogin = patch.autoLogin;
  if (typeof patch.guideCompleted === 'boolean') result.guideCompleted = patch.guideCompleted;
  // Only a marker that a secret exists; the secret itself lives encrypted in its own file.
  if (typeof patch.passwordSaved === 'boolean') result.passwordSaved = patch.passwordSaved;
  if (typeof patch.certificateDriveHint === 'string' && /^[A-Z]:$/.test(patch.certificateDriveHint)) result.certificateDriveHint = patch.certificateDriveHint;
  if (patch.placement && typeof patch.placement === 'object') {
    const placement = cleanPlacement(patch.placement);
    if (Object.keys(placement).length) result.placement = placement;
  }
  if (['auto', 'expanded'].includes(patch.displayMode)) result.displayMode = patch.displayMode;
  const buttons = cleanButtons(patch.buttons);
  if (buttons) result.buttons = buttons;
  return result;
}
function sanitizedSettings(value = {}) {
  const base = defaults();
  const patch = cleanPatch(value);
  if (value.schemaVersion !== 4) delete patch.autoLogin;
  if (!Object.hasOwn(value, 'displayMode') && Object.keys(value).length) patch.displayMode = 'expanded';
  const legacyEdge = EDGES.includes(value.dock) ? value.dock : null;
  const placementPatch = patch.placement || {};
  const settings = {
    ...base,
    ...patch,
    placement: {
      ...base.placement,
      ...(legacyEdge ? { edge: legacyEdge } : {}),
      ...placementPatch,
      offsets: { ...base.placement.offsets, ...(placementPatch.offsets || {}) },
      lastEdges: { ...base.placement.lastEdges, ...(placementPatch.lastEdges || {}) },
    },
  };
  if (!placementPatch.lastEdges?.horizontal && ['top', 'bottom'].includes(settings.placement.edge)) settings.placement.lastEdges.horizontal = settings.placement.edge;
  if (!placementPatch.lastEdges?.vertical && ['left', 'right'].includes(settings.placement.edge)) settings.placement.lastEdges.vertical = settings.placement.edge;
  return settings;
}
function loadSettings(directory) {
  try {
    const value=JSON.parse(fs.readFileSync(path.join(directory, 'settings.json'), 'utf8'));
    return sanitizedSettings(value);
  } catch { return defaults(); }
}
function saveSettings(directory, settings) {
  fs.mkdirSync(directory, { recursive: true });
  const target = path.join(directory, 'settings.json');
  fs.writeFileSync(target + '.tmp', JSON.stringify(sanitizedSettings(settings), null, 2));
  fs.renameSync(target + '.tmp', target);
}
module.exports = { loadSettings, saveSettings, cleanPatch, sanitizedSettings };
