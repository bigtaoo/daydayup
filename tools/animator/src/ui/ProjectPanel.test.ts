import { describe, it, expect, vi, afterEach } from 'vitest';
import { EventBus, type AppEvents } from '../core/EventBus';
import type { AutoSaveController } from '../io/AutoSaveController';
import type { ProjectMeta } from '../io/ProjectStore';
import { FakeElement } from './fakeDom';
import { ProjectPanel } from './ProjectPanel';

afterEach(() => vi.unstubAllGlobals());

function makeAutoSave(overrides: Partial<Record<string, unknown>> = {}) {
  const ctrl = {
    activeId: null as string | null,
    activeName: 'Untitled',
    switchTo:              vi.fn().mockResolvedValue(undefined),
    createNew:             vi.fn().mockResolvedValue(undefined),
    rename:                vi.fn().mockResolvedValue(undefined),
    duplicate:             vi.fn().mockResolvedValue(undefined),
    remove:                vi.fn().mockResolvedValue(undefined),
    listMetaForCurrentRig: vi.fn().mockResolvedValue([] as ProjectMeta[]),
    ...overrides,
  };
  return ctrl as unknown as AutoSaveController;
}

function build(autoSave: AutoSaveController) {
  vi.stubGlobal('document', { createElement: (tag: string) => new FakeElement(tag) });
  vi.stubGlobal('window', { prompt: vi.fn(), confirm: vi.fn() });

  const root      = new FakeElement('div');
  const select    = new FakeElement('select');
  select.id       = 'project-select';
  const indicator = new FakeElement('span');
  indicator.id    = 'autosave-indicator';
  const btnNew    = new FakeElement('button'); btnNew.id    = 'btn-project-new';
  const btnRename = new FakeElement('button'); btnRename.id = 'btn-project-rename';
  const btnDup    = new FakeElement('button'); btnDup.id    = 'btn-project-dup';
  const btnDel    = new FakeElement('button'); btnDel.id    = 'btn-project-del';
  root.append(select, indicator, btnNew, btnRename, btnDup, btnDel);

  const bus = new EventBus<AppEvents>();
  const panel = new ProjectPanel(root as unknown as HTMLElement, bus, autoSave);
  return { panel, root, select, indicator, btnNew, btnRename, btnDup, btnDel, bus };
}

