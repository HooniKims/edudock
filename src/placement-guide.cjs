'use strict';

const path = require('node:path');

// While the notch is being dragged, every monitor shows where it can snap: faint rails on all
// four edges and a bright one where it will land. The overlays never take focus or clicks —
// the drag keeps its pointer capture in the notch — and they are created once and reused, so a
// drag does not pay for window creation after the first time.

function createPlacementGuide({ BrowserWindow, screen, describe, keepAbove }) {
  let overlays = new Map();
  let visible = false;

  function dispose() {
    for (const overlay of overlays.values()) if (!overlay.window.isDestroyed()) overlay.window.destroy();
    overlays = new Map();
    visible = false;
  }

  function overlayFor(display) {
    const id = String(display.id);
    const existing = overlays.get(id);
    if (existing && !existing.window.isDestroyed()) {
      existing.window.setBounds(display.workArea);
      return existing;
    }
    const window = new BrowserWindow({
      ...display.workArea,
      frame: false,
      transparent: true,
      backgroundColor: '#00000000',
      resizable: false,
      movable: false,
      minimizable: false,
      maximizable: false,
      focusable: false,
      skipTaskbar: true,
      hasShadow: false,
      show: false,
      alwaysOnTop: true,
      webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false },
    });
    window.setIgnoreMouseEvents(true);
    window.setAlwaysOnTop(true, 'floating');
    window.setMenu(null);
    const ready = window.loadFile(path.join(__dirname, '../renderer/placement-guide.html')).catch(() => {});
    const overlay = { window, ready, id };
    overlays.set(id, overlay);
    return overlay;
  }

  function render(placement) {
    const displays = screen.getAllDisplays();
    const described = describe(displays);
    const known = new Set(displays.map(display => String(display.id)));
    for (const [id, overlay] of overlays) {
      if (!known.has(id)) { if (!overlay.window.isDestroyed()) overlay.window.destroy(); overlays.delete(id); }
    }
    for (const display of displays) {
      const overlay = overlayFor(display);
      const info = described.find(candidate => candidate.id === String(display.id));
      const payload = JSON.stringify({
        label: described.length > 1 && info ? info.label : '',
        target: String(placement.monitorId) === String(display.id) ? placement.edge : null,
      });
      overlay.ready.then(() => {
        if (overlay.window.isDestroyed()) return;
        overlay.window.webContents.executeJavaScript(`window.renderGuide && window.renderGuide(${payload})`).catch(() => {});
        if (visible && !overlay.window.isVisible()) { overlay.window.showInactive(); keepAbove?.(); }
      });
    }
  }

  function show(placement) {
    visible = true;
    render(placement);
  }

  function update(placement) {
    if (visible) render(placement);
  }

  function hide() {
    visible = false;
    for (const overlay of overlays.values()) if (!overlay.window.isDestroyed()) overlay.window.hide();
  }

  return { show, update, hide, dispose };
}

module.exports = { createPlacementGuide };
