/**
 * WeChatPlatform — the WeChat `Platform` implementation (design/04). `createApp()` is
 * NOT covered here: it constructs a real Pixi `Application` and calls a real
 * `app.init()` against a real WebGL context (same as `WebPlatform.test.ts`'s own
 * exemption). `createInput`/`createAudio` are plain factories with no such
 * dependency — fully covered here.
 */
import { describe, it, expect } from 'vitest';
import { Application } from 'pixi.js';
import { WeChatPlatform } from './WeChatPlatform';
import { WeChatInput } from './WeChatInput';
import { WeChatAudio } from './WeChatAudio';

describe('WeChatPlatform', () => {
  it('createInput returns a fresh WeChatInput, wired to the given app', () => {
    const platform = new WeChatPlatform();
    const app = { screen: { width: 800, height: 600 } } as unknown as Application;
    expect(platform.createInput(app)).toBeInstanceOf(WeChatInput);
  });

  it('createAudio returns a fresh WeChatAudio', () => {
    const platform = new WeChatPlatform();
    expect(platform.createAudio()).toBeInstanceOf(WeChatAudio);
  });

  it('createInput/createAudio return a NEW instance each call, not a shared singleton', () => {
    const platform = new WeChatPlatform();
    const app = { screen: { width: 800, height: 600 } } as unknown as Application;
    expect(platform.createInput(app)).not.toBe(platform.createInput(app));
    expect(platform.createAudio()).not.toBe(platform.createAudio());
  });
});
