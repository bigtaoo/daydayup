import { Container, Graphics, Sprite, type Texture } from 'pixi.js';
import type { Rig } from './Rig';
import type { RigSkinBundle } from './taoBundle';
import type { AnimationClip, ResolvedBoneTransform, WorldPose, WorldPositions } from './types';
import { sampleClip } from './interpolate';
import { facingFromAngle } from './facing';
import { getWeaponAnchor, getWeaponRotationOffset, getWeaponScale, getWeaponTexture, type WeaponVisualKind } from './weaponSkins';

// The socket that visibly carries the mounted weapon sprite (design/03 "swapping the
// active slot swaps which socket fires" — the demo's `attack` clip already privileges
// this socket for its recoil kick, so mounting here keeps the two in sync). Both
// sockets still track aim rotation below; only this one shows a weapon module.
const ACTIVE_WEAPON_SOCKET = 'socket_r';
// The other arm carries a module too (design/13's "TWO weapon modules that orbit it", and
// the concept turnaround draws both) — same art, purely decorative: `03`'s model is one
// ACTIVE weapon at a time, so this one never fires, takes no recoil, and is not what
// `updateWeaponSprite` aims. It points OUTWARD along its own tether instead of at the
// reticle, which is both how the concept draws the relaxed pose and what keeps its barrel
// from crossing the core whenever the hero shoots toward that side.
const IDLE_WEAPON_SOCKET = 'socket_l';
// Only the ACTIVE socket's ring tracks aim; the idle one turns with its own module so ring
// and module read as one assembly.
const SOCKET_IDS = new Set([ACTIVE_WEAPON_SOCKET]);

// The glowing energy tether every orbiting bone hangs off (design/13's "two weapon
// modules that orbit it on glowing energy tethers", design/12's "each of the two
// sockets orbits the core on a tether"). Drawn — not authored as art — because the
// tether's length and angle are pure rig geometry: it spans a bone's pivot (the core's
// centre) to its tip (where that bone's module sprite sits), so it has to follow FK
// every frame. A bone opts in by declaring the `outerW`/`innerW` stroke widths the
// editor's own skeleton view already uses for a tubular bone (orb-core's socket_l/
// socket_r, boss-core's ring_a/ring_b); every other bone (shell/eye/belly, an enemy's
// single body bone) leaves them undefined and draws no tether.
const TETHER_COLOR = 0x8fe9ff;
/** Perpendicular sag of the tether's arc, as a fraction of its length — the concept
 *  turnaround draws it as a slack curve bowing away from the core, not a straight rod. */
const TETHER_SAG = 0.22;

