// The cap's key light, pre-multiplied into the swatch instead of drawn as a second additive copy
// of it (2026-08-24 draw-call pass). `wallTone.ts` still owns the numbers; this file only moves
// WHERE they are applied.
//
// `wallTone.CAP_BOOST_*` exists because Pixi tints can only multiply DOWN, so the only way to lift
// a cap above its swatch's own value is to draw the swatch a second time in `add` mode — see that
// constant's doc for the contrast-ratio measurement that chose an additive copy over a white wash.
// The cost of doing it at draw time is one extra display object per wall block whose blend mode
// differs from its neighbours', and a blend-mode change breaks Pixi's sprite batch: on the level-1
// start room (27 wall runs, 8 live enemies, 1920x855) those 27 sprites were costing 29 of the
// frame's 161 draw calls — 54 once the rest of the frame batched properly, because each one cuts
// the batch both before and after itself.
//
// None of that lift depends on what is BEHIND the cap, though, which is what makes it removable.
// The cap tile is opaque, so the destination the additive copy reads is exactly the cap tile drawn
// immediately before it, and the two layers composite to
//
//     cap * CAP_TINT + cap * CAP_BOOST_TINT * CAP_BOOST_ALPHA  ==  cap * LIT_CAP_FACTORS
//
// per channel. That is a function of the swatch alone, so it can be baked once into a texture and
// drawn as a single ordinary sprite. The identity is exact rather than approximate: the factors
// land at (1.95, 1.902, 1.834), all above 1, which is precisely why a tint cannot express them and
// why the bake has to happen in texture space. Verified by reading back the composited frame before
// and after — 0 of 1,641,600 pixels differ.
//
// Two caveats, both checked against the shipped swatches:
//   * **Clamping.** `add` clamps at 1.0 in the framebuffer; the bake clamps at 255 in the texture.
//     Same point, given an opaque swatch. `wall_fire.png` peaks at 183, so 5 pixels in 65536 clamp
//     in red and none in green or blue — and those same 5 clamped in the additive path too.
//   * **Opacity.** Where the swatch is semi-transparent the additive copy adds over the FLOOR, not
//     over the cap, and no per-texel bake can reproduce that. All four `wall_*.png` swatches are
//     fully opaque (minimum alpha 255), so the case does not arise; if a future swatch has soft
//     edges, this is the assumption that breaks.
//
// The bake needs a 2D canvas, which a headless test environment does not have. `bakeLitCap` returns
// `undefined` there and `wallRender.addCapLayers` keeps the original two-layer additive path, so the
// cap is never left unlit — the optimisation is an optimisation, not a correctness dependency.
//
// Every DOM touch here goes through Pixi's `DOMAdapter` rather than through `document` and
// `Texture.from` directly, because the WeChat mini-game runtime has neither a `document` nor an
// `HTMLCanvasElement` global — and `Texture.from` identifies a canvas by `instanceof` against
// exactly those globals. Going through the adapter is what makes this file work on that target;
// see `platform/wechat/WeChatAdapter.ts`.
import { CanvasSource, DOMAdapter, Texture } from 'pixi.js';
import type { ICanvas, ICanvasRenderingContext2D } from 'pixi.js';
import { CAP_BOOST_ALPHA, CAP_BOOST_TINT, CAP_TINT } from './wallTone';

/** Per-channel multiplier the two cap layers composite to. See the module header for the identity. */
export const LIT_CAP_FACTORS: readonly [number, number, number] = [
  channel(CAP_TINT, 0) + channel(CAP_BOOST_TINT, 0) * CAP_BOOST_ALPHA,
  channel(CAP_TINT, 1) + channel(CAP_BOOST_TINT, 1) * CAP_BOOST_ALPHA,
  channel(CAP_TINT, 2) + channel(CAP_BOOST_TINT, 2) * CAP_BOOST_ALPHA,
];

/** One 0..1 channel of a 0xRRGGBB hex colour; `i` is 0 for red, 1 for green, 2 for blue. */
function channel(hex: number, i: number): number {
  return ((hex >> (16 - i * 8)) & 0xff) / 255;
}

