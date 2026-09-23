'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  createPlacementSession,
  fitScaleToDisplay,
  recoverPlacement,
  resolvePlacement,
  switchOrientation,
} = require('../src/notch-placement.cjs');
const { sanitizedSettings } = require('../src/settings.cjs');
const { getNotchShape } = require('../src/notch-geometry.cjs');

const displays = [
  { id: 1, workArea: { x: 0, y: 40, width: 1920, height: 1040 } },
  { id: 9, workArea: { x: -1600, y: -160, width: 1600, height: 900 } },
];

function placement(overrides = {}) {
  return {
    monitorId: '1',
    edge: 'right',
    offsets: { top: 0.2, right: 0.5, bottom: 0.8, left: 0.35 },
    scale: 1,
    lastEdges: { horizontal: 'bottom', vertical: 'right' },
    ...overrides,
  };
}

test('resolvePlacement uses workArea boundaries, including taskbar inset and negative coordinates', () => {
  assert.deepEqual(resolvePlacement(displays, placement(), { width: 56, height: 394 }), {
    displayId: '1',
    recovered: false,
    bounds: { x: 1864, y: 363, width: 56, height: 394 },
  });
  assert.deepEqual(resolvePlacement(displays, placement({ monitorId: '9', edge: 'top' }), { width: 394, height: 56 }), {
    displayId: '9',
    recovered: false,
    bounds: { x: -1359, y: -160, width: 394, height: 56 },
  });
});

test('missing monitor recovers to visible primary right-center safe default', () => {
  const recovered = recoverPlacement(displays, placement({ monitorId: 'removed', edge: 'bottom' }), displays[0]);
  assert.equal(recovered.recovered, true);
  assert.deepEqual(recovered.placement, {
    ...placement({ monitorId: '1', edge: 'right' }),
    offsets: { top: 0.2, right: 0.5, bottom: 0.8, left: 0.35 },
    lastEdges: { horizontal: 'bottom', vertical: 'right' },
  });
});

test('null monitor binds to primary without discarding the migrated edge, offset, or scale', () => {
  const migrated = placement({ monitorId: null, edge: 'left', scale: 1.2 });
  const recovered = recoverPlacement(displays, migrated, displays[0]);
  assert.equal(recovered.recovered, true);
  assert.equal(recovered.placement.monitorId, '1');
  assert.equal(recovered.placement.edge, 'left');
  assert.equal(recovered.placement.offsets.left, 0.35);
  assert.equal(recovered.placement.scale, 1.2);
});

test('horizontal and vertical toggle restores the last edge and its independent offset', () => {
  const horizontal = switchOrientation(placement(), 'horizontal');
  assert.equal(horizontal.edge, 'bottom');
  assert.equal(horizontal.offsets.bottom, 0.8);
  const vertical = switchOrientation({ ...horizontal, lastEdges: { horizontal: 'left', vertical: 'left' } }, 'vertical');
  assert.equal(vertical.edge, 'left');
  assert.equal(vertical.offsets.left, 0.35);
});

test('schema-3 placement derives missing orientation memory from its actual edge', () => {
  const left = sanitizedSettings({ schemaVersion: 3, placement: { edge: 'left', offsets: { left: 0.2 } } }).placement;
  assert.equal(switchOrientation(switchOrientation(left, 'horizontal'), 'vertical').edge, 'left');
  const bottom = sanitizedSettings({ schemaVersion: 3, placement: { edge: 'bottom', offsets: { bottom: 0.7 } } }).placement;
  assert.equal(switchOrientation(switchOrientation(bottom, 'vertical'), 'horizontal').edge, 'bottom');
});

test('move previews all four edges and commits exactly once only on release', () => {
  let persisted = 0;
  const session = createPlacementSession({
    displays,
    primaryDisplay: displays[0],
    placement: placement(),
    persist: () => { persisted += 1; },
  });
  session.begin({ mode: 'move', point: { x: 1912, y: 560 } });
  assert.equal(session.move({ x: 880, y: 44 }).edge, 'top');
  assert.equal(session.move({ x: 4, y: 600 }).edge, 'left');
  assert.equal(session.move({ x: 1000, y: 1076 }).edge, 'bottom');
  const right = session.move({ x: 1916, y: 700 });
  assert.equal(right.edge, 'right');
  assert.equal(right.offsets.right, 0.7167182662538699);
  assert.equal(persisted, 0);
  session.end({ commit: true });
  assert.equal(persisted, 1);
  assert.equal(session.end({ commit: true }).ok, false);
  assert.equal(persisted, 1);
});

