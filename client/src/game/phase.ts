// Which screen the game is currently showing. 'settings' is a full screen rather than
// an overlay (Game tracks which phase to return to via settingsReturnPhase). 'squad' is
// the PvP pre-formed-party lobby (design/05/15's squad follow-up) — the first runtime
// (not boot-flag) entry point into PvP.
//
// Lives at the game root rather than under screens/ because it is the shared vocabulary
// Game.ts and the screen layer both speak, not a screen implementation detail.
export type Phase =
  | 'menu' | 'forge' | 'playing' | 'paused'
  | 'victory' | 'defeat' | 'settings' | 'squad' | 'account';
