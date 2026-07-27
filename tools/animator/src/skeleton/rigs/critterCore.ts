import type { RigDef } from '../Rig';

// ── Critter-core rig ───────────────────────────────────────────────────────────
// The base enemy body (design/13): "a squat single-eyed crystal critter" that gets
// re-tinted into the elemental variants (emberling/frostling/galvanist/ironclad,
// content/09). `art/units/enemy_critter.png` is still one flat neutral-grey sprite
// (no body/eye part split yet — that's separate art-production work), so this rig
// is deliberately the smallest useful skeleton: one bone. It exists so the critter
// can be previewed/animated in the editor at all (bob, hurt flash, death, spawn)
// instead of being a static image, mirroring `BOSS_CORE_RIG`'s "a new rig is new
// data, not new code" proof — no `Rig` changes needed for a one-bone body either.
export const CRITTER_CORE_RIG: RigDef = {
  id:    'critter-core',
  label: 'Critter-Core',
  bones: [
    { id: 'root', parent: null,   len: 0,  rwa: 0,   label: 'Root' },
    { id: 'body', parent: 'root', len: 40, rwa: -90, bodyR: 50, label: 'Body' },
  ],
  drawOrder:     ['body'],
  timelineBones: ['body'],
  defaultShadow: { w: 50, h: 16 },
};
