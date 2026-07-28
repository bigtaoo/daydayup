import { Rig } from './Rig';
import { ORB_CORE_RIG, ORB_CORE_REFERENCE_RADIUS } from './orbCoreRig';
import { CRITTER_CORE_RIG, CRITTER_CORE_REFERENCE_RADIUS } from './critterCoreRig';
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
  /** authoring-px radius this bundle's art was bound against — Skin.ts scales the
   *  rendered rig to an actor's gameplay `radiusPx` against THIS, not a single
   *  hardcoded constant, since different rigs (orb-core vs critter-core) have
   *  different authoring-px conventions. */
  referenceRadius: number;
}

// Three characters (design/13's launch roster, content/skins.ts's SkinDef.atlasKey
// values), one shared rig — Rig is stateless FK math over a RigDef, so all three
// skins reuse a single instance (design/12: "one rig per body archetype, many skins").
const orbCoreRig = new Rig(ORB_CORE_RIG);
const critterCoreRig = new Rig(CRITTER_CORE_RIG);
// Two more enemy body forms (design/13 "roster variety beyond the base body: a heavy
// brute, a floating ranged form") share the SAME one-bone critter-core Rig/reference
// radius — only the bound art + each skin's own binding.scaleX/Y (client/public/skins/
// <name>/animation.json) differ, exactly like the 3 orb-core characters above share
// one Rig. `content/enemies.ts`'s BRUTE/FLOATER blueprints pick these via `bodyRig`.
const RIG_DEFS: Record<string, { rig: Rig; referenceRadius: number }> = {
  char_vanguard: { rig: orbCoreRig, referenceRadius: ORB_CORE_REFERENCE_RADIUS },
  char_skirmisher: { rig: orbCoreRig, referenceRadius: ORB_CORE_REFERENCE_RADIUS },
  char_juggernaut: { rig: orbCoreRig, referenceRadius: ORB_CORE_REFERENCE_RADIUS },
  'critter-core': { rig: critterCoreRig, referenceRadius: CRITTER_CORE_REFERENCE_RADIUS },
  'brute-core': { rig: critterCoreRig, referenceRadius: CRITTER_CORE_REFERENCE_RADIUS },
  'floater-core': { rig: critterCoreRig, referenceRadius: CRITTER_CORE_REFERENCE_RADIUS },
};

const registry = new Map<string, LoadedRigSkin>();

export async function preloadRigSkin(name: string, baseUrl: string): Promise<void> {
  const entry = RIG_DEFS[name];
  if (!entry) throw new Error(`No RigDef registered for skin '${name}'`);
  const bundle = await loadRigSkinBundle(baseUrl);
  registry.set(name, { rig: entry.rig, bundle, referenceRadius: entry.referenceRadius });
}

export function getRigSkin(name: string): LoadedRigSkin | undefined {
  return registry.get(name);
}
