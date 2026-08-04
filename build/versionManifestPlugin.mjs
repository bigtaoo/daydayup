import { createHash } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';

// Vite equivalent of funny's webpack VersionManifestPlugin (design/tools/desktop-shell/
// DESIGN.md §4.2): emits <outDir>/version.json so the desktop shell's contentUpdatePoller
// can detect a tool has a new build without comparing full asset contents. The hash is a
// sha256 over every emitted file's name+size (not full content — cheap, and a name or size
// change is exactly what a real rebuild produces).

/** @returns {import('vite').Plugin} */
export function versionManifestPlugin() {
  return {
    name: 'dd-version-manifest',
    apply: 'build',
    async writeBundle(options, bundle) {
      const hash = createHash('sha256');
      for (const fileName of Object.keys(bundle).sort()) {
        const item = bundle[fileName];
        const size = item.type === 'asset' ? item.source.length : item.code.length;
        hash.update(`${fileName}:${size}\n`);
      }
      const manifest = { hash: hash.digest('hex'), builtAt: new Date().toISOString() };
      const outDir = options.dir ?? 'dist';
      await writeFile(path.join(outDir, 'version.json'), JSON.stringify(manifest), 'utf8');
    },
  };
}
