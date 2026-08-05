import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import JSZip from 'jszip';
import { EventBus, type AppEvents } from '../core/EventBus';
import { AppState } from '../core/AppState';
import { AnimationController } from '../animation/AnimationController';
import { ImageController } from '../images/ImageController';
import { CommandManager } from '../core/CommandManager';
import { Rig } from '../skeleton/Rig';
import { ORB_CORE_RIG } from '../skeleton/rigs/orbCore';
import { TARGET_SCREEN_PX, SUPERSAMPLE, type SizeTierKey } from './unitSize';

// TaoExporter imports clamp01/loadImageFromBlob/canvasToBlob (needed for real, see
// the browser-API shims above) AND saveWithPicker (only exportTao's describe block
// below exercises it) from the same './ioUtils' module — so this partial mock keeps
// the former real via importOriginal and only replaces the latter.
const ioUtilsMock = vi.hoisted(() => ({ saveWithPicker: vi.fn() }));
vi.mock('./ioUtils', async importOriginal => {
  const actual = await importOriginal<typeof import('./ioUtils')>();
  return { ...actual, saveWithPicker: ioUtilsMock.saveWithPicker };
});

import { TaoExporter } from './TaoExporter';

// ── Browser-API shims ─────────────────────────────────────────────────────────
// This workspace's plain-Node vitest has no jsdom, so every browser primitive
// TaoExporter touches (JSZip's Blob-reading FileReader, canvas 2D, Image loading,
// document.getElementById/createElement) needs a stand-in — same category as
// ioUtils.test.ts's fake Image/URL for canvasToBlob/loadImageFromBlob. The ONE
// PIXI-touching call in this file (ImageController.setBlob, used only by
// importTao's bare-frame restore branch) is stubbed per-test via vi.spyOn instead,
// matching this project's "never unit-test Pixi texture loading" convention
// (see ImageController.variants.test.ts) — everything else here (packing, baking,
// the spritesheet math) goes through the REAL implementation.

class FakeFileReader {
  onload:  ((e: { target: { result: ArrayBuffer } }) => void) | null = null;
  onerror: ((e: { target: { error: unknown } }) => void) | null = null;
  result: ArrayBuffer | null = null;
  readAsArrayBuffer(data: Blob): void {
    data.arrayBuffer().then(buf => {
      this.result = buf;
      this.onload?.({ target: { result: buf } });
    }).catch(err => this.onerror?.({ target: { error: err } }));
  }
}

/** blob (by reference) -> the "natural" pixel size loadImageFromBlob's Image should
 *  report for it. Lets each test control exactly what buildExportImages sees. */
const blobDims = new Map<Blob, { w: number; h: number }>();
function withDims(b: Blob, w: number, h: number): Blob {
  blobDims.set(b, { w, h });
  return b;
}

function fakeCanvas() {
  const ctx = { drawImage: vi.fn(), imageSmoothingEnabled: false, imageSmoothingQuality: '' };
  return {
    width: 0,
    height: 0,
    getContext: () => ctx,
    toBlob: (cb: (b: Blob | null) => void) => cb(new Blob(['png-bytes'])),
  };
}

let selectEl: { value: string };

function stubBrowserGlobals(): void {
  vi.stubGlobal('FileReader', FakeFileReader);

  const urlDims = new Map<string, { w: number; h: number }>();
  let counter = 0;
  vi.stubGlobal('URL', {
    createObjectURL: (b: Blob) => {
      const url = `blob:${counter++}`;
      urlDims.set(url, blobDims.get(b) ?? { w: 10, h: 10 });
      return url;
    },
    revokeObjectURL: vi.fn(),
  });

  class FakeImage {
    onload:  (() => void) | null = null;
    onerror: (() => void) | null = null;
    naturalWidth  = 0;
    naturalHeight = 0;
    private _src = '';
    set src(v: string) {
      this._src = v;
      const d = urlDims.get(v);
      if (d) { this.naturalWidth = d.w; this.naturalHeight = d.h; }
      queueMicrotask(() => this.onload?.());
    }
    get src() { return this._src; }
  }
  vi.stubGlobal('Image', FakeImage);

  selectEl = { value: '' };
  vi.stubGlobal('document', {
    getElementById: (id: string) => (id === 'sel-export-tier' ? selectEl : null),
    createElement:  (_tag: string) => fakeCanvas(),
  });
}

beforeEach(stubBrowserGlobals);
afterEach(() => { vi.unstubAllGlobals(); blobDims.clear(); });

