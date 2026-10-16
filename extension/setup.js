'use strict';

// First-run page, opened by the extension itself right after installation. The browser only
// shows its permission dialog in answer to a click, so the [허용] here is that click.
const $ = id => document.getElementById(id);
const send = message => chrome.runtime.sendMessage(message);
let picked = null;

function pick(code) {
  picked = code;
  for (const button of $('grid').children) button.setAttribute('aria-checked', String(button.dataset.code === code));
  $('allow').disabled = !code;
  $('allow').textContent = code ? `${regionName(code)} 교육청으로 사용 허용하고 켜기` : '교육청을 먼저 골라 주세요';
}

function show(kind, text) {
  $('result').className = kind;
  $('result').textContent = text;
}

$('grid').replaceChildren(...REGIONS.map(({ code, name }) => {
  const button = document.createElement('button');
  button.type = 'button';
  button.setAttribute('role', 'radio');
  button.dataset.code = code;
  button.textContent = name;
  button.addEventListener('click', () => pick(code));
  return button;
}));

$('allow').addEventListener('click', () => {
  if (!picked) return;
  const region = picked;
  // Requested synchronously inside the click; awaiting anything first would lose the gesture.
  const request = chrome.permissions.request({ origins: regionPatterns(region) });
  void (async () => {
    try {
      const allowed = await request;
      await send({ type: 'set-region', region });
      if (!allowed) { show('warn', '권한 창에서 허용하지 않았습니다. 다시 누르고 [허용]을 직접 눌러 주세요.'); return; }
      await send({ type: 'set-enabled', enabled: true });
      show('ok', `${regionName(region)} 교육청으로 설정했고 세션 유지를 켰습니다. 업무포털에 로그인한 탭을 열어 두면 4분마다 연장합니다. 이 탭은 닫아도 됩니다.`);
    } catch {
      show('warn', '설정을 마치지 못했습니다. 잠시 뒤 다시 눌러 주세요.');
    }
  })();
});

void send({ type: 'state' }).then(state => {
  if (!state?.ok) return;
  if (isRegionCode(state.region)) pick(state.region);
  if (state.ready && state.enabled) show('ok', `${regionName(state.region)} 교육청으로 이미 설정되어 있고 세션 유지가 켜져 있습니다.`);
}).catch(() => {});
