import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

// The server consumes @dd/engine from the client package's source (design/06 "server via
// workspace dependency; same bytes on both sides"). Mirror the client's alias so tests
// and the dev entrypoint resolve the engine identically. @dd/net and @dd/game (added for
// the PvP bot-fill runner, server/src/BotClient.ts) follow the same pattern: the client's
// CoopSession + Transport contract and the shared pvpConfig/PvpBotController are source,
// not a published package, and the server imports them the same way it already does the
// engine — mirrored in tsconfig.json's `paths` for the tsx dev entrypoint.
const engineDir = fileURLToPath(new URL('../client/src/engine', import.meta.url));
const netDir = fileURLToPath(new URL('../client/src/net', import.meta.url));
const gameDir = fileURLToPath(new URL('../client/src/game', import.meta.url));

export default defineConfig({
  resolve: {
    alias: [
      { find: /^@dd\/engine$/, replacement: `${engineDir}/index.ts` },
      { find: /^@dd\/engine\//, replacement: `${engineDir}/` },
      { find: /^@dd\/net\//, replacement: `${netDir}/` },
      { find: /^@dd\/game\//, replacement: `${gameDir}/` },
    ],
  },
});
