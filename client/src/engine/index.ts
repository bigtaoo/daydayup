// @dd/engine — deterministic simulation core (design/06/08). No Pixi, no DOM,
// headless-runnable. The render layer and (later) the server consume this
// public surface only; the engine is the single authority on game outcomes.
//
// Stage A (current): math foundation only — fixed-point, injected PRNG, and the
// brad/fp-trig module. GameState, systems, and content land in later stages.

export * from './config';
export * from './math/fixed';
export * from './math/prng';
export * from './math/trig';
