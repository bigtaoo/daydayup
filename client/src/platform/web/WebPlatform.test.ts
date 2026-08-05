/**
 * WebPlatform — the Web `Platform` implementation (design/04). `createApp()` is NOT
 * covered here: it constructs a real Pixi `Application` and calls a real `app.init()`
 * against a real WebGL context, the same class of gap `Game.ts`/`ArenaCanvas.mount()`
 * are documented (daydayup-testing-conventions memory) as needing a live browser, not
 * worth stubbing. `createInput`/`createAudio` are plain factories with no such
 * dependency — fully covered here.
 */
import { describe, it, expect } from 'vitest';
import { Application } from 'pixi.js';
import { WebPlatform } from './WebPlatform';
import { WebInput } from './WebInput';
import { WebAudio } from './WebAudio';

describe('WebPlatform', () => {
  it('createInput returns a fresh WebInput, ignoring the app argument (Web input never needs it)', () => {
    const platform = new WebPlatform();
    const input = platform.createInput({} as Application);
    expect(input).toBeInstanceOf(WebInput);
  });

  it('createAudio returns a fresh WebAudio', () => {
    const platform = new WebPlatform();
    expect(platform.createAudio()).toBeInstanceOf(WebAudio);
  });

  it('createInput/createAudio return a NEW instance each call, not a shared singleton', () => {
    const platform = new WebPlatform();
    expect(platform.createInput({} as Application)).not.toBe(platform.createInput({} as Application));
    expect(platform.createAudio()).not.toBe(platform.createAudio());
  });
});
