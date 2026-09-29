'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createSavedDrafts, MAX_ITEMS } = require('../src/saved-drafts.cjs');

function store() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'edudock-saved-'));
  let tick = 0;
  return { directory, drafts: createSavedDrafts({ directory, now: () => new Date(Date.UTC(2026, 8, 29, 1, 0, tick++)) }) };
}

test('saved drafts survive a restart, newest first, and re-saving a title replaces it', () => {
  const { directory, drafts } = store();
  assert.deepEqual(drafts.list(), []);
  drafts.save({ title: '협의회 운영', body: '1. 협의회를 운영합니다.  끝.' });
  drafts.save({ title: '연수 참석', body: '1. 연수에 참석합니다.  끝.' });
  drafts.save({ title: '협의회 운영', body: '1. 수정한 본문.  끝.' });
  const reopened = createSavedDrafts({ directory });
  assert.deepEqual(reopened.list().map(item => [item.title, item.body]), [['협의회 운영', '1. 수정한 본문.  끝.'], ['연수 참석', '1. 연수에 참석합니다.  끝.']]);
  const [first] = reopened.list();
  assert.deepEqual(reopened.remove(first.id).map(item => item.title), ['연수 참석']);
  fs.rmSync(directory, { recursive: true, force: true });
});

test('empty drafts are refused and a damaged file reads as an empty list', () => {
  const { directory, drafts } = store();
  assert.throws(() => drafts.save({ title: '', body: 'x' }), /제목/);
  assert.throws(() => drafts.save({ title: '제목', body: '   ' }), /초안 내용/);
  fs.writeFileSync(drafts.file, '{not json');
  assert.deepEqual(drafts.list(), []);
  fs.rmSync(directory, { recursive: true, force: true });
});

test('the list is capped', () => {
  const { directory, drafts } = store();
  for (let i = 0; i < MAX_ITEMS + 5; i += 1) drafts.save({ title: `초안 ${i}`, body: '본문' });
  assert.equal(drafts.list().length, MAX_ITEMS);
  assert.equal(drafts.list()[0].title, `초안 ${MAX_ITEMS + 4}`);
  fs.rmSync(directory, { recursive: true, force: true });
});
