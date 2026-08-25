// WeChat mini-game canvas -> Pixi EventSystem bridge — split out of WeChatPlatform.ts
// (2026-08-25): the game's menu/HUD Button and Slider widgets (game/ui/widgets.ts) are
// built entirely on Pixi's own interaction system (`eventMode:'static'` +
// `.on('pointertap', ...)`), which only works because a real HTMLCanvasElement
// dispatches real pointer/mouse/touch events that Pixi's EventSystem listens for. The
// wx canvas WeChatPlatform hands Pixi has no DOM event API at all — before this file
// existed, `WeChatPlatform.createApp` gave it harmless addEventListener/
// removeEventListener no-ops just so `Application.init` didn't crash calling them —
// which meant nothing ever fed Pixi's EventSystem anything to hit-test, so every
// menu/HUD Button and Slider was silently unclickable on WeChat (`TouchControls`, the
// in-run twin-stick scheme, is unaffected — it hit-tests screen-space geometry itself
// and never went through Pixi's interaction system).
//
// The fix: install a REAL (if minimal) listener registry on the canvas, and have
// WeChatInput additionally drive it per touch — treating the first touch that starts,
// while no other touch is already driving it, as a single synthetic mouse pointer.
//
// WHY the mouse shape, not the touch shape, even though the underlying data IS touch
// data: Pixi's EventSystem picks its DOM wiring once at construction from two feature
// probes — `!!globalThis.PointerEvent` and `'ontouchstart' in globalThis` — and only
// takes the touch branch if the second is true. Neither exists in the WeChat mini-game
// global scope, so it always takes the plain mouse branch regardless of what we feed
// it (`_normalizeToPointerData`'s `!globalThis.MouseEvent || ...` check passes
// unconditionally once `MouseEvent` itself doesn't exist either). Forcing the touch
// branch would additionally require faking a global `TouchEvent` class so `event
// instanceof TouchEvent` doesn't throw, for no behavioural gain — every menu/HUD
// screen here only ever needs ONE active pointer at a time anyway.
//
// The one wrinkle: Pixi's mouse branch doesn't register every listener on the canvas —
// `mouseup` goes on `globalThis`, `mousemove` on `globalThis.document` (EventSystem.js's
// own `_addEvents`, hard-coded; not something an `Adapter`/`DOMAdapter` can redirect).
// Both globals already exist and accept `addEventListener` calls in this runtime (proven
// by the fact that `Application.init()` completes at all — otherwise it would already
// have thrown reading `globalThis.navigator.msPointerEnabled` or calling one of these),
// so this wraps those two calls just long enough to also capture the handler Pixi
// registers there, then forwards to the original — nothing else that might listen on
// those globals is affected.

export type WeChatSyntheticPointerType = 'mousedown' | 'mousemove' | 'mouseup';

export interface WeChatEventBridge {
  /** Feed one synthetic pointer sample straight to whatever Pixi's EventSystem
   *  registered for this `type`, across all three targets it may have used
   *  (canvas/globalThis/document) — see module doc comment. */
  dispatch(type: WeChatSyntheticPointerType, clientX: number, clientY: number): void;
}

type Listener = (evt: unknown) => void;

interface ListenerTarget {
  addEventListener: (type: string, fn: Listener, ...rest: unknown[]) => void;
  removeEventListener?: (type: string, fn: Listener, ...rest: unknown[]) => void;
}

/**
 * Installs the registry on `canvas` (replacing whatever addEventListener/
 * removeEventListener it has) and best-effort taps `globalTarget`/`docTarget` for the
 * two event types Pixi's EventSystem registers there directly instead of on the canvas.
 * MUST run before `Application.init()` — that's when Pixi's EventSystem calls
 * `addEventListener`, and a listener registered against a still-no-op stub is lost
 * forever, not merely delayed.
 */
export function installWeChatEventBridge(
  canvas: unknown,
  globalTarget: unknown = globalThis,
  docTarget: unknown = (globalThis as { document?: unknown }).document,
): WeChatEventBridge {
  const listeners = new Map<string, Set<Listener>>();
  const on = (type: string, fn: Listener) => {
    let set = listeners.get(type);
    if (!set) listeners.set(type, (set = new Set()));
    set.add(fn);
  };
  const off = (type: string, fn: Listener) => {
    listeners.get(type)?.delete(fn);
  };

  const c = canvas as ListenerTarget;
  c.addEventListener = on;
  c.removeEventListener = off;
  tap(globalTarget, 'mouseup', on, off);
  tap(docTarget, 'mousemove', on, off);

  return {
    dispatch(type, clientX, clientY) {
      const set = listeners.get(type);
      if (!set || set.size === 0) return;
      const evt = {
        type,
        target: canvas,
        clientX,
        clientY,
        button: 0,
        buttons: type === 'mouseup' ? 0 : 1,
        // Read unconditionally by EventSystem._onPointerDown (`nativeEvent.
        // preventDefault()`) whenever the event has no `cancelable` property — which
        // ours doesn't — so this must exist or every dispatch throws.
        preventDefault() {},
      };
      // Copy the set: nothing here calls removeEventListener mid-dispatch today, but a
      // handler that did would otherwise corrupt this loop.
      for (const fn of [...set]) fn(evt);
    },
  };
}

/** Best-effort: never let a missing/unwritable global break boot over this — a target
 *  that turns out not to exist just means that event type never reaches Pixi, which is
 *  the same "menu tap does nothing" symptom this file exists to fix elsewhere, not a
 *  new failure mode. */
function tap(
  target: unknown,
  type: string,
  on: (type: string, fn: Listener) => void,
  off: (type: string, fn: Listener) => void,
): void {
  const t = target as Partial<ListenerTarget> | null | undefined;
  if (!t || typeof t.addEventListener !== 'function') return;
  try {
    const originalAdd = t.addEventListener.bind(t);
    const originalRemove = t.removeEventListener?.bind(t);
    t.addEventListener = (evtType: string, fn: Listener, ...rest: unknown[]) => {
      if (evtType === type) on(evtType, fn);
      originalAdd(evtType, fn, ...rest);
    };
    if (originalRemove) {
      t.removeEventListener = (evtType: string, fn: Listener, ...rest: unknown[]) => {
        if (evtType === type) off(evtType, fn);
        originalRemove(evtType, fn, ...rest);
      };
    }
  } catch {
    // best-effort, see doc comment above
  }
}
