// Which screen the game is currently showing. 'settings' is a full screen rather than
// an overlay (Game tracks which phase to return to via settingsReturnPhase). 'squad' is
// the PvP pre-formed-party lobby (design/05/15's squad follow-up) — the first runtime
// (not boot-flag) entry point into PvP. 'modeSelect' is the branch point PLAY now opens
// (solo PvE / co-op / PvP solo queue / tutorial) instead of jumping straight to 'forge'.
// 'matchmaking' wraps the connectOnlineSession call for BOTH the solo-queue paths and the
// pre-formed squad path (PartyScreen's onStartMatch now routes through it too) so there is
// one real "connecting…"/error screen instead of a blank 'playing' phase with no feedback.
// 'pvpPreview' sits between ModeSelect's PVP SOLO QUEUE button and 'matchmaking' (design/10
// open question "PvP preset-pick has no UI yet") — the squad path does NOT route through it
// (every party member's poll auto-advances to beginSquadMatch, so a manual confirm gate
// there would desync followers who never see it; PartyScreen's own lobby/roster already
// serves as squad's pre-match review step).
//
// Lives at the game root rather than under screens/ because it is the shared vocabulary
// Game.ts and the screen layer both speak, not a screen implementation detail.
export type Phase =
  | 'menu' | 'modeSelect' | 'forge' | 'pvpPreview' | 'matchmaking' | 'playing' | 'paused'
  | 'victory' | 'defeat' | 'settings' | 'squad' | 'account';
