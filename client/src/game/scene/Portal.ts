import { Container, Graphics, Sprite } from 'pixi.js';
import { THEME } from '../theme';
import { getPortalArchTexture } from '../../render/environmentSprites';
import { Entity } from './Entity';

const TAU = Math.PI * 2;
const PARTICLE_COUNT = 10;
const GOLDEN_ANGLE = 2.399963; // radians — spreads N particles so no two ever fall in sync

/** Where the vortex sits inside the arch, and how big it can be there. Both are measured
 *  off the shipped sprite rather than chosen — `portalArt.test.ts` re-derives them from the
 *  file's own alpha channel every run and fails if they drift.
 *
 *  Neither number existed before 2026-08-20, because both were free: the "arch" was a
 *  single stroked ellipse whose stone had no thickness, so the vortex could fill the whole
 *  outer ellipse (`archW * 0.78`) centred on the object (`-archH / 2`). Real masonry is
 *  22% of the outer width per leg, which makes both of those wrong at once — and wrong in
 *  a way that compounds, since the arch's hole is bounded above by the crown's curve and
 *  below by nothing at all. Sweeping the shipped alpha for the largest ellipse the squash
 *  below can fit: centred on the object it is only 0.365 of `archW`, while dropping the
 *  centre to a QUARTER of the arch's height brings it to 0.560 — where the straight legs
 *  are the only thing bounding it. So the vortex sits low in the doorway, which is also
 *  where an arch's opening actually is. */
const VORTEX_CENTER_OF_ARCH_H = 0.25;
const VORTEX_MAX_R_OF_ARCH_W = 0.56;
/** Everything in the vortex scales by ONE factor, not just its radii. Its stroke widths and
 *  mote sizes were tuned against a vortex 0.78 of `archW` across; leaving them at full size
 *  while the radii came in to 0.56 made ringA 44% of its own radius thick, and it read live
 *  as a scatter of debris instead of a spinning ring. */
const VORTEX_SHRINK = VORTEX_MAX_R_OF_ARCH_W / 0.78;
/** Stroke width and the radius ratios between the vortex's parts, unchanged from the
 *  pre-sprite geometry — only what they are a fraction OF moved, so the vortex is the same
 *  shape it always was, sized and placed to the hole it now sits in. */
const RING_A_WIDTH = 6 * VORTEX_SHRINK;
const RING_B_WIDTH = 4 * VORTEX_SHRINK;
const RING_B_OF_A = 0.48 / 0.78;
const CORE_OF_A = 0.22 / 0.78;

/**
 * The extraction-checkpoint portal (design/10 legibility fix, 2026-08-02; VFX redesign
 * 2026-08-12, live screenshot report: "doesn't feel like a real portal"; masonry art
 * 2026-08-20). The STRUCTURE is a sprite and everything inside it stays program-drawn,
 * because everything inside it animates every frame — a split a single flattened raster
 * cannot make. `THEME.colors.extractGlow` (the extraction checkpoint's own tint) still
 * colours all of it, which is also why the arch art is authored as NEUTRAL stone with
 * colourless crystal: one `Sprite.tint` could not have tinted the shards without tinting
 * the masonry too, so the green in the frame comes from the code-drawn layers instead.
 *
 * The original version was a single static ring + one pulsing ellipse, which read as a
 * flat sticker rather than a gate. This version layers four cheap pieces, most of which
 * only ever rotate/rescale in `interpolate` — no per-frame Graphics redraws except the
 * particles, whose position genuinely changes every frame:
 *   1. groundGlow — wide ambient bloom on the floor (additive, slow pulse).
 *   2. arch — the standing masonry gate anchoring it to the ground (sprite, with the old
 *      dark-rim/bright-inner-edge ellipse pair kept as the no-art fallback).
 *   3. vortex — two counter-rotating rings of arc segments plus a bright core, squashed
 *      into the frame's ellipse: opposite spin directions read as a turbulent hole in
 *      space even though each ring is a perfectly static shape, just spun via `rotation`.
 *   4. particles — motes that spiral inward and vanish on a deterministic (non-random)
 *      schedule, i.e. matter continuously falling into the event horizon.
 */
export class Portal extends Entity {
  private t = 0; // pulse/rotation clock (render-only, ms)
  private readonly squash: number; // vertical squash shared by the vortex + particles
  private readonly vortexR: number; // outer reach of the vortex, i.e. the arch's own opening
  private readonly ringA: Graphics;
  private readonly ringB: Graphics;
  private readonly particles: Graphics;

