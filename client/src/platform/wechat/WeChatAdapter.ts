import type { Adapter, ICanvas, ICanvasRenderingContext2D } from 'pixi.js';

// Pixi v8 DOM adapter for the WeChat mini-game runtime.
//
// Instead of the heavyweight weapp-adapter (which globally polyfills window/document/
// Image/etc.), we implement Pixi's own `Adapter` extension point — the same one the
// built-in WebWorkerAdapter uses for the no-DOM case. This is ~1 small file we own and
// can read/patch, which matches the project's open-source-control preference.
//
// Set it via DOMAdapter.set(WeChatAdapter) BEFORE Application.init, and init with
// manageImports:false so Pixi's browser environment probe doesn't overwrite it with
// the BrowserAdapter (which calls document.createElement and would crash here).
//
// Only the surface our slice touches is implemented: createCanvas (Text rasterization),
// the two context-constructor probes (WebGL1/2 detection, text metrics). Asset/XML/font
// paths throw — the slice renders with pure Graphics and loads no remote assets.

// Cache constructors sniffed from a throwaway sub-canvas. wx sub-canvases (created after
// the main one) support only 2D, which is exactly what we need for the 2D probe.
let ctx2DCtor: { prototype: ICanvasRenderingContext2D } | null = null;

function get2DContextConstructor(): { prototype: ICanvasRenderingContext2D } {
  if (!ctx2DCtor) {
    const c = wx.createCanvas();
    const ctx = c.getContext('2d') as { constructor: { prototype: ICanvasRenderingContext2D } };
    ctx2DCtor = ctx.constructor;
  }
  return ctx2DCtor;
}

function getWebGL1Constructor(): typeof WebGLRenderingContext {
  // Modern WeChat base libraries expose the WebGL context constructors as globals.
  // Pixi only uses this for `gl instanceof <ctor>` → true means WebGL1, false WebGL2.
  if (typeof WebGLRenderingContext !== 'undefined') return WebGLRenderingContext;
  // Fallback: a never-matching stub so a WebGL2 context is (correctly) detected as v2.
  // If a device turns out to expose only WebGL1, this is where to revisit.
  return class {} as unknown as typeof WebGLRenderingContext;
}

// Pixi's Adapter interface (structural — avoids importing the type, which keeps this
// file free of the ambient DOM `Adapter` name clashes).
export const WeChatAdapter: Adapter = {
  createCanvas: (width?: number, height?: number) => {
    const c = wx.createCanvas();
    c.width = width ?? 0;
    c.height = height ?? 0;
    return c as unknown as ICanvas;
  },
  createImage: () => wx.createImage() as unknown as ReturnType<Adapter['createImage']>,
  getCanvasRenderingContext2D: () => get2DContextConstructor(),
  getWebGLRenderingContext: () => getWebGL1Constructor(),
  getNavigator: () => ({
    userAgent: 'wechat-minigame',
    gpu: null as unknown as GPU | null,
  }),
  getBaseUrl: () => '',
  getFontFaceSet: () => null,
  fetch: (_url: RequestInfo, _options?: RequestInit): Promise<Response> => {
    // The slice loads no remote assets. Wire this to wx.request/wx.downloadFile
    // if/when Assets are introduced.
    return Promise.reject(new Error('WeChatAdapter.fetch is not implemented'));
  },
  parseXML: (_xml: string): Document => {
    throw new Error('WeChatAdapter.parseXML is not implemented');
  },
};
