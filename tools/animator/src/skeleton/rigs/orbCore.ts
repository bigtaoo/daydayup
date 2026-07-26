import type { RigDef } from '../Rig';

// ── Orb-core rig ──────────────────────────────────────────────────────────────
// DayDayUp's hero (design/12, design/13): a legless floating spherical core.
// No arms/legs, no walk cycle — root → shell → eye + belly-fill + 2 orbiting
// weapon-socket bones. `root` is the invisible ground anchor the game's local
// position lands on; every visible bone hangs off `shell`.
//
// Rest pose (character facing the camera, aiming toward the bottom of the
// screen — the "front" hemisphere per design/12's facing model):
//   shell  — the main body sphere, straight up from root.
//   eye    — zero-length, sits at the shell's own center (the big front eye /
//            back vent swap is content, not rig — the bone just needs to exist).
//   belly  — offset down from shell center (the crystal-fill chamber).
//   socket_l / socket_r — orbit left/right at shell-center height on a tether
//            (len = tether length); a weapon module sprite parents to whichever
//            socket is equipped and follows its FK pose (design/12).
export const ORB_CORE_RIG: RigDef = {
  id:    'orb-core',
  label: 'Orb-Core',
  bones: [
    { id: 'root',     parent: null,    len: 0,  rwa: 0,   label: 'Root' },
    { id: 'shell',    parent: 'root',  len: 46, rwa: -90, bodyR: 40,                     label: 'Shell' },
    { id: 'eye',      parent: 'shell', len: 0,  rwa: 0,   bodyR: 16,                     label: 'Eye' },
    { id: 'belly',    parent: 'shell', len: 20, rwa: 90,  bodyR: 20,                     label: 'Belly' },
    { id: 'socket_l', parent: 'shell', len: 52, rwa: 180, bodyR: 13, outerW: 6, innerW: 3, label: 'Socket L' },
    { id: 'socket_r', parent: 'shell', len: 52, rwa: 0,   bodyR: 13, outerW: 6, innerW: 3, label: 'Socket R' },
  ],
  drawOrder:     ['shell', 'belly', 'eye', 'socket_l', 'socket_r'],
  timelineBones: ['shell', 'eye', 'belly', 'socket_l', 'socket_r'],
  defaultShadow: { w: 34, h: 12 },
};
