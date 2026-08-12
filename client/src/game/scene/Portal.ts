import { Container, Graphics } from 'pixi.js';
import { THEME } from '../theme';
import { Entity } from './Entity';

const TAU = Math.PI * 2;
const PARTICLE_COUNT = 10;
const GOLDEN_ANGLE = 2.399963; // radians — spreads N particles so no two ever fall in sync

/**
 * The extraction-checkpoint portal (design/10 legibility fix, 2026-08-02; VFX redesign
 * 2026-08-12, live screenshot report: "doesn't feel like a real portal"). No art asset
 * exists for this yet, so — same convention as Pickup.ts's shape-only kinds and
 * RoomBuilder's pillar shading — it's built entirely from Pixi `Graphics`, reusing
 * `THEME.colors.extractGlow` (already the extraction checkpoint's own tint) plus
 * black/white alpha overlays for depth, the same trick the pillar body uses instead of
 * a second colour.
 *
 * The original version was a single static ring + one pulsing ellipse, which read as a
 * flat sticker rather than a gate. This version layers four cheap pieces, most of which
 * only ever rotate/rescale in `interpolate` — no per-frame Graphics redraws except the
 * particles, whose position genuinely changes every frame:
 *   1. groundGlow — wide ambient bloom on the floor (additive, slow pulse).
 *   2. frame — a standing dark-rimmed arch anchoring the gate to the ground, the same
 *      "highlight/shadow band" trick RoomBuilder uses for pillar shading.
 *   3. vortex — two counter-rotating rings of arc segments plus a bright core, squashed
 *      into the frame's ellipse: opposite spin directions read as a turbulent hole in
 *      space even though each ring is a perfectly static shape, just spun via `rotation`.
 *   4. particles — motes that spiral inward and vanish on a deterministic (non-random)
 *      schedule, i.e. matter continuously falling into the event horizon.
 */
export class Portal extends Entity {
  private t = 0; // pulse/rotation clock (render-only, ms)
  private readonly radiusPx: number;
  private readonly squash: number; // vertical squash shared by the vortex + particles
  private readonly ringA: Graphics;
  private readonly ringB: Graphics;
  private readonly particles: Graphics;

  constructor(radiusPx = 26) {
    super();
    this.radiusPx = radiusPx;
    const color = THEME.colors.extractGlow;
    const archW = radiusPx * 1.15;
    const archH = radiusPx * 2.15;
    const centerY = -archH / 2; // "standing" offset, floats the gate above its shadow
    this.squash = archH / 2 / archW;

    // 1. Ground bloom.
    const groundGlow = new Graphics();
    groundGlow.ellipse(0, 0, radiusPx * 2.1, radiusPx * 1.05).fill({ color, alpha: 0.16 });
    groundGlow.blendMode = 'add';
    this.addChild(groundGlow);

    // 2. Standing arch frame — dark rim + bright inner edge (pillar-style shading)
    // gives the gate a defined boundary distinct from the ambient glow around it.
    const frame = new Graphics();
    frame.ellipse(0, centerY, archW, archH / 2).stroke({ color: 0x000000, alpha: 0.55, width: 10 });
    frame.ellipse(0, centerY, archW, archH / 2).stroke({ color, width: 3, alpha: 0.95 });
    this.addChild(frame);

    // 3. Vortex — two counter-rotating rings of arcs around a bright core, squashed
    // into the arch's ellipse so the spin reads as a disc tilted into the ground plane
    // rather than a flat spinning coin.
    const vortex = new Container();
    vortex.position.set(0, centerY);
    vortex.scale.set(1, this.squash);

    const ringA = new Graphics();
    const arcsA = 4;
    for (let i = 0; i < arcsA; i++) {
      const start = (i / arcsA) * TAU;
      ringA.arc(0, 0, archW * 0.78, start, start + TAU * 0.18).stroke({ color, width: 6, alpha: 0.55 });
    }
    ringA.blendMode = 'add';
    vortex.addChild(ringA);

    const ringB = new Graphics();
    const arcsB = 5;
    for (let i = 0; i < arcsB; i++) {
      const start = (i / arcsB) * TAU;
      ringB.arc(0, 0, archW * 0.48, start, start + TAU * 0.12).stroke({ color: 0xffffff, width: 4, alpha: 0.5 });
    }
    ringB.blendMode = 'add';
    vortex.addChild(ringB);

    // Bright core — the "singularity" the rings spin around.
    const core = new Graphics();
    core.circle(0, 0, archW * 0.22).fill({ color: 0xffffff, alpha: 0.85 });
    core.circle(0, 0, archW * 0.22).fill({ color, alpha: 0.4 });
    core.blendMode = 'add';
    vortex.addChild(core);

    this.addChild(vortex);
    this.ringA = ringA;
    this.ringB = ringB;

    // 4. Particles falling into the event horizon — redrawn every frame since their
    // radius/angle both continuously change (spinning a static shape can't do this).
    const particles = new Graphics();
    particles.position.set(0, centerY);
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
    const archW = this.radiusPx * 1.15;
    for (let i = 0; i < PARTICLE_COUNT; i++) {
      const phase = ((this.t + i * (cycleMs / PARTICLE_COUNT)) % cycleMs) / cycleMs; // 0..1
      const frac = Math.pow(phase, 1.6); // accelerates inward near the end of its fall
      const angle = i * GOLDEN_ANGLE + phase * TAU * 1.4; // extra winding as it falls
      const r = archW * (1 - frac);
      const x = Math.cos(angle) * r;
      const y = Math.sin(angle) * r * this.squash;
      const fade = Math.sin(phase * Math.PI); // fades in, peaks mid-fall, fades out at the core
      const size = 2.6 - 1.2 * frac;
      g.circle(x, y, Math.max(size, 0.5)).fill({ color: 0xffffff, alpha: 0.85 * fade });
    }
  }
}
