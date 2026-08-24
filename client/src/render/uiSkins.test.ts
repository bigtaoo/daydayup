/**
 * uiSkins.ts's best-effort asset registry (design/13 UI-art pass). `getUiTexture`
 * intentionally returns `undefined` identically whether a key was never registered
 * OR was registered but its file hasn't loaded (no network server in this test env,
 * so every `Assets.load` call rejects and is swallowed) — that's the "missing art
 * never blocks boot" contract every menu screen relies on. `UI_ASSET_KEYS` is the
 * one thing this file CAN assert precisely: that a given key is actually wired into
 * the registry, independent of whether its PNG exists yet.
 */
import { describe, it, expect, vi } from 'vitest';
import { preloadUiArt, getUiTexture, UI_ASSET_KEYS } from './uiSkins';

// The 2026-08 icon pass (LoginScreen/PauseMenu/PartyScreen/Forge) + the Forger NPC
// sprite — the exact set this session's icon/biome/npc wiring added.
const NEW_KEYS = [
  'icon_register', 'icon_password', 'icon_logout', 'icon_back', 'icon_quit',
  'icon_party_create', 'icon_party_join', 'icon_party_leave', 'icon_clear',
  'npc_forger',
];

describe('uiSkins — asset registry', () => {
  it('has every 2026-08 icon/npc key registered', () => {
    for (const key of NEW_KEYS) expect(UI_ASSET_KEYS).toContain(key);
  });

  it('still has the earlier hub/icon keys registered (no accidental drop)', () => {
    for (const key of ['hub', 'icon_play', 'icon_squad', 'icon_account', 'icon_settings']) {
      expect(UI_ASSET_KEYS).toContain(key);
    }
  });

  it('getUiTexture returns undefined for an unregistered key', () => {
    expect(getUiTexture('not_a_real_key')).toBeUndefined();
  });
});

describe('uiSkins — preloadUiArt never throws (missing/unreachable art must not block boot)', () => {
  it('resolves cleanly even though no asset server exists in this test environment', async () => {
    await expect(preloadUiArt()).resolves.toBeUndefined();
    // Every registered key still falls back to undefined — confirms the per-asset
    // try/catch swallowed the failed load instead of leaving a half-thrown state.
    for (const key of UI_ASSET_KEYS) expect(getUiTexture(key)).toBeUndefined();
  });
});

describe('uiSkins — every texture is loaded WITH a mip chain', () => {
  it('asks for autoGenerateMipmaps on all of them, and never for repeat addressing', async () => {
    // Every file here is a 208-256 px lone object drawn into a button or badge a fraction of
    // that size. Same rule and same reason as `weaponSkins`/`environmentSprites`/the sprite
    // keys in `biomeTiles`; this loader was simply the last one still passing a bare url,
    // found by auditing all of them at once (2026-08-24) rather than one report at a time.
    const calls: unknown[] = [];
    const pixi = await import('pixi.js');
    const spy = vi.spyOn(pixi.Assets, 'load').mockImplementation(async (opts: unknown) => {
      calls.push(opts);
      throw new Error('no asset server in this test environment');
    });
    try {
      await preloadUiArt();
    } finally {
      spy.mockRestore();
    }
    expect(calls.length).toBe(UI_ASSET_KEYS.length);
    for (const call of calls) {
      const opt = call as { src?: string; data?: Record<string, unknown> };
      expect(typeof call).toBe('object');
      expect(opt.src).toMatch(/^\/ui\/.+\.png$/);
      expect(opt.data?.autoGenerateMipmaps).toBe(true);
      expect(opt.data?.addressMode).toBeUndefined();
    }
  });
});
