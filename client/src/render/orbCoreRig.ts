import type { RigDef } from './Rig';

// Ported from tools/animator/src/skeleton/rigs/orbCore.ts (design/12/13): the
// hero's own rig, root -> shell -> eye + belly + 2 orbiting weapon-socket bones.
// No arms/legs/walk-cycle — motion is hover-bob, lean-into-travel, squash-stretch.

/** shell's bodyR (authoring px) — the rig's own notion of "body radius", used to
 *  scale the rendered rig to an actor's gameplay `radiusPx` (Skin.ts). */
export const ORB_CORE_REFERENCE_RADIUS = 40;

export const ORB_CORE_RIG: RigDef = {
  id: 'orb-core',
  label: 'Orb-Core',
  bones: [
    { id: 'root', parent: null, len: 0, rwa: 0, label: 'Root' },
    { id: 'shell', parent: 'root', len: 46, rwa: -90, bodyR: 40, label: 'Shell' },
    { id: 'eye', parent: 'shell', len: 0, rwa: 0, bodyR: 16, label: 'Eye' },
    { id: 'belly', parent: 'shell', len: 20, rwa: 90, bodyR: 20, label: 'Belly' },
    { id: 'socket_l', parent: 'shell', len: 52, rwa: 180, bodyR: 13, outerW: 6, innerW: 3, label: 'Socket L' },
    { id: 'socket_r', parent: 'shell', len: 52, rwa: 0, bodyR: 13, outerW: 6, innerW: 3, label: 'Socket R' },
  ],
  drawOrder: ['shell', 'belly', 'eye', 'socket_l', 'socket_r'],
};
