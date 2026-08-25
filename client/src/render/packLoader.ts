// Making a subpackage's files reachable before anything asks for them (design/04, design/12).
//
// On WeChat a subpackage's files do not exist until `wx.loadSubpackage` has run for it — a
// texture path inside one resolves to nothing before that, which every loader here would
// treat as "not generated yet" and silently fall back on. So the load has to be ordered
// ahead of the preload, not raced with it.
//
// **Today every pack is loaded once at boot**, by `ensureAllPacks()` from `preloadCoreArt`.
// That is deliberate and it is not the same thing as putting everything in the main package:
// WeChat's 4 MB limit is a rule about the FIRST download, so moving art into a subpackage
// satisfies it even when the subpackage is fetched moments later, and the game can start
// rendering while the rest arrives. What it avoids is the cost of real laziness — an `await`
// on the path into a room, and a frame where a biome has no stone.
//
// Making a pack genuinely lazy later is `await ensurePack('biome-ice')` at the point of use
// plus dropping it from the boot set. Nothing else moves: not the manifest, not a loader, not
// a call site. That is the whole reason this indirection exists while every pack is eager.
//
// On web this is all no-ops — there are no subpackages, the files are just served.
import { getAssetHost } from './assetHost';
import { SUBPACKS } from './assetManifest';

/** Memoised per pack: the SAME promise is returned to every caller, so two rooms entering at
 *  once cannot start two downloads, and a pack already loaded costs nothing to re-request. */
const inFlight = new Map<string, Promise<void>>();

export function ensurePack(name: string): Promise<void> {
  let p = inFlight.get(name);
  if (!p) {
    const def = SUBPACKS.find((s) => s.name === name);
    // An unknown name is main-pack content (or a typo). Resolving is right for the first and
    // survivable for the second — the asset either loads because it was in main all along, or
    // fails in the loader's own best-effort catch. Throwing here would turn a manifest typo
    // into a boot failure on the one platform that has no reload button.
    p = def ? loadPack(def.name, def.root) : Promise.resolve();
    inFlight.set(name, p);
  }
  return p;
}

async function loadPack(name: string, root: string): Promise<void> {
  const host = getAssetHost();
  if (!host.loadPack) return;
  try {
    await host.loadPack(name, root);
  } catch (err) {
    // Best-effort, exactly like every art preload: a subpackage that will not download leaves
    // its consumers on their Graphics fallbacks rather than failing boot (design/02/12,
    // "gameplay is never blocked on art").
    console.warn(`subpackage '${name}' failed to load; its art falls back to placeholders`, err);
  }
}

/** Every declared subpackage, in parallel. Called once from `preloadCoreArt`. */
export async function ensureAllPacks(): Promise<void> {
  await Promise.all(SUBPACKS.map((s) => ensurePack(s.name)));
}

/** Drops the memo table. Tests only — the map would otherwise leak a resolved promise from
 *  one test's fake host into the next test's assertions about what was loaded. */
export function resetPackLoader(): void {
  inFlight.clear();
}
