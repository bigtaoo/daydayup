import { describe, it, expect, vi, afterEach } from 'vitest';
import { EventBus, type AppEvents } from '../core/EventBus';
import { AnimationController } from '../animation/AnimationController';
import { AppState } from '../core/AppState';
import { CommandManager } from '../core/CommandManager';
import { FakeElement, installFakeDocument } from './fakeDom';
import { AnimListPanel } from './AnimListPanel';

afterEach(() => vi.unstubAllGlobals());

function build() {
  const btnNew = new FakeElement('button');
  const btnDel = new FakeElement('button');
  const btnRen = new FakeElement('button');
  installFakeDocument({
    'btn-new-anim': btnNew,
    'btn-del-anim': btnDel,
    'btn-ren-anim': btnRen,
  });

  const bus       = new EventBus<AppEvents>();
  const state     = new AppState(bus);
  const animCtrl  = new AnimationController(bus, state);
  const cmdManager = new CommandManager(bus);
  const listEl    = new FakeElement('div');

  const errors: string[] = [];
  bus.on('error', msg => errors.push(msg));

  const panel = new AnimListPanel(listEl as unknown as HTMLElement, bus, animCtrl, cmdManager);
  return { panel, listEl, bus, animCtrl, cmdManager, btnNew, btnDel, btnRen, errors };
}

describe('AnimListPanel', () => {
  it('renders nothing for an empty store', () => {
    const { listEl } = build();
    expect(listEl.children).toHaveLength(0);
  });

  it('renders one row per clip, marking the current clip active', () => {
    const { listEl, animCtrl, bus } = build();
    animCtrl.createClip('idle');
    animCtrl.createClip('walk');
    animCtrl.selectClip('walk');
    bus.emit('anim:list');

    expect(listEl.children).toHaveLength(2);
    const idleRow = listEl.children.find(c => c.innerHTML.includes('idle'))!;
    const walkRow = listEl.children.find(c => c.innerHTML.includes('walk'))!;
    expect(idleRow.hasClass('active')).toBe(false);
    expect(walkRow.hasClass('active')).toBe(true);
  });

  it('clicking a row selects that clip', () => {
    const { listEl, animCtrl } = build();
    animCtrl.createClip('idle');
    animCtrl.createClip('walk');

    const walkRow = listEl.children.find(c => c.innerHTML.includes('walk'))!;
    walkRow.fire('click');

    expect(animCtrl.currentName).toBe('walk');
  });

  it('re-renders on anim:list and anim:select', () => {
    const { listEl, animCtrl, bus } = build();
    expect(listEl.children).toHaveLength(0);

    animCtrl.createClip('idle'); // emits anim:list itself
    expect(listEl.children).toHaveLength(1);

    bus.emit('anim:select', 'idle');
    expect(listEl.children).toHaveLength(1); // re-rendered, still one row
  });

  describe('new (btn-new-anim)', () => {
    it('creates and selects a clip typed into the prompt', () => {
      const { btnNew, animCtrl } = build();
      vi.stubGlobal('prompt', vi.fn().mockReturnValue('idle'));

      btnNew.fire('click');

      expect(animCtrl.store.has('idle')).toBe(true);
      expect(animCtrl.currentName).toBe('idle');
    });

    it('does nothing when the prompt is cancelled or blank', () => {
      const { btnNew, animCtrl } = build();
      vi.stubGlobal('prompt', vi.fn().mockReturnValue('   '));

      btnNew.fire('click');

      expect(animCtrl.store.size).toBe(0);
    });

    it('emits an error instead of creating a duplicate-named clip', () => {
      const { btnNew, animCtrl, errors } = build();
      animCtrl.createClip('idle');
      vi.stubGlobal('prompt', vi.fn().mockReturnValue('idle'));

      btnNew.fire('click');

      expect(errors).toEqual(['"idle" already exists.']);
      expect(animCtrl.store.size).toBe(1);
    });

    it('is undoable via the command manager', () => {
      const { btnNew, animCtrl, cmdManager } = build();
      vi.stubGlobal('prompt', vi.fn().mockReturnValue('idle'));

      btnNew.fire('click');
      expect(animCtrl.store.has('idle')).toBe(true);

      cmdManager.undo();
      expect(animCtrl.store.has('idle')).toBe(false);
    });
  });

  describe('delete (btn-del-anim)', () => {
    it('deletes the current clip after confirm', () => {
      const { btnDel, animCtrl } = build();
      animCtrl.createClip('idle');
      animCtrl.selectClip('idle');
      vi.stubGlobal('confirm', vi.fn().mockReturnValue(true));

      btnDel.fire('click');

      expect(animCtrl.store.has('idle')).toBe(false);
    });

    it('does nothing when confirm is declined', () => {
      const { btnDel, animCtrl } = build();
      animCtrl.createClip('idle');
      animCtrl.selectClip('idle');
      vi.stubGlobal('confirm', vi.fn().mockReturnValue(false));

      btnDel.fire('click');

      expect(animCtrl.store.has('idle')).toBe(true);
    });

    it('does nothing when there is no current clip', () => {
      const { btnDel, animCtrl } = build();
      const confirmMock = vi.fn().mockReturnValue(true);
      vi.stubGlobal('confirm', confirmMock);

      btnDel.fire('click');

      expect(confirmMock).not.toHaveBeenCalled();
      expect(animCtrl.store.size).toBe(0);
    });
  });

  describe('rename (btn-ren-anim)', () => {
    it('renames the current clip', () => {
      const { btnRen, animCtrl } = build();
      animCtrl.createClip('idle');
      animCtrl.selectClip('idle');
      vi.stubGlobal('prompt', vi.fn().mockReturnValue('walk'));

      btnRen.fire('click');

      expect(animCtrl.store.has('walk')).toBe(true);
      expect(animCtrl.store.has('idle')).toBe(false);
    });

    it('does nothing when there is no current clip', () => {
      const { btnRen, animCtrl } = build();
      const promptMock = vi.fn().mockReturnValue('walk');
      vi.stubGlobal('prompt', promptMock);

      btnRen.fire('click');

      expect(promptMock).not.toHaveBeenCalled();
      expect(animCtrl.store.size).toBe(0);
    });

    it('does nothing when the new name is blank or unchanged', () => {
      const { btnRen, animCtrl } = build();
      animCtrl.createClip('idle');
      animCtrl.selectClip('idle');
      vi.stubGlobal('prompt', vi.fn().mockReturnValue('idle'));

      btnRen.fire('click');

      expect(animCtrl.store.has('idle')).toBe(true);
      expect(animCtrl.store.size).toBe(1);
    });

    it('emits an error instead of renaming onto an existing clip', () => {
      const { btnRen, animCtrl, errors } = build();
      animCtrl.createClip('idle');
      animCtrl.createClip('walk');
      animCtrl.selectClip('idle');
      vi.stubGlobal('prompt', vi.fn().mockReturnValue('walk'));

      btnRen.fire('click');

      expect(errors).toEqual(['"walk" already exists.']);
      expect(animCtrl.store.has('idle')).toBe(true);
    });

    it('is undoable via the command manager', () => {
      const { btnRen, animCtrl, cmdManager } = build();
      animCtrl.createClip('idle');
      animCtrl.selectClip('idle');
      vi.stubGlobal('prompt', vi.fn().mockReturnValue('walk'));

      btnRen.fire('click');
      expect(animCtrl.store.has('walk')).toBe(true);

      cmdManager.undo();
      expect(animCtrl.store.has('idle')).toBe(true);
      expect(animCtrl.store.has('walk')).toBe(false);
    });
  });
});
