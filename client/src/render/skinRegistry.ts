import { Rig } from './Rig';
import { ORB_CORE_RIG, ORB_CORE_REFERENCE_RADIUS } from './orbCoreRig';
import { CRITTER_CORE_RIG, CRITTER_CORE_REFERENCE_RADIUS } from './critterCoreRig';
import { BOSS_CORE_RIG, BOSS_CORE_REFERENCE_RADIUS } from './bossCoreRig';
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
  /** How much of `referenceRadius` this bundle's body art actually PAINTS: its opaque
   *  half-width divided by the body bone's `bodyR`. See `BODY_FILL` for what it is for. */
  bodyFill: number;
}

// Three characters (design/13's launch roster, content/skins.ts's SkinDef.atlasKey
// values), one shared rig — Rig is stateless FK math over a RigDef, so all three
// skins reuse a single instance (design/12: "one rig per body archetype, many skins").
const orbCoreRig = new Rig(ORB_CORE_RIG);
const critterCoreRig = new Rig(CRITTER_CORE_RIG);
const bossCoreRig = new Rig(BOSS_CORE_RIG);
// Two more enemy body forms (design/13 "roster variety beyond the base body: a heavy
// brute, a floating ranged form") share the SAME one-bone critter-core Rig/reference
// radius — only the bound art + each skin's own binding.scaleX/Y (client/public/skins/
// <name>/animation.json) differ, exactly like the 3 orb-core characters above share
// one Rig. `content/enemies.ts`'s BRUTE/FLOATER blueprints pick these via `bodyRig`.
// Exported for `rigComposition.test.ts`, which checks every SHIPPED bundle's real
// animation.json against the rig it will actually be rendered with — it has to resolve
// skin name → rig the same way the game does, not from a hand-copied table that could
// drift away from this one.
export const RIG_DEFS: Record<string, { rig: Rig; referenceRadius: number }> = {
  char_vanguard: { rig: orbCoreRig, referenceRadius: ORB_CORE_REFERENCE_RADIUS },
  char_skirmisher: { rig: orbCoreRig, referenceRadius: ORB_CORE_REFERENCE_RADIUS },
  char_juggernaut: { rig: orbCoreRig, referenceRadius: ORB_CORE_REFERENCE_RADIUS },
  'critter-core': { rig: critterCoreRig, referenceRadius: CRITTER_CORE_REFERENCE_RADIUS },
  'brute-core': { rig: critterCoreRig, referenceRadius: CRITTER_CORE_REFERENCE_RADIUS },
  'floater-core': { rig: critterCoreRig, referenceRadius: CRITTER_CORE_REFERENCE_RADIUS },
  'boss-core': { rig: bossCoreRig, referenceRadius: BOSS_CORE_REFERENCE_RADIUS },
};

/**
 * Per-skin ratio of the body art's OPAQUE half-width to the body bone's `bodyR`, i.e. how
 * much of its declared radius each bundle's art actually paints (2026-08-19 volume pass).
 *
 * Needed because a bone's `bodyR` is the rig's *declared* body radius while the PNG bound to
 * it is a square canvas with transparent margins — and the margin differs wildly per bundle:
 * `critter-core`'s crystal paints 0.70 of its bodyR, `brute-core`'s art fills its canvas
 * edge-to-edge at 1.00. Anything sized off `bodyR` (or off the gameplay radius, which equals
 * it for every rig here, since every `referenceRadius` IS the body bone's `bodyR`) is
 * therefore sized off a box that can be 45% wider than the creature inside it. That is
 * exactly what made a ground shadow read as a black dinner plate the enemy sat in — the
 * shadow was scaled to the box, not to the art.
 *
 * Measured, not guessed: `tools/png-pipeline/pngCodec.mjs` decodes each shipped body PNG and
 * `rigComposition.test.ts` re-measures the alpha bounding box of the REAL files on every run
 * and fails if a number here drifts from it. So re-cropping or replacing a body texture
 * cannot silently leave the shadow sized for the old art — which is the same cross-layer
 * failure mode as the 2026-08-19 `footprintRadius` bug, caught the same way.
 */
export const BODY_FILL: Readonly<Record<string, number>> = {
  char_vanguard: 0.81,
  char_skirmisher: 0.69,
  char_juggernaut: 0.87,
  'critter-core': 0.7,
  'brute-core': 1,
  'floater-core': 1,
  'boss-core': 0.68,
};
/** Fallback for a skin with no measured entry — assume the art fills its declared radius,
 *  which is the conservative direction (a shadow slightly too big, never a missing one). */
export const BODY_FILL_DEFAULT = 1;

const registry = new Map<string, LoadedRigSkin>();

export async function preloadRigSkin(name: string, baseUrl: string): Promise<void> {
  const entry = RIG_DEFS[name];
  if (!entry) throw new Error(`No RigDef registered for skin '${name}'`);
  const bundle = await loadRigSkinBundle(baseUrl);
  registry.set(name, {
    rig: entry.rig,
    bundle,
    referenceRadius: entry.referenceRadius,
    bodyFill: BODY_FILL[name] ?? BODY_FILL_DEFAULT,
  });
}

export function getRigSkin(name: string): LoadedRigSkin | undefined {
  return registry.get(name);
}
