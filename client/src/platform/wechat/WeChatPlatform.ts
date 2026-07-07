import { Application, DOMAdapter } from 'pixi.js';
import type { InputSource, Platform } from '../types';
import { WeChatAdapter } from './WeChatAdapter';
import { WeChatInput } from './WeChatInput';

// WeChat mini-game platform.
//
// Design (see design/04-wechat.md):
//  - No weapp-adapter. We give Pixi our own DOMAdapter (WeChatAdapter) and init with
//    manageImports:false so Pixi's browser-environment probe can't overwrite it with
//    the BrowserAdapter (which calls document.createElement → would crash here).
//  - One main canvas from wx.createCanvas() (the FIRST call is the on-screen canvas;
//    later calls are offscreen sub-canvases). We create it before setting the adapter,
//    so the adapter's own lazy sub-canvas probes never become the main canvas.
//  - No WebGPU → force WebGL. No resizeTo/autoDensity → size explicitly, set resolution.
export class WeChatPlatform implements Platform {
  async createApp(): Promise<Application> {
    // The first wx.createCanvas() is the main (on-screen) canvas.
    const wxCanvas = wx.createCanvas();

    const info = wx.getWindowInfo();
    const resolution = Math.min(info.pixelRatio || 1, 2);

    // Pixi's EventSystem attaches DOM listeners to the canvas during init. The wx canvas
    // has no DOM event API, so give it harmless no-ops — we drive input via WeChatInput,
    // not Pixi events.
    const c = wxCanvas as unknown as {
      addEventListener?: () => void;
      removeEventListener?: () => void;
      getBoundingClientRect?: () => { x: number; y: number; width: number; height: number; left: number; top: number; right: number; bottom: number };
      style?: Record<string, unknown>;
    };
    c.addEventListener ??= () => {};
    c.removeEventListener ??= () => {};
    c.getBoundingClientRect ??= () => ({
      x: 0, y: 0, left: 0, top: 0,
      width: info.windowWidth, height: info.windowHeight,
      right: info.windowWidth, bottom: info.windowHeight,
    });
    c.style ??= {};

    // Install our adapter before init; keep Pixi from swapping it back to the browser one.
    DOMAdapter.set(WeChatAdapter);

    const app = new Application();
    await app.init({
      canvas: wxCanvas as unknown as HTMLCanvasElement,
      width: info.windowWidth,
      height: info.windowHeight,
      background: '#0b0d12',
      antialias: true,
      resolution,
      autoDensity: false,
      preference: 'webgl',
      manageImports: false,
    });
    return app;
  }

  createInput(app: Application): InputSource {
    return new WeChatInput(app);
  }
}
