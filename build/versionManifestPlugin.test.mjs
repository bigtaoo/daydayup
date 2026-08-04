import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
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
      const { mkdir } = await import('node:fs/promises');
      await mkdir('dist', { recursive: true });
      const plugin = versionManifestPlugin();
      await plugin.writeBundle({}, bundleOf([['a.js', 1]]));
      const text = await readFile(path.join(dir, 'dist', 'version.json'), 'utf8');
      expect(JSON.parse(text).hash).toMatch(/^[0-9a-f]{64}$/);
    } finally {
      process.chdir(cwd);
    }
  });
});
