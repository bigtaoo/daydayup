import type { EventBus, AppEvents } from '../core/EventBus';
import type { AppState } from '../core/AppState';
import type { ImageController } from '../images/ImageController';
import type { Rig } from '../skeleton/Rig';

export class ImagePanel {
  constructor(
    private readonly el: HTMLElement,
    bus: EventBus<AppEvents>,
    private readonly imageCtrl: ImageController,
    private readonly state: AppState,
    private readonly rig: Rig,
  ) {
    bus.on('images:change',  () => this.render());
    bus.on('binding:change', () => this.render());
    this.build();
    this.render();
  }

  private build(): void {
    const header = this.el.querySelector('.panel-header');

    // Bulk import row
    const importRow = document.createElement('div');
    importRow.style.cssText = 'padding:8px;border-bottom:1px solid var(--border)';

    const multiInput = document.createElement('input');
    multiInput.type     = 'file';
    multiInput.accept   = 'image/png,image/jpeg,image/webp';
    multiInput.multiple = true;
    multiInput.style.display = 'none';

    const importBtn = document.createElement('button');
    importBtn.className   = 'primary sm';
    importBtn.style.width = '100%';
    importBtn.textContent = '📁 Import Images…';

    importBtn.addEventListener('click', () => multiInput.click());
    multiInput.addEventListener('change', async () => {
      if (multiInput.files?.length) {
        await this.imageCtrl.importFiles(multiInput.files);
        multiInput.value = '';
      }
    });

    importRow.append(importBtn, multiInput);
    if (header?.nextSibling) {
      this.el.insertBefore(importRow, header.nextSibling);
    } else {
      this.el.appendChild(importRow);
    }
  }

  private render(): void {
    let listEl = this.el.querySelector('#image-slot-list') as HTMLElement | null;
    if (!listEl) {
      listEl = document.createElement('div');
      listEl.id = 'image-slot-list';
      listEl.style.cssText = 'flex:1;overflow-y:auto';
      this.el.appendChild(listEl);
    }
    listEl.innerHTML = '';

    const defaultZOrder = this.imageCtrl.defaultZOrder;

    for (const slotId of this.imageCtrl.allSlots) {
      const boneDef   = this.rig.boneMap.get(slotId);
      const label     = boneDef?.label ?? slotId;
      const filename  = this.imageCtrl.getFilename(slotId);
      const hasImage  = !!this.imageCtrl.getTexture(slotId);
      const binding   = this.state.getBinding(slotId);

      const row = document.createElement('div');
      row.style.cssText = 'padding:4px 8px;border-bottom:1px solid var(--border);display:grid;grid-template-columns:1fr auto;gap:4px;align-items:center';

      // Left: label + filename
      const info = document.createElement('div');
      info.style.cssText = 'min-width:0';

      const nameEl = document.createElement('div');
      nameEl.style.cssText = 'font-size:11px;font-weight:600;color:' + (hasImage ? 'var(--selected)' : 'var(--text-dim)');
      nameEl.textContent = label;

      const fileEl = document.createElement('div');
      fileEl.style.cssText = 'font-size:10px;color:var(--text-dim);white-space:nowrap;overflow:hidden;text-overflow:ellipsis';
      fileEl.textContent = filename ?? 'no image';

      info.append(nameEl, fileEl);

      // Right: controls
      const controls = document.createElement('div');
      controls.style.cssText = 'display:flex;align-items:center;gap:4px';

      // zOrder input
      const zLabel = document.createElement('span');
      zLabel.style.cssText = 'font-size:10px;color:var(--text-dim)';
      zLabel.textContent = 'z:';

      const zInput = document.createElement('input');
      zInput.type  = 'number';
      zInput.style.cssText = 'width:38px;padding:2px 4px;font-size:11px';
      zInput.value = String(binding?.zOrder ?? defaultZOrder[slotId] ?? 0);
      zInput.title = 'z-order (higher = in front)';

      zInput.addEventListener('change', () => {
        const v = parseInt(zInput.value, 10);
        if (isNaN(v)) return;
        const b = this.state.getBinding(slotId);
        if (b) {
          this.state.setBinding(slotId, { ...b, zOrder: v });
        }
      });

      controls.append(zLabel, zInput);

      // Browse button
      const fileInput = document.createElement('input');
      fileInput.type    = 'file';
      fileInput.accept  = 'image/png,image/jpeg,image/webp';
      fileInput.style.display = 'none';

      const browseBtn = document.createElement('button');
      browseBtn.className   = 'sm';
      browseBtn.textContent = hasImage ? '🔄' : '＋';
      browseBtn.title       = hasImage ? 'Replace image' : 'Load image';

      browseBtn.addEventListener('click', () => fileInput.click());
      fileInput.addEventListener('change', async () => {
        const file = fileInput.files?.[0];
        if (file) {
          await this.imageCtrl.setImage(slotId, file);
          fileInput.value = '';
        }
      });

      controls.append(fileInput, browseBtn);

      row.append(info, controls);
      listEl.appendChild(row);

      // Variant sub-row: alternate named images for this bone (e.g. eye's
      // front/back facing swap, design/12) — only meaningful once a slot has
      // a live image at all. The active chip is highlighted; clicking any
      // other chip promotes it (demoting the current one into a variant, so
      // nothing is lost); "+ variant" adds a new named alternate.
      if (hasImage) {
        listEl.appendChild(this.buildVariantRow(slotId));
      }
    }
  }

