import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { versionManifestPlugin } from './versionManifestPlugin.mjs';

function bundleOf(entries) {
  const bundle = {};
  for (const [fileName, size, type = 'asset'] of entries) {
    bundle[fileName] = type === 'asset' ? { type: 'asset', source: 'x'.repeat(size) } : { type: 'chunk', code: 'x'.repeat(size) };
  }
  return bundle;
}

describe('versionManifestPlugin', () => {
  let dir;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'dd-version-manifest-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  async function runWriteBundle(bundle) {
    const plugin = versionManifestPlugin();
    await plugin.writeBundle({ dir }, bundle);
    const text = await readFile(path.join(dir, 'version.json'), 'utf8');
    return JSON.parse(text);
  }

  it('is a build-only plugin (apply: "build")', () => {
    expect(versionManifestPlugin().apply).toBe('build');
  });

  it('writes version.json with a hash and an ISO builtAt timestamp', async () => {
    const manifest = await runWriteBundle(bundleOf([['index.html', 100], ['assets/index-abc.js', 5000]]));

    expect(manifest.hash).toMatch(/^[0-9a-f]{64}$/); // sha256 hex digest
    expect(new Date(manifest.builtAt).toISOString()).toBe(manifest.builtAt);
  });

  it('produces the same hash for the same bundle contents, regardless of key order', async () => {
    const a = await runWriteBundle(bundleOf([['a.js', 10], ['b.js', 20]]));
    const b = await runWriteBundle(bundleOf([['b.js', 20], ['a.js', 10]]));

    expect(a.hash).toBe(b.hash);
  });

  it('changes hash when a file size changes (a real rebuild)', async () => {
    const before = await runWriteBundle(bundleOf([['assets/index-abc.js', 5000]]));
    const after = await runWriteBundle(bundleOf([['assets/index-abc.js', 5001]]));

    expect(after.hash).not.toBe(before.hash);
  });

  it('changes hash when a filename changes (a new content hash from the bundler)', async () => {
    const before = await runWriteBundle(bundleOf([['assets/index-abc.js', 5000]]));
    const after = await runWriteBundle(bundleOf([['assets/index-def.js', 5000]]));

    expect(after.hash).not.toBe(before.hash);
  });

  it('hashes both chunk (code) and asset (source) bundle entries', async () => {
    const manifest = await runWriteBundle(bundleOf([
      ['index.html', 42, 'asset'],
      ['assets/index-abc.js', 1234, 'chunk'],
    ]));

    expect(manifest.hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('defaults to "dist" when options.dir is not given', async () => {
    // Run from inside the temp dir so a bare "dist" resolves under it, not the real repo dist/.
    const cwd = process.cwd();
    process.chdir(dir);
    try {
      await mkdir('dist', { recursive: true });
      const plugin = versionManifestPlugin();
      await plugin.writeBundle({}, bundleOf([['a.js', 1]]));
      const text = await readFile(path.join(dir, 'dist', 'version.json'), 'utf8');
      expect(JSON.parse(text).hash).toMatch(/^[0-9a-f]{64}$/);
    } finally {
      process.chdir(cwd);
    }
  });

  // publicDir participates in the hash so an art-only deploy (the game client ships its
  // skins/tiles as static public/ files, untouched by the JS bundle) still counts as a new build.
  describe('publicDir', () => {
    /** Write `files` ({ relPath: byteLength }) into a fresh public dir and hash them with `bundle`. */
    async function runWithPublic(files, bundle, config) {
      const publicDir = await mkdtemp(path.join(tmpdir(), 'dd-public-'));
      for (const [rel, size] of Object.entries(files)) {
        const abs = path.join(publicDir, rel);
        await mkdir(path.dirname(abs), { recursive: true });
        await writeFile(abs, 'x'.repeat(size));
      }
      const plugin = versionManifestPlugin();
      plugin.configResolved({ publicDir, ...config });
      await plugin.writeBundle({ dir }, bundle);
      await rm(publicDir, { recursive: true, force: true });
      return JSON.parse(await readFile(path.join(dir, 'version.json'), 'utf8'));
    }

    it('changes hash when a nested public file changes size', async () => {
      const bundle = bundleOf([['a.js', 10]]);
      const before = await runWithPublic({ 'skins/orb-core.png': 100 }, bundle);
      const after = await runWithPublic({ 'skins/orb-core.png': 101 }, bundle);

      expect(after.hash).not.toBe(before.hash);
    });

    it('changes hash when a public file is added', async () => {
      const bundle = bundleOf([['a.js', 10]]);
      const before = await runWithPublic({ 'ui/hud.png': 50 }, bundle);
      const after = await runWithPublic({ 'ui/hud.png': 50, 'ui/extra.png': 50 }, bundle);

      expect(after.hash).not.toBe(before.hash);
    });

    it('is stable across runs for identical public contents', async () => {
      const bundle = bundleOf([['a.js', 10]]);
      const files = { 'ui/hud.png': 50, 'skins/orb-core.png': 100 };

      expect((await runWithPublic(files, bundle)).hash).toBe((await runWithPublic(files, bundle)).hash);
    });

    it('ignores publicDir when copyPublicDir is false (those files never reach outDir)', async () => {
      const bundle = bundleOf([['a.js', 10]]);
      const off = { build: { copyPublicDir: false } };
      const a = await runWithPublic({ 'ui/hud.png': 50 }, bundle, off);
      const b = await runWithPublic({ 'ui/hud.png': 999 }, bundle, off);

      expect(a.hash).toBe(b.hash);
    });

    it('still hashes the bundle when configResolved never ran or publicDir is disabled', async () => {
      const plugin = versionManifestPlugin();
      plugin.configResolved({ publicDir: '' });
      await plugin.writeBundle({ dir }, bundleOf([['a.js', 10]]));
      const manifest = JSON.parse(await readFile(path.join(dir, 'version.json'), 'utf8'));

      expect(manifest.hash).toMatch(/^[0-9a-f]{64}$/);
    });

    it('treats a missing publicDir as empty rather than failing the build', async () => {
      const plugin = versionManifestPlugin();
      plugin.configResolved({ publicDir: path.join(dir, 'does-not-exist') });
      await plugin.writeBundle({ dir }, bundleOf([['a.js', 10]]));
      const manifest = JSON.parse(await readFile(path.join(dir, 'version.json'), 'utf8'));

      expect(manifest.hash).toMatch(/^[0-9a-f]{64}$/);
    });
  });
});
