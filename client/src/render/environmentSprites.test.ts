/**
 * environmentSprites.ts's door-fixture registry (design/05 "Room & door model",
 * 2026-08-04). Same "no asset server in this test environment" convention as
 * biomeTiles.test.ts: every `Assets.load` call genuinely rejects here, which is exactly
 * what proves `preloadEnvironmentSprites()` is best-effort (RoomBuilder's flat-tint
 * fallback covers an unloaded door the same way it already covers an unloaded floor/wall
 * swatch) rather than one failed load aborting the whole preload.
 */
import { describe, it, expect } from 'vitest';
import { preloadEnvironmentSprites, getDoorTexture } from './environmentSprites';

describe('environmentSprites — getDoorTexture before any preload', () => {
  it('returns undefined for both lock states (RoomBuilder falls back to a flat tint)', () => {
    expect(getDoorTexture(true)).toBeUndefined();
    expect(getDoorTexture(false)).toBeUndefined();
  });
});

describe('environmentSprites — preloadEnvironmentSprites never throws (missing/unreachable art must not block boot)', () => {
  it('resolves cleanly even though no asset server exists in this test environment', async () => {
    await expect(preloadEnvironmentSprites()).resolves.toBeUndefined();
    expect(getDoorTexture(true)).toBeUndefined();
    expect(getDoorTexture(false)).toBeUndefined();
  });
});
