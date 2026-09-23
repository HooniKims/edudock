'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { buildTransitionPlan, easeTransition, unionBounds, fitShapeToCanvas } = require('../src/notch-window.cjs');
const { getNotchShape, placeNotch } = require('../src/notch-geometry.cjs');

const workArea = { x: 0, y: 0, width: 1920, height: 1032 };
const placement = { edge: 'right', monitorId: null, offsets: { top: 0.5, right: 0.4, bottom: 0.5, left: 0.5 }, scale: 1 };

function settled(progress, edge = 'right') {
  const shape = getNotchShape({ edge, progress, scale: placement.scale });
  const fitted = fitShapeToCanvas(shape);
  return { shape, fitted, bounds: placeNotch(workArea, { edge, ...fitted.canvas }, placement.offsets[edge]) };
}

test('a fold is one window for its whole duration, sized to both end states', () => {
  // The stutter came from resizing and re-shaping the native window on every tick; the plan
  // must describe a single canvas that already contains the collapsed and expanded notch.
  const plan = buildTransitionPlan({ placement, workArea, from: 0, to: 1, durationMs: 420 });
  const collapsed = settled(0);
  const expanded = settled(1);
  assert.deepEqual(plan.canvas, unionBounds(collapsed.bounds, expanded.bounds));
  assert.equal(plan.edge, 'right');
  assert.equal(plan.durationMs, 420);
  assert.ok(plan.frames.length >= 26 && plan.frames.length <= 28, `keyframes: ${plan.frames.length}`);
});

test('keyframes start and end exactly on the settled shapes, drawn at the right place inside the canvas', () => {
  const plan = buildTransitionPlan({ placement, workArea, from: 0, to: 1, durationMs: 420 });
  const first = plan.frames[0];
  const last = plan.frames[plan.frames.length - 1];
  const collapsed = settled(0);
  const expanded = settled(1);
  assert.equal(first.state, 'collapsed');
  assert.equal(first.path, collapsed.shape.path);
  assert.equal(last.state, 'expanded');
  assert.equal(last.path, expanded.shape.path);
  assert.equal(first.at, 0);
  assert.equal(last.at, 420);
  // Every frame hugs the right screen edge: offset + depth reaches the canvas' right side.
  for (const frame of plan.frames) {
    assert.equal(frame.offset.x + frame.depth, plan.canvas.width, `frame at ${frame.at}ms leaves the edge`);
    assert.ok(frame.offset.y >= 0 && frame.offset.y + frame.length <= plan.canvas.height);
  }
  // The visual position of each end state equals what the settled window would show.
  assert.equal(plan.canvas.x + first.offset.x, collapsed.bounds.x + collapsed.fitted.offset.x);
  assert.equal(plan.canvas.y + first.offset.y, collapsed.bounds.y + collapsed.fitted.offset.y);
  assert.equal(plan.canvas.x + last.offset.x, expanded.bounds.x + expanded.fitted.offset.x);
  assert.equal(plan.canvas.y + last.offset.y, expanded.bounds.y + expanded.fitted.offset.y);
});

test('frames advance monotonically in time and only the middle ones are transitional', () => {
  const plan = buildTransitionPlan({ placement, workArea, from: 1, to: 0, durationMs: 420 });
  for (let index = 1; index < plan.frames.length; index += 1) {
    assert.ok(plan.frames[index].at > plan.frames[index - 1].at);
    assert.ok(plan.frames[index].progress <= plan.frames[index - 1].progress + 0.05, 'collapsing must not reopen');
  }
  const middle = plan.frames.slice(1, -1);
  assert.ok(middle.every(frame => frame.state === 'transition'));
  assert.equal(plan.frames[0].state, 'expanded');
  assert.equal(plan.frames[plan.frames.length - 1].state, 'collapsed');
});

test('a fold interrupted midway starts from where the eye is, not from a settled end', () => {
  // visualProgress feeds `from`; a plan from 0.4 must begin on the 0.4 shape, not on 0 or 1.
  const plan = buildTransitionPlan({ placement, workArea, from: 0.4, to: 1, durationMs: 420 * 0.6 });
  const partial = getNotchShape({ edge: 'right', progress: 0.4, scale: 1, rects: false });
  assert.equal(plan.frames[0].path, partial.path);
  assert.equal(plan.frames[0].state, 'transition');
});

test('the easing curve is clamped and reaches both ends', () => {
  assert.equal(easeTransition(0), 0);
  assert.equal(easeTransition(1), 1);
  assert.equal(easeTransition(-1), 0);
  assert.equal(easeTransition(2), 1);
  assert.ok(easeTransition(0.5) > 0.5);
});

test('horizontal edges keep every frame welded to the top of the screen', () => {
  const top = { ...placement, edge: 'top' };
  const plan = buildTransitionPlan({ placement: top, workArea, from: 0, to: 1, durationMs: 420 });
  assert.equal(plan.canvas.y, 0);
  for (const frame of plan.frames) assert.equal(frame.offset.y, 0);
});