// The game-side .tao runtime renderer (design/12): bone FK + sprite binding +
// animation playback, ported from tools/animator/src/rendering/Renderer.ts's
// `updateSprites` (rewritten for Pixi v8's API — the editor is still on v7).
//
// Placement model (fixed 2026-08-17 — the port originally drew every sprite at its
// bone's PIVOT, unrotated-by-nothing, which visibly disassembled the character):
//   - A bone's art is centred on its TIP (`pose.ex/ey`), not its pivot — the tip is
//     where the rig itself puts that bone's `bodyR` body circle (the editor's own
//     skeleton view draws it there), so it's the point the art was sized against. It
//     matters because every rig here hangs its body off a pivot at the actor's feet
//     via one upward body bone (`shell`/`body`/`core`, `len` = hover height): drawing
//     at the pivot put the body a full body-length BELOW its own children, so
//     orb-core's eye/belly/both weapon sockets piled up in one spot above the shell's
//     head instead of sitting on the shell.
//   - Rotation is the bone's angle RELATIVE TO ITS REST ANGLE (`pose.wa - rwa`), so
//     art authored the way it reads on screen (shell upright, belly upright) stays
//     upright, and only animation/aim actually turns it. Drawing at the raw world
//     angle instead rotated every one of these rigs by its body bone's rest angle
//     (-90°, since it points up) — the hero's crystal spikes pointed left, and every
//     critter/boss body was 90° off too.
//
// Facing model (design/12 "Facing model (twin-stick 360° aim)"), extended with an
// upper/lower body split: a 2D bone rig gives L/R flip + part rotation, not a true
// 3D turn.
//   - L/R mirror + front/back hemisphere are driven by the BODY facing (movement
//     direction for a player, same as its aim for anything stationary like an
//     enemy) via `setBodyFacing` — the whole rig flips by that direction's
//     horizontal sign (`view.scale.x`), and aiming toward the top of the screen
//     (dy < 0, away from the camera) swaps in each slot's 'back' variant where one
//     exists (today: only `eye` has one — the concept turnaround's eye/vent swap).
//   - Aim-tracking socket rotation: the ACTIVE socket's WORLD rotation is overridden
//     every frame to the live AIM angle (`setAim`, design/03/12/13 "following that
//     socket's aim rotation every frame") instead of playing only its authored
//     clip — independently of the body flip above, so the gun can point at the
//     shot direction while the legs face movement. The rig is authored assuming it
//     faces right (rest pose `wa`/binding.rotation are canonical, unflipped); when
//     `view.scale.x` mirrors the whole rig, a socket's LOCAL rotation must be the
//     mirror image of the true aim angle so the flip renders it pointing at the
//     real reticle — see `canonicalSocketAngleRad` below.
export class RigSkin {
  readonly view = new Container();
  private readonly sprites = new Map<string, Sprite>();
  private readonly tethers: Graphics | null;
  private tetherGeometry = ''; // last-drawn endpoint signature (skip the rebuild if unchanged)
  private tetherTint = 0xffffff;
  private clip: AnimationClip | null = null;
  private clipT = 0;
  private showBack = false;
  private flipX: 1 | -1 = 1;
  private aimRad = 0;
  private weaponKind: WeaponVisualKind | null = null;
  private weaponName: string | undefined = undefined;
  private weaponSprite: Sprite | null = null; // the ACTIVE socket's module (aim-tracking)
  private idleModuleSprite: Sprite | null = null; // the other arm's decorative module
  private weaponTint = 0xffffff;

  constructor(
    private readonly rig: Rig,
    private readonly bundle: RigSkinBundle,
  ) {
    // Tethers paint behind every bone sprite: they run from the core's centre out to a
    // module, so the half nearest the core belongs UNDER the body, not across it.
    this.tethers = rig.boneDefs.some(b => b.outerW && b.innerW) ? new Graphics() : null;
    if (this.tethers) {
      this.tethers.zIndex = -1;
      this.view.addChild(this.tethers);
    }

    for (const boneId of rig.drawOrder) {
      const binding = bundle.bindings.get(boneId);
      const texture = bundle.textures.get(boneId);
      if (!binding || !texture) continue;

      const sprite = new Sprite(texture);
      sprite.anchor.set(binding.anchorX, binding.anchorY);
      sprite.zIndex = binding.zOrder;
      this.sprites.set(boneId, sprite);
      this.view.addChild(sprite);
    }
    this.view.sortableChildren = true;
  }

  /** Select which clip plays and at what local time (ms — converted to the seconds
   *  clip.duration/keyframe.time are authored in, tools/animator's AnimationController). */
  playClip(name: string, tMs: number): void {
    this.clip = this.bundle.clips.get(name) ?? null;
    const tSec = tMs / 1000;
    this.clipT = this.clip?.loop && this.clip.duration > 0 ? tSec % this.clip.duration : tSec;
  }

  /** Body/legs facing (radians, standard math convention, y-down screen space) —
   *  drives the whole-rig L/R flip + front/back hemisphere. Independent of `setAim`
   *  below: this is movement direction for a player, not the aim/shot direction. */
  setBodyFacing(rad: number): void {
    const { flipX, showBack } = facingFromAngle(rad);
    this.view.scale.x = flipX;
    this.showBack = showBack;
    this.flipX = flipX;
  }

  /** Aim/shot direction (radians) — drives ONLY the weapon-socket aim-tracking
   *  rotation, independently of the body flip set by `setBodyFacing`. */
  setAim(rad: number): void {
    this.aimRad = rad;
  }

  /** Multiply-tint every bone sprite (design/13: a neutral-grey body re-tinted per
   *  elemental variant at runtime, e.g. critter-core — never called for a character
   *  skin, which already carries its own real colours). The weapon sprite (mounted
   *  separately, not a bone) is deliberately left untinted. */
  setTint(color: number): void {
    this.sprites.forEach(sprite => {
      sprite.tint = color;
    });
    // The tether is part of the body, so it takes the variant tint too (a corrupted
    // boss core's shard-ring tethers read in its own hue, not the hero's cyan).
    this.tetherTint = color;
    if (this.tethers) this.tethers.tint = color;
  }

