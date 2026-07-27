import { Rig } from './Rig';
import { ORB_CORE_RIG } from './orbCoreRig';
import { loadRigSkinBundle, type RigSkinBundle } from './taoBundle';

// Preload real art at boot (design/12: "load a core bundle at boot"), then hand
// out already-resolved bundles synchronously. Actor/Skin construction happens
// mid-tick in Scene.reconcile's hot loop (no await available there), so the
// registry is the seam: async once at boot, sync forever after. A skin that
// hasn't (or never will) preload just falls back to Skin's Graphics placeholder
// — "gameplay is never blocked on art" (design/02/12), not an error state.
export interface LoadedRigSkin {
  rig: Rig;
  bundle: RigSkinBundle;
}

const RIG_DEFS: Record<string, Rig> = {
  'orb-core': new Rig(ORB_CORE_RIG),
};

const registry = new Map<string, LoadedRigSkin>();

export async function preloadRigSkin(name: string, baseUrl: string): Promise<void> {
  const rig = RIG_DEFS[name];
  if (!rig) throw new Error(`No RigDef registered for skin '${name}'`);
  const bundle = await loadRigSkinBundle(baseUrl);
  registry.set(name, { rig, bundle });
}

export function getRigSkin(name: string): LoadedRigSkin | undefined {
  return registry.get(name);
}
