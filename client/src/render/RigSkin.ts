import { Container, Graphics, Sprite, type Texture } from 'pixi.js';
import type { Rig } from './Rig';
import type { RigSkinBundle } from './taoBundle';
import type { AnimationClip, ResolvedBoneTransform, WorldPositions } from './types';
import { sampleClip } from './interpolate';
import { facingFromAngle } from './facing';
import { getWeaponAnchor, getWeaponRotationOffset, getWeaponScale, getWeaponTexture, type WeaponVisualKind } from './weaponSkins';
import { MODULE_BEHIND_SCALE, MODULE_BEHIND_SHADE, SHADE_MIN_BODY_R, drawModuleContacts, drawSphereShading, shadeHex } from './rigShading';
import { drawTethers, hasTetheredBone } from './rigTethers';
import {
  AIM_TRACKING_BONES, ACTIVE_WEAPON_SOCKET, IDLE_WEAPON_SOCKET, MODULE_Z_BEHIND,
  activeModuleMount, barrelReach, idleModuleMount, resolveWeaponMount,
  type ModuleMount, type WeaponMountMode,
} from './rigWeaponMount';

// `barrelReach` moved to ./rigWeaponMount with the rest of the mount geometry; re-exported
// here so the original import path stays valid for callers and tests (500-line convention:
// "keep that path alive as a thin re-export shell").
export { barrelReach };

// Eye tracking (2026-08-18). A 2D rig can't turn a head, and the two-hemisphere billboard
// (`facingFromAngle`) only has four states — L/R flip × front/back — so a 360° aim used to
// read as four discrete poses. For a body plan that is mostly one big eye (design/13),
// the direction cue nobody has to be taught is where the eye is LOOKING: the eye slot
// slides inside the shell along the aim direction, which turns those four states into a
// continuous read using the art that already ships. Free of new assets by construction.
const EYE_BONE_ID = 'eye';
/** How far the eye slides from its authored rest position, in rig authoring px. The shell's
 *  own `bodyR` is 40 and the eye's is 16 (`orbCoreRig`), so 14 keeps it inside the shell
 *  with a margin rather than riding the rim. */
const EYE_TRACK_R = 14;
/** The vertical half of that slide is squashed: this is a tilted view (design/01), so a
 *  sphere's surface covers less screen distance vertically than horizontally. */
const EYE_TRACK_SQUASH = 0.45;
/** How much the eye shrinks as the aim turns away from the camera — a little perspective
 *  on top of the front/back texture swap, so crossing the hemisphere isn't a hard cut. */
const EYE_AWAY_SHRINK = 0.15;
/**
 * Bones whose art depicts a FRONT surface and has no meaning seen from behind. Only the
 * belly qualifies today: it is the transparent chamber set into the front of the shell, so
 * from the back there is simply no chamber to see — the shell's own surface is the correct
 * picture. Every other bone either has real back art (`eye__back` ships for all three
 * characters) or reads the same from either side, which is a property of the design rather
 * than an accident: design/13 chose "one bold radially-ish-symmetric shape" partly because
 * "front/back sets nearly collapse".
 *
 * NOT a list of bones missing back art — `shell` is missing it too, and hiding the shell
 * would delete the character. This is a statement about what the art depicts.
 */
