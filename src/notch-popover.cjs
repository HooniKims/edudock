'use strict';

const path = require('node:path');

function clamp(value, minimum, maximum) { return Math.max(minimum, Math.min(maximum, value)); }

function placePopover(notch, anchor, size, workArea, edge) {
  const gap = 8;
  let x;
  let y;
  if (edge === 'right') {
    x = notch.x - size.width - gap;
    y = anchor.y + anchor.height / 2 - size.height / 2;
  } else if (edge === 'left') {
    x = notch.x + notch.width + gap;
    y = anchor.y + anchor.height / 2 - size.height / 2;
  } else if (edge === 'bottom') {
    x = anchor.x + anchor.width / 2 - size.width / 2;
    y = notch.y - size.height - gap;
  } else {
    x = anchor.x + anchor.width / 2 - size.width / 2;
    y = notch.y + notch.height + gap;
  }
  return {
    x: Math.round(clamp(x, workArea.x, workArea.x + workArea.width - size.width)),
    y: Math.round(clamp(y, workArea.y, workArea.y + workArea.height - size.height)),
    width: size.width,
    height: size.height,
  };
}

function createNotchPopover({ BrowserWindow, screen, preload, onWindow, onPresence }) {
  let popup = null;
  let pending = null;

  function ensure() {
    if (popup && !popup.isDestroyed()) return popup;
    popup = new BrowserWindow({
      width: 260,
      height: 120,
      frame: false,
      transparent: true,
      resizable: false,
      show: false,
      skipTaskbar: true,
      alwaysOnTop: true,
      focusable: true,
      hasShadow: false,
      backgroundColor: '#00000000',
      webPreferences: { preload, contextIsolation: true, nodeIntegration: false, sandbox: true },
    });
    const created = popup;
    onWindow(created, 'popover');
    created.setMenu(null);
    created.setAlwaysOnTop(true, 'floating');
    created.loadFile(path.join(__dirname, '../renderer/popup.html'));
    created.webContents.on('did-finish-load', () => { if (pending && popup === created && !created.isDestroyed()) created.webContents.send('popover-data', pending.data); });
    created.on('hide', () => { if (popup === created) onPresence(false); });
    created.on('closed', () => { if (popup === created) { popup = null; onPresence(false); } });
    return created;
  }

  function popupShape(size, edge) {
    const rects = [];
    const radius = 16;
    for (let y = 4; y < size.height - 4; y += 1) {
      const localY = Math.min(y - 4, size.height - 5 - y);
      const inset = localY >= radius ? 0 : Math.ceil(radius - Math.sqrt(Math.max(0, radius * radius - Math.pow(radius - localY, 2))));
      rects.push({ x: 4 + inset, y, width: size.width - 8 - 2 * inset, height: 1 });
    }
    if (edge === 'right') rects.push({ x: size.width - 12, y: Math.floor(size.height / 2) - 7, width: 12, height: 14 });
    if (edge === 'left') rects.push({ x: 0, y: Math.floor(size.height / 2) - 7, width: 12, height: 14 });
    if (edge === 'top') rects.push({ x: Math.floor(size.width / 2) - 7, y: 0, width: 14, height: 12 });
    if (edge === 'bottom') rects.push({ x: Math.floor(size.width / 2) - 7, y: size.height - 12, width: 14, height: 12 });
    return rects.filter(rect => rect.width > 0 && rect.height > 0);
  }

  function show(request) {
    const target = ensure();
    const kind = ['status', 'guide'].includes(request.kind) ? request.kind : 'tooltip';
    const size = kind === 'status' ? { width: 280, height: 176 }
      : kind === 'guide' ? (request.guide?.kind === 'password-offer' ? { width: 330, height: 372 } : { width: 330, height: 216 })
        : { width: 220, height: 52 };
    const workArea = screen.getDisplayMatching(request.notchBounds).workArea;
    const bounds = placePopover(request.notchBounds, request.anchor, size, workArea, request.edge);
    const data = { kind, label: String(request.label || '').slice(0, 80), status: request.status || null, edge: request.edge, guide: request.guide || null };
    pending = { data, bounds };
    target.setBounds(bounds, false);
    if (typeof target.setShape === 'function') target.setShape(popupShape(size, request.edge));
    if (!target.webContents.isLoadingMainFrame()) target.webContents.send('popover-data', data);
    onPresence(true);
    if (request.focus) { target.show(); target.focus(); }
    else target.showInactive();
    return { ok: true, kind, bounds };
  }

  function hide() { if (popup && !popup.isDestroyed()) popup.hide(); }
  function destroy() { if (popup && !popup.isDestroyed()) popup.destroy(); popup = null; }
  return { show, hide, destroy, get window() { return popup; } };
}

module.exports = { createNotchPopover, placePopover };
