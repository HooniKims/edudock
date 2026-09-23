'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { describeDisplays, describePlacement, placementMenuTemplate } = require('../src/placement-menu.cjs');

const left = { id: 11, bounds: { x: -1920, y: 0, width: 1920, height: 1080 }, workArea: { x: -1920, y: 0, width: 1920, height: 1032 } };
const main = { id: 22, bounds: { x: 0, y: 0, width: 1920, height: 1080 }, workArea: { x: 0, y: 0, width: 1920, height: 1032 } };

test('monitors are numbered left to right and say where they sit', () => {
  const described = describeDisplays([main, left], 22);
  assert.deepEqual(described.map(display => display.label), ['모니터 1 (왼쪽 모니터)', '모니터 2 (주 모니터)']);
  assert.equal(described[1].primary, true);
});

test('placement label names the monitor only when there is more than one', () => {
  assert.equal(describePlacement(describeDisplays([main, left], 22), { monitorId: '11', edge: 'top' }, 22), '모니터 1 (왼쪽 모니터) 위 가장자리');
  assert.equal(describePlacement(describeDisplays([main], 22), { monitorId: '22', edge: 'left' }, 22), '화면 왼쪽 가장자리');
});

test('menu offers every edge of every monitor and marks the current spot', () => {
  const moves = [];
  const template = placementMenuTemplate({ displays: [main, left], primaryId: 22, placement: { monitorId: '22', edge: 'right' }, onMove: move => moves.push(move) });
  assert.equal(template.length, 2);
  assert.match(template[1].label, /지금 여기/);
  const checked = template.flatMap(item => item.submenu).filter(item => item.checked);
  assert.equal(checked.length, 1);
  template[0].submenu[0].click();
  assert.deepEqual(moves, [{ monitorId: '11', edge: 'top' }]);
});

test('single monitor menu is a flat list of edges', () => {
  const template = placementMenuTemplate({ displays: [main], primaryId: 22, placement: { monitorId: '22', edge: 'bottom' }, onMove: () => {} });
  assert.deepEqual(template.map(item => item.label), ['위 가장자리', '오른쪽 가장자리', '아래 가장자리', '왼쪽 가장자리']);
  assert.equal(template.find(item => item.checked).label, '아래 가장자리');
});

test('a monitor that disappeared falls back to the primary one', () => {
  const template = placementMenuTemplate({ displays: [main, left], primaryId: 22, placement: { monitorId: '99', edge: 'left' }, onMove: () => {} });
  assert.match(template[1].label, /지금 여기/);
});

test('drag guide overlays never take focus or clicks', () => {
  const source = fs.readFileSync('src/placement-guide.cjs', 'utf8');
  assert.match(source, /focusable: false/);
  assert.match(source, /setIgnoreMouseEvents\(true\)/);
  assert.match(source, /showInactive\(\)/);
  assert.doesNotMatch(source, /\.focus\(\)|\.show\(\)/);
});

test('settings window is opaque so text keeps ClearType', () => {
  const main = fs.readFileSync('src/main.cjs', 'utf8');
  const block = main.slice(main.indexOf('function createAuxiliaryWindow'), main.indexOf('function showAuxiliary'));
  assert.match(block, /transparent: false/);
});
