const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { registerManagedWindow, sendToManagedWindows } = require('../src/window-registry.cjs');

test('destroyed webContents removes its captured id without dereferencing the destroyed object', () => {
  const contents = new EventEmitter();
  let destroyed = false;
  Object.defineProperty(contents, 'id', {
    get() {
      if (destroyed) throw new TypeError('Object has been destroyed');
      return 42;
    },
  });
  contents.setWindowOpenHandler = () => {};
  contents.session = { setPermissionRequestHandler() {} };
  const roles = new Map();
  const window = { webContents: contents };

  registerManagedWindow(window, 'notch', roles);
  assert.equal(roles.get(42), 'notch');
  destroyed = true;
  assert.doesNotThrow(() => contents.emit('destroyed'));
  assert.equal(roles.has(42), false);
});

test('publisher skips destroyed windows before reading webContents', () => {
  const destroyed = {
    isDestroyed: () => true,
    get webContents() {
      throw new TypeError('Object has been destroyed');
    },
  };
  const sent = [];
  const liveContents = { id: 7, isDestroyed: () => false, send: (...args) => sent.push(args) };
  const live = { isDestroyed: () => false, webContents: liveContents };
  const roles = new Map([[7, 'notch']]);
  assert.doesNotThrow(() => sendToManagedWindows([destroyed, live], roles, 'state-update', { ok: true }));
  assert.deepEqual(sent, [['state-update', { ok: true }]]);
});
