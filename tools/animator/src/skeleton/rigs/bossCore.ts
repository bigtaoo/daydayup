import type { RigDef } from '../Rig';

// ── Boss-core rig ─────────────────────────────────────────────────────────────
// The Blight's failed/corrupted mirror of the orb-core hero (design/13): "a
// giant cracked crystal core with orbiting shard rings — the same kind of
// thing the player *is*, but corrupted." Structurally distinct from
// `ORB_CORE_RIG` (no eye/belly/weapon-sockets — a boss doesn't carry weapons
// or a material-fill chamber) but reuses the exact same orbiting-bone pattern
// as the hero's weapon sockets, just themed as broken shard rings instead —
// proving design/12's "a new rig is new data, not new code" claim: `Rig`'s
// FK math (`skeleton/Rig.ts`) needed zero changes to support this.
//
// Rest pose: `core` — the main cracked body, straight up from root, much
// larger than the hero's `shell` (a boss reads huge at a glance). `ring_a`/
// `ring_b` orbit at a wide radius on diagonal rest angles (not directly
// left/right like the hero's sockets — the concept art's rings sit askew,
// part of the "broken" read), each a jagged shard-ring fragment rather than a
// smooth tether.
export const BOSS_CORE_RIG: RigDef = {
  id:    'boss-core',
  label: 'Boss-Core',
  bones: [
    { id: 'root',   parent: null,   len: 0,  rwa: 0,   label: 'Root' },
    { id: 'core',   parent: 'root', len: 60, rwa: -90, bodyR: 70,                     label: 'Core' },
    { id: 'ring_a', parent: 'core', len: 90, rwa: 45,  bodyR: 22, outerW: 8, innerW: 4, label: 'Ring A' },
    { id: 'ring_b', parent: 'core', len: 90, rwa: 225, bodyR: 22, outerW: 8, innerW: 4, label: 'Ring B' },
  ],
  drawOrder:     ['core', 'ring_a', 'ring_b'],
  timelineBones: ['core', 'ring_a', 'ring_b'],
  defaultShadow: { w: 60, h: 20 },
};
