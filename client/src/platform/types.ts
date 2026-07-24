// Platform isolation layer.
//
// The Game core (src/game) is platform-agnostic. Everything that differs between
// Web and the WeChat mini-game — canvas acquisition, the Pixi Application setup,
// input devices, lifecycle — lives behind these interfaces. See design/04-wechat.md.
import type { Application } from 'pixi.js';

// Aim is expressed two ways so both mouse and virtual-joystick controls fit the
// same Game code:
//  - 'point': a screen-space position (mouse cursor). Game converts it to world space.
//  - 'dir':   a normalized aim direction (right joystick). Game uses it as facing directly.
export type Aim =
  | { mode: 'point'; x: number; y: number }
  | { mode: 'dir'; dx: number; dy: number };

export interface InputState {
  moveX: number; // normalized movement, [-1, 1]
  moveY: number;
  aim: Aim;
  firing: boolean; // fires ranged / swings melee — a melee swing is also the parry (no block key)
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

// A swappable input device. Web = keyboard + mouse; WeChat = virtual joystick + touch.
export interface InputSource {
  onSwitchWeapon: ((slot: number) => void) | null;
  attach(canvas: InputCanvas): void;
  read(): InputState;
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

// A swappable audio device, symmetric to InputSource. Web synthesises placeholder
// cues via WebAudio (no asset files); WeChat needs real assets + InnerAudioContext
// (stubbed until those land — design/11). All calls are render-clock, fire-and-forget.
export interface AudioBus {
  // Play a one-shot SFX cue. Cheap and idempotent-per-frame — the caller coalesces
  // duplicate cues within a frame (design/11 "coalesce identical cues in the same frame").
  play(cue: AudioCue): void;
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
