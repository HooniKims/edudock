'use strict';
const EDGE_LABELS = { top: '위', right: '오른쪽', bottom: '아래', left: '왼쪽' };
window.renderGuide = ({ label, target }) => {
  document.querySelectorAll('.rail').forEach(rail => { rail.dataset.active = String(rail.dataset.edge === target); });
  document.getElementById('monitor-name').textContent = label || '';
  const hint = document.getElementById('drop-hint');
  hint.hidden = !target;
  if (target) {
    hint.dataset.edge = target;
    hint.textContent = `놓으면 ${EDGE_LABELS[target]} 가장자리에 붙어요`;
  }
};
