function registerManagedWindow(window, role, roles) {
  const contents = window.webContents;
  const id = contents.id;
  roles.set(id, role);
  contents.setWindowOpenHandler(() => ({ action: 'deny' }));
  contents.on('will-navigate', event => event.preventDefault());
  contents.session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  contents.once('destroyed', () => roles.delete(id));
}

function sendToManagedWindows(windows, roles, channel, value) {
  for (const window of windows) {
    if (window.isDestroyed()) continue;
    const contents = window.webContents;
    if (contents.isDestroyed() || !roles.has(contents.id)) continue;
    contents.send(channel, value);
  }
}

module.exports = { registerManagedWindow, sendToManagedWindows };
