// One-off build script: constructs skirmisher-core.editortao and
// juggernaut-core.editortao by cloning orb-core.editortao's editor.json
// (bindings/animations/attachmentPoints are shared — same orb-core rig,
// design/12 "a skin is the same skeleton with its own part PNGs") and
// swapping in each character's own shell/belly/eye/eye__back art, reusing
// the universal socket.png for socket_l/socket_r (design/13: theme lives on
// the orb, never on the weapon mount). Mirrors the Node+jszip approach used
// to bind orb-core.editortao / boss-core.editortao (design/12, 2026-07-27).
//
// Run from tools/animator: node scripts/build-character-projects.mjs
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import JSZip from 'jszip';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '../../..'); // repo root
const projectsDir = path.resolve(here, '../projects');
const unitsDir = path.join(root, 'art/units');
const skinsDir = path.join(root, 'client/public/skins');

const CHARACTERS = [
  {
    name: 'skirmisher-core',
    shell: 'skirmisher_shell.png',
    belly: 'skirmisher_belly.png',
    eyeFront: 'skirmisher_eye_front.png',
    eyeBack: 'skirmisher_eye_back.png',
  },
  {
    name: 'juggernaut-core',
    shell: 'juggernaut_shell.png',
    belly: 'juggernaut_belly.png',
    eyeFront: 'juggernaut_eye_front.png',
    eyeBack: 'juggernaut_eye_back.png',
  },
];

async function main() {
  const baseBuf = readFileSync(path.join(projectsDir, 'orb-core.editortao'));
  const baseZip = await JSZip.loadAsync(baseBuf);
  const baseEditorJson = JSON.parse(await baseZip.file('editor.json').async('string'));
  const socketBlob = readFileSync(path.join(unitsDir, 'socket.png'));

  // Base art (shell/belly/eye) is 1254px; the new characters' GPT Image 2 output
  // is 1024px. Bindings default to scale 1 (native pixel size), which would
  // render the new characters ~18% smaller than the base purely as an artifact
  // of source resolution, not a deliberate silhouette choice (design/13's
  // silhouette-reads-archetype intent is about SHAPE, not incidental export
  // size) — so scale shell/belly/eye up to match the base's apparent footprint.
  // socket_l/socket_r keep scale 1 (same socket.png texture, unchanged).
  const RESOLUTION_CORRECTION = 1254 / 1024;

  for (const char of CHARACTERS) {
    const editorJson = JSON.parse(JSON.stringify(baseEditorJson));
    for (const slot of ['shell', 'belly', 'eye']) {
      editorJson.bindings[slot].scaleX = RESOLUTION_CORRECTION;
      editorJson.bindings[slot].scaleY = RESOLUTION_CORRECTION;
    }
    const zip = new JSZip();
    zip.file('editor.json', JSON.stringify(editorJson, null, 2));
    const imgFolder = zip.folder('images');
    imgFolder.file('shell.png', readFileSync(path.join(unitsDir, char.shell)));
    imgFolder.file('belly.png', readFileSync(path.join(unitsDir, char.belly)));
    imgFolder.file('eye.png', readFileSync(path.join(unitsDir, char.eyeFront)));
    imgFolder.file('eye__back.png', readFileSync(path.join(unitsDir, char.eyeBack)));
    imgFolder.file('socket_l.png', socketBlob);
    imgFolder.file('socket_r.png', socketBlob);

    const outBuf = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
    const outPath = path.join(projectsDir, `${char.name}.editortao`);
    writeFileSync(outPath, outBuf);
    console.log(`wrote ${outPath} (${outBuf.length} bytes)`);

    // client/public/skins/<name>/ — the loose-file bundle client/src/render/taoBundle.ts
    // actually loads at runtime (design/12's real packed .tao is still pending; see
    // that file's header comment). Same shape as the existing orb-core export:
    // animation.json (version 2: bindings + animations only, no editor-only fields)
    // + frames.json (slotId -> variant ids, 'default' = the active/unsuffixed frame)
    // + one loose PNG per slot/variant.
    const skinOutDir = path.join(skinsDir, char.name);
    mkdirSync(skinOutDir, { recursive: true });
    const animationJson = {
      version: 2,
      bindings: editorJson.bindings,
      animations: editorJson.animations,
    };
    writeFileSync(path.join(skinOutDir, 'animation.json'), JSON.stringify(animationJson, null, 2));
    const framesJson = {
      shell: ['default'],
      belly: ['default'],
      eye: ['default', 'back'],
      socket_l: ['default'],
      socket_r: ['default'],
    };
    writeFileSync(path.join(skinOutDir, 'frames.json'), JSON.stringify(framesJson, null, 2));
    writeFileSync(path.join(skinOutDir, 'shell.png'), readFileSync(path.join(unitsDir, char.shell)));
    writeFileSync(path.join(skinOutDir, 'belly.png'), readFileSync(path.join(unitsDir, char.belly)));
    writeFileSync(path.join(skinOutDir, 'eye.png'), readFileSync(path.join(unitsDir, char.eyeFront)));
    writeFileSync(path.join(skinOutDir, 'eye__back.png'), readFileSync(path.join(unitsDir, char.eyeBack)));
    writeFileSync(path.join(skinOutDir, 'socket_l.png'), socketBlob);
    writeFileSync(path.join(skinOutDir, 'socket_r.png'), socketBlob);
    console.log(`wrote ${skinOutDir}/`);
  }
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
