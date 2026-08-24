// Room decoration (`RoomPiece.props`, content/rooms.ts) — sibling of pillarRender.ts/
// wallRender.ts: RoomBuilder owns the lifecycle (build/clear, layer placement, Y-sort),
// this module owns the drawing. A prop is render-only clutter, never read by the sim
// (rooms.ts's own doc comment) — no collision, no occlusion x-ray. The x-ray exists for
// objects tall enough that their art reaches north past their own footprint far enough to
// cover a character standing just beyond it (a wall/pillar/door, 70-104 px); nothing here
// comes close, so the Y-sort alone already gets the front/back order right. That bound is
// `PROP_HEIGHT_CEILING_PX` and `propRender.test.ts` sweeps every kind against it — both the
// Graphics metrics below AND the height each shipped sprite's own aspect derives — rather
// than leaving it as a claim in this comment that new art could silently outgrow.
//
// `PropPlacement.id` had no declared vocabulary (content/rooms.ts: "A decorative
// placement... render-only, never read by the sim") — `resolvePropKind` gives it one,
// following the same forward-compat rule `SpawnPoint.type` already uses: an unrecognized
// or missing id falls back to a default kind rather than drawing nothing.
import { Container, Graphics, Sprite, type Texture } from 'pixi.js';
import { mixHex, type BiomePalette } from '../theme';
import { EDGE_ALPHA, EDGE_COLOR, EDGE_WIDTH } from './wallTone';

export type PropKind = 'crate' | 'barrel' | 'rubble';

const KNOWN_PROP_KINDS: ReadonlySet<string> = new Set<PropKind>(['crate', 'barrel', 'rubble']);
const DEFAULT_PROP_KIND: PropKind = 'crate';

/** `PropPlacement.id` → a kind this module knows how to draw. Same fallback shape as
 *  `SpawnPoint.type`'s "missing/unknown → basic": content is free to author an id this
 *  module doesn't recognize yet (or omit it) without ever leaving a room silently missing
 *  a decoration. */
export function resolvePropKind(id: string | undefined): PropKind {
  return id !== undefined && KNOWN_PROP_KINDS.has(id) ? (id as PropKind) : DEFAULT_PROP_KIND;
}

/** How far a prop's shadow should reach, in world px — same number `Entity.makeShadow`
 *  wants for a pillar/pickup's ground radius. */
export function propShadowRadius(kind: PropKind): number {
  return PROP_METRICS[kind].shadowRadius;
}

// No real art yet for any of these — same staged rollout every other object in this room
// went through (walls, pillars, doors, weapons all shipped a Graphics fallback first and
// picked up real art in a later, dedicated pass). Desaturated wood/stone tones, mixed a
// little toward the room's own wall colour (`PROP_BIOME_MIX`, same amount pillarRender.ts
// mixes in) so a prop reads as part of THIS room rather than a fixed decal pasted over
// every biome alike — the opposite treatment from a pickup's fixed saturated hue, which is
// deliberate (design/13: "environment desaturated, hazards saturated" — a prop is
// environment, a drop is not).
const PROP_BIOME_MIX = 0.16;
const CRATE_BODY = 0x5c4a34;
const CRATE_TOP = 0x71583c;
const CRATE_SEAM = 0x362a1c;
const BARREL_BODY = 0x4a3a28;
const BARREL_HOOP = 0x2e2318;
const BARREL_TOP = 0x624c34;
const RUBBLE_BASE = 0x53565c;
const RUBBLE_DARK = 0x33353a;
const RUBBLE_LIGHT = 0x6e7178;

interface PropMetrics {
  halfW: number;
  height: number;
  shadowRadius: number;
}

/**
 * The tallest a prop's art may reach above its own ground point, world px. Not a tuning
 * knob — it is the reason this module skips the occlusion x-ray, so it is the number a test
 * can hold instead of a claim in a comment. The shortest object that DOES need the x-ray
 * stands 70 px, and a prop a third of that can cover a character's feet but never the head
 * and eye that identify it.
 *
 * 28 rather than the "under 18" this file used to claim. Real art landed the barrel at 22.3
 * (sprite) and 25.6 (Graphics fallback, whose lid ellipse and silhouette stroke both reach
 * past `height`), and the honest fix was to move the bound to where the art actually is and
 * pin it, not to squeeze art to fit a number nothing had ever enforced. Both paths are swept
 * against this in `propRender.test.ts`, so it is the drawn extent that is held, not `height`.
 */