describe('ProjectPanel', () => {
  it('starts the autosave indicator in the idle state', () => {
    const { indicator } = build(makeAutoSave());
    expect(indicator.style.color).toBe('var(--text-dim)');
    expect(indicator.title).toBe('No unsaved changes');
  });

  it('updates the indicator color/title on every autosave:state event', () => {
    const { indicator, bus } = build(makeAutoSave());

    bus.emit('autosave:state', 'dirty');
    expect(indicator.style.color).toBe('var(--warn)');
    expect(indicator.title).toBe('Unsaved changes…');

    bus.emit('autosave:state', 'saving');
    expect(indicator.style.color).toBe('var(--accent)');

    bus.emit('autosave:state', 'saved');
    expect(indicator.style.color).toBe('#a6e3a1');
    expect(indicator.title).toBe('All changes saved');
  });

  it('selecting a different project switches to it', () => {
    const autoSave = makeAutoSave();
    const { select } = build(autoSave);

    select.value = 'proj-2';
    select.fire('change');

    expect(autoSave.switchTo).toHaveBeenCalledWith('proj-2');
  });

  it('project:active updates the select value', () => {
    const { select, bus } = build(makeAutoSave());
    bus.emit('project:active', { id: 'proj-9', name: 'Anything' });
    expect(select.value).toBe('proj-9');
  });

  it('project:list repopulates the dropdown from listMetaForCurrentRig, most-recent first as given', async () => {
    const metas: ProjectMeta[] = [
      { id: 'a', name: 'Alpha', updatedAt: 2 },
      { id: 'b', name: 'Beta',  updatedAt: 1 },
    ];
    const autoSave = makeAutoSave({ listMetaForCurrentRig: vi.fn().mockResolvedValue(metas), activeId: 'b' });
    const { select, bus } = build(autoSave);

    bus.emit('project:list');
    await vi.waitFor(() => expect(select.children).toHaveLength(2));

    expect(select.children[0].value).toBe('a');
    expect(select.children[0].textContent).toBe('Alpha');
    expect(select.children[1].value).toBe('b');
    expect(select.value).toBe('b'); // re-applied from autoSave.activeId after repopulating
  });

  describe('btn-project-new', () => {
    it('creates a new project with the typed (trimmed) name', () => {
      const autoSave = makeAutoSave();
      const { btnNew } = build(autoSave);
      (window as unknown as { prompt: ReturnType<typeof vi.fn> }).prompt.mockReturnValue('  My Character  ');

      btnNew.fire('click');

      expect(autoSave.createNew).toHaveBeenCalledWith('My Character');
    });

    it('falls back to "Untitled" when the trimmed name is blank', () => {
      const autoSave = makeAutoSave();
      const { btnNew } = build(autoSave);
      (window as unknown as { prompt: ReturnType<typeof vi.fn> }).prompt.mockReturnValue('   ');

      btnNew.fire('click');

      expect(autoSave.createNew).toHaveBeenCalledWith('Untitled');
    });

    it('does nothing when the prompt is cancelled', () => {
      const autoSave = makeAutoSave();
      const { btnNew } = build(autoSave);
      (window as unknown as { prompt: ReturnType<typeof vi.fn> }).prompt.mockReturnValue(null);

      btnNew.fire('click');

      expect(autoSave.createNew).not.toHaveBeenCalled();
    });
  });

  describe('btn-project-rename', () => {
    it('renames using the typed (trimmed) name, pre-filled with the active name', () => {
      const autoSave = makeAutoSave({ activeName: 'Old Name' });
      const { btnRename } = build(autoSave);
      const promptMock = (window as unknown as { prompt: ReturnType<typeof vi.fn> }).prompt;
      promptMock.mockReturnValue('  New Name  ');

      btnRename.fire('click');

      expect(promptMock).toHaveBeenCalledWith('Rename project:', 'Old Name');
      expect(autoSave.rename).toHaveBeenCalledWith('New Name');
    });

    it('does nothing when the name is cancelled or blank', () => {
      const autoSave = makeAutoSave();
      const { btnRename } = build(autoSave);
      (window as unknown as { prompt: ReturnType<typeof vi.fn> }).prompt.mockReturnValue('   ');

      btnRename.fire('click');

      expect(autoSave.rename).not.toHaveBeenCalled();
    });
  });

  describe('btn-project-dup', () => {
    it('duplicates unconditionally', () => {
      const autoSave = makeAutoSave();
      const { btnDup } = build(autoSave);

      btnDup.fire('click');

      expect(autoSave.duplicate).toHaveBeenCalledTimes(1);
    });
  });

  describe('btn-project-del', () => {
    it('removes the active project after confirm', () => {
      const autoSave = makeAutoSave({ activeName: 'Doomed' });
      const { btnDel } = build(autoSave);
      const confirmMock = (window as unknown as { confirm: ReturnType<typeof vi.fn> }).confirm;
      confirmMock.mockReturnValue(true);

      btnDel.fire('click');

      expect(confirmMock).toHaveBeenCalledWith('Delete project "Doomed"? This cannot be undone.');
      expect(autoSave.remove).toHaveBeenCalledTimes(1);
    });

    it('does nothing when confirm is declined', () => {
      const autoSave = makeAutoSave();
      const { btnDel } = build(autoSave);
      (window as unknown as { confirm: ReturnType<typeof vi.fn> }).confirm.mockReturnValue(false);

      btnDel.fire('click');

      expect(autoSave.remove).not.toHaveBeenCalled();
    });
  });
});
