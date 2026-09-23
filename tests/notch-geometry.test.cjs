const test = require('node:test');
const assert = require('node:assert/strict');

const {
  getNotchShape,
  pointInNotch,
  placeNotch,
} = require('../src/notch-geometry.cjs');
const { isInteractivePoint, shouldUseMouseFallback } = require('../src/notch-window.cjs');

test('expanded notch uses one canonical inverse-shoulder shape on all four edges', () => {
  const expected = {
    top: [394, 56],
    bottom: [394, 56],
    left: [56, 394],
    right: [56, 394],
  };

  for (const edge of Object.keys(expected)) {
    const shape = getNotchShape({ edge, state: 'expanded' });
    assert.deepEqual([shape.width, shape.height], expected[edge]);
    assert.equal(shape.depth, 56);
    assert.equal(shape.length, 394);
    assert.equal(shape.curl, 31);
    assert.equal(shape.corner, 24);
    assert.match(shape.path, /^M/);
    assert.match(shape.path, /A31 31/);
    assert.ok(shape.rects.length > 1);
    assert.ok(shape.rects.every(rect => rect.width > 0 && rect.height > 0));
  }
});

test('inverse shoulders touch the selected edge while transparent outer corners stay click-through', () => {
  const top = getNotchShape({ edge: 'top', state: 'expanded' });
  assert.equal(pointInNotch(top, top.width / 2, 0.5), true);
  assert.equal(pointInNotch(top, top.curl + 0.5, 0.5), true);
  assert.equal(pointInNotch(top, 0.5, top.height - 0.5), false);

  const right = getNotchShape({ edge: 'right', state: 'expanded' });
  assert.equal(pointInNotch(right, right.width - 0.5, right.height / 2), true);
  assert.equal(pointInNotch(right, 0.5, 0.5), false);
});

test('collapsed notch clamps both radii and keeps its invisible wake area out of native shape', () => {
  const shape = getNotchShape({ edge: 'top', state: 'collapsed' });
  assert.deepEqual([shape.width, shape.height], [79, 10]);
  assert.equal(shape.curl, 5);
  assert.equal(shape.corner, 5);
  assert.deepEqual(shape.wakeSize, { width: 79, height: 34 });
  assert.ok(shape.rects.every(rect => rect.y + rect.height <= 10));
});

test('placement is flush to work area and honors relative edge offset', () => {
  const workArea = { x: -1920, y: 40, width: 1920, height: 1040 };
  assert.deepEqual(placeNotch(workArea, getNotchShape({ edge: 'top' }), 0.5), {
    x: -1157,
    y: 40,
    width: 394,
    height: 56,
  });
  assert.deepEqual(placeNotch(workArea, getNotchShape({ edge: 'right' }), 0.25), {
    x: -56,
    y: 202,
    width: 56,
    height: 394,
  });
});

test('cursor fallback ignores transparent corners but restores input on visible actions', () => {
  const shape = getNotchShape({ edge: 'top' });
  const bounds = { x: 763, y: 0, width: shape.width, height: shape.height };
  assert.equal(isInteractivePoint(shape, bounds, { x: 764, y: 55 }), false);
  assert.equal(isInteractivePoint(shape, bounds, { x: 960, y: 28 }), true);
  assert.equal(isInteractivePoint(shape, bounds, { x: 20, y: 20 }), false);
});

test('Windows native shape stays authoritative so rapid icon entry is never polling-gated', () => {
  assert.equal(shouldUseMouseFallback('win32', true), false);
  assert.equal(shouldUseMouseFallback('win32', false), true);
  assert.equal(shouldUseMouseFallback('linux', false), true);
});