  /** Which weapon module (if any) the active socket (`ACTIVE_WEAPON_SOCKET`) mounts —
   *  null hides it (unarmed / no rig / texture not preloaded yet). design/13's
   *  universal mount: one neutral sprite per KIND, not per weapon frame. */
  setWeaponKind(kind: WeaponVisualKind | null, name?: string): void {
    this.weaponKind = kind;
    this.weaponName = name;
  }

  /** Re-tint the mounted weapon sprite (design/03/13 "element = colour" — a fire/ice/
   *  lightning/poison weapon reads in its element hue, physical stays neutral). Applied
   *  immediately if the sprite already exists; otherwise picked up the next time
   *  `updateWeaponSprite` (re)creates it. */
  setWeaponTint(color: number): void {
    this.weaponTint = color;
    if (this.weaponSprite) this.weaponSprite.tint = color;
    if (this.idleModuleSprite) this.idleModuleSprite.tint = color;
  }

  /** The canonical (pre-mirror) local rotation, in RADIANS, that renders as the true
   *  world aim angle once `view.scale.x` possibly flips the whole rig (see class doc). */
  private canonicalSocketAngleRad(): number {
    return this.flipX === 1 ? this.aimRad : Math.PI - this.aimRad;
  }

  /** Recompute FK from the current clip sample and push it onto the sprites. Call once per render frame. */
  update(): void {
    const transforms: Map<string, ResolvedBoneTransform> = this.clip
      ? sampleClip(this.clip, this.clipT)
      : new Map();
    const worldPose = this.rig.computeFK(0, 0, transforms);
    const canonicalSocketDeg = (this.canonicalSocketAngleRad() * 180) / Math.PI;

    this.sprites.forEach((sprite, boneId) => {
      const pose = worldPose.get(boneId);
      const binding = this.bundle.bindings.get(boneId)!;
      if (!pose) return;

      const backTexture = this.showBack ? this.bundle.textures.get(`${boneId}__back`) : undefined;
      sprite.texture = backTexture ?? this.bundle.textures.get(boneId)!;

      const transform = transforms.get(boneId);
      sprite.x = pose.ex + (transform?.translateX ?? 0);
      sprite.y = pose.ey + (transform?.translateY ?? 0);
      // `pose.wa` already carries the clip's own rotation for this bone (Rig.computeFK
      // folds it in), so it is NOT added a second time here.
      const restAngleDeg = this.rig.boneMap.get(boneId)?.rwa ?? 0;
      const angleDeg = SOCKET_IDS.has(boneId) ? canonicalSocketDeg : pose.wa - restAngleDeg;
      sprite.rotation = ((angleDeg + binding.rotation) * Math.PI) / 180;
      sprite.scale.set(
        (binding.flipX ? -1 : 1) * (transform?.scaleX ?? 1) * binding.scaleX,
        (transform?.scaleY ?? 1) * binding.scaleY,
      );
      sprite.alpha = transform?.alpha ?? 1;
    });

    this.drawTethers(worldPose, transforms);
    this.updateWeaponSprites(worldPose);
  }