test('move preserves an off-center grab point before snapping to another edge', () => {
  const session = createPlacementSession({ displays, primaryDisplay: displays[0], placement: placement(), persist: () => {} });
  session.begin({ mode: 'move', point: { x: 1912, y: 400 } });
  const unchanged = session.move({ x: 1912, y: 400 });
  assert.equal(unchanged.edge, 'right');
  assert.equal(unchanged.offsets.right, 0.5);
});

test('move stays on the current edge outside the 72 DIP snap corridor', () => {
  const session = createPlacementSession({ displays, primaryDisplay: displays[0], placement: placement(), persist: () => {} });
  session.begin({ mode: 'move', point: { x: 1912, y: 400 } });
  assert.equal(session.move({ x: 900, y: 520 }).edge, 'right');
  assert.equal(session.move({ x: 900, y: 100 }).edge, 'top');
});

test('Escape-style cancellation restores the exact original placement without persistence', () => {
  let persisted = 0;
  const original = placement({ monitorId: '9', edge: 'left', scale: 1.2 });
  const session = createPlacementSession({ displays, primaryDisplay: displays[0], placement: original, persist: () => { persisted += 1; } });
  session.begin({ mode: 'move', point: { x: -1598, y: 200 } });
  session.move({ x: 1918, y: 500 });
  assert.deepEqual(session.cancel().placement, original);
  assert.equal(persisted, 0);
});

test('resize clamps to 0.85..1.5 and leaves edge, monitor, and offset anchored', () => {
  const session = createPlacementSession({ displays, primaryDisplay: displays[0], placement: placement(), persist: () => {} });
  session.begin({ mode: 'resize', point: { x: 1868, y: 560 } });
  const minimum = session.move({ x: 1920, y: 560 });
  assert.equal(minimum.scale, 0.85);
  assert.equal(minimum.edge, 'right');
  assert.equal(minimum.monitorId, '1');
  assert.equal(resolvePlacement(displays, minimum, { width: 48, height: 335 }).bounds.y, 363);
  const maximum = session.move({ x: 1680, y: 560 });
  assert.equal(maximum.scale, 1.5);
  assert.equal(resolvePlacement(displays, maximum, { width: 84, height: 591 }).bounds.y, 363);
});

test('all edge resize rails reach 85% from 150% using only physically reachable cursor endpoints', () => {
  const display = { id: 21, workArea: { x: 0, y: 0, width: 1920, height: 1032 } };
  const fixtures = [
    { edge: 'right', offset: 0.7, start: { x: 1842, y: 600 }, end: { x: 1919, y: 600 } },
    { edge: 'left', offset: 0.3, start: { x: 78, y: 400 }, end: { x: 0, y: 400 } },
    { edge: 'bottom', offset: 0.8, start: { x: 1200, y: 954 }, end: { x: 1200, y: 1031 } },
    { edge: 'top', offset: 0.2, start: { x: 700, y: 78 }, end: { x: 700, y: 0 } },
  ];
  for (const fixture of fixtures) {
    const original = placement({ monitorId: '21', edge: fixture.edge, scale: 1.5, offsets: { ...placement().offsets, [fixture.edge]: fixture.offset } });
    const session = createPlacementSession({ displays: [display], primaryDisplay: display, placement: original, persist: () => {} });
    assert.equal(session.begin({ mode: 'resize', point: fixture.start }).ok, true);
    const resized = session.move(fixture.end);
    assert.equal(resized.scale, 0.85, fixture.edge);
    assert.equal(resized.edge, fixture.edge);
    assert.equal(resized.monitorId, '21');
    const shape = getNotchShape({ edge: fixture.edge, state: 'expanded', scale: resized.scale });
    const bounds = resolvePlacement([display], resized, shape, display).bounds;
    const gap = fixture.edge === 'right' ? 1920 - (bounds.x + bounds.width) : fixture.edge === 'left' ? bounds.x : fixture.edge === 'bottom' ? 1032 - (bounds.y + bounds.height) : bounds.y;
    assert.equal(gap, 0, fixture.edge);
  }
});

test('malformed placement events and NaN coordinates are inert', () => {
  const session = createPlacementSession({ displays, primaryDisplay: displays[0], placement: placement(), persist: () => {} });
  assert.deepEqual(session.begin({ mode: 'other', point: { x: 0, y: 0 } }), { ok: false, reason: 'invalid-request' });
  assert.deepEqual(session.begin({ mode: 'move', point: { x: Number.NaN, y: 0 } }), { ok: false, reason: 'invalid-request' });
  assert.deepEqual(session.move({ x: 0, y: Infinity }), { ok: false, reason: 'inactive' });
  assert.deepEqual(session.end({ commit: true }), { ok: false, reason: 'inactive' });
});

