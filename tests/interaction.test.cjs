const test = require('node:test');
const assert = require('node:assert/strict');

const { createInteractionController } = require('../src/notch-interaction.cjs');
const { sanitizedSettings } = require('../src/settings.cjs');
const { fitShapeToCanvas } = require('../src/notch-window.cjs');
const { placePopover } = require('../src/notch-popover.cjs');

function clock() {
  let nextId = 1;
  let now = 0;
  const jobs = new Map();
  return {
    setTimeout(fn, delay) { const id = nextId++; jobs.set(id, { at: now + delay, fn }); return id; },
    clearTimeout(id) { jobs.delete(id); },
    advance(ms) {
      const end = now + ms;
      while (true) {
        const due = [...jobs.entries()].filter(([, job]) => job.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
        if (!due) break;
        now = due[1].at; jobs.delete(due[0]); due[1].fn();
      }
      now = end;
    },
  };
}

function fixture(options = {}) {
  const scheduler = clock();
  const changes = [];
  const controller = createInteractionController({ scheduler, displayMode: options.displayMode || 'auto', reducedMotion: Boolean(options.reducedMotion), onChange: state => changes.push({ ...state }) });
  return { scheduler, changes, controller };
}

test('pointer entry waits 180ms and leave keeps a 450ms grace corridor', () => {
  const { scheduler, controller } = fixture();
  assert.equal(controller.state().visualState, 'collapsed');
  controller.pointer(true); scheduler.advance(179);
  assert.equal(controller.state().visualState, 'collapsed');
  scheduler.advance(1);
  assert.equal(controller.state().visualState, 'expanded');
  controller.pointer(false); scheduler.advance(449);
  assert.equal(controller.state().visualState, 'expanded');
  scheduler.advance(1);
  assert.equal(controller.state().visualState, 'collapsed');
});

test('fast re-entry cancels a pending fold without emitting a collapsed frame', () => {
  const { scheduler, controller, changes } = fixture();
  controller.pointer(true); scheduler.advance(180);
  controller.pointer(false); scheduler.advance(300);
  controller.pointer(true); scheduler.advance(200);
  assert.equal(controller.state().visualState, 'expanded');
  assert.equal(changes.filter(change => change.visualState === 'collapsed').length, 0);
});

test('pin, focus, popup corridor, and always-expanded mode independently prevent folding', () => {
  const { scheduler, controller } = fixture();
  controller.pointer(true); scheduler.advance(180);
  controller.pin(true); controller.pointer(false); scheduler.advance(500);
  assert.equal(controller.state().visualState, 'expanded');
  controller.pin(false); controller.focus(true); scheduler.advance(500);
  assert.equal(controller.state().visualState, 'expanded');
  controller.focus(false); controller.popup(true); scheduler.advance(500);
  assert.equal(controller.state().visualState, 'expanded');
  controller.popup(false); scheduler.advance(450);
  assert.equal(controller.state().visualState, 'collapsed');
  controller.mode('expanded');
  assert.equal(controller.state().visualState, 'expanded');
  controller.pointer(false); scheduler.advance(1000);
  assert.equal(controller.state().visualState, 'expanded');
});

test('Escape closes popup first, then unpins and collapses', () => {
  const { scheduler, controller } = fixture();
  controller.pointer(true); scheduler.advance(180);
  controller.pin(true); controller.popup(true);
  assert.equal(controller.escape(), 'popup');
  assert.equal(controller.state().pinned, true);
  assert.equal(controller.escape(), 'pin');
  assert.equal(controller.state().pinned, false);
  scheduler.advance(450);
  assert.equal(controller.state().visualState, 'collapsed');
  controller.pointer(true); scheduler.advance(180);
  assert.equal(controller.state().visualState, 'collapsed');
  controller.pointer(false); controller.pointer(true); scheduler.advance(180);
  assert.equal(controller.state().visualState, 'expanded');
});

test('expanded mode reports Escape as retained and state changes emit once', () => {
  const { controller, changes } = fixture({ displayMode: 'expanded' });
  assert.equal(controller.escape(), 'expanded');
  controller.pin(true);
  assert.equal(changes.length, 1);
});

test('destroy prevents delayed or later interaction emissions', () => {
  const { controller, scheduler, changes } = fixture();
  controller.pointer(true);
  controller.destroy();
  controller.focus(true);
  scheduler.advance(1000);
  assert.deepEqual(changes, []);
});

test('reduced motion reports immediate transitions while normal mode reports 420ms', () => {
  const normal = fixture(); normal.controller.pointer(true); normal.scheduler.advance(180);
  assert.equal(normal.controller.state().transitionMs, 420);
  const reduced = fixture({ reducedMotion: true }); reduced.controller.pointer(true); reduced.scheduler.advance(180);
  assert.equal(reduced.controller.state().transitionMs, 0);
});

test('placement hold expands without changing pin or focus and release resumes normal folding', () => {
  const { controller, scheduler } = fixture();
  controller.placement(true);
  assert.equal(controller.state().visualState, 'expanded');
  assert.equal(controller.state().pinned, false);
  assert.equal(controller.state().focused, false);
  controller.placement(false);
  scheduler.advance(450);
  assert.equal(controller.state().visualState, 'collapsed');
});

test('fresh schema defaults to auto while an existing schema-3 preference remains expanded', () => {
  assert.equal(sanitizedSettings({}).displayMode, 'auto');
  assert.equal(sanitizedSettings({ schemaVersion: 3, displayMode: 'expanded' }).displayMode, 'expanded');
  assert.equal(sanitizedSettings({ schemaVersion: 3 }).displayMode, 'expanded');
});

test('native 64 DIP minimum keeps the right-edge visual flush and transparent padding click-through', () => {
  const fitted = fitShapeToCanvas({ edge: 'right', width: 10, height: 79, rects: [{ x: 0, y: 0, width: 10, height: 79 }] }, 64);
  assert.deepEqual(fitted.canvas, { width: 64, height: 79 });
  assert.deepEqual(fitted.offset, { x: 54, y: 0 });
  assert.deepEqual(fitted.rects, [{ x: 54, y: 0, width: 10, height: 79 }]);
});

test('right-edge popover unfolds inward and clamps to the display work area', () => {
  assert.deepEqual(placePopover({ x: 1856, y: 343, width: 64, height: 394 }, { x: 1856, y: 480, width: 40, height: 40 }, { width: 260, height: 120 }, { x: 0, y: 0, width: 1920, height: 1040 }, 'right'), { x: 1588, y: 440, width: 260, height: 120 });
});
