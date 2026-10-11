'use strict';

const $ = id => document.getElementById(id);
const HOST_NAMES = { 'sen.eduptl.kr': '업무포털', 'klef.sen.go.kr': 'K-에듀파인', 'sen.neis.go.kr': '나이스' };
const send = message => chrome.runtime.sendMessage(message);

function describe(entry) {
  const time = new Date(entry.at).toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit' });
  if (entry.note) return { cls: 'miss', text: `${time} · ${entry.note}` };
  const name = HOST_NAMES[entry.host] || entry.host;
  if (entry.status) {
    const messages = {
      'server-accepted': '기본 세션 서버 응답 확인 · 메뉴 동작·2차 인증은 별도',
      'page-error': '화면 오류 감지 · 연장 중단. 나이스 오류 안내를 확인해 주세요',
      'expired': '세션 종료 감지 · 다시 로그인해 주세요',
      'server-rejected': '서버가 세션을 확인하지 못함 · 다시 로그인해 주세요',
      'not-ready': '로그인된 메인 화면과 세션 정보를 확인하지 못함',
      'http-error': '서버 오류 · 시간은 초기화하지 않음',
      'timeout': '서버 응답 시간 초과',
      'request-failed': '연장 처리 실패 · 나이스 화면을 확인해 주세요',
      'wrong-origin': '나이스 주소가 아니므로 실행하지 않음'
    };
    return { cls: entry.status === 'server-accepted' ? 'ok' : 'miss', text: `${time} · ${name}: ${messages[entry.status] || '결과를 확인하지 못함'}` };
  }
  if (entry.error) return { cls: 'err', text: `${time} · ${name}: 실패 (${entry.error})` };
  if (!entry.clicked) return { cls: 'miss', text: `${time} · ${name}: 연장 버튼 없음${entry.before ? ` (남은 ${entry.before})` : ''}` };
  return { cls: 'ok', text: `${time} · ${name}: "${entry.clicked}" 누름 ${entry.before || '?'} → ${entry.after || '?'}` };
}

async function render() {
  const state = await send({ type: 'state' });
  $('enabled').checked = state.enabled === true;
  $('neis').hidden = state.neisAllowed === true;
  $('neis-status').textContent = state.neisAllowed
    ? '나이스도 기본으로 포함됩니다. 위의 세션 유지 설정을 함께 따릅니다.'
    : '나이스도 기본으로 포함됩니다. 처음 한 번 Edge의 사이트 접근을 허용해 주세요.';
  $('log').replaceChildren(...(state.log || []).map(entry => {
    const { cls, text } = describe(entry);
    const li = document.createElement('li');
    li.className = cls;
    li.textContent = text;
    return li;
  }));
}

async function perform(action) {
  $('message').textContent = '';
  try { const result = await action(); if (result?.ok === false) throw new Error(); }
  catch { $('message').textContent = '요청을 완료하지 못했습니다. 사이트 접근 허용과 탭 상태를 확인해 주세요.'; }
  finally { await render().catch(() => { $('message').textContent = '확장 프로그램 상태를 읽지 못했습니다.'; }); }
}
$('enabled').addEventListener('change', event => { void perform(() => send({ type: 'set-enabled', enabled: event.target.checked })); });
$('neis').addEventListener('click', () => {
  // Request directly in the user's gesture; browser permission dialogs are user-controlled.
  const permission = chrome.permissions.request({ origins: ['https://sen.neis.go.kr/*'] });
  void perform(async () => {
    if (!await permission) { $('message').textContent = '나이스 접근이 허용되지 않았습니다. 기존 사이트 설정은 유지됩니다.'; return; }
  });
});
$('run').addEventListener('click', async () => {
  $('run').disabled = true;
  try { await perform(() => send({ type: 'run-now' })); }
  finally { $('run').disabled = false; }
});
void perform(() => Promise.resolve());
