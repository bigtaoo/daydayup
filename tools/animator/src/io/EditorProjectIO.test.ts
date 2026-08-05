import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import JSZip from 'jszip';
import { EventBus, type AppEvents } from '../core/EventBus';
import { AppState } from '../core/AppState';
import { AnimationController } from '../animation/AnimationController';
import { ImageController } from '../images/ImageController';
import { CommandManager } from '../core/CommandManager';
import { Rig } from '../skeleton/Rig';
import { ORB_CORE_RIG } from '../skeleton/rigs/orbCore';

// EditorProjectIO only ever imports `saveWithPicker` from ioUtils (not
// clamp01/loadImageFromBlob/canvasToBlob — those are TaoExporter's), so mocking
// the whole module here is safe for every test in this file, not just the
// saveEditorProject describe block below.
const ioUtilsMock = vi.hoisted(() => ({ saveWithPicker: vi.fn() }));
vi.mock('./ioUtils', () => ioUtilsMock);

import { EditorProjectIO } from './EditorProjectIO';

// NOTE on images/: EditorProjectIO's build path only ever reads ImageController's
// pure bookkeeping (getAllVariantEntries/getActiveVariantId) — never routes through
// PIXI, so priming `_variantBlobs`/`_activeVariantId` via setVariantBlob/
// setActiveVariantLabel (both pure, no texture load) is enough to exercise the
// images/ zip-building logic for real. The LOAD path's bare-filename branch does
// call `imageCtrl.setBlob`, which routes through PIXI.BaseTexture.from(objectURL) —
// that one call is stubbed via vi.spyOn in the load tests below, matching this
// project's existing "never unit-test Pixi texture loading" convention (see
// ImageController.variants.test.ts).

function blob(text: string): Blob {
  return new Blob([text], { type: 'image/png' });
}

// JSZip.loadAsync only knows how to pull bytes out of a Blob via FileReader
// (lib/utils.js's prepareContent — `isBlob && typeof FileReader !== 'undefined'`);
// with no FileReader in plain-Node vitest it silently falls through to "unsupported
// data type". Both buildEditorBlob/loadEditorBlob (the code under test) and this
// file's own unzipJson helper feed JSZip a real Blob, so every test needs this shim —
// same category of missing-browser-API stub as ioUtils.test.ts's fake Image/URL.
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

beforeEach(() => { vi.stubGlobal('FileReader', FakeFileReader); });
afterEach(() => { vi.unstubAllGlobals(); });

function buildDeps() {
  const bus = new EventBus<AppEvents>();
  const state = new AppState(bus);
  const rig = new Rig(ORB_CORE_RIG);
  const animCtrl = new AnimationController(bus, state);
  const imageCtrl = new ImageController(bus, rig);
  const cmdManager = new CommandManager(bus);
  const editorIO = new EditorProjectIO(state, animCtrl, imageCtrl, cmdManager, bus);
  return { bus, state, rig, animCtrl, imageCtrl, cmdManager, editorIO };
}

async function unzipJson(blobData: Blob, name: string): Promise<any> {
  const zip = await JSZip.loadAsync(blobData);
  const file = zip.file(name);
  if (!file) return undefined;
  return JSON.parse(await file.async('string'));
}