  /** Repaint the glowing tether of every orbiting bone (see TETHER_COLOR above): an arc
   *  from the bone's pivot on the core out to the module sitting at its tip. Geometry is
   *  static in body space unless a clip actually moves those bones, so the endpoints are
   *  signed and the rebuild skipped when nothing moved — a hovering idle costs one
   *  string compare per frame, not two curve rebuilds. */
  private drawTethers(worldPose: WorldPositions, transforms: Map<string, ResolvedBoneTransform>): void {
    const g = this.tethers;
    if (!g) return;

    const arcs: Array<{ pose: WorldPose; outerW: number; innerW: number; alpha: number }> = [];
    let signature = '';
    for (const bone of this.rig.boneDefs) {
      if (!bone.outerW || !bone.innerW) continue;
      const pose = worldPose.get(bone.id);
      if (!pose) continue;
      const alpha = transforms.get(bone.id)?.alpha ?? 1;
      arcs.push({ pose, outerW: bone.outerW, innerW: bone.innerW, alpha });
      signature += `${pose.sx.toFixed(1)},${pose.sy.toFixed(1)},${pose.ex.toFixed(1)},${pose.ey.toFixed(1)},${alpha.toFixed(2)};`;
    }
    if (signature === this.tetherGeometry) return;
    this.tetherGeometry = signature;

    g.clear();
    for (const { pose, outerW, innerW, alpha } of arcs) {
      if (alpha <= 0) continue;
      const dx = pose.ex - pose.sx;
      const dy = pose.ey - pose.sy;
      const len = Math.hypot(dx, dy);
      if (len < 1) continue;
      // Control point: the midpoint pushed along the segment's normal, so the tether
      // bows out to one consistent side (down, in the rig's own y-down space) whichever
      // way the bone points — the whole rig mirrors as a unit, so the sag mirrors with it.
      const nx = -dy / len;
      const ny = dx / len;
      const bow = (ny >= 0 ? 1 : -1) * len * TETHER_SAG;
      const cx = pose.sx + dx / 2 + nx * bow;
      const cy = pose.sy + dy / 2 + ny * bow;
      // Two passes over the same curve: a wide soft halo, then the bright core line.
      g.moveTo(pose.sx, pose.sy).quadraticCurveTo(cx, cy, pose.ex, pose.ey)
        .stroke({ color: TETHER_COLOR, width: outerW, alpha: 0.3 * alpha, cap: 'round' });
      g.moveTo(pose.sx, pose.sy).quadraticCurveTo(cx, cy, pose.ex, pose.ey)
        .stroke({ color: TETHER_COLOR, width: innerW, alpha: 0.9 * alpha, cap: 'round' });
    }
    g.tint = this.tetherTint;
  }

  /** Mount/move/hide both orbiting weapon modules (design/03 universal mount — render-only,
   *  never touches the sim): the ACTIVE one, which tracks the live aim, and the decorative
   *  IDLE one on the other arm, which points outward along its own tether (see the socket
   *  constants at the top of this file). Each sits on its socket bone's TIP — that's where
   *  the module orbits; the pivot is the core's own centre. */
  private updateWeaponSprites(worldPose: WorldPositions): void {
    const activePose = worldPose.get(ACTIVE_WEAPON_SOCKET);
    const idlePose = worldPose.get(IDLE_WEAPON_SOCKET);
    const texture = this.weaponKind ? getWeaponTexture(this.weaponName, this.weaponKind) : undefined;
    if (!texture) {
      if (this.weaponSprite) this.weaponSprite.visible = false;
      if (this.idleModuleSprite) this.idleModuleSprite.visible = false;
      return;
    }

    const rotationOffset = getWeaponRotationOffset(this.weaponName, this.weaponKind!);
    this.weaponSprite = this.mountModule(
      this.weaponSprite, ACTIVE_WEAPON_SOCKET, activePose, texture,
      this.canonicalSocketAngleRad() + rotationOffset,
    );
    // The idle module turns with its own bone (rest angle 180° = away from the core), not
    // with the reticle — computed pre-mirror like every other local angle here, so the
    // whole-rig flip keeps it pointing outward on whichever side it ends up.
    this.idleModuleSprite = this.mountModule(
      this.idleModuleSprite, IDLE_WEAPON_SOCKET, idlePose, texture,
      idlePose ? (idlePose.wa * Math.PI) / 180 + rotationOffset : 0,
    );
  }

  /** Place one module sprite (creating it on first use) on a socket bone's tip at the given
   *  local rotation; hides it when that bone isn't posed. Returns the sprite so the caller
   *  can keep its lazily-created reference. */
  private mountModule(
    sprite: Sprite | null,
    socketId: string,
    pose: WorldPose | undefined,
    texture: Texture,
    rotation: number,
  ): Sprite | null {
    if (!pose) {
      if (sprite) sprite.visible = false;
      return sprite;
    }
    if (!sprite) {
      sprite = new Sprite(texture);
      sprite.zIndex = (this.bundle.bindings.get(socketId)?.zOrder ?? 0) + 1;
      sprite.tint = this.weaponTint;
      this.view.addChild(sprite);
      this.view.sortableChildren = true;
    }
    const anchor = getWeaponAnchor(this.weaponName, this.weaponKind!);
    sprite.texture = texture;
    sprite.anchor.set(anchor.x, anchor.y);
    sprite.scale.set(getWeaponScale(this.weaponName, this.weaponKind!));
    sprite.visible = true;
    sprite.x = pose.ex;
    sprite.y = pose.ey;
    sprite.rotation = rotation;
    return sprite;
  }

