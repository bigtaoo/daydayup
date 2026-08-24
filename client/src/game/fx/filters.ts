// Assembly shell for the custom Pixi filters (split 2026-08-18 under CLAUDE.md's 500-line
// convention — this file was at 493 lines and the depth/lighting pass needed to grow it).
// Every caller keeps importing `game/fx/filters`; the four modules under `filters/` own the
// code. Split by DOMAIN (form ① — independent modules of unrelated classes), not by
// inheritance: no filter here shares state with another.
//
//   filters/shaderPrelude.ts — the shared GLSL prelude (FRAME_UV) + hexToRgb
//   filters/screenFx.ts      — screen-space post: vignette, chromatic aberration
//   filters/skinFx.ts        — per-actor skin fx: shield, outline, dissolve, heat-haze
//   filters/litFx.ts         — one screen-space lighting pass over the scene layer
export { FRAME_UV, hexToRgb } from './filters/shaderPrelude';
export { VignetteFilter, ChromaticAberrationFilter } from './filters/screenFx';
export { EnergyShieldFilter, OutlineFilter, DissolveFilter, HeatHazeFilter } from './filters/skinFx';
export { SceneLightFilter, MAX_SCENE_LIGHTS, flatReference, FLAT_KEY, type SceneLightOptions, type SceneLight } from './filters/litFx';
