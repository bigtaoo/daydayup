// Persistent client-side settings (design/10 "Settings" — volume once audio lands,
// design/11). Sits outside the sim exactly like MetaState (../meta/MetaState.ts):
// it is never read by @dd/engine, only by the render-side AudioBus wiring in Game.ts.
// `master` multiplies both buses rather than the AudioBus interface growing a third
// setter — one fewer platform-seam method to implement per backend (design/11's
// WebAudio/WeChatAudio).
export interface SettingsState {
  master: number; // 0..1
  sfx: number; // 0..1
  music: number; // 0..1
  muted: boolean;
  // Aim at the nearest living enemy within ~one screen automatically, falling back
  // to the character's current facing when nothing is in range. On by default.
  autoAim: boolean;
}

export function defaultSettingsState(): SettingsState {
  return { master: 1, sfx: 0.5, music: 0.5, muted: false, autoAim: true };
}

/** The effective 0..1 gain to hand the AudioBus for a given slider — `muted` zeroes
 * both buses without discarding the stored slider values (so unmuting restores them). */
export function effectiveVolume(s: SettingsState, bus: 'sfx' | 'music'): number {
  if (s.muted) return 0;
  return Math.max(0, Math.min(1, s.master * s[bus]));
}
