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
import { decodePNG, boxDownsample, encodePNG } from '../../png-pipeline/pngCodec.mjs';

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

  // Ground truth for "how big should each slot render": orb-core's ACTUAL SHIPPED
  // runtime bindings (client/public/skins/orb-core/animation.json), not the
  // .editortao zip's editor.json above — those are two different artifacts that
  // have drifted (found 2026-07-28 while auditing this script). editor.json's
  // bindings are all scale=1 (the raw pre-calibration export); the real numbers
  // that make orb-core render at CONFIG.playerRadius=16px on screen (shell~32px,
  // belly~16px, eye~12.8px, socket~10.4px — a real hierarchy, not a uniform
  // footprint) live only in the shipped animation.json. The PREVIOUS version of
  // this script computed skirmisher/juggernaut's scale from editor.json's stale
  // scale=1 baseline (`RESOLUTION_CORRECTION = 1254/1024`), which produced a
  // shell/belly/eye scale of ~4.9 instead of orb's real ~0.06/0.03/0.03 — i.e.
  // skirmisher/juggernaut were rendering at ~500px world-width instead of ~16-32px,
  // a ~15-30x oversized character, live-verified via a dynamic Skin instantiation
  // in the running dev server (client/src/game/Skin.ts, sprite.texture.width *
  // sprite.scale.x * wrapper.scale.x) — not merely theorized. Fixed by deriving
  // scale from orb's real per-slot (texture-width × scaleX) product instead.
  const orbRuntimeJson = JSON.parse(readFileSync(path.join(skinsDir, 'orb-core/animation.json'), 'utf8'));
  const orbWorldWidth = {}; // slot -> orb-core's real (texW * scaleX), the target apparent size every character's own slot must match
  for (const slot of ['shell', 'belly', 'eye', 'socket_l']) {
    const png = decodePNG(readFileSync(path.join(skinsDir, `orb-core/${slot}.png`)));
    orbWorldWidth[slot] = png.width * orbRuntimeJson.bindings[slot].scaleX;
  }

  // The runtime-shipped copy (client/public/skins/) is a SEPARATE artifact from the
  // .editortao project file above: the zip stays full native resolution (1024px) for
  // comfortable future editing, but the served PNGs don't need to be — this rig
  // renders at CONFIG.playerRadius=16px on screen (game/config.ts), so 1024px source
  // art is ~30x oversampled. Downsampling here (uniform box filter, whole canvas, no
  // alpha-bbox trim) is safe for anchor/pivot alignment specifically BECAUSE it's not
  // a crop — every binding's anchorX/anchorY (0.5, 0.5, a normalized fraction of the
  // texture) still points at the same relative pixel after a uniform resize, unlike a
  // trim which would shift the anchor's effective target (that's why the weapon-icon
  // pipeline's alpha-bbox trim is NOT reused here). Since Pixi scales a sprite by
  // `texture.width * binding.scaleX` (RigSkin.ts), shrinking the texture must be
  // compensated by inflating scaleX/scaleY so texW*scaleX still equals orb's real
  // target (orbWorldWidth above) — computed below from the ACTUAL post-downsample
  // width, not an assumed constant, in case box-filter rounding ever differs slot
  // to slot.
  const RUNTIME_LONG_AXIS = 256;

  function downsampleForRuntime(buf) {
    const decoded = decodePNG(buf);
    const resized = boxDownsample(decoded, RUNTIME_LONG_AXIS);
    const encoded = encodePNG(resized);
    const roundTrip = decodePNG(encoded);
    if (roundTrip.width !== resized.width || roundTrip.height !== resized.height || !roundTrip.data.every((v, i) => v === resized.data[i])) {
      throw new Error('Round-trip verification failed for runtime-downsampled rig art');
    }
    return { buffer: encoded, width: resized.width };
  }

  // Native art (shell/belly/eye) is 1024px; socket.png (shared, untouched) is
  // whatever width orb-core's own copy already is.
  const NATIVE_CHAR_ART_WIDTH = 1024;
  const socketWidth = decodePNG(socketBlob).width;
  const socketScale = orbWorldWidth.socket_l / socketWidth;

  for (const char of CHARACTERS) {
    const editorJson = JSON.parse(JSON.stringify(baseEditorJson));
    for (const slot of ['shell', 'belly', 'eye']) {
      editorJson.bindings[slot].scaleX = editorJson.bindings[slot].scaleY = orbWorldWidth[slot] / NATIVE_CHAR_ART_WIDTH;
    }
    editorJson.bindings.socket_l.scaleX = editorJson.bindings.socket_l.scaleY = socketScale;
    editorJson.bindings.socket_r.scaleX = editorJson.bindings.socket_r.scaleY = socketScale;
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

    const shellOut = downsampleForRuntime(readFileSync(path.join(unitsDir, char.shell)));
    const bellyOut = downsampleForRuntime(readFileSync(path.join(unitsDir, char.belly)));
    const eyeFrontOut = downsampleForRuntime(readFileSync(path.join(unitsDir, char.eyeFront)));
    const eyeBackOut = downsampleForRuntime(readFileSync(path.join(unitsDir, char.eyeBack)));
    if (eyeFrontOut.width !== eyeBackOut.width) {
      throw new Error(`${char.name}: eye front/back downsampled to different widths (${eyeFrontOut.width} vs ${eyeBackOut.width}) — the 'eye' binding's single scale can't fit both`);
    }

    const runtimeBindings = JSON.parse(JSON.stringify(editorJson.bindings));
    runtimeBindings.shell.scaleX = runtimeBindings.shell.scaleY = orbWorldWidth.shell / shellOut.width;
    runtimeBindings.belly.scaleX = runtimeBindings.belly.scaleY = orbWorldWidth.belly / bellyOut.width;
    runtimeBindings.eye.scaleX = runtimeBindings.eye.scaleY = orbWorldWidth.eye / eyeFrontOut.width;
    // socket_l/socket_r: unchanged from editorJson above (same socket.png, no downsample here)

    const animationJson = {
      version: 2,
      bindings: runtimeBindings,
      // Same ground-truth argument as `orbWorldWidth` above, and found the same way: the
      // .editortao zip's editor.json and the SHIPPED bundle have drifted, and it is the
      // shipped bundle that is real. Sourcing clips from editor.json meant a re-run of this
      // script silently reverted every clip authored against the runtime bundle since the
      // zip was last rebuilt -- which is exactly what would have happened to the 2026-09-02
      // additive `attack` layer had this still read `editorJson.animations`.
      animations: orbRuntimeJson.animations,
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
    writeFileSync(path.join(skinOutDir, 'shell.png'), shellOut.buffer);
    writeFileSync(path.join(skinOutDir, 'belly.png'), bellyOut.buffer);
    writeFileSync(path.join(skinOutDir, 'eye.png'), eyeFrontOut.buffer);
    writeFileSync(path.join(skinOutDir, 'eye__back.png'), eyeBackOut.buffer);
    writeFileSync(path.join(skinOutDir, 'socket_l.png'), socketBlob);
    writeFileSync(path.join(skinOutDir, 'socket_r.png'), socketBlob);
    console.log(`wrote ${skinOutDir}/ (shell ${shellOut.width}px, belly ${bellyOut.width}px, eye ${eyeFrontOut.width}px)`);
  }
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