// ── Fixture wiring ────────────────────────────────────────────────────────────

function buildDeps() {
  const bus = new EventBus<AppEvents>();
  const state = new AppState(bus);
  const rig = new Rig(ORB_CORE_RIG);
  const animCtrl = new AnimationController(bus, state);
  const imageCtrl = new ImageController(bus, rig);
  const cmdManager = new CommandManager(bus);
  const exporter = new TaoExporter(state, animCtrl, imageCtrl, cmdManager, bus, rig);
  return { bus, state, rig, animCtrl, imageCtrl, cmdManager, exporter };
}

function binding(scaleX = 1, scaleY = 1) {
  return { anchorX: 0.5, anchorY: 0.5, flipX: false, zOrder: 0, rotation: 0, scaleX, scaleY };
}

async function unzipJson(blobData: Blob, name: string): Promise<any> {
  const zip = await JSZip.loadAsync(blobData);
  const file = zip.file(name);
  if (!file) return undefined;
  return JSON.parse(await file.async('string'));
}

/** Ground truth for the export bake's global factor G, computed the same way
 *  TaoExporter does internally (`this.rig.computeNaturalHeight(...)`) — Rig's FK
 *  scan always includes the REST pose (see Rig.computeNaturalHeight), so hNat is
 *  never actually 0 for orb-core even with zero clips; deriving G from the real
 *  rig/clip state (instead of assuming a fallback) keeps these tests correct
 *  regardless of the rig's exact geometry. */
function expectedG(rig: Rig, animCtrl: AnimationController, state: AppState, tier: SizeTierKey = 'M'): number {
  const hNat = rig.computeNaturalHeight(animCtrl.store.values(), state.boneLengthScales);
  return (SUPERSAMPLE * TARGET_SCREEN_PX[tier]) / hNat;
}

// ── buildTaoBlob / exportTao ──────────────────────────────────────────────────

describe('TaoExporter.buildTaoBlob — animation.json shape', () => {
  it('bundles only animation.json (no spritesheet) when nothing is bound', async () => {
    const { rig, animCtrl, state, exporter } = buildDeps();
    // Rig.computeNaturalHeight's FK scan always includes the rest pose (see its own
    // doc comment on `scan(new Map())`), so hNat is the rest-pose bounding height
    // here, NOT 0, even though there are zero clips.
    const hNat = rig.computeNaturalHeight(animCtrl.store.values(), state.boneLengthScales);

    const out = await exporter.buildTaoBlob();
    const zip = await JSZip.loadAsync(out);
    const json = await unzipJson(out, 'animation.json');

    expect(zip.file('spritesheet.json')).toBeNull();
    expect(zip.file('spritesheet.png')).toBeNull();
    expect(json).toMatchObject({
      version: 2, bindings: {}, animations: {}, attachmentPoints: [],
      unitHeight: { tier: 'M', targetScreenPx: TARGET_SCREEN_PX.M, naturalHeight: Math.round(hNat), supersample: SUPERSAMPLE },
    });
    expect(json.boneLengthScales).toBeUndefined();
  });

  it('serializes bindings, clips, attachment points and length scales, honoring the tier dropdown', async () => {
    const { state, animCtrl, exporter } = buildDeps();
    selectEl.value = 'L';
    state.setBinding('shell', binding());
    state.setAllAttachmentPoints([{ id: 'shadow', label: 'Shadow', parentBone: 'shell', offsetX: 0, offsetY: 5 }]);
    state.setLengthScale('shell', 1.2);
    animCtrl.createClip('idle');
    animCtrl.selectClip('idle');
    animCtrl.addKeyframeAt(0);

    const out = await exporter.buildTaoBlob();
    const json = await unzipJson(out, 'animation.json');

    expect(json.unitHeight.tier).toBe('L');
    expect(json.unitHeight.targetScreenPx).toBe(TARGET_SCREEN_PX.L);
    expect(json.attachmentPoints).toEqual([{ id: 'shadow', label: 'Shadow', parentBone: 'shell', offsetX: 0, offsetY: 5 }]);
    expect(json.boneLengthScales).toEqual({ shell: 1.2 });
    expect(Object.keys(json.animations)).toEqual(['idle']);
  });
});

