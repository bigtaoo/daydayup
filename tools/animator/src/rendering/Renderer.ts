import * as PIXI from 'pixi.js';
import type {
  WorldPositions,
  ResolvedBoneTransform,
  SpriteBinding,
  AttachmentPoint,
  BoneDef,
} from '../core/types';
import type { Rig } from '../skeleton/Rig';

// Unified procedural shadow — a single soft ellipse generated once, scaled to the
// shadow attachment point's shadowW/H. Mirrors the runtime so the editor preview
// matches the game; shadows are no longer authored as images.
let _shadowTex: PIXI.Texture | null = null;
function shadowTexture(): PIXI.Texture {
  if (_shadowTex) return _shadowTex;
  const SIZE = 128;
  const canvas  = document.createElement('canvas');
  canvas.width  = SIZE;
  canvas.height = SIZE;
  const ctx = canvas.getContext('2d')!;
  const r   = SIZE / 2;
  const grad = ctx.createRadialGradient(r, r, 0, r, r, r);
  grad.addColorStop(0,    'rgba(0,0,0,1)');
  grad.addColorStop(0.55, 'rgba(0,0,0,0.85)');
  grad.addColorStop(1,    'rgba(0,0,0,0)');
  ctx.fillStyle = grad;
  ctx.beginPath();
  ctx.arc(r, r, r, 0, Math.PI * 2);
  ctx.fill();
  _shadowTex = PIXI.Texture.from(canvas);
  return _shadowTex;
}

// ── RenderData ────────────────────────────────────────────────────────────────

export interface RenderData {
  worldPose:    WorldPositions;
  boneTransforms: Map<string, ResolvedBoneTransform>;
  /** The rig's own bone defs — the sprite layer needs each bone's REST angle to draw
   *  its art in the orientation it was authored in (see updateSprites). */
  bones:        ReadonlyMap<string, BoneDef>;

  // Sprite resources — texture looked up by boneId directly (1 image per bone)
  bindings:   ReadonlyMap<string, SpriteBinding>;
  getTexture: (boneId: string) => PIXI.Texture | undefined;

  // Attachment points
  attachmentPoints: ReadonlyMap<string, AttachmentPoint>;

  // Render options
  previewMode:         'skeleton' | 'sprite';
  selectedBone:        string | null;
  showJoints:          boolean;
  showSkeletonOverlay: boolean;
  showGuide:           boolean;
  showPivots:          boolean;
  backgroundColor:     number;
  rootX:               number;
  rootY:               number;
  onionData:           Array<{
    worldPose: WorldPositions;
    boneTransforms: Map<string, ResolvedBoneTransform>;
  }>;
}

// ── Renderer ──────────────────────────────────────────────────────────────────

export class Renderer {
  readonly pixiApp: PIXI.Application;

  private readonly gridGfx:     PIXI.Graphics;
  private readonly onionGfx:    PIXI.Graphics;
  private readonly boneGfx:     PIXI.Graphics;
  private readonly spriteLayer: PIXI.Container;
  private readonly overlayGfx:  PIXI.Graphics;  // skeleton overlay above sprites
  private readonly selGfx:      PIXI.Graphics;

  /** boneId → Sprite (one per bone, reused across frames) */
  private readonly spriteCache = new Map<string, PIXI.Sprite>();

  /** When true, spriteLayer children are re-sorted by zOrder on the next draw. */
  private _spriteOrderDirty = false;

  constructor(
    container: HTMLElement,
    private readonly rig: Rig,
  ) {
    const w = container.clientWidth;
    const h = container.clientHeight;

    this.pixiApp = new PIXI.Application({
      width: w,
      height: h,
      backgroundColor: 0xF5F0E8,
      antialias: true,
      resolution: window.devicePixelRatio || 1,
      autoDensity: true,
    });

    const canvas = this.pixiApp.view as HTMLCanvasElement;
    canvas.style.width  = '100%';
    canvas.style.height = '100%';
    container.appendChild(canvas);

    this.gridGfx     = new PIXI.Graphics();
    this.onionGfx    = new PIXI.Graphics();
    this.boneGfx     = new PIXI.Graphics();
    this.spriteLayer = new PIXI.Container();
    this.overlayGfx  = new PIXI.Graphics();
    this.selGfx      = new PIXI.Graphics();
    this.onionGfx.alpha = 0.2;

    // Layer order (bottom → top):
    // grid → onion → bones → sprites → skeleton overlay → selection/pivots/attachments
    this.pixiApp.stage.addChild(
      this.gridGfx, this.onionGfx, this.boneGfx, this.spriteLayer, this.overlayGfx, this.selGfx,
    );

    this.drawGrid(w, h);
  }

