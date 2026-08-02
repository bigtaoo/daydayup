/**
 * Forge's Forger-NPC sprite (design/13's "Outpost/hub" NPC gap). Decorative,
 * corner-anchored art that must stay hidden until BOTH its texture exists (uiSkins.ts's
 * non-blocking preload — nothing generated yet just means `getUiTexture` returns
 * undefined) AND the viewport is wide enough beside the centered row column (mirrors
 * `renderCompareCard`'s own no-room hide check, covered separately in Forge.test.ts).
 * `render/uiSkins.ts` is mocked here so the "texture exists" branch is actually
 * reachable under vitest — Forge.test.ts's own suite never registers one, so it only
 * ever exercises the "no texture" fallback.
 */
import { describe, it, expect, vi } from 'vitest';
import { DOMAdapter, Texture, TextureSource, type Sprite } from 'pixi.js';
import { Forge } from './Forge';
import { defaultMetaState } from '../meta';

const mocks = vi.hoisted(() => ({ npcTexture: undefined as Texture | undefined }));

vi.mock('../render/uiSkins', () => ({
  getUiTexture: (key: string) => (key === 'npc_forger' ? mocks.npcTexture : undefined),
}));

// Same fake-canvas seam Forge.test.ts installs — render() reads Text.height to flow
// its layout, which needs a real 2D context this repo's plain-node vitest lacks.
DOMAdapter.set({
  ...DOMAdapter.get(),
  createCanvas: (width?: number, height?: number) => {
    const ctx = {
      font: '',
      measureText(text: string) {
        const m = /(\d+(?:\.\d+)?)px/.exec(this.font as string);
        const fontSize = m ? parseFloat(m[1]!) : 10;
        const w = text.length * fontSize * 0.6;
        return { width: w, actualBoundingBoxAscent: fontSize * 0.8, actualBoundingBoxDescent: fontSize * 0.2 };
      },
    };
    return { width: width ?? 0, height: height ?? 0, getContext: () => ctx } as unknown as HTMLCanvasElement;
  },
  getCanvasRenderingContext2D: () => class {} as unknown as typeof CanvasRenderingContext2D,
});

function npcSpriteOf(f: Forge): Sprite {
  return (f as unknown as { npcSprite: Sprite }).npcSprite;
}

describe('Forge — Forger NPC visibility', () => {
  it('stays hidden when no texture has been generated yet, even on a wide viewport', () => {
    mocks.npcTexture = undefined;
    const f = new Forge();
    f.render(defaultMetaState(), 1280, 720);
    expect(npcSpriteOf(f).visible).toBe(false);
  });

  it('shows once a texture exists and the viewport is wide enough beside the row column', () => {
    mocks.npcTexture = new Texture({ source: new TextureSource({ width: 100, height: 140 }) });
    const f = new Forge();
    f.render(defaultMetaState(), 1280, 720);
    const sprite = npcSpriteOf(f);
    expect(sprite.visible).toBe(true);
    expect(sprite.texture).toBe(mocks.npcTexture);
  });

  it('hides again on a narrow viewport even though the texture exists (no-room hide, like the compare card)', () => {
    mocks.npcTexture = new Texture({ source: new TextureSource({ width: 100, height: 140 }) });
    const f = new Forge();
    f.render(defaultMetaState(), 700, 720); // cx+300 leaves < 130px margin at this width
    expect(npcSpriteOf(f).visible).toBe(false);
  });

  it('scales to fit a max height without exceeding it, preserving aspect ratio', () => {
    mocks.npcTexture = new Texture({ source: new TextureSource({ width: 100, height: 140 }) });
    const f = new Forge();
    f.render(defaultMetaState(), 1280, 720);
    const sprite = npcSpriteOf(f);
    // targetH = min(220, h*0.32=230.4) = 220; scale = targetH / textureHeight
    expect(sprite.scale.y).toBeCloseTo(220 / 140, 5);
    expect(sprite.scale.x).toBeCloseTo(220 / 140, 5); // uniform scale, not stretched
  });
});