  private buildVariantRow(slotId: string): HTMLElement {
    const variantIds      = this.imageCtrl.getVariantIds(slotId);
    const activeVariantId = this.imageCtrl.getActiveVariantId(slotId);

    const variantRow = document.createElement('div');
    variantRow.style.cssText = 'padding:2px 8px 6px;border-bottom:1px solid var(--border);display:flex;flex-wrap:wrap;gap:4px;align-items:center';

    for (const vid of variantIds) {
      const isActive = vid === activeVariantId;

      const chip = document.createElement('button');
      chip.className   = 'sm';
      chip.style.cssText = 'font-size:10px;padding:1px 6px;' + (isActive ? 'background:var(--selected);color:#fff' : '');
      chip.textContent = vid;
      chip.title       = isActive ? `Active variant: ${vid}` : `Switch to variant: ${vid}`;
      if (!isActive) {
        chip.addEventListener('click', () => { void this.imageCtrl.setActiveVariant(slotId, vid); });
      }
      variantRow.appendChild(chip);

      if (!isActive) {
        const rmBtn = document.createElement('button');
        rmBtn.className   = 'sm';
        rmBtn.style.cssText = 'font-size:9px;padding:1px 4px';
        rmBtn.textContent = '✕';
        rmBtn.title       = `Remove variant "${vid}"`;
        rmBtn.addEventListener('click', () => this.imageCtrl.removeVariant(slotId, vid));
        variantRow.appendChild(rmBtn);
      }
    }

    const variantFileInput = document.createElement('input');
    variantFileInput.type    = 'file';
    variantFileInput.accept  = 'image/png,image/jpeg,image/webp';
    variantFileInput.style.display = 'none';

    const addVariantBtn = document.createElement('button');
    addVariantBtn.className   = 'sm';
    addVariantBtn.style.cssText = 'font-size:10px;padding:1px 6px';
    addVariantBtn.textContent = '+ variant';
    addVariantBtn.title       = 'Add a named alternate image for this bone (e.g. a back/vent facing)';

    addVariantBtn.addEventListener('click', () => {
      const name = window.prompt('Variant name (e.g. "back"):', '')?.trim();
      if (!name) return;
      variantFileInput.dataset.variantName = name;
      variantFileInput.click();
    });
    variantFileInput.addEventListener('change', () => {
      const file  = variantFileInput.files?.[0];
      const vname = variantFileInput.dataset.variantName;
      if (file && vname) {
        this.imageCtrl.setVariantBlob(slotId, vname, file, file.name);
      }
      variantFileInput.value = '';
    });

    variantRow.append(addVariantBtn, variantFileInput);
    return variantRow;
  }
}
