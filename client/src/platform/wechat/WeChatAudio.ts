import type { AudioBus, AudioCue } from '../types';

// WeChat audio backend (design/11) — STUB.
//
// Unlike web, WeChat has no WebAudio synth path we rely on and no bundled sound
// assets yet, so there is nothing to play. This no-op satisfies the AudioBus
// interface so the WeChat build stays sound-agnostic and identical in simulation
// (audio never feeds the sim — design/06/11).
//
// To make it real (design/11 "to design" + open questions), all of which need
// assets and/or a real device:
//   1. Ship a core SFX bundle (mp3) and load ids → files via the design/12 manifest.
//   2. Play through a small pool of wx.createInnerAudioContext() (or
//      wx.createWebAudioContext() where the base library supports it — verify on the
//      LOWEST base library, design/04).
//   3. Apply setSfxVolume as the context volume; duck/pause on
//      wx.onAudioInterruptionBegin / hide (design/10 handles focus/blur).
// Kept as a stub deliberately: the sourcing + device-tuning work is flagged back to
// the owner rather than faked here.
export class WeChatAudio implements AudioBus {
  play(_cue: AudioCue): void {}
  setSfxVolume(_v: number): void {}
  setMusicVolume(_v: number): void {}
  resume(): void {}
}
