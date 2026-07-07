// WeChat mini-game entry.
//
// No weapp-adapter: the bundle installs Pixi's own DOMAdapter (WeChatAdapter) itself,
// so the only thing this entry does is load the bundled game. The bundle is the
// build output of ../src/main.wechat.ts (see wechat/README.md, `npm run build:wechat`).
require('./js/game.js');