const FRONT_ONLY_BONES: ReadonlySet<string> = new Set(['belly']);
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
  // Sphere shading over the body bone (see rigShading.ts), plus which bone it tracks. Null
  // for a rig whose body is too small to shade, or one with no bound body art at all.
  private readonly sphereShade: Graphics | null;
  /** Contact shade where each orbiting module meets the core (`rigShading.drawModuleContacts`,
   *  2026-08-19). Allocated only for a rig that HAS orbiting modules, i.e. the same tethered
   *  bones the tether Graphics is drawn from, and only when that rig's body is big enough to
   *  shade at all — an enemy with one body bone gets neither. */
  private readonly moduleAO: Graphics | null;
  private readonly shadeBoneId: string | null;
  /** Which mount path this body plan uses (`rigWeaponMount.resolveWeaponMount`) — resolved
   *  once at construction, since it is a property of the rig def, not of this frame. */
  private readonly weaponMount: WeaponMountMode;
  private tetherGeometry = ''; // last-drawn endpoint signature (skip the rebuild if unchanged)
  private tetherTint = 0xffffff; // multiply-tint over the tether hue; white = as authored
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

  /** `bodyFill` is how much of the body bone's declared `bodyR` this bundle's art actually
   *  paints (`skinRegistry.BODY_FILL`, measured from the shipped PNGs). Everything drawn ON the
   *  body rather than as part of it — the sphere shading, the module contact shades — must be
   *  sized against that, not against `bodyR`: nothing here is masked, so a mark sized to a
   *  radius the art does not reach paints straight onto the transparent background. Defaults to
   *  1 (assume the art fills its radius) so a fake bundle in a test behaves as before. */
  constructor(
    private readonly rig: Rig,
    private readonly bundle: RigSkinBundle,
    private readonly bodyFill = 1,
  ) {
    this.weaponMount = resolveWeaponMount(rig);
    // Tethers paint behind every bone sprite: they run from the core's centre out to a
    // module, so the half nearest the core belongs UNDER the body, not across it.
    this.tethers = hasTetheredBone(rig.boneDefs) ? new Graphics() : null;
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

    // Sphere shading goes on the rig's BODY bone — the first bone in draw order with a
    // bodyR big enough to be worth shading, which is `shell` (orb-core), `body`
    // (critter-core and the brute/floater that share its rig) and `core` (boss-core).
    // Placed at that bone's own zOrder + 0.5, i.e. immediately over its art and under
    // everything drawn later (an orb-core's belly/eye/modules keep their own reads).
    this.shadeBoneId =
      rig.drawOrder.find(id => {
        const r = rig.boneMap.get(id)?.bodyR ?? 0;
        return r >= SHADE_MIN_BODY_R && bundle.bindings.has(id) && bundle.textures.has(id);
      }) ?? null;
    if (this.shadeBoneId) {
      this.sphereShade = drawSphereShading(this.drawnBodyR());
      this.sphereShade.zIndex = (bundle.bindings.get(this.shadeBoneId)?.zOrder ?? 0) + 0.5;
      this.view.addChild(this.sphereShade);
    } else {
      this.sphereShade = null;
    }

    // Just above the sphere shade and still below every decorative bone (orb-core: belly 1,
    // eye 2, sockets 3/4), so a module's own art always draws over its contact shade.
    this.moduleAO = this.shadeBoneId && this.tethers ? new Graphics() : null;
    if (this.moduleAO) {
      this.moduleAO.zIndex = (bundle.bindings.get(this.shadeBoneId!)?.zOrder ?? 0) + 0.6;
      this.view.addChild(this.moduleAO);
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
    // The key light is fixed in SCREEN space, so the shading must not mirror with the body:
    // counter-flipping cancels `view.scale.x` exactly, leaving the highlight on the
    // upper-left and the terminator on the lower-right whichever way the character faces.
    // (Every other child here is body-space art and SHOULD mirror.)
    if (this.sphereShade) this.sphereShade.scale.x = flipX;
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
      // A FRONT_ONLY bone with no back art of its own is hidden from behind rather than
      // drawn as though the character were still facing the camera. Closes design/12's one
      // remaining facing-model gap ("a character facing away still shows its belly"), which
      // that doc offers two fixes for: ship `belly__back`, or hide it. This is the second,
      // and it is written so the first supersedes it for free — the moment a `belly__back`
      // texture exists the lookup above finds it, `backTexture` is defined, and the bone
      // draws again with no code change.
      sprite.visible = !(this.showBack && !backTexture && FRONT_ONLY_BONES.has(boneId));

      const transform = transforms.get(boneId);
      sprite.x = pose.ex + (transform?.translateX ?? 0);
      sprite.y = pose.ey + (transform?.translateY ?? 0);
      // `pose.wa` already carries the clip's own rotation for this bone (Rig.computeFK
      // folds it in), so it is NOT added a second time here.
      const restAngleDeg = this.rig.boneMap.get(boneId)?.rwa ?? 0;
      const angleDeg = AIM_TRACKING_BONES.has(boneId) ? canonicalSocketDeg : pose.wa - restAngleDeg;
      sprite.rotation = ((angleDeg + binding.rotation) * Math.PI) / 180;
      let scaleMul = 1;
      if (boneId === EYE_BONE_ID) {
        // Canonical (pre-mirror) angle, like the sockets: `view.scale.x` mirrors the whole
        // rig, so an offset computed here in canonical space lands on the correct side of
        // the shell after the flip. cos(π−a) = −cos(a) unflips to +cos(a); sin is unchanged,
        // which is exactly right — the vertical component must not mirror.
        const a = this.canonicalSocketAngleRad();
        sprite.x += Math.cos(a) * EYE_TRACK_R;
        sprite.y += Math.sin(a) * EYE_TRACK_R * EYE_TRACK_SQUASH;
        scaleMul = 1 - EYE_AWAY_SHRINK * Math.max(0, -Math.sin(this.aimRad));
      }
      sprite.scale.set(
        (binding.flipX ? -1 : 1) * (transform?.scaleX ?? 1) * binding.scaleX * scaleMul,
        (transform?.scaleY ?? 1) * binding.scaleY * scaleMul,
      );
      sprite.alpha = transform?.alpha ?? 1;
    });

    // Sphere shading rides the body bone's drawn position — same tip-not-pivot convention
    // as the art itself, and re-read every frame because the idle clip translates that bone
    // (the hover bob). Geometry is static in body space, so only x/y move here.
    if (this.sphereShade && this.shadeBoneId) {
      const bodyPose = worldPose.get(this.shadeBoneId);
      const bodyTransform = transforms.get(this.shadeBoneId);
      if (bodyPose) {
        this.sphereShade.visible = true;
        this.sphereShade.x = bodyPose.ex + (bodyTransform?.translateX ?? 0);
        this.sphereShade.y = bodyPose.ey + (bodyTransform?.translateY ?? 0);
        this.sphereShade.alpha = bodyTransform?.alpha ?? 1;
      } else {
        this.sphereShade.visible = false;
      }
    }

    if (this.tethers) {
      this.tetherGeometry = drawTethers(
        this.tethers, this.rig.boneDefs, worldPose, transforms, this.tetherGeometry, this.tetherTint,
      );
    }
    this.updateModuleContacts(worldPose, transforms);
    this.updateWeaponSprites(worldPose, transforms);
  }

  /** Repaint the module contact shades from this frame's socket-bone tips, in the body
   *  bone's own space (the same space `drawSphereShading` draws in), so the whole overlay
   *  rides the body's hover bob exactly as the shading does. */
  private updateModuleContacts(worldPose: WorldPositions, transforms: Map<string, ResolvedBoneTransform>): void {
    const g = this.moduleAO;
    if (!g || !this.shadeBoneId) return;
    const body = worldPose.get(this.shadeBoneId);
    if (!body) {
      g.visible = false;
      return;
    }
    const bodyTransform = transforms.get(this.shadeBoneId);
    const bx = body.ex + (bodyTransform?.translateX ?? 0);
    const by = body.ey + (bodyTransform?.translateY ?? 0);
    const mounts: Array<{ x: number; y: number }> = [];
    for (const bone of this.rig.boneDefs) {
      if (!bone.outerW || !bone.innerW) continue;
      const pose = worldPose.get(bone.id);
      const t = transforms.get(bone.id);
      if (!pose || (t?.alpha ?? 1) <= 0) continue;
      // `+ translate` for the same reason the sprite loop above does it: `computeFK` folds a
      // clip's ROTATION into a bone's tip but not its translation, so a module the clip slides
      // (the attack clip's recoil kick) would otherwise leave its contact shade behind.
      mounts.push({ x: pose.ex + (t?.translateX ?? 0) - bx, y: pose.ey + (t?.translateY ?? 0) - by });
    }
    g.visible = true;
    g.position.set(bx, by);
    g.alpha = bodyTransform?.alpha ?? 1;
    drawModuleContacts(g, mounts, this.drawnBodyR());
  }

  /** The body art's real drawn radius in authoring px — the shade bone's declared `bodyR` times
   *  this bundle's measured `bodyFill`. Only valid once `shadeBoneId` has resolved. */
  private drawnBodyR(): number {
    return this.rig.boneMap.get(this.shadeBoneId!)!.bodyR! * this.bodyFill;
  }

  /** The body bone a 'held' module hangs off, or null for a rig that mounts on a socket (or
   *  mounts nothing). It is the same bone the sphere shading tracks — the rig's actual body —
   *  and the radius is the ART's, not the bone's declared `bodyR`; see `HELD_MOUNT_R`.
   *
   *  The `weaponMount !== 'held'` half of the guard is deliberately unobservable: the socket
   *  path ignores this argument and the 'none' path returns null whatever it is handed, so
   *  dropping it changes no output (it is the one surviving mutant of the 59-mutant battery run
   *  for this pass, and survives as a true equivalent). Kept because it states the intent and
   *  skips the work, not because anything downstream depends on it. */
  private heldMountBody(): { boneId: string; drawnR: number } | null {
    if (this.weaponMount !== 'held' || !this.shadeBoneId) return null;
    return { boneId: this.shadeBoneId, drawnR: this.drawnBodyR() };
  }

  /** Mount/move/hide this rig's weapon modules (design/03 universal mount — render-only,
   *  never touches the sim). Which modules exist, and where they sit, is `rigWeaponMount`'s
   *  call: the hero's orb-core gets an aim-tracking ACTIVE module on its socket bone's TIP
   *  plus a decorative IDLE one on the other arm; an enemy body gets a single module held at
   *  its own drawn edge; the boss gets none. */
  private updateWeaponSprites(worldPose: WorldPositions, transforms: Map<string, ResolvedBoneTransform>): void {
    const texture = this.weaponKind ? getWeaponTexture(this.weaponName, this.weaponKind) : undefined;
    const canonical = this.canonicalSocketAngleRad();
    const activeMount = texture
      ? activeModuleMount(this.weaponMount, worldPose, transforms, canonical, this.heldMountBody())
      : null;
    const idleMount = texture ? idleModuleMount(this.weaponMount, worldPose) : null;
    if (!texture) {
      if (this.weaponSprite) this.weaponSprite.visible = false;
      if (this.idleModuleSprite) this.idleModuleSprite.visible = false;
      return;
    }

    const rotationOffset = getWeaponRotationOffset(this.weaponName, this.weaponKind!);
    this.weaponSprite = this.mountModule(
      this.weaponSprite, ACTIVE_WEAPON_SOCKET, activeMount, texture, rotationOffset,
    );
    this.idleModuleSprite = this.mountModule(
      this.idleModuleSprite, IDLE_WEAPON_SOCKET, idleMount, texture, rotationOffset,
    );
  }

  /** Place one module sprite (creating it on first use) at the given mount; hides it when
   *  there is no mount this frame (an unposed bone, or a rig that has no such module at all).
   *  Returns the sprite so the caller can keep its lazily-created reference. */
  private mountModule(
    sprite: Sprite | null,
    socketId: string,
    mount: ModuleMount | null,
    texture: Texture,
    rotationOffset: number,
  ): Sprite | null {
    if (!mount) {
      if (sprite) sprite.visible = false;
      return sprite;
    }
    if (!sprite) {
      sprite = new Sprite(texture);
      sprite.tint = this.weaponTint;
      this.view.addChild(sprite);
      this.view.sortableChildren = true;
    }
    // design/01's "Per-weapon local z-order" rule, implemented 2026-08-18 (it had been
    // documented, and pinned to in-front, since the rig renderer shipped): aiming away from
    // the camera puts the module on the far side of the core, so it has to draw BEHIND the
    // body — otherwise it reads as a gun stuck on the hero's back/chest. Re-evaluated every
    // frame, not just on creation, since `showBack` flips during play.
    // ...and, since 2026-08-18, two more depth cues on the same edge (MODULE_BEHIND_*): the
    // far-side module is drawn smaller and darker, so crossing the hemisphere reads as an
    // orbit around a sphere rather than a layer swap. Applied here, not in `setWeaponTint`,
    // because it has to be recomputed against the CURRENT `showBack` every frame — the tint
    // setter only knows the element colour.
    const behind = this.showBack;
    sprite.zIndex = behind ? MODULE_Z_BEHIND : (this.bundle.bindings.get(socketId)?.zOrder ?? 0) + 1;
    sprite.tint = behind ? shadeHex(this.weaponTint, MODULE_BEHIND_SHADE) : this.weaponTint;
    const anchor = getWeaponAnchor(this.weaponName, this.weaponKind!);
    sprite.texture = texture;
    sprite.anchor.set(anchor.x, anchor.y);
    sprite.scale.set(getWeaponScale(this.weaponName, this.weaponKind!) * (behind ? MODULE_BEHIND_SCALE : 1));
    sprite.visible = true;
    sprite.x = mount.x;
    sprite.y = mount.y;
    sprite.rotation = mount.angle + rotationOffset;
    return sprite;
  }

  /**
   * Where the mounted weapon's business end actually is, in this rig's PARENT space
   * (i.e. `view`'s own scale.x flip already applied, the wrapper's uniform scale not
   * yet — `Skin.muzzleAnchor` finishes the job). Null when nothing is mounted, which
   * covers a rig whose `weaponMount` is 'none' (`boss-core`) and the frames before the
   * weapon texture finishes preloading. It is NOT null for enemies any more: since
   * 2026-08-21 they mount a real module on the 'held' path, so their bullets get the same
   * barrel-tip spawn correction the hero's always had.
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
   *   - the module's own mounted position (`sprite.x/y`, i.e. whatever `rigWeaponMount`
   *     resolved this frame — a socket bone's tip, or the body's drawn edge);
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