export const PROP_HEIGHT_CEILING_PX = 28;

/** A kind's Graphics-fallback silhouette height (world px). Sibling of
 *  `propFootprintWidth`, exposed for the same reason: so a test can derive the number
 *  instead of restating it, and so the sprite/Graphics agreement can be checked at all. */
export function propBodyHeight(kind: PropKind): number {
  return PROP_METRICS[kind].height;
}

/**
 * `height` is the GRAPHICS fallback's silhouette height; a sprite derives its own from the
 * art's aspect (`buildPropBody`). The two are kept in agreement deliberately — the fallback
 * exists to stand in for the art, and a stand-in that is a different size is a worse bug
 * than no art at all. Each `height` below is `halfW * 2 / aspect` of the shipped file,
 * rounded: crate 144x128 -> 16, barrel 128x178 -> 22, rubble 176x48 -> 6.
 * `propRender.test.ts` re-derives all three from the real PNGs rather than trusting this.
 */
const PROP_METRICS: Record<PropKind, PropMetrics> = {
  crate: { halfW: 9, height: 16, shadowRadius: 9 },
  barrel: { halfW: 8, height: 22, shadowRadius: 8 },
  rubble: { halfW: 11, height: 6, shadowRadius: 11 },
};

/** The footprint width (world px) a kind's art is scaled to — the Graphics fallback's own
 *  `halfW * 2`, exposed so a real-art sprite can be fitted to the exact same box the
 *  Graphics silhouette already occupies, and so tests can assert the two agree. */
export function propFootprintWidth(kind: PropKind): number {
  return PROP_METRICS[kind].halfW * 2;
}

function biomeTone(base: number, palette: BiomePalette): number {
  return mixHex(base, palette.wall, PROP_BIOME_MIX);
}

/**
 * The same biome pull as `biomeTone`, in the only form a Sprite can take it. The Graphics
 * fallback mixes `PROP_BIOME_MIX` of `palette.wall` into each of its own tones; a sprite
 * cannot mix, only multiply, so the identical amount is mixed into WHITE and multiplied over
 * the art instead — the trick `pillarTint` already uses, and it lands in the same place
 * because `palette.wall` is a dark near-neutral in every biome.
 *
 * Without this the sprite branch simply ignored the `palette` it was handed, which is the
 * whole point of `PROP_BIOME_MIX` ("a prop reads as part of THIS room rather than a fixed
 * decal pasted over every biome alike") quietly not happening as soon as real art landed:
 * the Graphics fallback kept mixing and the shipped sprite did not.
 *
 * What this does NOT do is re-hue the art. At 16% of a dark near-neutral wall the multiply
 * lands around 0.87 on every channel, which moves a colour's R-to-B balance by about a
 * point — it is a value/biome pull, not a colour correction. `prop_crate.png` leans warm
 * (R+10.0/B-9.6, alone among the environment set, which is all stone and leans blue) and
 * comes out of this still leaning warm, deliberately: it is wood, its chroma of 20.0 sits
 * inside the shipped band (floor 15.3, wall face 18.1), and its median luma of 53 is what
 * separates it from the loot crate's 167 — value carries that distinction, not hue.
 */
export function propTint(palette: BiomePalette): number {
  return mixHex(0xffffff, palette.wall, PROP_BIOME_MIX);
}

function silhouette(g: Graphics, halfW: number, height: number, corner: number): void {
  g.roundRect(-halfW, -height, halfW * 2, height, corner)
    .stroke({ color: EDGE_COLOR, width: EDGE_WIDTH, alpha: EDGE_ALPHA });
}

/** A wooden crate: a filled body, a lighter lid band along the top (the plane most exposed
 *  to the same overhead key light every other standing object in the room agrees on), and
 *  two seam lines standing in for its planks. */
function buildCrate(palette: BiomePalette): Graphics {
  const { halfW, height } = PROP_METRICS.crate;
  const g = new Graphics();
  const corner = 1.5;
  g.roundRect(-halfW, -height, halfW * 2, height, corner).fill({ color: biomeTone(CRATE_BODY, palette) });
  const lidH = height * 0.24;
  g.roundRect(-halfW, -height, halfW * 2, lidH, corner).fill({ color: biomeTone(CRATE_TOP, palette) });
  const seam = biomeTone(CRATE_SEAM, palette);
  g.rect(-halfW * 0.34, -height + lidH, 1, height - lidH).fill({ color: seam });
  g.rect(halfW * 0.34 - 1, -height + lidH, 1, height - lidH).fill({ color: seam });
  silhouette(g, halfW, height, corner);
  return g;
}

