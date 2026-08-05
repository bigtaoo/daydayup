import { describe, it, expect, vi, afterEach } from 'vitest';
import { EventBus, type AppEvents } from '../core/EventBus';
import { AppState } from '../core/AppState';
import { Rig } from '../skeleton/Rig';
import { ORB_CORE_RIG } from '../skeleton/rigs/orbCore';
import type { ImageController } from '../images/ImageController';
import type { SpriteBinding } from '../core/types';
import { FakeElement, installFakeDocument } from './fakeDom';
import { ImagePanel } from './ImagePanel';

afterEach(() => vi.unstubAllGlobals());

function binding(zOrder: number): SpriteBinding {
  return { anchorX: 0.5, anchorY: 0.5, flipX: false, zOrder, rotation: 0, scaleX: 1, scaleY: 1 };
}

function makeImageCtrl(overrides: Partial<Record<string, unknown>> = {}) {
  const ctrl = {
    allSlots: ['shell', 'eye'],
    defaultZOrder: { shell: 0, eye: 1 },
    getFilename:       vi.fn(() => undefined),
    getTexture:        vi.fn(() => undefined),
    setImage:          vi.fn().mockResolvedValue(undefined),
    importFiles:       vi.fn().mockResolvedValue(undefined),
    getVariantIds:     vi.fn(() => ['default']),
    getActiveVariantId: vi.fn(() => 'default'),
    setActiveVariant:  vi.fn().mockResolvedValue(undefined),
    removeVariant:     vi.fn(),
    setVariantBlob:    vi.fn(),
    ...overrides,
  };
  return ctrl as unknown as ImageController;
}

function build(imageCtrl: ImageController) {
  installFakeDocument();
  vi.stubGlobal('window', { prompt: vi.fn() });

  const el     = new FakeElement('div');
  el.appendChild(new FakeElement('div')).className = 'panel-header';
  const header = el.children[0];
  header.className = 'panel-header';

  const bus   = new EventBus<AppEvents>();
  const rig   = new Rig(ORB_CORE_RIG);
  const state = new AppState(bus);

  const panel = new ImagePanel(el as unknown as HTMLElement, bus, imageCtrl, state, rig);
  return { el, bus, rig, state, panel };
}

