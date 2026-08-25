// Bundle boundaries, runtime half (design/12 "Bundle boundaries", design/04).
//
// Answers one question for a shipped asset path: which package does it live in, and what
// does its path look like once it is there. The DATA lives in `assetPacks.json` — see that
// file's own $comment for why it is JSON rather than TypeScript (plain Node reads the same
// table for the byte-budget gate and the WeChat copy step, so the two cannot drift).
//
// Web never needs any of this: its assets are served from the site root and `AssetHost`'s
// web implementation is the identity function. It exists for WeChat, where a subpackage's
// files sit under that subpackage's `root` and are unreachable until `wx.loadSubpackage`
// has run — see `packLoader.ts` for when that happens.
import packs from './assetPacks.json';

export interface PackDef {
  name: string;
  /** Directory prefix inside the WeChat project. '' for the main package. */
  root: string;
  /** Hard byte ceiling for this package (WeChat: 4 MB main / independent subpackage). */
  limitBytes: number;
  note?: string;
}

export const PACKS: readonly PackDef[] = packs.packs;
export const DEFAULT_PACK: string = packs.defaultPack;
/** Ceiling for main + every subpackage together (WeChat: 30 MB). */
export const TOTAL_LIMIT_BYTES: number = packs.totalLimitBytes;

/** Every pack that is NOT the main one, i.e. every WeChat subpackage. These are the packs
 *  whose files do not exist until `wx.loadSubpackage` has run for them. */
export const SUBPACKS: readonly PackDef[] = PACKS.filter((p) => p.name !== packs.defaultPack);

interface PackRule {
  prefix: string;
  pack: string;
}
const RULES: readonly PackRule[] = packs.rules as readonly PackRule[];

/** Which package a public-relative asset path ('/biome/floor_ice.png') belongs to.
 *  First matching prefix rule wins; unmatched paths fall to `defaultPack`. */
export function packOf(path: string): string {
  return RULES.find((r) => path.startsWith(r.prefix))?.pack ?? DEFAULT_PACK;
}

/** The declared package by name. Throws rather than silently defaulting: a rule naming a
 *  pack that does not exist is a manifest bug, and the byte gate can only be trusted if
 *  every asset lands in a package with a real budget. */
export function packDef(name: string): PackDef {
  const def = PACKS.find((p) => p.name === name);
  if (!def) throw new Error(`assetPacks.json: no pack named '${name}'`);
  return def;
}

/** Where `path` actually lives inside the WeChat project — the value handed to
 *  `wx.createImage().src` / `FileSystemManager.readFileSync`. WeChat resolves a package
 *  path from the project root, so the leading slash of the web-relative form goes away
 *  (the docs allow both 'a/b/c' and '/a/b/c', but never './a/b/c'; the relative form is
 *  what every mini-game sample uses), and a subpackage's files sit under its `root`. */
export function packedPathFor(path: string): string {
  const root = packDef(packOf(path)).root;
  const rel = path.startsWith('/') ? path.slice(1) : path;
  return root ? `${root}/${rel}` : rel;
}
