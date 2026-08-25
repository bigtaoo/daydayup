// Render quality tiers (2026-08-25) — the lever that did not exist.
//
// Everything design/01's fidelity roadmap shipped ran unconditionally: four full-viewport
// filter passes (vignette + chromatic on `world`, a bloom-lite blur on `fx`, the one
// `SceneLightFilter` pass on `lit`), the four per-actor skin shaders, ambient particles, and a
// renderer resolution capped only at the platform's own `min(pixelRatio, 2)`. Every perf number
// in design/01 was measured on a desktop Chrome; nothing has ever been measured on a phone
// (design/04 items 3 and 6). The gap that mattered was not the missing measurement — it was that
// a bad measurement would have had NOTHING to act on. This module is the something.
//
// The knobs are ordered by what actually costs a mobile GPU:
//   1. `resolutionCap` — fill rate. A DPR-3 phone rendering at 2 draws 4x the fragments of one
//      rendering at 1, and every filter pass below pays that multiplier again.
//   2. `sceneLight`/`screenFx`/`bloom` — three render-target passes over the whole viewport.
//   3. `actorShaders` — one render-target pass per actor that currently has a status effect.
//   4. `particleBudget` — CPU + draw calls; each particle is its own `Graphics` node.
//
// Deliberately NOT a knob: anything the sim can see. Quality is presentation-only (design/12's
// locked "art never decides an outcome"), so two clients on different tiers stay byte-identical
// (design/06). A low-tier client sees a flatter scene, never a different fight.

/** What the player picked, as persisted in `SettingsState`. */
export type QualitySetting = 'auto' | 'high' | 'low';

/** What the renderer actually runs at. `'auto'` resolves to one of these — see `resolveTier`. */
export type QualityTier = 'high' | 'low';

/** Declared order for the settings screen's tap-to-cycle button. */
export const QUALITY_SETTINGS: readonly QualitySetting[] = ['auto', 'high', 'low'];

export interface QualityProfile {
  readonly tier: QualityTier;
  /** The one lighting pass over `layers.lit` (`fx/filters/litFx.ts`). */
  readonly sceneLight: boolean;
  /** Vignette + chromatic aberration over `layers.world`. */
  readonly screenFx: boolean;
  /** Bloom-lite blur over the additive `layers.fx`. */
  readonly bloom: boolean;
  /** The four per-actor skin shaders (`scene/actorFilters.ts`). */
  readonly actorShaders: boolean;
  /** Multiplier on particle burst counts and ambient dust rate. 0 disables particles. */
  readonly particleBudget: number;
  /** Ceiling on `renderer.resolution`. The platform's own device-pixel-ratio cap still
   *  applies on top — this only ever lowers it, never raises it above what the platform
   *  chose (`WebPlatform`/`WeChatPlatform` both cap at 2 already). */
  readonly resolutionCap: number;
}

const PROFILES: Readonly<Record<QualityTier, QualityProfile>> = {
  high: {
    tier: 'high',
    sceneLight: true,
    screenFx: true,
    bloom: true,
    actorShaders: true,
    particleBudget: 1,
    resolutionCap: 2,
  },
  // Everything that costs a render-target pass is off, and the frame is drawn at 1x. This is
  // roughly the game as it looked before design/01's milestones 2-5 landed: flat, unlit,
  // un-vignetted, but the same fight at the same framerate budget.
  low: {
    tier: 'low',
    sceneLight: false,
    screenFx: false,
    bloom: false,
    actorShaders: false,
    particleBudget: 0.35,
    resolutionCap: 1,
  },
};

export function qualityProfile(tier: QualityTier): QualityProfile {
  return PROFILES[tier];
}

/**
 * The policy for `'auto'`: start high, and stay there unless the frame watchdog
 * (`qualityWatchdog.ts`) has decided this device cannot hold the framerate.
 *
 * There is deliberately no path back UP. A device that downgraded is by definition one whose
 * frame budget the high tier does not fit, so re-enabling would re-measure a slow frame and
 * downgrade again — an oscillation the player would read as the game flickering between two
 * looks. An explicit `'high'` pick is always honoured, watchdog or not: the player asking for
 * the good-looking version outranks our guess about their hardware.
 */
export function resolveTier(setting: QualitySetting, autoDowngraded: boolean): QualityTier {
  if (setting === 'high') return 'high';
  if (setting === 'low') return 'low';
  return autoDowngraded ? 'low' : 'high';
}

// ---- live mirror ----
//
// Same shape as i18n's `setLocale`/`t()` (design/17): a module-level mirror that presentation
// code reads directly, with the persisted copy living in `SettingsState` and `Game` keeping the
// two in sync. The alternative — threading a profile through `Scene` into every `Actor` — would
// put a render-quality parameter into constructors that have nothing else to do with it, for a
// value that is process-wide by definition.
//
// Only presentation reads this. Nothing under `@dd/engine` may (see the header).
let active: QualityProfile = PROFILES.high;

export function setActiveQuality(tier: QualityTier): void {
  active = PROFILES[tier];
}

export function activeQuality(): QualityProfile {
  return active;
}

/** Test helper — restores the boot default so one test's tier cannot leak into the next.
 *  (The engine's own global pools have burned this repo before; see design/ROADMAP.) */
export function resetActiveQuality(): void {
  active = PROFILES.high;
}
