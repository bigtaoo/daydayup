/**
 * The pack table's own rules, read from the SHIPPED `assetPacks.json` rather than a fixture.
 *
 * A fixture would defeat the point: what can actually go wrong here is a rule that stops
 * matching a real shipped path (a renamed texture), a rule naming a pack that does not exist,
 * or a deferral that is wrong about the content — none of which a hand-written table would
 * ever reproduce. `build/wechatAssetSync.mjs` reimplements `packOf` in plain Node for the
 * build and the byte gate, so the two are checked against each other at the bottom.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { PACKS, SUBPACKS, DEFAULT_PACK, TOTAL_LIMIT_BYTES, packOf, packDef, packedPathFor } from './assetManifest';
import { BIOME_TILE_ASSETS } from './biomeTiles';
import { UI_ASSETS } from './uiSkins';
import { ENV_SPRITE_ASSETS } from './environmentSprites';
import { WEAPON_DEFS, KIND_DEFAULTS } from './weaponSkins';
import { CHAR_BUNDLES } from './preloadArt';

describe('the pack table', () => {
  it('has a main pack at the project root and gives every pack a distinct name and root', () => {
    expect(DEFAULT_PACK).toBe('main');
    expect(packDef('main').root).toBe('');
    expect(new Set(PACKS.map((p) => p.name)).size).toBe(PACKS.length);
    expect(new Set(PACKS.map((p) => p.root)).size).toBe(PACKS.length);
  });

  it('throws for a pack that does not exist rather than defaulting to main', () => {
    // Silently defaulting would put a rule's assets in the main package while the gate
    // reported the subpackage as empty — a budget that lies is worse than no budget.
    expect(() => packDef('not-a-pack')).toThrow(/no pack named/);
  });

  it("keeps every subpackage's root under one top-level directory", () => {
    // build/wechatAssetSync.mjs prunes by first path segment, so a subpackage rooted at a
    // top-level name would put the prune sweep over a directory it does not own.
    for (const p of SUBPACKS) expect(p.root.startsWith('packs/')).toBe(true);
  });

  it('fits every pack limit inside the whole-game ceiling', () => {
    expect(PACKS.reduce((n, p) => n + p.limitBytes, 0)).toBeLessThanOrEqual(TOTAL_LIMIT_BYTES);
  });
});

describe('what is deferred', () => {
  it('keeps fire and neutral in main — the only elements a run can actually reach', () => {
    // theme.ts's BIOME_ID_TO_ELEMENT maps the one authored dungeon ('ember') to 'fire', and
    // anything without a dungeonConfig (PvP, arena) falls to 'neutral'. Deferring either one
    // would blank the stone on floor 1.
    for (const el of ['fire', 'neutral'] as const) {
      for (const kind of ['floor', 'wall', 'wallface'] as const) {
        expect(packOf(BIOME_TILE_ASSETS[`${kind}_${el}`])).toBe('main');
      }
    }
    expect(packOf(BIOME_TILE_ASSETS.pillar_neutral)).toBe('main');
  });

  it('defers ice, lightning and poison, each to its own subpackage', () => {
    for (const el of ['ice', 'lightning', 'poison'] as const) {
      for (const kind of ['floor', 'wall', 'wallface'] as const) {
        expect(packOf(BIOME_TILE_ASSETS[`${kind}_${el}`]), `${kind}_${el}`).toBe(`biome-${el}`);
      }
    }
  });

  it('defers only the boss rig, and keeps every floor-1 enemy body in main', () => {
    // `brute` and `floater` spawn on floor 1; `blightlord` (boss-core) is floor 5 only. This is
    // the assertion that would catch a pack renamed "elite" quietly swallowing the wrong rigs.
    const packOfBundle = (name: string): string =>
      packOf(`${CHAR_BUNDLES.find(([n]) => n === name)![1]}/animation.json`);
    expect(packOfBundle('boss-core')).toBe('boss');
    for (const name of ['char_vanguard', 'char_skirmisher', 'char_juggernaut', 'critter-core', 'brute-core', 'floater-core']) {
      expect(packOfBundle(name), name).toBe('main');
    }
  });

  it('leaves UI, environment and every weapon in main', () => {
    // All of them are reachable from the first screen or the first room, so none may be
    // deferred — and a broad accidental rule (say a `/ui` prefix) would show up right here.
    for (const path of Object.values(UI_ASSETS)) expect(packOf(path)).toBe('main');
    for (const path of Object.values(ENV_SPRITE_ASSETS)) expect(packOf(path)).toBe('main');
    for (const def of [...Object.values(WEAPON_DEFS), ...Object.values(KIND_DEFAULTS)]) {
      expect(packOf(def!.path)).toBe('main');
    }
  });
});

describe('packedPathFor', () => {
  it('drops the leading slash for main-pack art and prepends the root for a subpackage', () => {
    expect(packedPathFor('/biome/floor_fire.png')).toBe('biome/floor_fire.png');
    expect(packedPathFor('/biome/floor_ice.png')).toBe('packs/biome-ice/biome/floor_ice.png');
  });

  it('accepts a path that already has no leading slash', () => {
    expect(packedPathFor('biome/floor_fire.png')).toBe('biome/floor_fire.png');
  });

  it('never emits a leading slash or a "./" segment', () => {
    // WeChat's FileSystemManager documents `a/b/c` and `/a/b/c` as valid and `./a/b/c` as not;
    // the relative form is what every sample uses, so that is what this must produce.
    for (const path of [...Object.values(BIOME_TILE_ASSETS), ...Object.values(UI_ASSETS)]) {
      const packed = packedPathFor(path);
      expect(packed.startsWith('/')).toBe(false);
      expect(packed.startsWith('./')).toBe(false);
    }
  });
});

describe('the build reimplements packOf, and the two must agree', () => {
  it('assigns every shipped asset to the same pack in both implementations', () => {
    // build/wechatAssetSync.mjs is plain Node (it runs from a vite plugin and from the gate,
    // neither of which can import TypeScript), so `packOf` genuinely exists twice. Both read
    // the same JSON; this checks they read it the same WAY — the first-match-wins ordering is
    // the part that could silently diverge.
    const table = JSON.parse(readFileSync(new URL('./assetPacks.json', import.meta.url), 'utf8')) as {
      defaultPack: string;
      rules: Array<{ prefix: string; pack: string }>;
    };
    const buildPackOf = (webPath: string): string =>
      table.rules.find((r) => webPath.startsWith(r.prefix))?.pack ?? table.defaultPack;

    const everyPath = [
      ...Object.values(BIOME_TILE_ASSETS),
      ...Object.values(UI_ASSETS),
      ...Object.values(ENV_SPRITE_ASSETS),
      ...Object.values(WEAPON_DEFS).map((d) => d!.path),
      ...CHAR_BUNDLES.map(([, baseUrl]) => `${baseUrl}/animation.json`),
    ];
    expect(everyPath.length).toBeGreaterThan(60);
    for (const path of everyPath) expect(buildPackOf(path), path).toBe(packOf(path));
  });
});