test('high-DPI-sized work areas cap scale before actions can clip', () => {
  const twoHundredPercentArea = { id: 12, workArea: { x: 0, y: 0, width: 960, height: 516 } };
  assert.equal(fitScaleToDisplay(twoHundredPercentArea, 'right', 1.5), 516 / 394);
  assert.equal(fitScaleToDisplay(twoHundredPercentArea, 'top', 1.5), 1.5);
});

test('cross-display move caps scale before preview bounds on a smaller destination', () => {
  const mixed = [
    { id: 1, workArea: { x: 0, y: 0, width: 1920, height: 1040 } },
    { id: 2, workArea: { x: 1920, y: 0, width: 960, height: 516 } },
  ];
  const session = createPlacementSession({ displays: mixed, primaryDisplay: mixed[0], placement: placement({ scale: 1.5 }), persist: () => {} });
  session.begin({ mode: 'move', point: { x: 1910, y: 520 } });
  const preview = session.move({ x: 2878, y: 250 });
  assert.equal(preview.monitorId, '2');
  assert.equal(preview.edge, 'right');
  assert.equal(preview.scale, 516 / 394);
  const shape = { width: Math.round(56 * preview.scale), height: 516 };
  assert.deepEqual(resolvePlacement(mixed, preview, shape, mixed[0]).bounds, { x: 2807, y: 0, width: 73, height: 516 });
});

test('the next monitor follows the physical left-to-right arrangement and wraps around', () => {
  const { nextMonitorId } = require('../src/notch-placement.cjs');
  const two = [
    { id: 1, bounds: { x: 0, y: 0, width: 1920, height: 1080 } },
    { id: 2, bounds: { x: -1920, y: 0, width: 1920, height: 1080 } },
  ];
  assert.equal(nextMonitorId(two, '2'), '1', 'the left display hands over to the primary on its right');
  assert.equal(nextMonitorId(two, '1'), '2', 'and wraps back to the leftmost');
  assert.equal(nextMonitorId(two, 'gone'), '2', 'an unknown monitor starts from the leftmost');
  assert.equal(nextMonitorId([{ id: 7, bounds: { x: 0, y: 0, width: 800, height: 600 } }], '7'), '7', 'a single monitor stays put');
  assert.equal(nextMonitorId([], '1'), null);
  assert.equal(nextMonitorId(null, '1'), null);
});

test('stacked monitors order top to bottom when they share a horizontal position', () => {
  const { orderedDisplays } = require('../src/notch-placement.cjs');
  const stacked = [
    { id: 'lower', bounds: { x: 0, y: 1080, width: 1920, height: 1080 } },
    { id: 'upper', bounds: { x: 0, y: 0, width: 1920, height: 1080 } },
  ];
  assert.deepEqual(orderedDisplays(stacked).map(display => display.id), ['upper', 'lower']);
});

test('notch opacity is clamped so the widget can dim but never vanish', () => {
  const { applyOpacity } = require('../src/notch-window.cjs');
  const seen = [];
  const fake = { setOpacity: value => seen.push(value) };
  assert.equal(applyOpacity(fake, 0.6), 0.6);
  assert.equal(applyOpacity(fake, 0.05), 0.3, 'an almost invisible notch would be unclickable');
  assert.equal(applyOpacity(fake, 4), 1);
  assert.equal(applyOpacity(fake, undefined), 1);
  assert.equal(applyOpacity(fake, Number.NaN), 1);
  assert.deepEqual(seen, [0.6, 0.3, 1, 1, 1]);
  assert.equal(applyOpacity({}, 0.5), null, 'a window without opacity support is left alone');
});

test('opacity settings are sanitised to the same safe range', () => {
  const { sanitizedSettings } = require('../src/settings.cjs');
  assert.equal(sanitizedSettings({}).opacity, 1);
  assert.equal(sanitizedSettings({ opacity: 0.55 }).opacity, 0.55);
  assert.equal(sanitizedSettings({ opacity: 0 }).opacity, 0.3);
  assert.equal(sanitizedSettings({ opacity: 9 }).opacity, 1);
  assert.equal(sanitizedSettings({ opacity: 'half' }).opacity, 1);
  assert.equal(sanitizedSettings({ opacity: 0.6666 }).opacity, 0.67, 'stored at a stable precision');
});
