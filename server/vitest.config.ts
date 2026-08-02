import { defineConfig } from 'vitest/config';
// @ts-expect-error — plain .mjs helper, shared with every other vite/vitest config here.
import { serverAlias } from '../build/ddAlias.mjs';

// The server consumes @dd/engine from the sibling engine package's source (design/06
// "server via workspace dependency; same bytes on both sides"), plus @dd/net and @dd/game
// for the PvP bot-fill runner (server/src/BotClient.ts): the client's CoopSession +
// Transport contract and the shared pvpConfig/PvpBotController are source, not a published
// package. tsconfig.base.json's `paths` is the type-side mirror of this same map.
export default defineConfig({
  resolve: { alias: serverAlias },
});