  // ── Coordinate conversion ─────────────────────────────────────────────────

  toStageCoords(clientX: number, clientY: number): { x: number; y: number } {
    const canvas = this.pixiApp.view as HTMLCanvasElement;
    const rect   = canvas.getBoundingClientRect();
    const { w, h } = this.logicalSize;
    return {
      x: ((clientX - rect.left) / rect.width)  * w,
      y: ((clientY - rect.top)  / rect.height) * h,
    };
  }

  get logicalSize(): { w: number; h: number } {
    const res = this.pixiApp.renderer.resolution || 1;
    return {
      w: this.pixiApp.renderer.width  / res,
      h: this.pixiApp.renderer.height / res,
    };
  }

  resize(w: number, h: number): void {
    this.pixiApp.renderer.resize(w, h);
    this.drawGrid(w, h);
  }

  destroy(): void {
    this.pixiApp.destroy(true, { children: true });
  }

  // ── Sprite order ──────────────────────────────────────────────────────────

  /** Call whenever bindings or zOrder values change. Sorting is deferred to
   *  the next draw call so it happens at most once per binding-change event. */
  markSpriteOrderDirty(): void {
    this._spriteOrderDirty = true;
  }

  // ── Main draw ─────────────────────────────────────────────────────────────

  draw(data: RenderData): void {
    (this.pixiApp.renderer as PIXI.Renderer).backgroundColor = data.backgroundColor;

    this.onionGfx.clear();
    if (data.onionData.length) {
      for (const od of data.onionData) {
        this.drawSkeleton(this.onionGfx, od.worldPose, null, false, false);
      }
    }

    this.updateSprites(data);

    this.boneGfx.clear();
    this.overlayGfx.clear();
    if (data.previewMode === 'skeleton') {
      this.drawSkeleton(this.boneGfx, data.worldPose, data.selectedBone, data.showJoints, true);
    } else if (data.showSkeletonOverlay) {
      // In sprite mode, draw skeleton into overlayGfx so it renders above sprites
      this.drawSkeleton(this.overlayGfx, data.worldPose, data.selectedBone, data.showJoints, true);
    }

    this.selGfx.clear();
    this.drawSelection(data);
    if (data.showGuide)  this.drawGuide(data.rootX, data.rootY);
    if (data.showPivots) this.drawPivots(data.worldPose, data.selectedBone);
    if (data.previewMode === 'sprite') this.drawAnchorPoints(data);
    this.drawAttachmentPoints(data.worldPose, data.attachmentPoints);
  }

  // ── Sprite layer ──────────────────────────────────────────────────────────

