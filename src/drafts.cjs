const weekday = ['일', '월', '화', '수', '목', '금', '토'];
function dateLabel(value) {
  if (!value) return '';
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new Error('날짜 형식을 확인해 주세요.');
  const [year, month, day] = value.split('-').map(Number);
  const date = new Date(year, month - 1, day);
  if (date.getFullYear() !== year || date.getMonth() !== month - 1 || date.getDate() !== day) throw new Error('유효한 날짜를 입력해 주세요.');
  return `${year}. ${month}. ${day}.(${weekday[date.getDay()]})`;
}
function generateDraft(input) {
  if (!input || typeof input !== 'object') throw new Error('초안 입력값이 없습니다.');
  const fields = ['kind', 'title', 'purpose', 'basis', 'date', 'startTime', 'endTime', 'place', 'audience', 'attachments', 'leaveType'];
  const v = Object.fromEntries(fields.map(key => [key, typeof input[key] === 'string' ? input[key].trim().slice(0, 20000) : '']));
  if (!['official', 'trip', 'attendance'].includes(v.kind)) throw new Error('초안 종류를 선택해 주세요.');
  if (!v.title || !v.purpose) throw new Error('제목과 목적·내용을 입력해 주세요.');
  if (v.endTime && !v.startTime) throw new Error('종료 시간 전에 시작 시간을 입력해 주세요.');
  for (const time of [v.startTime, v.endTime]) if (time && !/^([01]\d|2[0-3]):[0-5]\d$/.test(time)) throw new Error('시간 형식을 확인해 주세요.');
  if (v.startTime && v.endTime && v.startTime >= v.endTime) throw new Error('종료 시간은 시작 시간 뒤여야 합니다.');
  const warnings = [];
  const when = dateLabel(v.date) + (v.startTime ? ` ${v.startTime}${v.endTime ? `~${v.endTime}` : ''}` : '');
  const attachments = v.attachments.split('\n').map(x => x.trim()).filter(Boolean);
  if (!v.date) warnings.push('일시 미확정');
  if (!v.place && v.kind !== 'attendance') warnings.push('장소 미확정');
  if (v.kind === 'official' && !v.basis) warnings.push('관련 근거가 없어 관련 항목을 생략했습니다.');
  if (attachments.length) warnings.push('붙임 표기만 작성했습니다. 실제 파일 첨부와 개수를 확인하세요.');
  let body;
  if (v.kind === 'official') {
    const lines = []; let number = 1;
    if (v.basis) lines.push(`${number++}. 관련: ${v.basis}`);
    lines.push(`${number}. ${v.purpose}`);
    const details = [['일시', when], ['장소', v.place], ['대상', v.audience]].filter(([,value]) => value);
    details.forEach(([name, value], i) => lines.push(`  ${'가나다라마바사'[i]}. ${name}: ${value}`));
    body = lines.join('\n');
    if (attachments.length) {
      const appendix = attachments.map((name, i) => `${i ? '      ' : '붙임  '}${attachments.length > 1 ? `${i + 1}. ` : ''}${name.replace(/\.$/, '')}${i === attachments.length - 1 ? '.  끝.' : ''}`).join('\n');
      body += `\n\n${appendix}`;
    } else body += '  끝.';
    warnings.push('과제카드·결재경로·공람은 현재 조직도와 문서 내용으로 확인해야 합니다.');
  } else {
    const lines = v.kind === 'trip' ? [['출장 목적', v.purpose], ['출장 일시', when], ['출장지', v.place]] : [['근무상황 종류', v.leaveType], ['신청 일시', when], ['사유', v.purpose]];
    body = lines.filter(([,value]) => value).map(([name,value]) => `${name}: ${value}`).join('\n');
    warnings.push('나이스의 신청 구분·시간·복무 기준을 확인한 뒤 입력하세요.');
  }
  return { title: v.title, body, warnings, metadata: { kind: v.kind, disclosure: '비공개', disclosureReason: '6호', keywords: '', submission: '작성 전 검토', source: '사용자 입력', approvalRoles: ['담당 부장(검토)', '교감 또는 직무대리(검토)', '교장(결재)'] } };
}
module.exports = { generateDraft, dateLabel };
