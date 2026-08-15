import { createHash } from 'node:crypto';
import { readdir, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';

// Vite equivalent of funny's webpack VersionManifestPlugin (design/tools/desktop-shell/
// DESIGN.md §4.2): emits <outDir>/version.json so a running page can detect that a newer
// build has been deployed without comparing full asset contents. Two consumers:
//   - the desktop shell's contentUpdatePoller (tools/desktop-shell), which reloads a tool's
//     BrowserView after asking it to save;
//   - the web client's foreground auto-reload (client/src/platform/web/autoReload.ts).
//
// The hash is a sha256 over every emitted file's name+size (not full content — cheap, and a
// name or size change is exactly what a real rebuild produces). publicDir is folded in
// alongside the bundle because the game client ships most of its art as static public/
// files: a skin/tile re-export changes nothing in the JS bundle, but it is still a new
// build players should pick up. The SOURCE publicDir is read rather than the copied output,
// so this does not depend on when Vite runs its public-dir copy relative to writeBundle.

/** Recursively collect `<relative path>:<byte size>` lines for every file under `dir`. */
async function publicDirEntries(dir) {
  /** @type {string[]} */
  const entries = [];
  /** @param {string} current @param {string} prefix */
  async function walk(current, prefix) {
    const dirents = await readdir(current, { withFileTypes: true });
    for (const dirent of dirents) {
      const rel = prefix ? `${prefix}/${dirent.name}` : dirent.name;
      const abs = path.join(current, dirent.name);
      if (dirent.isDirectory()) await walk(abs, rel);
      else entries.push(`${rel}:${(await stat(abs)).size}`);
    }
  }
  await walk(dir, '');
  return entries;
}

/** @returns {import('vite').Plugin} */
export function versionManifestPlugin() {
  /** @type {string | null} */
  let publicDir = null;

  return {
    name: 'dd-version-manifest',
    apply: 'build',
    configResolved(config) {
      // `publicDir` is '' (falsy) when the project disables it, and copyPublicDir:false means
      // those files never reach outDir — in both cases they are not part of this build.
      publicDir = config.build?.copyPublicDir === false ? null : config.publicDir || null;
    },
    async writeBundle(options, bundle) {
      const hash = createHash('sha256');
      for (const fileName of Object.keys(bundle).sort()) {
        const item = bundle[fileName];
        const size = item.type === 'asset' ? item.source.length : item.code.length;
        hash.update(`${fileName}:${size}\n`);
      }
      if (publicDir) {
        // Missing publicDir is normal (a project simply has no static files) — not an error.
        const entries = await publicDirEntries(publicDir).catch(() => []);
        for (const entry of entries.sort()) hash.update(`public/${entry}\n`);
      }
      const manifest = { hash: hash.digest('hex'), builtAt: new Date().toISOString() };
      const outDir = options.dir ?? 'dist';
      await writeFile(path.join(outDir, 'version.json'), JSON.stringify(manifest), 'utf8');
    },
  };
}
