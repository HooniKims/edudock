'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

// Execute the actual embedded editor script. Reading the document is modelled as returning
// the viewport to the title page, reproducing the state that used to be left after filling.
const native = fs.readFileSync(path.join(__dirname, '../src/native/edufine-draft.ps1'), 'utf8');
const builder = native.slice(native.indexOf('function Build-DraftFillScript'), native.indexOf('# Read stdin as UTF-8 explicitly.'));
const writeStep = builder.match(/else \{\s*@"\r?\n([\s\S]*?)\r?\n"@/)[1];
const template = builder.match(/return @"\r?\n([\s\S]*?)\r?\n"@/)[1];

function fill({ failFinalMove = false, throwFinalMove = false, alreadyWritten = false, missingBodyTab = false, wrongTabLabel = false } = {}) {
  const title = '협의회 운영';
  const body = '1. 관련: 학교 운영 계획\n2. 운영 내용\n  가. 학년 협의';
  const fields = { 결재제목: alreadyWritten ? '기존 문서' : '', 본문: '' };
  let viewport = 'title';
  let moves = 0;
  let inserts = 0;
  let selectedTab = '결재정보';
  let tabClicks = 0;
  const bodyLink = { innerText: wrongTabLabel ? '다른 탭' : '본문', click() { tabClicks++; selectedTab = '본문'; } };
  const document = { title: '', getElementById: id => id === 'maindoc1' && !missingBodyTab
    ? { getElementsByTagName: tag => tag === 'a' ? [bodyLink] : [] } : null };
  const window = {
    IMPL_GetFieldText: (_, name) => fields[name],
    IMPL_PutFieldText: (_, name, value) => { fields[name] = value; },
    IMPL_IsDocumentUpdated: () => alreadyWritten,
    IMPL_IsFieldExist: (_, name) => name in fields,
    IMPL_MovePos: () => { viewport = 'title'; },
    IMPL_MoveToField: (_, name) => {
      moves++;
      if (moves === 2 && throwFinalMove) throw new Error('control unavailable');
      if (moves === 2 && failFinalMove) return false;
      viewport = name;
      return true;
    },
    IMPL_InsertText: (_, value) => { inserts++; fields.본문 = value; },
    editor: () => ({ GetControl: () => ({ GetTextFile: () => {
      viewport = 'title';
      return fields.결재제목 + '\r\n' + fields.본문;
    } }) }),
  };
  const script = template.replace('$titleLiteral', () => JSON.stringify(title))
    .replace('$bodyLiteral', () => JSON.stringify(body)).replace('$writeStep', () => writeStep);
  vm.runInNewContext(script, { window, document });
  return { status: document.title, viewport, selectedTab, tabClicks, inserts, fields, body };
}

test('after readback, a filled draft ends on the body without inserting it twice', () => {
  const result = fill();
  assert.equal(result.status, 'EDFILL::written|1|1');
  assert.equal(result.viewport, '본문');
  assert.equal(result.selectedTab, '본문', 'moving the caret alone leaves the approval-information tab visible');
  assert.equal(result.tabClicks, 1);
  assert.equal(result.inserts, 1);
  assert.equal(result.fields.본문, result.body.replace(/\n/g, '\r\n'));
});

test('a final navigation failure reports that the text was written and must be checked', () => {
  for (const options of [{ failFinalMove: true }, { throwFinalMove: true }, { missingBodyTab: true }, { wrongTabLabel: true }]) {
    const result = fill(options);
    assert.equal(result.status, 'EDFILL::body-view-unreachable');
    assert.equal(result.inserts, 1);
    assert.equal(result.fields.본문, result.body.replace(/\n/g, '\r\n'));
  }
});

test('existing documents are neither edited nor repositioned', () => {
  const result = fill({ alreadyWritten: true });
  assert.equal(result.status, 'EDFILL::not-blank');
  assert.equal(result.inserts, 0);
  assert.equal(result.viewport, 'title');
  assert.equal(result.selectedTab, '결재정보');
  assert.equal(result.tabClicks, 0);
  assert.equal(result.fields.결재제목, '기존 문서');
});