/**
 * Apply `LIT_CAP_FACTORS` to RGBA bytes in place, leaving alpha untouched.
 *
 * Rounded and clamped exactly as the GPU's additive blend would be when it writes an 8-bit target,
 * so a baked texel and the two-layer composite agree to the last bit for an opaque source.
 * Exported for tests — it is the whole of the transform, with none of the canvas plumbing.
 *
 * Takes a plain `Uint8Array` as well as the `Uint8ClampedArray` that `ImageData.data` actually is.
 * The wider type is deliberate: with the clamped variant the `Math.min` below is unreachable (the
 * array clamps on assignment and the factors only ever push UP), so a mutation battery could delete
 * it and stay green — a lift of 1.95 on a value of 200 wraps to 134 in an unclamped buffer, which
 * is a black stone in place of a white one. Accepting both keeps the clamp load-bearing and tested.
 */
export function applyLitCap(rgba: Uint8Array | Uint8ClampedArray): void {
  const [kr, kg, kb] = LIT_CAP_FACTORS;
  for (let i = 0; i < rgba.length; i += 4) {
    rgba[i] = Math.min(255, Math.round(rgba[i]! * kr));
    rgba[i + 1] = Math.min(255, Math.round(rgba[i + 1]! * kg));
    rgba[i + 2] = Math.min(255, Math.round(rgba[i + 2]! * kb));
  }
}

/** Keyed by the SOURCE texture's uid: one bake per swatch, however many rooms use it. */
const baked = new Map<number, Texture | undefined>();

/**
 * The swatch with its key light already in it, or `undefined` where the bake cannot run (no 2D
 * canvas, an unreadable source, a zero-sized texture) — in which case the caller keeps the
 * two-layer additive path.
 *
 * Memoised including the failures, so an environment without a canvas pays the probe once.
 */
export function bakeLitCap(cap: Texture): Texture | undefined {
  const key = cap.uid;
  if (baked.has(key)) return baked.get(key);
  const lit = bake(cap);
  baked.set(key, lit);
  return lit;
}

function bake(cap: Texture): Texture | undefined {
  const { frame } = cap;
  const w = Math.round(frame.width);
  const h = Math.round(frame.height);
  if (w <= 0 || h <= 0) return undefined;
  let canvas: ICanvas;
  try {
    // Through the adapter, never `document.createElement` — see the module header. On the WeChat
    // mini-game runtime this is `wx.createCanvas()`; in a browser it is the same `<canvas>` as
    // before; in a canvas-free environment it throws and the caller keeps the additive path.
    canvas = DOMAdapter.get().createCanvas(w, h);
  } catch {
    return undefined;
  }
  const ctx = canvas.getContext('2d', { willReadFrequently: true }) as ICanvasRenderingContext2D | null;
  const source = cap.source.resource as CanvasImageSource | null;
  if (!ctx || !source) return undefined;
  let lit: Texture;
  try {
    // Source-frame coordinates, not the whole resource: correct for a swatch that is one region of
    // a packed sheet as well as for the standalone PNGs shipped today.
    ctx.drawImage(source as CanvasImageSource, Math.round(frame.x), Math.round(frame.y), w, h, 0, 0, w, h);
    const image = ctx.getImageData(0, 0, w, h);
    applyLitCap(image.data);
    ctx.putImageData(image, 0, 0);
    // `new CanvasSource(...)`, not `Texture.from(canvas)`: `Texture.from` picks a source class by
    // sniffing the resource, and every canvas test in that list is an `instanceof` against a DOM
    // global (`HTMLCanvasElement` / `OffscreenCanvas`). A WeChat canvas is an instance of neither —
    // there is no such global on that runtime — so `from` fell through the whole list and threw
    // "Could not find a source type for resource", taking the room build down with it. Naming the
    // source class removes the sniff; `CanvasSource` itself only ever touches width/height/
    // getContext, which the wx canvas has.
    lit = new Texture({ source: new CanvasSource({ resource: canvas }) });
  } catch {
    // A tainted canvas (a cross-origin swatch) throws at `getImageData`, and a runtime whose canvas
    // the renderer cannot accept throws at the source. Fall back rather than ship a black cap.
    return undefined;
  }
  // The cap is a TilingSprite, so the baked copy needs the same wrap the swatch was loaded with
  // (`biomeTiles.preloadBiomeTiles`) — clamp-to-edge would repeat one border pixel instead.
  lit.source.addressMode = 'repeat';
  lit.label = `lit-cap:${cap.label ?? cap.uid}`;
  return lit;
}

/** Drop every cached bake. Tests only — a texture cache that survives between cases hides bugs. */
export function resetLitCapCache(): void {
  baked.clear();
}