  /**
   * Where the mounted weapon's business end actually is, in this rig's PARENT space
   * (i.e. `view`'s own scale.x flip already applied, the wrapper's uniform scale not
   * yet — `Skin.muzzleAnchor` finishes the job). Null when nothing is mounted, which
   * covers every socket-less rig (`critter-core`'s enemies) and the frames before the
   * weapon texture finishes preloading.
   *
   * Exists because the bullet spawns at the SIM's muzzle — `RangedSimSpec.muzzleOffset`,
   * a flat distance along the aim ray from the actor's centre — and the drawn gun's
   * barrel tip is somewhere else entirely: the module hangs off a socket bone that
   * orbits the core (52 authoring-px out on `orb-core`) and then extends its own texture
   * beyond that again, so the sim's 30px landed roughly mid-gun and shots visibly left
   * the middle of the housing rather than the muzzle (user report, 2026-08-17: "子弹要从
   * 枪口打出"). `Scene` uses this as the bullet view's FIRST position and lets the normal
   * interpolation carry it to the authoritative sim position over that tick — the sim is
   * untouched, so nothing here can affect hit detection or determinism, and deliberately
   * so: pushing the sim's spawn point out to the barrel tip instead would let a player
   * standing flush against a wall spawn bullets on the far side of it.
   *
   * The geometry, all in the rig's own authoring-px space:
   *   - the socket bone's TIP (`worldPose.ex/ey`) is where the module is mounted;
   *   - the barrel points along `canonicalSocketAngleRad()` — the sprite's rotation is
   *     that angle PLUS the texture's `rotationOffsetRad`, and the offset exists exactly
   *     to cancel each texture's own baked pointing direction, so the two cancel and the
   *     business end lies along the canonical aim angle;
   *   - its distance is how far the texture's own rect reaches from its anchor in that
   *     baked direction (`barrelReach`), scaled by the sprite's scale.
   */
  muzzleLocal(): { x: number; y: number } | null {
    const sprite = this.weaponSprite;
    if (!sprite || !sprite.visible || !this.weaponKind) return null;
    const angle = this.canonicalSocketAngleRad();
    const reach = barrelReach(
      sprite.texture.width,
      sprite.texture.height,
      getWeaponAnchor(this.weaponName, this.weaponKind),
      getWeaponRotationOffset(this.weaponName, this.weaponKind),
    ) * getWeaponScale(this.weaponName, this.weaponKind);
    return {
      x: this.flipX * (sprite.x + Math.cos(angle) * reach),
      y: sprite.y + Math.sin(angle) * reach,
    };
  }
}

/**
 * How far a weapon texture reaches from its anchor toward its own baked business end, in
 * unscaled texture px. A ray/rect intersection: the anchor is the ray origin (it is the
 * sprite's own local origin once `anchor` is set), the direction is the texture's baked
 * tip direction — `-rotationOffsetRad`, since that offset is what gets ADDED to rotate
 * the baked direction onto the live aim angle — and the rect is the texture's bounds
 * around the anchor. Assumes the art reaches its own canvas edge in that direction, which
 * is what `WEAPON_DEFS`' measured `rotationOffsetRad` values were derived from (the
 * alpha-farthest pixel from the anchor); the failure mode for a padded texture is a
 * muzzle a few px too far out, not a wrong direction. Exported for `RigSkin.test.ts`.
 */
export function barrelReach(
  texW: number,
  texH: number,
  anchor: { x: number; y: number },
  rotationOffsetRad: number,
): number {
  const dx = Math.cos(-rotationOffsetRad);
  const dy = Math.sin(-rotationOffsetRad);
  const right = (1 - anchor.x) * texW;
  const left = -anchor.x * texW;
  const bottom = (1 - anchor.y) * texH;
  const top = -anchor.y * texH;
  const tx = dx > 1e-6 ? right / dx : dx < -1e-6 ? left / dx : Infinity;
  const ty = dy > 1e-6 ? bottom / dy : dy < -1e-6 ? top / dy : Infinity;
  return Math.min(tx, ty);
}