describe('TaoExporter.buildTaoBlob — image baking + spritesheet packing', () => {
  it('does not shrink an image whose bake factor clamps to 1 (binding scale large enough that v ≥ 1)', async () => {
    const { state, imageCtrl, exporter } = buildDeps();
    // scaleX=5 guarantees |5| * 1(kf) * G ≥ 1 for any plausible G, so clamp01 clamps
    // to 1 (never upscale) regardless of the rig's exact rest-pose height.
    state.setBinding('eye', binding(5, 5));
    imageCtrl.setActiveVariantLabel('eye', 'v1');
    imageCtrl.setVariantBlob('eye', 'v1', withDims(new Blob(['a']), 40, 20), 'eye.png');

    const out = await exporter.buildTaoBlob();
    const ssJson = await unzipJson(out, 'spritesheet.json');
    const json = await unzipJson(out, 'animation.json');

    expect(ssJson.frames.eye.frame).toEqual({ x: 0, y: 0, w: 40, h: 20 });
    expect(json.bindings.eye.scaleX).toBe(5); // unchanged: bakeX was 1
    expect(json.bindings.eye.scaleY).toBe(5);
  });

  it('shrinks the image and compensates binding.scale when the bake factor is < 1', async () => {
    const { state, rig, animCtrl, imageCtrl, exporter } = buildDeps();
    state.setBinding('eye', binding(0.1, 0.1));
    imageCtrl.setActiveVariantLabel('eye', 'v1');
    imageCtrl.setVariantBlob('eye', 'v1', withDims(new Blob(['a']), 100, 50), 'eye.png');

    const G = expectedG(rig, animCtrl, state);
    const bakeX = Math.min(1, 0.1 * G);

    const out = await exporter.buildTaoBlob();
    const ssJson = await unzipJson(out, 'spritesheet.json');
    const json = await unzipJson(out, 'animation.json');

    expect(ssJson.frames.eye.frame).toEqual({ x: 0, y: 0, w: Math.round(100 * bakeX), h: Math.round(50 * bakeX) });
    // binding.scale /= bakeX so keyframe.scale × binding.scale renders identical pixels.
    expect(json.bindings.eye.scaleX).toBeCloseTo(0.1 / bakeX, 10);
    expect(json.bindings.eye.scaleY).toBeCloseTo(0.1 / bakeX, 10);
  });

  it('uses the larger of two keyframes\' scale (across all clips) when computing the bake factor', async () => {
    const { state, rig, animCtrl, imageCtrl, exporter } = buildDeps();
    state.setBinding('eye', binding(0.1, 0.1));
    animCtrl.createClip('a');
    animCtrl.selectClip('a');
    animCtrl.addKeyframeAt(0);
    animCtrl.updateKeyframeProp(0, 'eye', { scaleX: 1, scaleY: 1 });
    animCtrl.addKeyframeAt(0.5);
    animCtrl.updateKeyframeProp(0.5, 'eye', { scaleX: 3, scaleY: 1 });
    imageCtrl.setActiveVariantLabel('eye', 'v1');
    imageCtrl.setVariantBlob('eye', 'v1', withDims(new Blob(['a']), 100, 100), 'eye.png');

    const G = expectedG(rig, animCtrl, state);
    const bakeX = Math.min(1, 0.1 * 3 * G); // max scaleX across both keyframes is 3
    const bakeY = Math.min(1, 0.1 * 1 * G); // scaleY never exceeds 1 in either keyframe

    const out = await exporter.buildTaoBlob();
    const ssJson = await unzipJson(out, 'spritesheet.json');

    expect(ssJson.frames.eye.frame.w).toBe(Math.round(100 * bakeX));
    expect(ssJson.frames.eye.frame.h).toBe(Math.round(100 * bakeY));
  });

  it('anchors the bake to the real natural height once a clip exists (G = SUPERSAMPLE·targetPx/hNat)', async () => {
    const { state, animCtrl, imageCtrl, rig, exporter } = buildDeps();
    // A small binding.scaleX (0.01) keeps bakeX comfortably below 1 regardless of
    // how large hNat/G turn out to be, so the "real downscale" branch is exercised.
    state.setBinding('shell', binding(0.01, 0.01));
    animCtrl.createClip('idle');
    animCtrl.selectClip('idle');
    animCtrl.addKeyframeAt(0);
    animCtrl.updateKeyframeProp(0, 'shell', { rotation: 30 });
    imageCtrl.setActiveVariantLabel('shell', 'v1');
    imageCtrl.setVariantBlob('shell', 'v1', withDims(new Blob(['a']), 200, 100), 'shell.png');

    // Ground truth: call the same pure Rig method TaoExporter calls internally,
    // with the exact same clip/length-scale state, to get hNat independently.
    const hNat = rig.computeNaturalHeight(animCtrl.store.values(), state.boneLengthScales);
    expect(hNat).toBeGreaterThan(0);
    const G = (SUPERSAMPLE * TARGET_SCREEN_PX.M) / hNat;
    const expectedBakeX = Math.min(1, 0.01 * G);

    const out = await exporter.buildTaoBlob();
    const ssJson = await unzipJson(out, 'spritesheet.json');
    const json = await unzipJson(out, 'animation.json');

    expect(json.unitHeight.naturalHeight).toBe(Math.round(hNat));
    expect(ssJson.frames.shell.frame.w).toBe(Math.max(1, Math.round(200 * expectedBakeX)));
    expect(json.bindings.shell.scaleX).toBeCloseTo(0.01 / expectedBakeX, 10);
  });
});

