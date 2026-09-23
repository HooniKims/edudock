'use strict';

const fs = require('node:fs');
const { Tray } = require('electron');

const originalSetContextMenu = Tray.prototype.setContextMenu;
Tray.prototype.setContextMenu = function captureContextMenu(menu) {
  globalThis.__edudockQaTray = this;
  globalThis.__edudockQaTrayMenu = menu;
  return originalSetContextMenu.call(this, menu);
};

process.on('uncaughtException', error => {
  const target = process.env.EDUDOCK_QA_TRAY_ERROR;
  if (target) fs.writeFileSync(target, `${error.stack || error}\n`, 'utf8');
  process.exit(1);
});
