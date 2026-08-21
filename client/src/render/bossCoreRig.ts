import type { RigDef } from './Rig';

// Ported from tools/animator/src/skeleton/rigs/bossCore.ts (design/13): the Blight's
// failed/corrupted mirror of the hero orb-core — "a giant cracked crystal core with
// orbiting shard rings, the same kind of thing the player is, but corrupted." No
// eye/belly/weapon-socket bones (a boss carries no weapons, no material chamber);
// `ring_a`/`ring_b` reuse the same orbiting-bone pattern as the hero's weapon sockets,
// themed as broken shard rings instead.

/** core's bodyR (authoring px) — same role as ORB_CORE_REFERENCE_RADIUS/
 *  CRITTER_CORE_REFERENCE_RADIUS (Skin.ts scales the rendered rig to an actor's
 *  gameplay `radiusPx` against this). */
export const BOSS_CORE_REFERENCE_RADIUS = 70;

export const BOSS_CORE_RIG: RigDef = {
  id: 'boss-core',
  label: 'Boss-Core',
  bones: [
    { id: 'root', parent: null, len: 0, rwa: 0, label: 'Root' },
    { id: 'core', parent: 'root', len: 60, rwa: -90, bodyR: 70, label: 'Core' },
    { id: 'ring_a', parent: 'core', len: 90, rwa: 45, bodyR: 22, outerW: 8, innerW: 4, label: 'Ring A' },
    { id: 'ring_b', parent: 'core', len: 90, rwa: 225, bodyR: 22, outerW: 8, innerW: 4, label: 'Ring B' },
  ],
  drawOrder: ['core', 'ring_a', 'ring_b'],
  // Draws no weapon at all. The boss fires in the sim like any mob, but design/13's "giant
  // cracked crystal core with orbiting shard rings" already carries its armament — ring_a/
  // ring_b ARE it — and a raider rifle stuck to a 60-px core reads as a mob's loadout on the
  // finale. Before 2026-08-21 it drew the same 12x5 `Graphics` placeholder bar every enemy
  // did, at its ground origin, which measured as a white rectangle lying on the floor ~28
  // world px below the body's centre. 'none' is what that placeholder was standing in for.
  weaponMount: 'none',
};
