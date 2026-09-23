'use strict';

const ENTER_DELAY_MS = 180;
const FOLD_DELAY_MS = 450;
const TRANSITION_MS = 420;

function createInteractionController(options = {}) {
  const scheduler = options.scheduler || globalThis;
  const onChange = typeof options.onChange === 'function' ? options.onChange : () => {};
  let displayMode = options.displayMode === 'expanded' ? 'expanded' : 'auto';
  let visualState = displayMode === 'expanded' ? 'expanded' : 'collapsed';
  let pointerInside = false;
  let focused = false;
  let popupOpen = false;
  let pinned = false;
  let placing = false;
  let enterTimer = null;
  let foldTimer = null;
  let suppressWakeUntilLeave = false;
  let destroyed = false;
  let reducedMotion = Boolean(options.reducedMotion);

  function snapshot() {
    return {
      displayMode,
      visualState,
      pointerInside,
      focused,
      popupOpen,
      pinned,
      placing,
      transitionMs: reducedMotion ? 0 : TRANSITION_MS,
    };
  }

  function emit() { if (!destroyed) onChange(snapshot()); }
  function clearEnter() { if (enterTimer !== null) scheduler.clearTimeout(enterTimer); enterTimer = null; }
  function clearFold() { if (foldTimer !== null) scheduler.clearTimeout(foldTimer); foldTimer = null; }
  function heldOpen() { return displayMode === 'expanded' || (pointerInside && !suppressWakeUntilLeave) || focused || popupOpen || pinned || placing; }

  function expand() {
    if (destroyed) return false;
    clearEnter();
    clearFold();
    if (visualState === 'expanded') return false;
    visualState = 'expanded';
    emit();
    return true;
  }

  function queueFold() {
    if (destroyed) return;
    clearEnter();
    clearFold();
    if (heldOpen() || visualState === 'collapsed') return;
    foldTimer = scheduler.setTimeout(() => {
      foldTimer = null;
      if (heldOpen()) return;
      visualState = 'collapsed';
      emit();
    }, FOLD_DELAY_MS);
  }

  function pointer(inside) {
    if (destroyed) return;
    pointerInside = Boolean(inside);
    if (!pointerInside) suppressWakeUntilLeave = false;
    if (pointerInside && suppressWakeUntilLeave) return;
    if (!pointerInside) {
      queueFold();
      return;
    }
    clearFold();
    if (visualState === 'expanded' || enterTimer !== null) return;
    enterTimer = scheduler.setTimeout(() => {
      enterTimer = null;
      if (pointerInside) expand();
    }, ENTER_DELAY_MS);
  }

  function focus(inside) {
    if (destroyed) return;
    focused = Boolean(inside);
    if (focused) expand(); else queueFold();
  }

  function popup(open) {
    if (destroyed) return;
    popupOpen = Boolean(open);
    if (popupOpen) expand(); else queueFold();
  }

  function pin(next) {
    if (destroyed) return;
    pinned = typeof next === 'boolean' ? next : !pinned;
    const visualChanged = pinned ? expand() : (queueFold(), false);
    if (!visualChanged) emit();
  }

  function mode(next) {
    if (destroyed) return false;
    if (next !== 'auto' && next !== 'expanded') return false;
    displayMode = next;
    const visualChanged = displayMode === 'expanded' ? expand() : (queueFold(), false);
    if (!visualChanged) emit();
    return true;
  }

  function placement(next) {
    if (destroyed) return false;
    placing = Boolean(next);
    const visualChanged = placing ? expand() : (queueFold(), false);
    if (!visualChanged) emit();
    return true;
  }

  function escape() {
    if (destroyed) return 'destroyed';
    if (popupOpen) { popup(false); return 'popup'; }
    if (pinned) {
      focused = false;
      suppressWakeUntilLeave = true;
      pin(false);
      return 'pin';
    }
    focused = false;
    if (displayMode === 'expanded') return 'expanded';
    suppressWakeUntilLeave = true;
    queueFold();
    return 'collapse';
  }

  function reduce(next) { if (!destroyed) reducedMotion = Boolean(next); return snapshot(); }

  function destroy() { destroyed = true; clearEnter(); clearFold(); }

  return { state: snapshot, pointer, focus, popup, pin, mode, placement, reduce, escape, expand, destroy };
}

module.exports = { createInteractionController, ENTER_DELAY_MS, FOLD_DELAY_MS, TRANSITION_MS };