  private updateSprites(data: RenderData): void {
    const visible = new Set<string>();

    if (data.previewMode === 'sprite') {
      data.bindings.forEach((binding, boneId) => {
        const pose      = data.worldPose.get(boneId);
        const transform = data.boneTransforms.get(boneId);
        if (!pose) return;

        // alpha:0 hides the bone — skip rendering
        if ((transform?.alpha ?? 1) <= 0) return;

        const texture = data.getTexture(boneId);
        if (!texture) return;

        visible.add(boneId);

        let sprite = this.spriteCache.get(boneId);
        if (!sprite) {
          sprite      = new PIXI.Sprite(texture);
          sprite.name = boneId;  // tag for zOrder sorting
          this.spriteCache.set(boneId, sprite);
          this.spriteLayer.addChild(sprite);
          this._spriteOrderDirty = true;  // new sprite added, re-sort
        }

        sprite.texture  = texture;
        sprite.anchor.set(binding.anchorX, binding.anchorY);
        // A bone's art is centred on its TIP (where the rig draws that bone's bodyR
        // circle) and rotated by its angle RELATIVE to its rest angle, so art authored
        // the way it reads on screen stays upright and only animation turns it. Kept
        // byte-for-byte in step with the game's own renderer (client/src/render/
        // RigSkin.ts's "Placement model" — that's where the full rationale lives);
        // the editor previewing a different layout than the game ships is exactly how
        // a disassembled character got authored and shipped once already.
        sprite.x        = pose.ex + (transform?.translateX ?? 0);
        sprite.y        = pose.ey + (transform?.translateY ?? 0);
        const restAngle = data.bones.get(boneId)?.rwa ?? 0;
        sprite.rotation = ((pose.wa - restAngle + (binding.rotation ?? 0)) * Math.PI) / 180;
        sprite.scale.set(
          (binding.flipX ? -1 : 1) * (transform?.scaleX ?? 1) * (binding.scaleX ?? 1),
          (transform?.scaleY ?? 1) * (binding.scaleY ?? 1),
        );
        sprite.alpha   = transform?.alpha ?? 1;
        sprite.visible = true;
      });
    }

    // Render the unified procedural shadow (below all bone sprites)
    if (data.previewMode === 'sprite') {
      const shadowPt  = data.attachmentPoints.get('shadow');
      const shadowTex = shadowTexture();
      if (shadowPt) {
        const parent = data.worldPose.get(shadowPt.parentBone) ?? data.worldPose.get('root');
        if (parent) {
          visible.add('shadow');
          let sprite = this.spriteCache.get('shadow');
          if (!sprite) {
            sprite      = new PIXI.Sprite(shadowTex);
            sprite.name = 'shadow';
            this.spriteCache.set('shadow', sprite);
            this.spriteLayer.addChild(sprite);
            this._spriteOrderDirty = true;
          }
          const def = this.rig.defaultShadow;
          const sw  = shadowPt.shadowW ?? def.w;
          const sh  = shadowPt.shadowH ?? def.h;
          sprite.texture = shadowTex;
          sprite.anchor.set(0.5, 0.5);
          sprite.x       = parent.ex + shadowPt.offsetX;
          sprite.y       = parent.ey + shadowPt.offsetY;
          sprite.rotation = 0;
          sprite.scale.set(
            (sw * 2) / shadowTex.width,
            (sh * 2) / shadowTex.height,
          );
          sprite.alpha   = 0.55;
          sprite.visible = true;
        }
      }
    }

    // Hide sprites not in visible set
    this.spriteCache.forEach((sprite, boneId) => {
      sprite.visible = visible.has(boneId);
    });

    // Sort spriteLayer children by zOrder (once per binding change, not every frame)
    // shadow always goes to the bottom (zOrder = -Infinity)
    if (this._spriteOrderDirty) {
      this.spriteLayer.children.sort((a, b) => {
        const za = a.name === 'shadow' ? -Infinity : (data.bindings.get(a.name!)?.zOrder ?? 0);
        const zb = b.name === 'shadow' ? -Infinity : (data.bindings.get(b.name!)?.zOrder ?? 0);
        return za - zb;
      });
      this._spriteOrderDirty = false;
    }
  }

  // ── Skeleton drawing ──────────────────────────────────────────────────────