describe('TaoExporter.buildTaoBlob — spritesheet shelf packing', () => {
  it('names the active variant frame bare and a stashed variant "<slot>__<variant>", and wraps rows past 1024px', async () => {
    const { state, imageCtrl, exporter } = buildDeps();
    state.setBinding('eye', binding(1, 1)); // bakeX/Y clamp to 1 (fallback G=1.5) — sizes stay exactly as given.
    imageCtrl.setActiveVariantLabel('eye', 'front');
    imageCtrl.setVariantBlob('eye', 'front', withDims(new Blob(['a']), 700, 50), 'eye_front.png');
    imageCtrl.setVariantBlob('eye', 'back',  withDims(new Blob(['b']), 700, 50), 'eye_back.png');

    const out = await exporter.buildTaoBlob();
    const ssJson = await unzipJson(out, 'spritesheet.json');

    expect(Object.keys(ssJson.frames).sort()).toEqual(['eye', 'eye__back']);
    // Row 1: 'eye' at x=0. The second 700px-wide item can't fit next to it under
    // MAX_W=1024, so shelf-packing wraps it to a new row at y = rowH + PADDING.
    expect(ssJson.frames.eye.frame).toEqual({ x: 0, y: 0, w: 700, h: 50 });
    expect(ssJson.frames.eye__back.frame).toEqual({ x: 0, y: 52, w: 700, h: 50 });
    expect(ssJson.meta.size).toEqual({ w: 1024, h: 102 });
  });
});

// ── importTao ─────────────────────────────────────────────────────────────────

