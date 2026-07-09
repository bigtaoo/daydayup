// @dd/engine — deterministic simulation core (design/06/08). No Pixi, no DOM,
// headless-runnable. The render layer and (later) the server consume this
// public surface only; the engine is the single authority on game outcomes.
//
// Stage A: math foundation — fixed-point, injected PRNG, brad/fp-trig.
// Stage B: deterministic sim skeleton — GameState, the 11 systems in design/08's
// frozen step() order, and the createGameEngine factory.
// Stage C: content catalog (content/) — human-unit weapons/actors + the one-time
// converter — and the grid unit switch (1 grid = 32 px).
// Stage E: the InputSource seam formalized — input-edge quantization (state/input),
// ReplayInputSource + runHeadless + state hashing (replay), guarded by ENGINE_VERSION.
// Stage F: the roguelite loop — content/drops (DROP_TABLE) + balance/ (affixes,
// the run/arena build wall) grow the in-run power stack on top of the sim.

export * from './config';
export * from './math/fixed';
export * from './math/prng';
export * from './math/trig';

export * from './state/entities';
export * from './state/commands';
export * from './state/input';
export * from './state/events';
export * from './state/GameState';
export * from './sim.config';
export * from './content';
export * from './balance';
export * from './systems';
export * from './GameEngine';
export * from './replay';
