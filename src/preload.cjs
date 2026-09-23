const { contextBridge, ipcRenderer } = require('electron');
const invoke = channel => value => ipcRenderer.invoke(channel, value);
function listen(channel, callback) {
  const listener = (_event, data) => callback(data);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
}
contextBridge.exposeInMainWorld('portal', {
  getState: invoke('state'), settings: invoke('settings'), window: invoke('window'), resize: invoke('resize'),
  openMenu: invoke('open-menu'), generateDraft: invoke('generate-draft'), copy: invoke('copy'), saveDraft: invoke('save-draft'),
  openAuxiliary: invoke('open-auxiliary'), cancelAuth: invoke('cancel-auth'), retryAuth: invoke('retry-auth'), getDiagnostics: invoke('diagnostics'),
  notchInteraction: invoke('notch-interaction'), showPopover: invoke('show-popover'), hidePopover: invoke('hide-popover'),
  notchPlacement: invoke('notch-placement'), notchMove: invoke('notch-move'), notchContextMenu: invoke('notch-context-menu'), placementOrientation: invoke('placement-orientation'),
  guideStart: invoke('guide-start'), guideNext: invoke('guide-next'), guideSkip: invoke('guide-skip'),
  guideSavePassword: invoke('guide-save-password'), clearPassword: invoke('clear-password'), savePassword: invoke('save-password'),
  updateCheck: invoke('update-check'), updateInstall: invoke('update-install'), updateOpenPage: invoke('update-open-page'),
  onStatus: callback => listen('status', callback), onState: callback => listen('state-update', callback),
  onAuxView: callback => listen('aux-view', callback), onNotchShape: callback => listen('notch-shape', callback),
  onNotchAnimate: callback => listen('notch-animate', callback),
  onPopoverData: callback => listen('popover-data', callback), onNotchFocusFirst: callback => listen('notch-focus-first', callback),
  onGuideStep: callback => listen('guide-step', callback),
});
