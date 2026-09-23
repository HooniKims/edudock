'use strict';

// First-run walkthrough. Each step points at one real notch button so the popover appears
// next to the thing it describes; the last step offers to remember the certificate password.

const BUTTON_STEPS = Object.freeze({
  neis: { title: '나이스', body: '버튼 하나로 나이스 첫 화면까지 갑니다. 로그인이 풀려 있으면 인증서 창도 알아서 띄웁니다.' },
  edufine: { title: 'K-에듀파인', body: 'K-에듀파인을 엽니다. 이미 열어 둔 창이 있으면 새로 띄우지 않고 그 창으로 갑니다.' },
  attendance: { title: '개인근무상황', body: '복무 메뉴를 거쳐 개인근무상황 화면까지 데려다줍니다. 신청은 직접 누르세요.' },
  trip: { title: '출장', body: '출장 화면을 바로 띄웁니다. 내용은 확인하고 상신하세요.' },
  draft: { title: '일반기안문', body: '공용서식에서 일반기안문을 꺼내 줍니다. 떠 있는 기안창이 있으면 그 창을 앞으로 올립니다.' },
  compose: { title: '초안 만들기', body: '기안 문구를 미리 다듬어 보는 창입니다. 복사하거나 파일로 저장하세요.' },
  settings: { title: '설정', body: '위치와 크기, 투명도, 버튼 순서를 여기서 바꿉니다. 이 안내도 다시 볼 수 있어요.' },
});

const PASSWORD_STEP = Object.freeze({
  id: 'password',
  kind: 'password-offer',
  button: null,
  title: '비밀번호를 저장할까요?',
  body: '저장해 두면 다음부터 버튼만 눌러도 로그인까지 갑니다. 비밀번호는 이 컴퓨터에 안전하게 보관됩니다.',
});

function buildSteps({ buttons = [], includePasswordOffer = true } = {}) {
  const seen = new Set();
  const steps = [];
  for (const button of buttons) {
    if (!Object.hasOwn(BUTTON_STEPS, button) || seen.has(button)) continue;
    seen.add(button);
    steps.push(Object.freeze({ id: button, kind: 'button', button, ...BUTTON_STEPS[button] }));
  }
  if (!seen.has('settings') && Object.hasOwn(BUTTON_STEPS, 'settings')) {
    steps.push(Object.freeze({ id: 'settings', kind: 'button', button: 'settings', ...BUTTON_STEPS.settings }));
  }
  if (includePasswordOffer) steps.push(PASSWORD_STEP);
  return Object.freeze(steps);
}

class GuideSession {
  #steps;
  #index;
  #finished;
  #outcome;

  constructor({ buttons = [], includePasswordOffer = true } = {}) {
    this.#steps = buildSteps({ buttons, includePasswordOffer });
    this.#index = 0;
    this.#finished = this.#steps.length === 0;
    this.#outcome = this.#finished ? 'completed' : null;
  }

  get steps() { return this.#steps; }
  get finished() { return this.#finished; }
  get outcome() { return this.#outcome; }

  current() {
    if (this.#finished) return null;
    const step = this.#steps[this.#index];
    return Object.freeze({ ...step, index: this.#index, total: this.#steps.length, last: this.#index === this.#steps.length - 1 });
  }

  next() {
    if (this.#finished) return null;
    if (this.#index >= this.#steps.length - 1) {
      this.#finished = true;
      this.#outcome = 'completed';
      return null;
    }
    this.#index += 1;
    return this.current();
  }

  skip() {
    if (this.#finished) return null;
    this.#finished = true;
    this.#outcome = 'skipped';
    return null;
  }
}

// The walkthrough runs once per install. A user who skipped it still counts as having seen it,
// so it never reappears on its own; settings offers an explicit "다시 보기".
function shouldAutoStart(settings) {
  return settings?.guideCompleted !== true;
}

module.exports = { BUTTON_STEPS, PASSWORD_STEP, buildSteps, GuideSession, shouldAutoStart };