describe('ImagePanel', () => {
  it('inserts the bulk-import row right after the panel header', () => {
    const { el } = build(makeImageCtrl());
    expect(el.children[0].hasClass('panel-header')).toBe(true);
    const importRow = el.children[1];
    const importBtn = importRow.children.find(c => c.tagName === 'BUTTON')!;
    expect(importBtn.textContent).toContain('Import Images');
  });

  it('appends the import row at the end when there is no panel header', () => {
    installFakeDocument();
    vi.stubGlobal('window', { prompt: vi.fn() });
    const el   = new FakeElement('div');
    const bus  = new EventBus<AppEvents>();
    const rig  = new Rig(ORB_CORE_RIG);
    const state = new AppState(bus);
    new ImagePanel(el as unknown as HTMLElement, bus, makeImageCtrl(), state, rig);
    // No header ⇒ import row + the rendered #image-slot-list are both direct children.
    expect(el.children[0].children.some(c => c.tagName === 'BUTTON')).toBe(true);
  });

  it('clicking the bulk-import button clicks the hidden multi-file input', () => {
    const { el } = build(makeImageCtrl());
    const importRow = el.children[1];
    const importBtn   = importRow.children.find(c => c.tagName === 'BUTTON')!;
    const multiInput  = importRow.children.find(c => c.tagName === 'INPUT')!;

    importBtn.fire('click');
    expect(multiInput.click).toHaveBeenCalledTimes(1);
  });

  it('picking files in the multi-input imports them and clears the input', async () => {
    const imageCtrl = makeImageCtrl();
    const { el } = build(imageCtrl);
    const importRow  = el.children[1];
    const multiInput = importRow.children.find(c => c.tagName === 'INPUT')!;

    multiInput.files = [{ name: 'a.png' }];
    multiInput.value = 'a.png';
    multiInput.fire('change');
    await vi.waitFor(() => expect(imageCtrl.importFiles).toHaveBeenCalledWith(multiInput.files));

    expect(multiInput.value).toBe('');
  });

  it('does nothing when the multi-input change fires with no files', () => {
    const imageCtrl = makeImageCtrl();
    const { el } = build(imageCtrl);
    const importRow  = el.children[1];
    const multiInput = importRow.children.find(c => c.tagName === 'INPUT')!;

    multiInput.files = [];
    multiInput.fire('change');
    expect(imageCtrl.importFiles).not.toHaveBeenCalled();
  });

  it('renders one row per slot, with label + "no image" placeholder', () => {
    const { el, rig } = build(makeImageCtrl());
    const list = el.querySelector('#image-slot-list')!;
    expect(list).toBeTruthy();

    const rows = list.children;
    expect(rows).toHaveLength(2); // shell, eye — no variant rows since hasImage is false for both

    const shellRow = rows[0];
    const nameEl = shellRow.children[0].children[0];
    expect(nameEl.textContent).toBe(rig.boneMap.get('shell')!.label);
    const fileEl = shellRow.children[0].children[1];
    expect(fileEl.textContent).toBe('no image');
  });

  it('falls back to the raw slotId as the label when the rig has no bone def for it', () => {
    const imageCtrl = makeImageCtrl({ allSlots: ['ghost-slot'] });
    const { el } = build(imageCtrl);
    const list = el.querySelector('#image-slot-list')!;
    const nameEl = list.children[0].children[0].children[0];
    expect(nameEl.textContent).toBe('ghost-slot');
  });

  it('shows the filename when the image controller has one loaded', () => {
    const imageCtrl = makeImageCtrl({ getFilename: vi.fn(() => 'shell.png') });
    const { el } = build(imageCtrl);
    const list = el.querySelector('#image-slot-list')!;
    const fileEl = list.children[0].children[0].children[1];
    expect(fileEl.textContent).toBe('shell.png');
  });

  it('re-renders (rebuilding rows, not duplicating the list) on images:change / binding:change', () => {
    const imageCtrl = makeImageCtrl();
    const { el, bus } = build(imageCtrl);

    bus.emit('images:change', 'shell');
    bus.emit('binding:change', 'shell');

    // Still exactly one #image-slot-list, with the same two rows.
    const lists = el.querySelectorAll('#image-slot-list');
    expect(lists).toHaveLength(1);
    expect(lists[0].children).toHaveLength(2);
  });

  it('the z-order input defaults to the binding zOrder, falling back to imageCtrl.defaultZOrder', () => {
    const { el, state } = build(makeImageCtrl());
    state.setBinding('shell', binding(7));

    // binding:change triggers a re-render — re-query afterwards.
    const list = el.querySelector('#image-slot-list')!;
    const shellControls = list.children[0].children[1];
    const zInput = shellControls.children.find(c => c.type === 'number')!;
    expect(zInput.value).toBe('7');

    const eyeControls = list.children[1].children[1];
    const eyeZInput = eyeControls.children.find(c => c.type === 'number')!;
    expect(eyeZInput.value).toBe('1'); // imageCtrl.defaultZOrder.eye, no binding
  });

  it('changing the z-order input updates the existing binding', () => {
    const { el, state } = build(makeImageCtrl());
    state.setBinding('shell', binding(0));

    const list = el.querySelector('#image-slot-list')!;
    const zInput = list.children[0].children[1].children.find(c => c.type === 'number')!;
    zInput.value = '9';
    zInput.fire('change');

    expect(state.getBinding('shell')).toEqual(binding(9));
  });

  it('ignores a non-numeric z-order edit', () => {
    const { el, state } = build(makeImageCtrl());
    state.setBinding('shell', binding(3));

    const list = el.querySelector('#image-slot-list')!;
    const zInput = list.children[0].children[1].children.find(c => c.type === 'number')!;
    zInput.value = 'abc';
    zInput.fire('change');

    expect(state.getBinding('shell')).toEqual(binding(3));
  });

  it('silently no-ops a z-order edit when the slot has no binding at all', () => {
    const { el, state } = build(makeImageCtrl());
    const list = el.querySelector('#image-slot-list')!;
    const zInput = list.children[1].children[1].children.find(c => c.type === 'number')!; // eye, unbound
    zInput.value = '5';
    zInput.fire('change');
    expect(state.getBinding('eye')).toBeUndefined();
  });

  it('browse button click clicks the hidden per-slot file input, and picking a file loads it', async () => {
    const imageCtrl = makeImageCtrl();
    const { el } = build(imageCtrl);
    const list = el.querySelector('#image-slot-list')!;
    const controls = list.children[0].children[1];
    const fileInput = controls.children.find(c => c.tagName === 'INPUT' && c.type === 'file')!;
    const browseBtn  = controls.children.find(c => c.tagName === 'BUTTON')!;

    expect(browseBtn.textContent).toBe('＋'); // no image yet ⇒ "load" glyph

    browseBtn.fire('click');
    expect(fileInput.click).toHaveBeenCalledTimes(1);

    fileInput.files = [{ name: 'shell.png' }];
    fileInput.value = 'shell.png';
    fileInput.fire('change');
    await vi.waitFor(() => expect(imageCtrl.setImage).toHaveBeenCalledWith('shell', fileInput.files![0]));
    expect(fileInput.value).toBe('');
  });

  it('browse button reads "replace" when the slot already has an image', () => {
    const imageCtrl = makeImageCtrl({ getTexture: vi.fn(() => ({})) });
    const { el } = build(imageCtrl);
    const list = el.querySelector('#image-slot-list')!;
    const controls = list.children[0].children[1];
    const browseBtn = controls.children.find(c => c.tagName === 'BUTTON')!;
    expect(browseBtn.textContent).toBe('🔄');
  });

  it('does nothing when the per-slot file input change fires with no file chosen', () => {
    const imageCtrl = makeImageCtrl();
    const { el } = build(imageCtrl);
    const list = el.querySelector('#image-slot-list')!;
    const fileInput = list.children[0].children[1].children.find(c => c.tagName === 'INPUT' && c.type === 'file')!;
    fileInput.files = [];
    fileInput.fire('change');
    expect(imageCtrl.setImage).not.toHaveBeenCalled();
  });

  describe('variant row (only rendered once a slot has an image)', () => {
    function withVariants() {
      return makeImageCtrl({
        getTexture:         vi.fn(() => ({})),
        getVariantIds:      vi.fn(() => ['front', 'back']),
        getActiveVariantId: vi.fn(() => 'front'),
      });
    }

    it('is omitted entirely when the slot has no image', () => {
      const { el } = build(makeImageCtrl());
      const list = el.querySelector('#image-slot-list')!;
      expect(list.children).toHaveLength(2); // one row per slot, no variant sub-rows
    });

    it('renders a chip per variant, highlighting the active one and hiding its remove button', () => {
      const imageCtrl = withVariants();
      const { el } = build(imageCtrl);
      const list = el.querySelector('#image-slot-list')!;
      // shell row (0), shell variant row (1), eye row (2), eye variant row (3)
      const variantRow = list.children[1];
      const buttons = variantRow.children.filter(c => c.tagName === 'BUTTON');

      const frontChip = buttons.find(b => b.textContent === 'front')!;
      const backChip  = buttons.find(b => b.textContent === 'back')!;
      expect(frontChip.style.cssText).toContain('var(--selected)');
      expect(backChip.style.cssText).not.toContain('var(--selected)');

      // Remove (✕) buttons: one for "back", none for the active "front".
      const removeBtns = buttons.filter(b => b.textContent === '✕');
      expect(removeBtns).toHaveLength(1);
    });

    it('clicking a non-active chip promotes that variant', () => {
      const imageCtrl = withVariants();
      const { el } = build(imageCtrl);
      const variantRow = el.querySelector('#image-slot-list')!.children[1];
      const backChip = variantRow.children.find(c => c.tagName === 'BUTTON' && c.textContent === 'back')!;

      backChip.fire('click');
      expect(imageCtrl.setActiveVariant).toHaveBeenCalledWith('shell', 'back');
    });

    it('clicking a remove (✕) button removes that variant', () => {
      const imageCtrl = withVariants();
      const { el } = build(imageCtrl);
      const variantRow = el.querySelector('#image-slot-list')!.children[1];
      const removeBtn = variantRow.children.find(c => c.tagName === 'BUTTON' && c.textContent === '✕')!;

      removeBtn.fire('click');
      expect(imageCtrl.removeVariant).toHaveBeenCalledWith('shell', 'back');
    });

    it('"+ variant" prompts for a name, then clicks the hidden variant file input', () => {
      const imageCtrl = withVariants();
      const { el } = build(imageCtrl);
      (window as unknown as { prompt: ReturnType<typeof vi.fn> }).prompt.mockReturnValue('side');

      const variantRow = el.querySelector('#image-slot-list')!.children[1];
      const addBtn = variantRow.children.find(c => c.tagName === 'BUTTON' && c.textContent === '+ variant')!;
      const variantFileInput = variantRow.children.find(c => c.tagName === 'INPUT')!;

      addBtn.fire('click');
      expect(variantFileInput.dataset.variantName).toBe('side');
      expect(variantFileInput.click).toHaveBeenCalledTimes(1);
    });

    it('"+ variant" does nothing when the prompt is cancelled or blank', () => {
      const imageCtrl = withVariants();
      const { el } = build(imageCtrl);
      (window as unknown as { prompt: ReturnType<typeof vi.fn> }).prompt.mockReturnValue('   ');

      const variantRow = el.querySelector('#image-slot-list')!.children[1];
      const addBtn = variantRow.children.find(c => c.tagName === 'BUTTON' && c.textContent === '+ variant')!;
      const variantFileInput = variantRow.children.find(c => c.tagName === 'INPUT')!;

      addBtn.fire('click');
      expect(variantFileInput.click).not.toHaveBeenCalled();
    });

    it('picking a variant file calls setVariantBlob with the stashed name, then clears the input', () => {
      const imageCtrl = withVariants();
      const { el } = build(imageCtrl);
      const variantRow = el.querySelector('#image-slot-list')!.children[1];
      const variantFileInput = variantRow.children.find(c => c.tagName === 'INPUT')!;

      variantFileInput.dataset.variantName = 'side';
      const file = { name: 'shell_side.png' };
      variantFileInput.files = [file];
      variantFileInput.fire('change');

      expect(imageCtrl.setVariantBlob).toHaveBeenCalledWith('shell', 'side', file, 'shell_side.png');
      expect(variantFileInput.value).toBe('');
    });

    it('picking a variant file with no stashed name is a no-op', () => {
      const imageCtrl = withVariants();
      const { el } = build(imageCtrl);
      const variantRow = el.querySelector('#image-slot-list')!.children[1];
      const variantFileInput = variantRow.children.find(c => c.tagName === 'INPUT')!;

      variantFileInput.files = [{ name: 'shell_side.png' }];
      variantFileInput.fire('change');

      expect(imageCtrl.setVariantBlob).not.toHaveBeenCalled();
    });
  });
});