describe('EditorProjectIO.buildEditorBlob', () => {
  it('produces a minimal editor.json when the project is empty', async () => {
    const { editorIO } = buildDeps();

    const out = await editorIO.buildEditorBlob();
    const json = await unzipJson(out, 'editor.json');

    expect(json).toEqual({
      version: 1,
      selectedClip: null,
      previewMode: 'skeleton',
      bindings: {},
      animations: {},
      attachmentPoints: [],
    });
    // Sparse-omission: no boneLengthScales/activeVariantIds keys when both are empty.
    expect(json.boneLengthScales).toBeUndefined();
    expect(json.activeVariantIds).toBeUndefined();
  });

  it('serializes bindings, animations, attachment points, length scales, and selection', async () => {
    const { state, animCtrl, editorIO } = buildDeps();

    state.setBinding('shell', { anchorX: 0.5, anchorY: 0.5, flipX: false, zOrder: 0, rotation: 0, scaleX: 1, scaleY: 1 });
    state.setAllAttachmentPoints([{ id: 'shadow', label: 'Shadow', parentBone: 'shell', offsetX: 0, offsetY: 10 }]);
    state.setLengthScale('shell', 1.5);
    animCtrl.createClip('idle');
    animCtrl.selectClip('idle');
    animCtrl.addKeyframeAt(0);

    const out = await editorIO.buildEditorBlob();
    const json = await unzipJson(out, 'editor.json');

    expect(json.selectedClip).toBe('idle');
    expect(json.previewMode).toBe('skeleton');
    expect(json.bindings.shell).toEqual({ anchorX: 0.5, anchorY: 0.5, flipX: false, zOrder: 0, rotation: 0, scaleX: 1, scaleY: 1 });
    expect(json.attachmentPoints).toEqual([{ id: 'shadow', label: 'Shadow', parentBone: 'shell', offsetX: 0, offsetY: 10 }]);
    expect(json.boneLengthScales).toEqual({ shell: 1.5 });
    expect(Object.keys(json.animations)).toEqual(['idle']);
    expect(json.animations.idle.keyframes).toHaveLength(1);
  });

  it('writes the active variant as bare "<slot>.png" and stashed alternates as "<slot>__<variant>.png"', async () => {
    const { state, imageCtrl, editorIO } = buildDeps();
    state.setBinding('eye', { anchorX: 0.5, anchorY: 0.5, flipX: false, zOrder: 0, rotation: 0, scaleX: 1, scaleY: 1 });

    // Prime the active variant (label 'front') plus a stashed alternate ('back'),
    // without ever touching PIXI — see the file-level note.
    imageCtrl.setActiveVariantLabel('eye', 'front');
    imageCtrl.setVariantBlob('eye', 'front', blob('front-bytes'), 'eye_front.png');
    imageCtrl.setVariantBlob('eye', 'back', blob('back-bytes'), 'eye_back.png');

    const out = await editorIO.buildEditorBlob();
    const zip = await JSZip.loadAsync(out);

    expect(zip.file('images/eye.png')).not.toBeNull();
    expect(zip.file('images/eye__back.png')).not.toBeNull();
    const json = await unzipJson(out, 'editor.json');
    expect(json.activeVariantIds).toEqual({ eye: 'front' });
  });

  it('skips a bound slot that has no image entries at all', async () => {
    const { state, editorIO } = buildDeps();
    state.setBinding('belly', { anchorX: 0.5, anchorY: 0.5, flipX: false, zOrder: 0, rotation: 0, scaleX: 1, scaleY: 1 });

    const out = await editorIO.buildEditorBlob();
    const zip = await JSZip.loadAsync(out);

    expect(zip.file('images/belly.png')).toBeNull();
    const json = await unzipJson(out, 'editor.json');
    expect(json.activeVariantIds).toBeUndefined();
  });
});

