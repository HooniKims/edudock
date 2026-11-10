const test = require('node:test');
const assert = require('node:assert/strict');
const { keepOnTop } = require('../src/notch-window.cjs');

function fakeWindow({ visible = true, minimized = false, destroyed = false, top = true } = {}) {
  const calls = [];
  return {
    calls,
    isDestroyed: () => destroyed,
    isVisible: () => visible,
    isMinimized: () => minimized,
    isAlwaysOnTop: () => top,
    setAlwaysOnTop: (flag, level) => { top = flag; calls.push(['setAlwaysOnTop', flag, level]); },
    moveTop: () => calls.push(['moveTop']),
  };
}

test('the widget is raised above windows that came later, then the bubble above it', () => {
  const window = fakeWindow();
  const order = [];
  window.moveTop = () => order.push('widget');
  assert.equal(keepOnTop(window, () => order.push('bubble')), true);
  assert.deepEqual(order, ['widget', 'bubble']);
});

test('a lost topmost flag is put back', () => {
  const window = fakeWindow({ top: false });
  keepOnTop(window);
  assert.deepEqual(window.calls, [['setAlwaysOnTop', true, 'floating'], ['moveTop']]);
});

test('a hidden, minimized or closed widget is left alone', () => {
  for (const state of [{ visible: false }, { minimized: true }, { destroyed: true }]) {
    const window = fakeWindow(state);
    let raised = false;
    assert.equal(keepOnTop(window, () => { raised = true; }), false);
    assert.deepEqual(window.calls, []);
    assert.equal(raised, false);
  }
  assert.equal(keepOnTop(null), false);
});
