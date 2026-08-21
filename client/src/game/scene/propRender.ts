// Room decoration (`RoomPiece.props`, content/rooms.ts) — sibling of pillarRender.ts/
// wallRender.ts: RoomBuilder owns the lifecycle (build/clear, layer placement, Y-sort),
// this module owns the drawing. A prop is render-only clutter, never read by the sim
// (rooms.ts's own doc comment) — no collision, no occlusion x-ray. The x-ray exists for
// objects tall enough that their art reaches north past their own footprint far enough to
// cover a character standing just beyond it (a wall/pillar/door, 70-104 px); every shape
// here tops out under 18 px, so the Y-sort alone already gets the front/back order right.
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

const PROP_METRICS: Record<PropKind, PropMetrics> = {
  crate: { halfW: 9, height: 15, shadowRadius: 9 },
  barrel: { halfW: 8, height: 17, shadowRadius: 8 },
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
 * `tex` is real art (`render/environmentSprites.ts getPropTexture`), undefined until a
 * future pass ships one — the same optional-art-else-Graphics shape `Pickup.ts`/
 * `pillarRender.buildPillarSprite` already use. Bottom-anchored and scaled by WIDTH (the
 * footprint every kind's `halfW` already fixes), letting the art's own aspect set height —
 * same rule the pillar sprite follows, for the same reason: aspect is the art's to choose. */
export function buildPropBody(kind: PropKind, palette: BiomePalette, tex?: Texture): Container {
  const c = new Container();
  if (tex) {
    const w = propFootprintWidth(kind);
    const sprite = new Sprite(tex);
    sprite.anchor.set(0.5, 1);
    sprite.setSize(w, w * (tex.height / tex.width));
    c.addChild(sprite);
    return c;
  }
  const gfx = kind === 'barrel' ? buildBarrel(palette) : kind === 'rubble' ? buildRubble(palette) : buildCrate(palette);
  c.addChild(gfx);
  return c;
}
