import { fileURLToPath } from 'node:url';

// The single definition of the repo's cross-package source aliases, imported by every
// vite/vitest config that needs them. It mirrors tsconfig.base.json's `paths` — TypeScript
// and the bundler have to agree, and keeping the two halves adjacent (one file each) is
// what stops them drifting.
//
// These are SOURCE aliases, not published packages: the engine, the client's net layer and
// the client's game layer are consumed as .ts by everything that uses them, so there is no
// build step between packages and no chance of a stale artifact.
//
// Order matters: match the exact bare specifier to the barrel first, then fall through to
// subpath imports (@dd/engine/math/fixed → engine/math/fixed).
const dir = (rel) => fileURLToPath(new URL(rel, import.meta.url));

const ENGINE = dir('../engine');
const NET = dir('../client/src/net');
const GAME = dir('../client/src/game');

/** Just the engine — for packages that must not reach into the client (tools, and the engine itself). */
export const engineAlias = [
  { find: /^@dd\/engine$/, replacement: `${ENGINE}/index.ts` },
  { find: /^@dd\/engine\//, replacement: `${ENGINE}/` },
];

/** Engine + the client source the headless server runner shares (server/src/BotClient.ts). */
export const serverAlias = [
  ...engineAlias,
  { find: /^@dd\/net\//, replacement: `${NET}/` },
  { find: /^@dd\/game\//, replacement: `${GAME}/` },
];
