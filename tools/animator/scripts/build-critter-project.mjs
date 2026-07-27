// One-off build script: constructs critter-core.editortao — the minimal one-bone
// enemy rig (tools/animator/src/skeleton/rigs/critterCore.ts) bound to the existing
// neutral art/units/enemy_critter.png, with a gentle idle bob so it's actually
// previewable/animated instead of a static image. Mirrors the Node+jszip approach
// used for orb-core.editortao / boss-core.editortao / the two character projects
// (design/12, 2026-07-27).
//
// Run from tools/animator: node scripts/build-critter-project.mjs
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import JSZip from 'jszip';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '../../..');
const projectsDir = path.resolve(here, '../projects');
const unitsDir = path.join(root, 'art/units');
const skinsDir = path.join(root, 'client/public/skins');

// body's bodyR=50 (authoring px, skeleton/rigs/critterCore.ts) vs enemy_critter.png's
// actual 1254px native resolution — same "Static scale offset" correction every other
// real-art binding needed (client/src/render/critterCoreRig.ts's
// CRITTER_CORE_REFERENCE_RADIUS convention): scale = (2*bodyR)/nativePx.
const BODY_SCALE = 100 / 1254;

async function main() {
  const editorJson = {
    version: 1,
    selectedClip: 'idle',
    previewMode: 'sprite',
    bindings: {
      body: {
        anchorX: 0.5,
        anchorY: 0.5,
        flipX: false,
        zOrder: 0,
        rotation: 0,
        scaleX: BODY_SCALE,
        scaleY: BODY_SCALE,
      },
    },
    animations: {
      idle: {
        duration: 2,
        loop: true,
        keyframes: [
          { time: 0, bones: { body: { translateY: 0 } } },
          { time: 1, bones: { body: { translateY: -6 } } },
          { time: 2, bones: { body: { translateY: 0 } } },
        ],
      },
      hurt: {
        duration: 0.3,
        loop: false,
        keyframes: [
          { time: 0, bones: { body: { scaleX: 1, scaleY: 1, alpha: 1 } } },
          { time: 0.06, bones: { body: { scaleX: 1.15, scaleY: 0.8, alpha: 0.6 } } },
          { time: 0.18, bones: { body: { scaleX: 0.95, scaleY: 1.05, alpha: 1 } } },
          { time: 0.3, bones: { body: { scaleX: 1, scaleY: 1, alpha: 1 } } },
        ],
      },
      death: {
        duration: 0.9,
        loop: false,
        keyframes: [
          { time: 0, bones: { body: { scaleX: 1, scaleY: 1, translateY: 0, alpha: 1 } } },
          { time: 0.3, bones: { body: { scaleX: 1.1, scaleY: 0.85, translateY: 6, alpha: 1 } } },
          { time: 0.6, bones: { body: { scaleX: 0.7, scaleY: 0.5, translateY: 14, alpha: 0.5 } } },
          { time: 0.9, bones: { body: { scaleX: 0.4, scaleY: 0.3, translateY: 18, alpha: 0 } } },
        ],
      },
      spawn: {
        duration: 0.35,
        loop: false,
        keyframes: [
          { time: 0, bones: { body: { scaleX: 0.2, scaleY: 0.2, alpha: 0 } } },
          { time: 0.15, bones: { body: { scaleX: 1.15, scaleY: 0.85, alpha: 1 } } },
          { time: 0.25, bones: { body: { scaleX: 0.95, scaleY: 1.05 } } },
          { time: 0.35, bones: { body: { scaleX: 1, scaleY: 1 } } },
        ],
      },
    },
    attachmentPoints: [{ id: 'shadow', label: '🔵 Shadow', parentBone: 'root', offsetX: 0, offsetY: 4 }],
  };

  const zip = new JSZip();
  zip.file('editor.json', JSON.stringify(editorJson, null, 2));
  zip.folder('images').file('body.png', readFileSync(path.join(unitsDir, 'enemy_critter.png')));

  const outBuf = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
  const outPath = path.join(projectsDir, 'critter-core.editortao');
  writeFileSync(outPath, outBuf);
  console.log(`wrote ${outPath} (${outBuf.length} bytes)`);

  // client/public/skins/critter-core/ — the loose-file bundle client/src/render/
  // taoBundle.ts actually loads at runtime (same shape as the character bundles,
  // design/12's real packed .tao is still pending).
  const skinOutDir = path.join(skinsDir, 'critter-core');
  mkdirSync(skinOutDir, { recursive: true });
  const animationJson = {
    version: 2,
    bindings: editorJson.bindings,
    animations: editorJson.animations,
  };
  writeFileSync(path.join(skinOutDir, 'animation.json'), JSON.stringify(animationJson, null, 2));
  writeFileSync(path.join(skinOutDir, 'frames.json'), JSON.stringify({ body: ['default'] }, null, 2));
  writeFileSync(path.join(skinOutDir, 'body.png'), readFileSync(path.join(unitsDir, 'enemy_critter.png')));
  console.log(`wrote ${skinOutDir}/`);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
