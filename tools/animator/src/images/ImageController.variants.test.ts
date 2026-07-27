import { describe, it, expect } from 'vitest';
import { ImageController } from './ImageController';
import { EventBus, type AppEvents } from '../core/EventBus';
import { Rig } from '../skeleton/Rig';
import { ORB_CORE_RIG } from '../skeleton/rigs/orbCore';

// NOTE: deliberately never calls setBlob/setImage/setActiveVariant here — those
// route through PIXI.BaseTexture.from(objectURL), which needs a real Image/
// canvas the plain Node vitest environment (no jsdom configured, matching this
// project's existing convention of not unit-testing Pixi-texture loading at
// all) doesn't have. This file covers the pure bookkeeping surface only — the
// full load-through-the-real-app path was verified live against the running
// dev server instead (see the orb-core.editortao / boss-core seed projects).

function makeController(): ImageController {
  const bus = new EventBus<AppEvents>();
  const rig = new Rig(ORB_CORE_RIG);
  return new ImageController(bus, rig);
}

function blob(text: string): Blob {
  return new Blob([text], { type: 'image/png' });
}

describe('ImageController variants', () => {
  it('a slot with no image has no variants', () => {
    const ctrl = makeController();
    expect(ctrl.getVariantIds('eye')).toEqual(['default']);
    expect(ctrl.getActiveVariantId('eye')).toBe('default');
  });

  it('setVariantBlob stashes an alternate without touching the active slot', () => {
    const ctrl = makeController();
    ctrl.setVariantBlob('eye', 'back', blob('back-bytes'), 'eye_back.png');

    expect(ctrl.getVariantIds('eye').sort()).toEqual(['back', 'default'].sort());
    expect(ctrl.getActiveVariantId('eye')).toBe('default');
    expect(ctrl.getVariantBlob('eye', 'back')).toBeInstanceOf(Blob);
    // Active variant ('default') has no real texture loaded in this test, so no blob yet.
    expect(ctrl.getVariantBlob('eye', 'default')).toBeUndefined();
  });

  it('setActiveVariantLabel relabels the active slot without side effects', () => {
    const ctrl = makeController();
    ctrl.setActiveVariantLabel('eye', 'front');
    expect(ctrl.getActiveVariantId('eye')).toBe('front');
    expect(ctrl.getVariantIds('eye')).toEqual(['front']);
  });

  it('getAllVariantEntries returns every stashed variant (no active texture in this test)', () => {
    const ctrl = makeController();
    ctrl.setVariantBlob('eye', 'back', blob('back-bytes'), 'eye_back.png');
    ctrl.setVariantBlob('eye', 'side', blob('side-bytes'), 'eye_side.png');

    const entries = ctrl.getAllVariantEntries('eye');
    const ids = entries.map(e => e.variantId).sort();
    expect(ids).toEqual(['back', 'side']);
    expect(entries.find(e => e.variantId === 'back')?.displayName).toBe('eye_back.png');
  });

  it('removeVariant drops a stashed variant but refuses to drop the active one', () => {
    const ctrl = makeController();
    ctrl.setVariantBlob('eye', 'back', blob('back-bytes'), 'eye_back.png');
    expect(ctrl.getVariantIds('eye')).toContain('back');

    ctrl.removeVariant('eye', 'back');
    expect(ctrl.getVariantIds('eye')).toEqual(['default']);

    // 'default' is the active variant — removeVariant must no-op on it.
    ctrl.removeVariant('eye', 'default');
    expect(ctrl.getActiveVariantId('eye')).toBe('default');
  });

  it('variants are scoped per slot — a variant named "back" on eye does not leak to socket_l', () => {
    const ctrl = makeController();
    ctrl.setVariantBlob('eye', 'back', blob('eye-back'), 'eye_back.png');
    expect(ctrl.getVariantIds('socket_l')).toEqual(['default']);
  });

  it('clearAll wipes stashed variants and active-variant labels for every slot', () => {
    const ctrl = makeController();
    ctrl.setVariantBlob('eye', 'back', blob('back-bytes'), 'eye_back.png');
    ctrl.setActiveVariantLabel('eye', 'front');
    ctrl.setVariantBlob('socket_l', 'alt', blob('alt-bytes'), 'alt.png');

    ctrl.clearAll();

    expect(ctrl.getVariantIds('eye')).toEqual(['default']);
    expect(ctrl.getActiveVariantId('eye')).toBe('default');
    expect(ctrl.getVariantIds('socket_l')).toEqual(['default']);
  });
});
