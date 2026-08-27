// Split out 2026-08-27 (CLAUDE.md form ① — one independent function over GameState, no
// state of its own): the single answer to "which co-resident room model is this state
// running, and what are its rooms", so the engine and the client cannot disagree about it.
//
// They could, and did. Three call sites asked the same question with two different rules:
// `EnvironmentSystem` used `zoneEnabled ? arenaRoomRects : dungeonRoomRects`, while
// `GameLoop.cameraFrame` and `groundLayer.roomRectsPx` used
// `dungeonRoomRects.length > 0 ? dungeonRoomRects : arenaRoomRects`. The two rules only
// disagree on a state with BOTH lists populated, and the only thing keeping such a state
// from existing was a doc comment on `EngineConfig.dungeon` / `.arena` calling each an
// "ALTERNATIVE to" the other. Nothing enforced it, and the divergence it prevented was a
// silent one: `EnvironmentSystem` would stamp `Actor.roomId` from the arena's rooms while
// the camera looked that id up among the dungeon's, missed, and fell back to framing the
// whole world. Both halves are now closed — the invariant is enforced where it is decided
// (`GameState`'s constructor throws on a config carrying both), and this module is the one
// rule every consumer reads, so if that guard is ever relaxed they relax together.
//
// The rule kept is the client's: whichever list HAS rooms. Under the invariant it is
// identical to the engine's old `zoneEnabled` rule for every reachable state — an arena
// always has rooms, and a dungeon's list being empty means the same thing to every consumer
// here as no rooms at all (`SpawnSystem` and `ExtractionSystem` both empty it as the
// "generate a fresh floor" sentinel, and during that window there is genuinely no room to
// frame, paint or place an actor in). It is preferred over the flag rule only because it
// needs nothing but the two arrays, so a test fixture cannot fake a mode without also
// supplying the rooms that mode is supposed to have.
import type { RoomId } from '../content/arenas';
import type { AABB } from './entities';

/** One room's identity + bounds, in Fp — the shape both `GameState.arenaRoomRects` and
 *  `GameState.dungeonRoomRects` hold. */
export interface RoomRect {
  id: RoomId;
  rect: AABB;
}

/** Which room model a state is running. `'none'` covers both a config with no room model at
 *  all (a flat `waves`/`floors` run: the tutorial, every config older than dungeon mode) and
 *  a dungeon between floors — for every consumer of this module those are the same case,
 *  "there are no rooms", and the world itself is the only bound anything can fall back to. */
export type RoomModelKind = 'arena' | 'dungeon' | 'none';

export interface RoomModel {
  readonly kind: RoomModelKind;
  /** The model's rooms — empty exactly when `kind` is `'none'`. */
  readonly rects: readonly RoomRect[];
}

/** The fields of `GameState` this selector reads, narrowed per this repo's
 *  narrow-interface convention so a caller (or a test) never has to hand over a whole state. */
export interface RoomModelSource {
  readonly arenaRoomRects: readonly RoomRect[];
  readonly dungeonRoomRects: readonly RoomRect[];
}

const NO_ROOMS: RoomModel = { kind: 'none', rects: [] };

/** Which room model this state is running. Dungeon first, matching the precedence both
 *  client call sites already had; the two are mutually exclusive by construction
 *  (`GameState` throws on a config setting both), so the order decides nothing real — it is
 *  fixed here only so that a state hand-built past that guard still gets ONE answer rather
 *  than a different one per consumer. */
export function roomModel(s: RoomModelSource): RoomModel {
  if (s.dungeonRoomRects.length > 0) return { kind: 'dungeon', rects: s.dungeonRoomRects };
  if (s.arenaRoomRects.length > 0) return { kind: 'arena', rects: s.arenaRoomRects };
  return NO_ROOMS;
}

/** The active room model's rooms — the common case, for callers that only look a `RoomId` up
 *  (`EnvironmentSystem`, `GameLoop.cameraFrame`) and treat all three kinds the same way. */
export function roomRects(s: RoomModelSource): readonly RoomRect[] {
  return roomModel(s).rects;
}
