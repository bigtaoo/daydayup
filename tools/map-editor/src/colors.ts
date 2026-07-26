// Hand-copied subset of client/src/game/config.ts CONFIG.colors, so the editor's
// canvas reads as the same palette as the actual game renderer. Kept in sync
// manually (funny's tools/map-editor precedent — not worth a shared package for
// a handful of hex constants).
export const COLORS = {
  ground: 0x161a24,
  gridLine: 0x1f2532,
  wall: 0x2a3140,
  wallEdge: 0x4c566a,
  pillar: 0x3b4252,
  pillarTop: 0x4c566a,
  player: 0x4fd1c5,
  enemy: 0xf56565,
  extractGlow: 0x68d391,

  // Editor-only accents (no game-renderer equivalent — these are authoring UI,
  // never shown in the live game).
  selection: 0xffd27f,
  prop: 0x9f7aea,
  door: 0x63b3ed,
  eyeCandidate: 0xf6e05e,
  cellTrait: 0xff7043,
  lootMarker: 0xd6bcfa,
  overlapError: 0xe06c75,
  roomBounds: 0x2d3446,
} as const;
