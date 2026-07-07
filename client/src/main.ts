import { Application } from 'pixi.js';
import { Game } from './game/Game';

// Web entry. The WeChat entry is provided separately under platform/wechat (reusing the Game core).
async function boot() {
  const app = new Application();
  await app.init({
    background: '#0b0d12',
    resizeTo: window,
    antialias: true,
    resolution: Math.min(window.devicePixelRatio || 1, 2),
    autoDensity: true,
    preference: 'webgl', // WeChat has no WebGPU; use WebGL to match target-platform behavior
  });
  document.body.appendChild(app.canvas);

  const game = new Game(app);
  game.start();

  // Expose for debugging
  (globalThis as unknown as { __game: Game }).__game = game;
}

boot();