  private drawSkeleton(
    g: PIXI.Graphics,
    wp: WorldPositions,
    selectedBone: string | null,
    showJoints: boolean,
    showSelection: boolean,
  ): void {
    for (const boneId of this.rig.drawOrder) {
      const bone = this.rig.boneMap.get(boneId);
      const pos  = wp.get(boneId);
      if (!bone || !pos) continue;

      if (bone.outerW && bone.innerW) {
        this.drawTubularBone(g, pos.sx, pos.sy, pos.ex, pos.ey, bone.outerW, bone.innerW, 1);
      }
      if (bone.bodyR) {
        this.drawCircleBone(g, pos.ex, pos.ey, bone.bodyR, 1);
      }
    }

    if (showJoints) {
      const drawn = new Set<string>();
      for (const bone of this.rig.boneDefs) {
        if (bone.id === 'root' || bone.bodyR) continue;
        const pos = wp.get(bone.id);
        if (!pos) continue;
        const sk = `${pos.sx.toFixed(0)},${pos.sy.toFixed(0)}`;
        if (!drawn.has(sk)) { this.drawJoint(g, pos.sx, pos.sy, 6); drawn.add(sk); }
        const isLeaf = !this.rig.boneDefs.some(b => b.parent === bone.id);
        if (isLeaf) {
          const ek = `${pos.ex.toFixed(0)},${pos.ey.toFixed(0)}`;
          if (!drawn.has(ek)) { this.drawJoint(g, pos.ex, pos.ey, 5); drawn.add(ek); }
        }
      }
    }

    if (showSelection && selectedBone) {
      const pos  = wp.get(selectedBone);
      const bone = this.rig.boneMap.get(selectedBone);
      if (pos && bone) {
        if (bone.bodyR) {
          g.lineStyle({ width: 3, color: 0x74c7ec, alpha: 0.9 });
          g.beginFill(0, 0); g.drawCircle(pos.ex, pos.ey, bone.bodyR + 5); g.endFill();
        } else {
          g.lineStyle({ width: (bone.outerW ?? 4) + 6, color: 0x74c7ec, alpha: 0.4, cap: PIXI.LINE_CAP.ROUND });
          g.moveTo(pos.sx, pos.sy); g.lineTo(pos.ex, pos.ey);
        }
      }
    }
  }

  private drawSelection(data: RenderData): void {
    const { selectedBone, worldPose } = data;
    if (!selectedBone) return;
    const pos  = worldPose.get(selectedBone);
    const bone = this.rig.boneMap.get(selectedBone);
    if (!pos || !bone || bone.bodyR) return;

    this.selGfx.lineStyle({ width: 1.5, color: 0x74c7ec, alpha: 0.7 });
    this.selGfx.beginFill(0x74c7ec, 0.2);
    this.selGfx.drawCircle(pos.sx, pos.sy, 8);
    this.selGfx.endFill();
  }

  private drawGuide(rootX: number, rootY: number): void {
    this.selGfx.lineStyle({ width: 1, color: 0x89b4fa, alpha: 0.3 });
    this.selGfx.moveTo(rootX, rootY - 200);
    this.selGfx.lineTo(rootX, rootY + 50);
  }

  private drawPivots(wp: WorldPositions, selectedBone: string | null): void {
    wp.forEach((pos, boneId) => {
      if (boneId === 'root') return;
      const isSelected = boneId === selectedBone;
      const color = isSelected ? 0xf9e2af : 0x89b4fa;
      this.selGfx.lineStyle({ width: 1, color, alpha: 0.6 });
      this.selGfx.beginFill(color, 0.4);
      this.selGfx.drawCircle(pos.sx, pos.sy, 3);
      this.selGfx.endFill();
    });
  }

  // ── Drawing primitives ────────────────────────────────────────────────────

  private drawTubularBone(
    g: PIXI.Graphics,
    sx: number, sy: number, ex: number, ey: number,
    outerW: number, innerW: number, alpha: number,
  ): void {
    g.lineStyle({ width: outerW, color: 0x222222, alpha, cap: PIXI.LINE_CAP.ROUND, join: PIXI.LINE_JOIN.ROUND });
    g.moveTo(sx, sy); g.lineTo(ex, ey);
    g.lineStyle({ width: innerW, color: 0xFFFFFF, alpha, cap: PIXI.LINE_CAP.ROUND, join: PIXI.LINE_JOIN.ROUND });
    g.moveTo(sx, sy); g.lineTo(ex, ey);
  }

  /** A round module (shell, eye, belly, a weapon socket) — an outlined filled
   *  circle with a small off-center dot, a placeholder "face" cue generic
   *  enough to read for any circular bone, not just a humanoid head. */
  private drawCircleBone(g: PIXI.Graphics, cx: number, cy: number, r: number, alpha: number): void {
    g.lineStyle({ width: 4, color: 0x222222, alpha });
    g.beginFill(0xFFFFFF, alpha);
    g.drawCircle(cx, cy, r);
    g.endFill();
    g.lineStyle(0);
    g.beginFill(0x222222, alpha);
    g.drawCircle(cx + r * 0.38, cy - r * 0.1, Math.max(2, r * 0.12));
    g.endFill();
  }

