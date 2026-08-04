import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventBus, type AppEvents } from '../core/EventBus';
import { AppState } from '../core/AppState';
import { AnimationController } from '../animation/AnimationController';
import { ImageController } from '../images/ImageController';
import { CommandManager } from '../core/CommandManager';
import { Rig } from '../skeleton/Rig';
import { ORB_CORE_RIG } from '../skeleton/rigs/orbCore';

const ioUtilsMock = vi.hoisted(() => ({
  hasDesktopBridge: vi.fn(),
  openViaDesktopBridge: vi.fn(),
}));
vi.mock('./ioUtils', () => ioUtilsMock);

import { IOController } from './IOController';

function fakeElement() {
  const listeners = new Map<string, Array<(e: unknown) => void>>();
  return {
    click: vi.fn(),
    value: '',
    addEventListener: (event: string, cb: (e: unknown) => void) => {
      const arr = listeners.get(event) ?? [];
      arr.push(cb);
      listeners.set(event, arr);
    },
    fire(event: string, e: unknown = { target: { files: [], value: '' } }) {
      (listeners.get(event) ?? []).forEach(cb => cb(e));
    },
  };
}

function buildController() {
  const bus = new EventBus<AppEvents>();
  const state = new AppState(bus);
  const rig = new Rig(ORB_CORE_RIG);
  const animCtrl = new AnimationController(bus, state);
  const imageCtrl = new ImageController(bus, rig);
  const cmdManager = new CommandManager(bus);

  const elements: Record<string, ReturnType<typeof fakeElement>> = {
    'btn-export': fakeElement(),
    'btn-import': fakeElement(),
    'file-input': fakeElement(),
    'btn-save-editor': fakeElement(),
    'btn-load-editor': fakeElement(),
    'editor-file-input': fakeElement(),
  };
  vi.stubGlobal('document', { getElementById: (id: string) => elements[id] });

  const controller = new IOController(state, animCtrl, imageCtrl, cmdManager, bus, rig);
  return { controller, elements };
}

describe('IOController — desktop bridge wiring', () => {
  beforeEach(() => {
    ioUtilsMock.hasDesktopBridge.mockReset();
    ioUtilsMock.openViaDesktopBridge.mockReset();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  describe('btn-import (.tao)', () => {
    it('falls back to clicking the hidden file input when there is no desktop bridge', () => {
      ioUtilsMock.hasDesktopBridge.mockReturnValue(false);
      const { elements } = buildController();

      elements['btn-import'].fire('click');

      expect(elements['file-input'].click).toHaveBeenCalledTimes(1);
      expect(ioUtilsMock.openViaDesktopBridge).not.toHaveBeenCalled();
    });

    it('uses the desktop bridge and imports the picked file when one is chosen', async () => {
      ioUtilsMock.hasDesktopBridge.mockReturnValue(true);
      const blob = new Blob(['zip-bytes']);
      ioUtilsMock.openViaDesktopBridge.mockResolvedValue({ name: 'anim.tao', blob });
      const { controller, elements } = buildController();
      const importTao = vi.spyOn(controller, 'importTao').mockResolvedValue(undefined);

      elements['btn-import'].fire('click');
      await vi.waitFor(() => expect(importTao).toHaveBeenCalled());

      expect(importTao).toHaveBeenCalledWith(blob, 'anim.tao');
      expect(elements['file-input'].click).not.toHaveBeenCalled();
      const [types] = ioUtilsMock.openViaDesktopBridge.mock.calls[0];
      expect(types[0].accept['application/octet-stream']).toEqual(['.tao']);
    });

    it('does nothing when the desktop bridge picker is cancelled', async () => {
      ioUtilsMock.hasDesktopBridge.mockReturnValue(true);
      ioUtilsMock.openViaDesktopBridge.mockResolvedValue(null);
      const { controller, elements } = buildController();
      const importTao = vi.spyOn(controller, 'importTao').mockResolvedValue(undefined);

      elements['btn-import'].fire('click');
      await vi.waitFor(() => expect(ioUtilsMock.openViaDesktopBridge).toHaveBeenCalled());

      expect(importTao).not.toHaveBeenCalled();
      expect(elements['file-input'].click).not.toHaveBeenCalled();
    });
  });

  describe('btn-load-editor (.editortao)', () => {
    it('falls back to clicking the hidden file input when there is no desktop bridge', () => {
      ioUtilsMock.hasDesktopBridge.mockReturnValue(false);
      const { elements } = buildController();

      elements['btn-load-editor'].fire('click');

      expect(elements['editor-file-input'].click).toHaveBeenCalledTimes(1);
      expect(ioUtilsMock.openViaDesktopBridge).not.toHaveBeenCalled();
    });

    it('uses the desktop bridge and loads the picked project when one is chosen', async () => {
      ioUtilsMock.hasDesktopBridge.mockReturnValue(true);
      const blob = new Blob(['project-json']);
      ioUtilsMock.openViaDesktopBridge.mockResolvedValue({ name: 'proj.editortao', blob });
      const { controller, elements } = buildController();
      const loadEditorBlob = vi.spyOn(controller, 'loadEditorBlob').mockResolvedValue(undefined);

      elements['btn-load-editor'].fire('click');
      await vi.waitFor(() => expect(loadEditorBlob).toHaveBeenCalled());

      expect(loadEditorBlob).toHaveBeenCalledWith(blob, 'proj.editortao');
      expect(elements['editor-file-input'].click).not.toHaveBeenCalled();
      const [types] = ioUtilsMock.openViaDesktopBridge.mock.calls[0];
      expect(types[0].accept['application/octet-stream']).toEqual(['.editortao']);
    });

    it('does nothing when the desktop bridge picker is cancelled', async () => {
      ioUtilsMock.hasDesktopBridge.mockReturnValue(true);
      ioUtilsMock.openViaDesktopBridge.mockResolvedValue(null);
      const { controller, elements } = buildController();
      const loadEditorBlob = vi.spyOn(controller, 'loadEditorBlob').mockResolvedValue(undefined);

      elements['btn-load-editor'].fire('click');
      await vi.waitFor(() => expect(ioUtilsMock.openViaDesktopBridge).toHaveBeenCalled());

      expect(loadEditorBlob).not.toHaveBeenCalled();
      expect(elements['editor-file-input'].click).not.toHaveBeenCalled();
    });
  });
});
