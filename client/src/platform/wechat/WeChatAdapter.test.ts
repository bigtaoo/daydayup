/**
 * WeChatAdapter — Pixi v8's DOM-adapter extension point, implemented against the `wx`
 * global instead of a real browser DOM. No real DOM/wx runtime here (plain-node
 * vitest): `wx` is a hand-rolled fake. The module caches its 2D-context constructor
 * probe (`ctx2DCtor`) at MODULE scope, so every test resets the module fresh via
 * `vi.resetModules()` + a dynamic re-import — otherwise a test earlier in file order
 * would silently pre-populate the cache for every test after it.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { Adapter } from 'pixi.js';

class Fake2DContext {}

function fakeWx() {
  const ctx2d = { constructor: Fake2DContext };
  const getContext = vi.fn((type: string) => (type === '2d' ? ctx2d : null));
  const createCanvas = vi.fn(() => ({ width: 0, height: 0, getContext }));
  const createImage = vi.fn(() => ({ src: '', width: 0, height: 0, onload: null, onerror: null }));
  return { createCanvas, createImage, getContext };
}

let wxFake: ReturnType<typeof fakeWx>;
let WeChatAdapter: Adapter;

beforeEach(async () => {
  vi.resetModules();
  vi.unstubAllGlobals();
  wxFake = fakeWx();
  vi.stubGlobal('wx', wxFake);
  ({ WeChatAdapter } = await import('./WeChatAdapter'));
});

describe('WeChatAdapter.createCanvas', () => {
  it('creates via wx.createCanvas and applies the given width/height', () => {
    const c = WeChatAdapter.createCanvas(320, 240);
    expect(wxFake.createCanvas).toHaveBeenCalledTimes(1);
    expect(c.width).toBe(320);
    expect(c.height).toBe(240);
  });

  it('defaults width/height to 0 when omitted', () => {
    const c = WeChatAdapter.createCanvas();
    expect(c.width).toBe(0);
    expect(c.height).toBe(0);
  });
});

describe('WeChatAdapter.createImage', () => {
  it('delegates straight to wx.createImage()', () => {
    const img = WeChatAdapter.createImage();
    expect(wxFake.createImage).toHaveBeenCalledTimes(1);
    expect(img).toBeDefined();
  });
});

describe('WeChatAdapter.getCanvasRenderingContext2D', () => {
  it("probes a throwaway wx canvas's 2D context and returns its constructor", () => {
    const ctor = WeChatAdapter.getCanvasRenderingContext2D();
    expect(ctor).toBe(Fake2DContext);
    expect(wxFake.createCanvas).toHaveBeenCalledTimes(1);
    expect(wxFake.getContext).toHaveBeenCalledWith('2d');
  });

  it('caches the probe — a second call reuses the constructor without creating another sub-canvas', () => {
    const first = WeChatAdapter.getCanvasRenderingContext2D();
    const second = WeChatAdapter.getCanvasRenderingContext2D();
    expect(second).toBe(first);
    expect(wxFake.createCanvas).toHaveBeenCalledTimes(1); // NOT 2 — the cache is what saved this
  });
});

describe('WeChatAdapter.getWebGLRenderingContext', () => {
  it('returns the real global WebGLRenderingContext when present (modern base library)', () => {
    class RealWebGL1 {}
    vi.stubGlobal('WebGLRenderingContext', RealWebGL1);
    expect(WeChatAdapter.getWebGLRenderingContext()).toBe(RealWebGL1);
  });

  it('falls back to a never-matching stub class when the global is absent — Pixi\'s "gl instanceof ctor" WebGL1 check always reads false, so any real gl context is (correctly) treated as WebGL2', () => {
    vi.stubGlobal('WebGLRenderingContext', undefined);
    const Stub = WeChatAdapter.getWebGLRenderingContext();
    expect(Stub).toBeTypeOf('function');
    // A real WebGL2 context is just a plain object here (no WebGL constructors exist in
    // node) — the whole point of the stub is that this reads false, unlike a real
    // WebGLRenderingContext ctor which a real WebGL1 gl object WOULD match.
    expect({} instanceof (Stub as unknown as new () => unknown)).toBe(false);
  });
});

describe('WeChatAdapter — the rest of the Adapter surface', () => {
  it('getNavigator reports a wechat-minigame user agent with no GPU', () => {
    expect(WeChatAdapter.getNavigator()).toEqual({ userAgent: 'wechat-minigame', gpu: null });
  });

  it('getBaseUrl is empty (no asset base path)', () => {
    expect(WeChatAdapter.getBaseUrl()).toBe('');
  });

  it('getFontFaceSet is null (no font loading)', () => {
    expect(WeChatAdapter.getFontFaceSet()).toBeNull();
  });

  it('fetch rejects — no remote asset loading in this slice', async () => {
    await expect(WeChatAdapter.fetch('https://example.com')).rejects.toThrow(/not implemented/i);
  });

  it('parseXML throws — no XML parsing in this slice', () => {
    expect(() => WeChatAdapter.parseXML('<a/>')).toThrow(/not implemented/i);
  });
});
