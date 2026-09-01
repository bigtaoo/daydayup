/**
 * `wechatAssetSync`'s prune, against a real temp repo — the one thing about this module that no
 * other check can see.
 *
 * The byte gate (`checkWeChatPackage.mjs`) weighs `client/public` THROUGH the pack rules; it
 * never looks at the built tree. So a file that stops being planned but stays on disk in
 * `platforms/wechat` is invisible to it: the gate says the main package holds one file while the
 * package about to be uploaded holds a full stale copy of the old layout. That is not
 * hypothetical — it is exactly what happened on 2026-09-01 when every asset moved out of the
 * main package into `packs/`, and it is what this file exists to stop happening again.
 *
 * Built on a temp directory rather than the repo's own `platforms/` (which is git-ignored local
 * scratch a developer may have opened in DevTools) so the assertions can be about a known
 * before-state.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { planPackage, syncAssets } from './wechatAssetSync.mjs';

let root;

/** A repo shaped just enough for `planPackage`: an asset tree, a pack table, a game.json shell
 *  and a project.config.json to seed from. */
function seedRepo(packs, publicFiles) {
  mkdirSync(join(root, 'client', 'src', 'render'), { recursive: true });
  writeFileSync(join(root, 'client', 'src', 'render', 'assetPacks.json'), JSON.stringify(packs));
  for (const [rel, bytes] of Object.entries(publicFiles)) {
    const abs = join(root, 'client', 'public', rel);
    mkdirSync(join(abs, '..'), { recursive: true });
    writeFileSync(abs, 'x'.repeat(bytes));
  }
  mkdirSync(join(root, 'client', 'wechat', 'js'), { recursive: true });
  writeFileSync(join(root, 'client', 'wechat', 'game.json'), JSON.stringify({ deviceOrientation: 'landscape' }));
  writeFileSync(join(root, 'client', 'wechat', 'project.config.json'), '{}');
}