/** A barrel: a narrow rounded body, two darker hoop bands, and a lighter top ellipse (the
 *  lid) — the same "lightest plane on top" rule the pillar's cap follows, kept here because
 *  it is the one cue that costs nothing and always reads as "this stands upright". */
function buildBarrel(palette: BiomePalette): Graphics {
  const { halfW, height } = PROP_METRICS.barrel;
  const g = new Graphics();
  const corner = halfW * 0.4;
  g.roundRect(-halfW, -height, halfW * 2, height, corner).fill({ color: biomeTone(BARREL_BODY, palette) });
  const hoop = biomeTone(BARREL_HOOP, palette);
  g.rect(-halfW, -height + height * 0.28, halfW * 2, 2).fill({ color: hoop });
  g.rect(-halfW, -height + height * 0.68, halfW * 2, 2).fill({ color: hoop });
  g.ellipse(0, -height, halfW * 0.9, halfW * 0.35).fill({ color: biomeTone(BARREL_TOP, palette) });
  silhouette(g, halfW, height, corner);
  return g;
}

/** A rubble pile: a handful of overlapping low stones, no single silhouette rect (unlike
 *  the crate/barrel, this is meant to read as loose debris, not a standing object) — fixed
 *  positions rather than random, same determinism rule every other draw call in this room
 *  follows. */
function buildRubble(palette: BiomePalette): Graphics {
  const { halfW, height } = PROP_METRICS.rubble;
  const g = new Graphics();
  const stones: ReadonlyArray<readonly [number, number, number, number]> = [
    [-halfW * 0.55, -height * 0.4, halfW * 0.5, RUBBLE_DARK],
    [halfW * 0.35, -height * 0.55, halfW * 0.45, RUBBLE_BASE],
    [0, -height * 0.25, halfW * 0.4, RUBBLE_BASE],
    [halfW * 0.6, -height * 0.2, halfW * 0.32, RUBBLE_DARK],
    [-halfW * 0.15, -height * 0.7, halfW * 0.3, RUBBLE_LIGHT],
  ];
  for (const [x, y, r, color] of stones) {
    g.ellipse(x, y, r, r * 0.6).fill({ color: biomeTone(color, palette) });
  }
  return g;
}

/** The visual for one prop, by resolved kind. Local coords with the origin at the prop's
 *  ground point — drawn upward (negative y), same convention `Entity`/pillar/pickup all
 *  share, so `RoomBuilder` can `place()` it exactly like any other static ground object.
 *
 * `tex` is real art (`render/environmentSprites.ts getPropTexture`), shipped 2026-08-24 for
 * all three kinds — the same optional-art-else-Graphics shape `Pickup.ts`/
 * `pillarRender.buildPillarSprite` already use, kept because the fallback is what any future
 * kind draws with before its art exists. Bottom-anchored and scaled by WIDTH (the footprint
 * every kind's `halfW` already fixes), letting the art's own aspect set height — same rule
 * the pillar sprite follows, for the same reason: aspect is the art's to choose.
 *
 * Bottom-anchoring is why the import runs `alphaClamp.mjs` before `compress.mjs`: the trim
 * keeps any pixel with `alpha !== 0`, and all three generations arrived wrapped in a veil of
 * alpha 1-10 reaching over a hundred px past the object, which would have left empty rows
 * under the anchor and floated every prop off the floor. */
export function buildPropBody(kind: PropKind, palette: BiomePalette, tex?: Texture): Container {
  const c = new Container();
  if (tex) {
    const w = propFootprintWidth(kind);
    const sprite = new Sprite(tex);
    sprite.anchor.set(0.5, 1);
    sprite.setSize(w, w * (tex.height / tex.width));
    sprite.tint = propTint(palette);
    c.addChild(sprite);
    return c;
  }
  const gfx = kind === 'barrel' ? buildBarrel(palette) : kind === 'rubble' ? buildRubble(palette) : buildCrate(palette);
  c.addChild(gfx);
  return c;
}
