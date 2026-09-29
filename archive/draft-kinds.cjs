'use strict';

// Archived from src/drafts.cjs in 0.10.8: 출장·근무상황 drafts were removed from 초안 만들기
// because both are typed into their own NEIS screens anyway. Kept here, with its tests, to be
// reused another way later. Not part of the app build (package.json build.files).

const { dateLabel } = require('../src/drafts.cjs');

function generateNeisDraft(input) {
  if (!input || typeof input !== 'object') throw new Error('초안 입력값이 없습니다.');
  const fields = ['kind', 'title', 'purpose', 'date', 'startTime', 'endTime', 'place', 'leaveType'];
  const v = Object.fromEntries(fields.map(key => [key, typeof input[key] === 'string' ? input[key].trim().slice(0, 20000) : '']));
  if (!['trip', 'attendance'].includes(v.kind)) throw new Error('출장 또는 근무상황을 선택해 주세요.');
  if (!v.title || !v.purpose) throw new Error('제목과 목적·내용을 입력해 주세요.');
  if (v.endTime && !v.startTime) throw new Error('종료 시간 전에 시작 시간을 입력해 주세요.');
  for (const time of [v.startTime, v.endTime]) if (time && !/^([01]\d|2[0-3]):[0-5]\d$/.test(time)) throw new Error('시간 형식을 확인해 주세요.');
  if (v.startTime && v.endTime && v.startTime >= v.endTime) throw new Error('종료 시간은 시작 시간 뒤여야 합니다.');
  const when = dateLabel(v.date) + (v.startTime ? ` ${v.startTime}${v.endTime ? `~${v.endTime}` : ''}` : '');
  const lines = v.kind === 'trip'
    ? [['출장 목적', v.purpose], ['출장 일시', when], ['출장지', v.place]]
    : [['근무상황 종류', v.leaveType], ['신청 일시', when], ['사유', v.purpose]];
  const warnings = [];
  if (!v.date) warnings.push('일시 미확정');
  if (!v.place && v.kind === 'trip') warnings.push('장소 미확정');
  warnings.push('나이스의 신청 구분·시간·복무 기준을 확인한 뒤 입력하세요.');
  return { title: v.title, body: lines.filter(([, value]) => value).map(([name, value]) => `${name}: ${value}`).join('\n'), warnings };
}

module.exports = { generateNeisDraft };