  private drawAnchorPoints(data: RenderData): void {
    data.bindings.forEach((_binding, boneId) => {
      if (!data.getTexture(boneId)) return;
      const pose      = data.worldPose.get(boneId);
      const transform = data.boneTransforms.get(boneId);
      if (!pose) return;

      // Same tip-centred placement as updateSprites above, so the overlay marks where
      // the sprite actually is.
      const ax = pose.ex + (transform?.translateX ?? 0);
      const ay = pose.ey + (transform?.translateY ?? 0);
      const isSelected = boneId === data.selectedBone;

      // Line from bone tip to anchor (visible when a clip translates the bone)
      if (Math.hypot(ax - pose.ex, ay - pose.ey) > 1) {
        this.selGfx.lineStyle({ width: 1, color: 0xff4444, alpha: 0.4 });
        this.selGfx.moveTo(pose.ex, pose.ey);
        this.selGfx.lineTo(ax, ay);
      }

      // Anchor dot
      const r = isSelected ? 6 : 4;
      this.selGfx.lineStyle({ width: 1.5, color: 0xffffff, alpha: 0.9 });
      this.selGfx.beginFill(0xff3333, 0.95);
      this.selGfx.drawCircle(ax, ay, r);
      this.selGfx.endFill();

      // Crosshair for selected bone
      if (isSelected) {
        const S = 11;
        this.selGfx.lineStyle({ width: 1.5, color: 0xff3333, alpha: 0.85 });
        this.selGfx.moveTo(ax - S, ay); this.selGfx.lineTo(ax + S, ay);
        this.selGfx.moveTo(ax, ay - S); this.selGfx.lineTo(ax, ay + S);
      }
    });
  }

  private drawJoint(g: PIXI.Graphics, x: number, y: number, r: number): void {
    g.lineStyle({ width: 2.5, color: 0x222222, alpha: 1 });
    g.beginFill(0xFFFFFF);
    g.drawCircle(x, y, r);
    g.endFill();
  }

  // ── Attachment points ─────────────────────────────────────────────────────

  private drawAttachmentPoints(
    worldPose: RenderData['worldPose'],
    pts: ReadonlyMap<string, AttachmentPoint>,
  ): void {
    pts.forEach(pt => {
      const parent = worldPose.get(pt.parentBone) ?? worldPose.get('root');
      if (!parent) return;
      const x = parent.ex + pt.offsetX;
      const y = parent.ey + pt.offsetY;

      if (pt.id === 'shadow') {
        const def = this.rig.defaultShadow;
        const sw = pt.shadowW ?? def.w;
        const sh = pt.shadowH ?? def.h;
        this.selGfx.lineStyle({ width: 1.5, color: 0x5555aa, alpha: 0.8 });
        this.selGfx.beginFill(0x3333aa, 0.25);
        this.selGfx.drawEllipse(x, y, sw, sh);
        this.selGfx.endFill();
        this.selGfx.lineStyle(0);
        this.selGfx.beginFill(0x7777ff, 0.9);
        this.selGfx.drawCircle(x, y, 2.5);
        this.selGfx.endFill();
      } else {
        const S = 7;
        this.selGfx.lineStyle({ width: 1.5, color: 0xff6666, alpha: 0.9 });
        this.selGfx.moveTo(x - S, y); this.selGfx.lineTo(x + S, y);
        this.selGfx.moveTo(x, y - S); this.selGfx.lineTo(x, y + S);
        this.selGfx.lineStyle({ width: 1.5, color: 0xff6666, alpha: 0.5 });
        this.selGfx.drawCircle(x, y, 5);
      }
    });
  }

  // ── Grid ──────────────────────────────────────────────────────────────────

  private drawGrid(w: number, h: number): void {
    const CELL = 48;
    this.gridGfx.clear();
    this.gridGfx.lineStyle({ width: 1, color: 0xC8D8E8, alpha: 0.5 });
    for (let x = 0; x < w; x += CELL) { this.gridGfx.moveTo(x, 0); this.gridGfx.lineTo(x, h); }
    for (let y = 0; y < h; y += CELL) { this.gridGfx.moveTo(0, y); this.gridGfx.lineTo(w, y); }
  }
}