describe('EditorProjectIO.loadEditorBlob', () => {
  async function buildProjectZip(overrides: Record<string, unknown> = {}): Promise<Blob> {
    const zip = new JSZip();
    const project = {
      version: 1,
      selectedClip: 'idle',
      previewMode: 'sprite',
      bindings: { shell: { anchorX: 0.5, anchorY: 0.5, flipX: false, zOrder: 0, rotation: 0, scaleX: 1, scaleY: 1 } },
      animations: { idle: { duration: 0.5, loop: true, keyframes: [{ time: 0, bones: {} }] } },
      attachmentPoints: [{ id: 'shadow', label: 'Shadow', parentBone: 'shell', offsetX: 0, offsetY: 10 }],
      boneLengthScales: { shell: 1.25 },
      activeVariantIds: { eye: 'front' },
      ...overrides,
    };
    zip.file('editor.json', JSON.stringify(project));
    const imgFolder = zip.folder('images')!;
    imgFolder.file('eye.png', blob('front-bytes'));
    imgFolder.file('eye__back.png', blob('back-bytes'));
    return zip.generateAsync({ type: 'blob' });
  }

  it('restores bindings, animations, attachments, length scales, preview mode, and images', async () => {
    const { state, animCtrl, imageCtrl, cmdManager, editorIO } = buildDeps();
    const setBlobSpy = vi.spyOn(imageCtrl, 'setBlob').mockResolvedValue(undefined);
    const clearAllSpy = vi.spyOn(imageCtrl, 'clearAll');
    const cmdClearSpy = vi.spyOn(cmdManager, 'clear');
    const zipBlob = await buildProjectZip();

    await editorIO.loadEditorBlob(zipBlob, 'proj.editortao');

    expect(clearAllSpy).toHaveBeenCalledTimes(1);
    expect(state.getBinding('shell')).toEqual({ anchorX: 0.5, anchorY: 0.5, flipX: false, zOrder: 0, rotation: 0, scaleX: 1, scaleY: 1 });
    expect([...state.attachmentPoints.values()]).toEqual([{ id: 'shadow', label: 'Shadow', parentBone: 'shell', offsetX: 0, offsetY: 10 }]);
    expect(state.getLengthScale('shell')).toBe(1.25);
    expect(state.previewMode).toBe('sprite');
    expect(animCtrl.store.has('idle')).toBe(true);
    expect(animCtrl.currentName).toBe('idle');

    expect(setBlobSpy).toHaveBeenCalledWith('eye', expect.any(Blob), 'eye.png');
    expect(imageCtrl.getVariantIds('eye')).toEqual(expect.arrayContaining(['back']));
    expect(imageCtrl.getActiveVariantId('eye')).toBe('front');
    expect(cmdClearSpy).toHaveBeenCalledTimes(1);
  });

  it('emits an error and stops without mutating state when editor.json is missing', async () => {
    const { state, editorIO, bus } = buildDeps();
    const errors: string[] = [];
    bus.on('error', msg => errors.push(msg));
    const emptyZip = await new JSZip().generateAsync({ type: 'blob' });

    await editorIO.loadEditorBlob(emptyZip, 'broken.editortao');

    expect(errors).toEqual(['Load failed: editor.json missing from archive']);
    expect(state.boneBindings.size).toBe(0);
  });

  it('emits an error and does not clear existing state for an unsupported version', async () => {
    const { state, imageCtrl, editorIO, bus } = buildDeps();
    const clearAllSpy = vi.spyOn(imageCtrl, 'clearAll');
    state.setBinding('shell', { anchorX: 0, anchorY: 0, flipX: false, zOrder: 0, rotation: 0, scaleX: 1, scaleY: 1 });
    const errors: string[] = [];
    bus.on('error', msg => errors.push(msg));
    const zipBlob = await buildProjectZip({ version: 2 });

    await editorIO.loadEditorBlob(zipBlob, 'proj.editortao');

    expect(errors).toEqual(['Unsupported editor version 2']);
    expect(clearAllSpy).not.toHaveBeenCalled();
    expect(state.boneBindings.has('shell')).toBe(true);
  });

  it('falls back to selecting the first loaded clip when selectedClip is null', async () => {
    const { animCtrl, imageCtrl, editorIO } = buildDeps();
    vi.spyOn(imageCtrl, 'setBlob').mockResolvedValue(undefined);
    const zipBlob = await buildProjectZip({ selectedClip: null });

    await editorIO.loadEditorBlob(zipBlob, 'proj.editortao');

    expect(animCtrl.currentName).toBe('idle');
  });

  it('loadEditorProject(file) delegates to loadEditorBlob using the File name as the label', async () => {
    const { imageCtrl, editorIO, bus } = buildDeps();
    vi.spyOn(imageCtrl, 'setBlob').mockResolvedValue(undefined);
    const statuses: string[] = [];
    bus.on('status', s => statuses.push(s));
    const zipBlob = await buildProjectZip();
    const file = new File([await zipBlob.arrayBuffer()], 'my-project.editortao');

    await editorIO.loadEditorProject(file);

    expect(statuses).toContain('Loaded my-project.editortao');
  });
});

describe('EditorProjectIO.saveEditorProject', () => {
  beforeEach(() => { ioUtilsMock.saveWithPicker.mockReset(); });

  it('builds the blob, saves it via the picker, and emits status', async () => {
    ioUtilsMock.saveWithPicker.mockResolvedValue(undefined);
    const { editorIO, bus } = buildDeps();
    const statuses: string[] = [];
    bus.on('status', s => statuses.push(s));

    await editorIO.saveEditorProject();

    expect(ioUtilsMock.saveWithPicker).toHaveBeenCalledTimes(1);
    const [savedBlob, suggestedName, types] = ioUtilsMock.saveWithPicker.mock.calls[0];
    expect(savedBlob).toBeInstanceOf(Blob);
    expect(suggestedName).toBe('project');
    expect(types[0].accept['application/octet-stream']).toEqual(['.editortao']);
    expect(statuses).toEqual(['Saving .editortao…', 'Project saved']);
  });

  it('emits an error status when the picker rejects', async () => {
    ioUtilsMock.saveWithPicker.mockRejectedValue(new Error('disk full'));
    const { editorIO, bus } = buildDeps();
    const errors: string[] = [];
    bus.on('error', msg => errors.push(msg));

    await editorIO.saveEditorProject();

    expect(errors).toEqual(['Save failed: disk full']);
  });
});