const TABLE = {
  mainPack: 'main',
  defaultPack: 'run',
  totalLimitBytes: 31457280,
  packs: [
    { name: 'main', root: '', phase: 'main', limitBytes: 4194304 },
    { name: 'lobby', root: 'packs/lobby', phase: 'lobby', limitBytes: 1048576 },
    { name: 'run', root: 'packs/run', phase: 'run', limitBytes: 4194304 },
  ],
  rules: [{ prefix: '/ui/', pack: 'lobby' }],
};

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'dd-wechat-sync-'));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('syncAssets — the prune', () => {
  it('removes a stale copy left where an asset USED to live', () => {
    // The 2026-09-01 case in miniature: `ui/hub.png` was main-package art in the previous build,
    // and the rules now route it to `packs/lobby`. A prune derived from what the plan owns TODAY
    // never visits `ui/`, so the old file survives — in the FIRST download, which is the one
    // place bytes are actually capped.
    seedRepo(TABLE, { 'ui/hub.png': 100, 'biome/floor.png': 50 });
    const target = join(root, 'platforms', 'wechat');
    mkdirSync(join(target, 'ui'), { recursive: true });
    writeFileSync(join(target, 'ui', 'hub.png'), 'stale');
    writeFileSync(join(target, 'ui', 'gone.png'), 'stale');

    syncAssets(root, () => {});

    expect(existsSync(join(target, 'ui'))).toBe(false);
    expect(existsSync(join(target, 'packs', 'lobby', 'ui', 'hub.png'))).toBe(true);
    expect(existsSync(join(target, 'packs', 'run', 'biome', 'floor.png'))).toBe(true);
  });

  it('never touches the bundle or the appid config', () => {
    // `platforms/` is git-ignored scratch, and whoever has a real appid keeps it in
    // project.config.json. A sweep that pruned by exclusion and forgot these would delete both.
    seedRepo(TABLE, { 'ui/hub.png': 100 });
    const target = join(root, 'platforms', 'wechat');
    mkdirSync(join(target, 'js'), { recursive: true });
    writeFileSync(join(target, 'js', 'game.js'), 'bundle');
    writeFileSync(join(target, 'game.js'), 'entry');
    writeFileSync(join(target, 'project.config.json'), '{"appid":"real"}');
    writeFileSync(join(target, 'project.private.config.json'), '{}');

    syncAssets(root, () => {});

    expect(existsSync(join(target, 'js', 'game.js'))).toBe(true);
    expect(existsSync(join(target, 'game.js'))).toBe(true);
    // Seeded only when absent — a real appid must survive every build.
    expect(existsSync(join(target, 'project.config.json'))).toBe(true);
    expect(existsSync(join(target, 'project.private.config.json'))).toBe(true);
  });

  it('empties a pack that no longer has any files, rather than leaving them downloadable', () => {
    const emptied = {
      ...TABLE,
      rules: [], // '/ui/' no longer routes to `lobby`
    };
    seedRepo(emptied, { 'ui/hub.png': 100 });
    const target = join(root, 'platforms', 'wechat');
    mkdirSync(join(target, 'packs', 'lobby', 'ui'), { recursive: true });
    writeFileSync(join(target, 'packs', 'lobby', 'ui', 'hub.png'), 'stale');

    syncAssets(root, () => {});

    expect(existsSync(join(target, 'packs', 'lobby', 'ui', 'hub.png'))).toBe(false);
    expect(existsSync(join(target, 'packs', 'run', 'ui', 'hub.png'))).toBe(true);
    // The pack root survives with its generated no-op entry: it is still a declared subpackage,
    // and the 分包 docs describe `root` as a directory whose game.js is the entry file.
    expect(readdirSync(join(target, 'packs', 'lobby'))).toEqual(['game.js']);
  });

  it('prunes a stray top-level FILE instead of crashing on it', () => {
    // `ownedTopLevel` is derived by EXCLUSION from a readdir — that is the whole point of the
    // 2026-09-01 change, since a plan-derived set cannot clean up a directory the plan used to
    // own. But exclusion also admits plain files, and the sweep below handed each entry straight
    // to `walk()`, which readdirs it: `ENOTDIR: not a directory, scandir '.../stray-note.txt'`,
    // out of `npm run build:wechat`. Reachable without contrivance — `platforms/` is git-ignored
    // scratch that DevTools and a developer both write into, and every previous test here seeded
    // only directories, so nothing looked.
    seedRepo(TABLE, { 'ui/hub.png': 100 });
    const target = join(root, 'platforms', 'wechat');
    mkdirSync(target, { recursive: true });
    writeFileSync(join(target, 'stray-note.txt'), 'scratch');

    expect(() => syncAssets(root, () => {})).not.toThrow();

    // Unplanned and unreserved, so it is stale by the same rule as a stale texture.
    expect(existsSync(join(target, 'stray-note.txt'))).toBe(false);
    expect(existsSync(join(target, 'packs', 'lobby', 'ui', 'hub.png'))).toBe(true);
  });

  it('keeps a reserved top-level file that is a FILE, not a directory', () => {
    // The other side of the same readdir: `game.js` is reserved and is a file. Broadening the
    // sweep to cope with files must not broaden it to cope with THOSE files — deleting the
    // bundle entry every build is the failure mode a naive fix reaches for.
    seedRepo(TABLE, { 'ui/hub.png': 100 });
    const target = join(root, 'platforms', 'wechat');
    mkdirSync(target, { recursive: true });
    writeFileSync(join(target, 'game.js'), 'entry');

    syncAssets(root, () => {});

    expect(readFileSync(join(target, 'game.js'), 'utf8')).toBe('entry');
  });

  it('declares every subpackage in game.json, the default pack included', () => {
    // `subpackageEntries` filters on `mainPack`, not `defaultPack`. Filtering on the latter — as
    // it did until the two became different values — drops `run` from game.json and leaves
    // `wx.loadSubpackage('run')` naming nothing at all.
    seedRepo(TABLE, { 'ui/hub.png': 100, 'biome/floor.png': 50 });
    syncAssets(root, () => {});
    const gameJson = JSON.parse(readFileSync(join(root, 'platforms', 'wechat', 'game.json'), 'utf8'));
    expect(gameJson.subpackages.map((s) => s.name).sort()).toEqual(['lobby', 'run']);
    for (const sub of gameJson.subpackages) expect(sub.root.endsWith('/')).toBe(true);
  });
});