describe('TaoExporter.importTao', () => {
  function buildTaoZip(overrides: Record<string, unknown> = {}): Promise<Blob> {
    const zip = new JSZip();
    const project = {
      version: 2,
      bindings: { shell: binding() },
      animations: { idle: { duration: 0.5, loop: true, keyframes: [{ time: 0, bones: {} }] } },
      attachmentPoints: [{ id: 'shadow', label: 'Shadow', parentBone: 'shell', offsetX: 0, offsetY: 5 }],
      boneLengthScales: { shell: 1.2 },
      unitHeight: { tier: 'L', targetScreenPx: TARGET_SCREEN_PX.L, naturalHeight: 40, supersample: SUPERSAMPLE },
      ...overrides,
    };
    zip.file('animation.json', JSON.stringify(project));
    return zip.generateAsync({ type: 'blob' });
  }

  it('restores bindings, clips, attachments, length scales, and the export-tier dropdown', async () => {
    const { state, animCtrl, cmdManager, exporter, bus } = buildDeps();
    const cmdClearSpy = vi.spyOn(cmdManager, 'clear');
    const statuses: string[] = [];
    bus.on('status', s => statuses.push(s));
    const zipBlob = await buildTaoZip();

    await exporter.importTao(zipBlob, 'anim.tao');

    expect(state.getBinding('shell')).toEqual(binding());
    expect([...state.attachmentPoints.values()]).toEqual([{ id: 'shadow', label: 'Shadow', parentBone: 'shell', offsetX: 0, offsetY: 5 }]);
    // NB: unlike EditorProjectIO.loadEditorBlob, TaoExporter.restoreAnimationData
    // never calls state.setAllLengthScales — a `.tao` re-import silently drops any
    // per-bone length customization the exported project had. Documenting the
    // actual (buggy-looking) behavior rather than the behavior one might expect.
    expect(state.getLengthScale('shell')).toBe(1);
    expect(animCtrl.store.has('idle')).toBe(true);
    expect(animCtrl.currentName).toBe('idle');
    expect(selectEl.value).toBe('L');
    expect(cmdClearSpy).toHaveBeenCalledTimes(1);
    expect(statuses).toContain('Loaded anim.tao');
  });

  it('restores images from the spritesheet: bare frame via setBlob, "__" frame via setVariantBlob', async () => {
    const { imageCtrl, exporter } = buildDeps();
    const setBlobSpy = vi.spyOn(imageCtrl, 'setBlob').mockResolvedValue(undefined);

    const zip = new JSZip();
    zip.file('animation.json', JSON.stringify({ version: 2, bindings: {}, animations: {} }));
    zip.file('spritesheet.json', JSON.stringify({
      frames: {
        eye:        { frame: { x: 0,  y: 0, w: 10, h: 10 }, sourceSize: { w: 10, h: 10 } },
        'eye__back': { frame: { x: 12, y: 0, w: 8,  h: 8  }, sourceSize: { w: 8,  h: 8  } },
      },
      meta: { size: { w: 32, h: 10 } },
    }));
    zip.file('spritesheet.png', new Blob(['fake-png']));
    const zipBlob = await zip.generateAsync({ type: 'blob' });

    await exporter.importTao(zipBlob);

    expect(setBlobSpy).toHaveBeenCalledWith('eye', expect.any(Blob), 'eye');
    expect(imageCtrl.getVariantBlob('eye', 'back')).toBeInstanceOf(Blob);
  });

  it('emits an error and does not restore anything for an unsupported version', async () => {
    const { state, exporter, bus } = buildDeps();
    const errors: string[] = [];
    bus.on('error', msg => errors.push(msg));
    const zipBlob = await buildTaoZip({ version: 1 });

    await exporter.importTao(zipBlob);

    expect(errors).toEqual(['Unsupported version 1 (expected 2)']);
    expect(state.boneBindings.size).toBe(0);
  });

  it('emits an error when animation.json is missing from the archive', async () => {
    const { exporter, bus } = buildDeps();
    const errors: string[] = [];
    bus.on('error', msg => errors.push(msg));
    const emptyZip = await new JSZip().generateAsync({ type: 'blob' });

    await exporter.importTao(emptyZip);

    expect(errors).toEqual(['Import failed: animation.json missing from archive']);
  });
});

// ── exportTao (public wrapper: build + save + status) ────────────────────────

describe('TaoExporter.exportTao', () => {
  beforeEach(() => { ioUtilsMock.saveWithPicker.mockReset(); });

  it('builds the .tao blob, saves it via the picker, and emits status', async () => {
    ioUtilsMock.saveWithPicker.mockResolvedValue(undefined);
    const { exporter, bus } = buildDeps();
    const statuses: string[] = [];
    bus.on('status', s => statuses.push(s));

    await exporter.exportTao();

    expect(ioUtilsMock.saveWithPicker).toHaveBeenCalledTimes(1);
    const [savedBlob, suggestedName, types] = ioUtilsMock.saveWithPicker.mock.calls[0];
    expect(savedBlob).toBeInstanceOf(Blob);
    expect(suggestedName).toBe('animation');
    expect(types[0].accept['application/octet-stream']).toEqual(['.tao']);
    expect(statuses).toEqual(['Building .tao…', 'Exported .tao']);
  });

  it('emits an error status when building the blob fails (e.g. canvas.toBlob returns null)', async () => {
    const { state, imageCtrl, exporter, bus } = buildDeps();
    state.setBinding('eye', binding());
    imageCtrl.setActiveVariantLabel('eye', 'v1');
    imageCtrl.setVariantBlob('eye', 'v1', withDims(new Blob(['a']), 10, 10), 'eye.png');
    // Force the FINAL spritesheet canvas's toBlob to fail (this only fires because
    // at least one image is being packed, per the setup above).
    vi.stubGlobal('document', {
      getElementById: (id: string) => (id === 'sel-export-tier' ? selectEl : null),
      createElement: () => ({
        width: 0, height: 0,
        getContext: () => ({ drawImage: vi.fn(), imageSmoothingEnabled: false, imageSmoothingQuality: '' }),
        toBlob: (cb: (b: Blob | null) => void) => cb(null),
      }),
    });
    const errors: string[] = [];
    bus.on('error', msg => errors.push(msg));

    await exporter.exportTao();

    expect(errors).toEqual(['Export failed: canvas.toBlob returned null']);
  });
});