  constructor(radiusPx = 26) {
    super();
    const color = THEME.colors.extractGlow;
    const archW = radiusPx * 1.15;
    const archH = radiusPx * 2.15;
    const archCenterY = -archH / 2; // mid-height of the gate — the no-art fallback's ellipse
    const vortexCenterY = -archH * VORTEX_CENTER_OF_ARCH_H; // low in the doorway, see above
    this.squash = archH / 2 / archW;
    this.vortexR = archW * VORTEX_MAX_R_OF_ARCH_W;

    // 1. Ground bloom.
    const groundGlow = new Graphics();
    groundGlow.ellipse(0, 0, radiusPx * 2.1, radiusPx * 1.05).fill({ color, alpha: 0.16 });
    groundGlow.blendMode = 'add';
    this.addChild(groundGlow);

    // 2. The standing arch. Real masonry art since 2026-08-20 — bottom-anchored on the
    // ground point and scaled by WIDTH, so the file's aspect decides how tall the gate
    // stands (the same rule the pillar sprite follows; the shipped file's 576x539 lands
    // within a pixel of `archH`, which `portalArt.test.ts` pins). Falls back to the two
    // stroked ellipses it drew before the art existed — a dark rim plus a bright inner
    // edge, which gave the gate a boundary distinct from the ambient glow around it.
    const archTex = getPortalArchTexture();
    if (archTex) {
      const arch = new Sprite(archTex);
      arch.anchor.set(0.5, 1);
      arch.width = archW * 2;
      arch.height = arch.width / (archTex.width / archTex.height);
      this.addChild(arch);
    } else {
      const frame = new Graphics();
      frame.ellipse(0, archCenterY, archW, archH / 2).stroke({ color: 0x000000, alpha: 0.55, width: 10 });
      frame.ellipse(0, archCenterY, archW, archH / 2).stroke({ color, width: 3, alpha: 0.95 });
      this.addChild(frame);
    }

    // 3. Vortex — two counter-rotating rings of arcs around a bright core, squashed
    // into the arch's ellipse so the spin reads as a disc tilted into the ground plane
    // rather than a flat spinning coin.
    const vortex = new Container();
    vortex.position.set(0, vortexCenterY);
    vortex.scale.set(1, this.squash);

    // ringA's stroke straddles its own radius, so the outermost ring sits half a stroke
    // inside the opening or its bright edge crosses onto the stone.
    const ringAR = this.vortexR - RING_A_WIDTH / 2;

    const ringA = new Graphics();
    const arcsA = 4;
    for (let i = 0; i < arcsA; i++) {
      const start = (i / arcsA) * TAU;
      ringA.arc(0, 0, ringAR, start, start + TAU * 0.18).stroke({ color, width: RING_A_WIDTH, alpha: 0.55 });
    }
    ringA.blendMode = 'add';
    vortex.addChild(ringA);

    const ringB = new Graphics();
    const arcsB = 5;
    for (let i = 0; i < arcsB; i++) {
      const start = (i / arcsB) * TAU;
      ringB.arc(0, 0, ringAR * RING_B_OF_A, start, start + TAU * 0.12).stroke({ color: 0xffffff, width: RING_B_WIDTH, alpha: 0.5 });
    }
    ringB.blendMode = 'add';
    vortex.addChild(ringB);

    // Bright core — the "singularity" the rings spin around.
    const core = new Graphics();
    const coreR = ringAR * CORE_OF_A;
    core.circle(0, 0, coreR).fill({ color: 0xffffff, alpha: 0.85 });
    core.circle(0, 0, coreR).fill({ color, alpha: 0.4 });
    core.blendMode = 'add';
    vortex.addChild(core);

    this.addChild(vortex);
    this.ringA = ringA;
    this.ringB = ringB;

    // 4. Particles falling into the event horizon — redrawn every frame since their
    // radius/angle both continuously change (spinning a static shape can't do this).
    const particles = new Graphics();
    particles.position.set(0, vortexCenterY);
    particles.blendMode = 'add';
    this.addChild(particles);
    this.particles = particles;

    this.makeShadow(radiusPx * 0.9);
    this.visible = false;
  }

  setOpen(open: boolean): void {
    this.visible = open;
  }

  override interpolate(alpha: number, frameDt: number): void {
    super.interpolate(alpha, frameDt);
    this.t += frameDt;

    this.alpha = 0.9 + 0.1 * Math.sin(this.t * 0.003);
    this.ringA.rotation = this.t * 0.0011;
    this.ringB.rotation = -this.t * 0.0021; // faster, opposite direction — reads as turbulence

    this.drawParticles();
  }

  /** Motes spiralling into the event horizon — a deterministic function of the pulse
   * clock (no Math.random: keeps the view reproducible frame-to-frame like everything
   * else in this render layer, and trivially testable). Each mote loops on its own
   * golden-angle-spaced phase so they never bunch up mid-fall. */
  private drawParticles(): void {
    const g = this.particles;
    g.clear();
    const cycleMs = 2600;
    for (let i = 0; i < PARTICLE_COUNT; i++) {
      const phase = ((this.t + i * (cycleMs / PARTICLE_COUNT)) % cycleMs) / cycleMs; // 0..1
      const frac = Math.pow(phase, 1.6); // accelerates inward near the end of its fall
      const angle = i * GOLDEN_ANGLE + phase * TAU * 1.4; // extra winding as it falls
      // Motes start at the arch's OPENING, not at its outer half-width — the same
      // correction the rings above needed once the arch became real masonry.
      const r = this.vortexR * (1 - frac);
      const x = Math.cos(angle) * r;
      const y = Math.sin(angle) * r * this.squash;
      const fade = Math.sin(phase * Math.PI); // fades in, peaks mid-fall, fades out at the core
      const size = (2.6 - 1.2 * frac) * VORTEX_SHRINK;
      g.circle(x, y, Math.max(size, 0.5)).fill({ color: 0xffffff, alpha: 0.85 * fade });
    }
  }
}