/** `byPack`, keyed — the shape the byte gate actually reads. */
function packsByName(plan) {
  return Object.fromEntries(plan.byPack.map((p) => [p.name, p]));
}

describe('planPackage — the number the byte gate exists for', () => {
  it("charges js/game.js to the MAIN package, not to whichever pack is the default", () => {
    // The gate's whole job is "does WeChat's FIRST download fit in 4 MB", and since 2026-09-01
    // that download is `js/game.js` and nothing else — so this one attribution IS the gate.
    // Nothing exercised it: `seedRepo` creates `client/wechat/js/` but never a `game.js` inside
    // it, so `hasBundle` was false in every case above and `planPackage` was never called
    // directly at all. Reverting `pack: packs.mainPack` to `packs.defaultPack` therefore passed,
    // and that mutant reports the main package as 0 bytes against a 4 MB cap while quietly
    // charging ~0.95 MB of code to the `run` subpackage.
    seedRepo(TABLE, { 'ui/hub.png': 100, 'biome/floor.png': 50 });
    const BUNDLE_BYTES = 4321;
    writeFileSync(join(root, 'client', 'wechat', 'js', 'game.js'), 'x'.repeat(BUNDLE_BYTES));

    const plan = planPackage(root);
    const byName = packsByName(plan);

    expect(plan.hasBundle).toBe(true);
    expect(byName.main.count).toBe(1);
    expect(byName.main.bytes).toBe(BUNDLE_BYTES);
    // ...and it is charged ONCE: the default pack still holds only the art no rule claimed.
    expect(byName.run.count).toBe(1);
    expect(byName.run.bytes).toBe(50);
    expect(byName.lobby.bytes).toBe(100);
    expect(plan.totalBytes).toBe(BUNDLE_BYTES + 150);
    // The bundle's destination is the project root's `js/`, which is what `game.json` and every
    // `packedPathFor` result assume (see this module's layout note).
    expect(plan.files.find((f) => f.webPath === null).dest).toBe('js/game.js');
  });

  it('says the main package is empty rather than pretending it is small', () => {
    // Before the first `build:wechat` there is no bundle. The plan has to report that, because a
    // gate that silently weighed art only would go green on a package it had not measured.
    seedRepo(TABLE, { 'ui/hub.png': 100 });

    const plan = planPackage(root);

    expect(plan.hasBundle).toBe(false);
    expect(packsByName(plan).main.count).toBe(0);
    expect(packsByName(plan).main.bytes).toBe(0);
  });
});

/** A table with two OVERLAPPING prefixes, the narrower first. The real `assetPacks.json` has no
 *  such pair, which makes its documented "first matching prefix wins" rule unfalsifiable there —
 *  `find` → `findLast` changes the answer for no shipped path. This is the pair that gives the
 *  claim teeth, and the only place it can live is a fixture table. */
const OVERLAPPING = {
  ...TABLE,
  rules: [
    { prefix: '/ui/hub.png', pack: 'lobby' },
    { prefix: '/ui/', pack: 'run' },
  ],
};

describe('packOf — first matching prefix wins', () => {
  it('lets the NARROWER rule win when it is listed first', () => {
    seedRepo(OVERLAPPING, { 'ui/hub.png': 100, 'ui/other.png': 60 });

    const plan = planPackage(root);
    const byName = packsByName(plan);

    expect([byName.lobby.count, byName.lobby.bytes]).toEqual([1, 100]);
    expect([byName.run.count, byName.run.bytes]).toEqual([1, 60]);
    // ...and the split really reaches the mirrored tree, not just the plan's arithmetic.
    syncAssets(root, () => {});
    const target = join(root, 'platforms', 'wechat');
    expect(existsSync(join(target, 'packs', 'lobby', 'ui', 'hub.png'))).toBe(true);
    expect(existsSync(join(target, 'packs', 'run', 'ui', 'other.png'))).toBe(true);
  });
});
