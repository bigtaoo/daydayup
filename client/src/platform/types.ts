// Platform isolation layer.
//
// The Game core (src/game) is platform-agnostic. Everything that differs between
// Web and the WeChat mini-game — canvas acquisition, the Pixi Application setup,
// input devices, lifecycle — lives behind these interfaces. See design/04-wechat.md.
import type { Application } from 'pixi.js';

export interface InputState {
  moveX: number; // normalized movement, [-1, 1]
  moveY: number;
  // No aim field (design/10 v33): manual aim is gone. The engine auto-faces the nearest
  // hostile, else the movement direction, else holds last facing (ApplyInputSystem).
  firing: boolean; // fires ranged / swings melee — a melee swing is also the parry (no block key)
  // Held at a dungeon extraction checkpoint (design/05, ROADMAP 1.4): a sustained hold
  // EXTRACTs (bank + leave), a tap DESCENDs (bank + go deeper). Engine reads it as
  // Button.INTERACT via CommandBuilder. Ignored away from a checkpoint.
  interacting: boolean;
}

// Minimal structural view of the canvas the input source attaches to.
// On Web this is an HTMLCanvasElement; on WeChat it is the wx canvas — both expose
// width/height, and only the Web input touches the DOM event APIs (guarded).
export interface InputCanvas {
  width: number;
  height: number;
  addEventListener?: HTMLCanvasElement['addEventListener'];
  getBoundingClientRect?: () => { left: number; top: number };
}

// Render-facing geometry snapshot of the on-screen touch controls (TouchControls.ts) —
// exactly the values a render layer needs to draw sticks/buttons in the same place
// TouchControls hit-tests them, so the visual never drifts from the real hit zones.
// `active` is true once the player has touched the screen at least once this session
// (not just "a stick is currently held") — a render layer gates all drawing on it so a
// desktop/mouse session never shows the overlay.
export interface TouchVisual {
  active: boolean;
  // Shared hit-zone radius (CSS px, from TouchControls.layout()) for both sticks' base circles.
  stickRadius: number;
  // Null when the move stick isn't currently held. ox/oy is the touch-down origin
  // (dynamic, set fresh each press); dx/dy is the current pixel offset from it, already
  // clamped to stickRadius — same units as ox/oy, so a render layer can draw the knob at
  // (ox + dx, oy + dy) with no further math.
  move: { ox: number; oy: number; dx: number; dy: number } | null;
  // The right-side fire zone (design/10 v33: no more aim stick, just hold-to-fire) — a
  // fixed button, same shape as weapon1/weapon2, plus whether it's currently held.
  fire: { cx: number; cy: number; r: number; pressed: boolean };
  weapon1: { cx: number; cy: number; r: number };
  weapon2: { cx: number; cy: number; r: number };
  // INTERACT — a third corner button, held (not tapped) the same way `fire` is: the
  // revive channel (ReviveSystem, ROADMAP 3.2) reads it every tick for as long as it's
  // down, exactly like the keyboard's E/Space hold. Desktop-only until this pass — see
  // TouchControls.ts's own doc comment for why it was missing.
  interact: { cx: number; cy: number; r: number; pressed: boolean };
}

// A swappable input device. Web = keyboard + mouse; WeChat = virtual joystick + touch.
export interface InputSource {
  onSwitchWeapon: ((slot: number) => void) | null;
  attach(canvas: InputCanvas): void;
  read(): InputState;
  // Both Web and WeChat proxy this straight from their shared TouchControls instance
  // (platform/TouchControls.ts) — see TouchVisual's own doc comment.
  getTouchVisual(): TouchVisual;
  // Left-handed control-layout option (design/10, `Settings.ts` — SettingsState.
  // controlLayout), proxied to TouchControls.setMirrored. Optional: only Web/WeChat's
  // touch-backed sources implement it — a test fake with no touch controls at all has
  // nothing to mirror.
  setControlMirror?(mirrored: boolean): void;
}

// Audio cue vocabulary — a small closed set of ids, shared with fx/animation
// (design/11, design/12). The render layer maps engine events (design/08) to a cue;
// the platform's AudioBus decides how to make the sound. Audio is pure presentation:
// it reads events and plays, and NEVER feeds the sim (design/06/11).
export type AudioCue =
  | 'muzzle'
  | 'impact'
  | 'deflect'
  | 'clash'
  | 'shield.break'
  | 'status.burn'
  | 'status.chill'
  | 'status.shock'
  | 'status.poison'
  | 'death'
  | 'pickup.heal'
  | 'pickup.weapon'
  | 'pickup.material'
  | 'pickup.buff'
  | 'wave-clear'
  | 'win';

// A swappable audio device, symmetric to InputSource. Both backends now run the SAME cue
// pipeline (audio/CueMixer.ts — the shipped sample if one is loaded, the procedural voice if
// not); they differ only in how the AudioContext is obtained and how asset bytes are read.
// All calls are render-clock, fire-and-forget.
export interface AudioBus {
  /**
   * Fetch + decode the shipped SFX set (design/11 "preload the core SFX set at boot").
   * Best-effort, and boot never awaits it: until it resolves — or if it fails outright —
   * cues fall back to the procedural voices, which is audible rather than silent. Safe to
   * call more than once; a second call retries only what has nothing loaded.
   */
  preload(): Promise<void>;
  // Play a one-shot SFX cue. Cheap and idempotent-per-frame — the caller coalesces duplicate
  // cues within a frame (design/11 "coalesce identical cues in the same frame") and passes
  // how many events collapsed into this one as `count`, which raises the gain rather than
  // playing the cue twice.
  play(cue: AudioCue, count?: number): void;
  // 0..1 gain on the SFX / music buses (design/10 settings). Music is reserved.
  setSfxVolume(v: number): void;
  setMusicVolume(v: number): void;
  // Resume after the browser/WeChat autoplay gate; call on a user gesture (design/11).
  resume(): void;
}

// A platform provides the Pixi Application (bound to its canvas), the input device,
// and the audio device.
export interface Platform {
  createApp(): Promise<Application>;
  createInput(app: Application): InputSource;
  createAudio(): AudioBus;
}
