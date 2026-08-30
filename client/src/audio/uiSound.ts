// The UI half of design/11's cue vocabulary: the sounds a screen makes, as opposed to the
// ones an engine event makes.
//
// WHY A MODULE-LEVEL SINK, and not a dependency threaded through the screens. Every other
// cue in the game reaches the bus through exactly one object — `EventReactor`, which Game
// already hands the `AudioBus` to. UI cues have no such funnel: they originate in ~14 screen
// classes and 6 widget classes (`ui/widgets.ts`'s Button/Slider, BlueprintCard,
// WeaponSlotChip, …), none of which take any dependencies today — they are pure
// presentation, constructed with plain layout options and reporting back through `onTap`
// callbacks. Injecting a bus into all of them to play a click would be the single largest
// constructor-signature change in the client, and it would put an audio device in the
// constructor of a widget whose test does not otherwise need one.
//
// So the module owns one nullable sink, the same shape `render/uiSkins.ts` (getUiTexture)
// and `i18n` (t) already use for the same reason. `Game` sets it once, at the same point it
// builds `EventReactor`, so there is still exactly one place where the audio device meets
// the render layer.
//
// UNSET IS THE SAFE STATE, and it is the normal one in tests: with no sink, `playUiCue` is a
// no-op, so a widget test constructs a Button and taps it without stubbing audio, and a
// headless boot that never reaches `Game` stays silent rather than throwing. `setUiAudio`
// accepts null so a test that DOES install a fake can put the module back afterwards —
// module state outlives a single test in the same file.
//
// DETERMINISM (design/06/11): identical to every other cue path — this reads nothing but a
// widget interaction, plays on the render/wall clock, and writes nothing back. UI sound is
// the one cue family that cannot desync anything even in principle, since the sim never sees
// a button press at all.
import type { AudioBus, AudioCue } from '../platform/types';

/** The `ui.*` members of the cue union — derived, so adding one to `AudioCue` makes it
 *  playable here with no second list to update (and removing one breaks its call sites). */
export type UiCue = Extract<AudioCue, `ui.${string}`>;

let bus: AudioBus | null = null;
/** One warning per attached bus, not one per press — a denied button can be pressed all day. */
let warned = false;

/**
 * Point UI cues at an audio device (Game, at construction). Pass `null` to detach — which is
 * what a test does when it is done, and what a torn-down Game would do if this ever grows a
 * shutdown path.
 */
export function setUiAudio(next: AudioBus | null): void {
  bus = next;
  warned = false;
}

/**
 * Play a UI cue. Silent (not an error) when no device is attached.
 *
 * `resume()` first, every time: a tap IS the user gesture design/11's autoplay gate needs,
 * and on WeChat it is the ONLY one — `WeChatAudio` registers no global listeners the way
 * `WebAudio` does for pointerdown/keydown/touchstart, so before this existed the mini-game's
 * audio stayed suspended until the player reached a `Game.confirm()`. The resume is async, so
 * the very first tap of a session is still usually silent (the context is not `running` yet
 * when `play` checks); every tap after it sounds. That is a property of the platform gate,
 * not something worth queueing a cue for.
 *
 * Failures are contained here rather than allowed out. This runs from inside a Pixi
 * `pointertap` listener, AFTER the button's own handler — the player's action has already
 * happened — so a throw could only take down whatever else that emit was going to do, in
 * exchange for a sound. `WeChatAudio.resume()` is the realistic source: it calls into
 * `wx.createWebAudioContext()`'s context, whose behaviour on the lowest base library is one
 * of design/11's own unverified items. The warning is one-shot per attached bus, because the
 * one press that can produce this cue most often is the one that is being refused.
 */
export function playUiCue(cue: UiCue): void {
  if (!bus) return;
  try {
    bus.resume();
    bus.play(cue);
  } catch (err) {
    if (!warned) {
      warned = true;
      console.warn(`[audio] UI cue ${cue} failed; UI stays silent this session:`, err);
    }
  }
}
