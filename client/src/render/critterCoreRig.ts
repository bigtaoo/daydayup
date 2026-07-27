import type { RigDef } from './Rig';

// Ported from tools/animator/src/skeleton/rigs/critterCore.ts (design/13): the base
// enemy body — "a squat single-eyed crystal critter" re-tinted into the elemental
// variants (emberling/frostling/galvanist/ironclad, content/enemies.ts) rather than
// authored as 4 separate art files. Deliberately the smallest useful rig: one bone.

/** body's bodyR (authoring px) — same role as ORB_CORE_REFERENCE_RADIUS (Skin.ts scales
 *  the rendered rig to an actor's gameplay `radiusPx` against this). */
export const CRITTER_CORE_REFERENCE_RADIUS = 50;

export const CRITTER_CORE_RIG: RigDef = {
  id: 'critter-core',
  label: 'Critter-Core',
  bones: [
    { id: 'root', parent: null, len: 0, rwa: 0, label: 'Root' },
    { id: 'body', parent: 'root', len: 40, rwa: -90, bodyR: 50, label: 'Body' },
  ],
  drawOrder: ['body'],
};
