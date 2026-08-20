import { Graphics, Sprite, Texture, TilingSprite } from 'pixi.js';
import type { GameState } from '@dd/engine';
import type { Layers } from './layers';
import { Entity } from './Entity';
import { biomePalette, biomeElementOf, type BiomePalette } from '../theme';
import { fpToPx } from '../coords';
import { getFloorTexture, getWallTexture, getWallFaceTexture } from '../../render/biomeTiles';
import { getDoorTexture } from '../../render/environmentSprites';
import { wallTier, wallHeight, WALL_HEIGHT, type RectPx } from './wallGeometry';
import { buildWallBlock, drawWallShadow } from './wallRender';
import { buildPillarBody, pillarArtExtent } from './pillarRender';
import {
  deepXrayLayers,
  fadeableBlock,
  updateOcclusion,
  xrayLayers,
  type FadeableOccluder,
  type OcclusionFocus,
} from './occlusion';
import { blockCapTop, bordersDoorNorth, mergeWallRuns, wallJoins, type WallRun } from './wallRuns';
import { faceCrownFraction } from './wallTone';
import { drawRoomLight } from './roomLight';
import { NormalLitFilter, WALL_LIT_AMBIENT, WALL_LIT_GRADIENT, WALL_LIT_KEY_INTENSITY } from '../fx/filters';
import { SHADOW_SLANT_X, SHADOW_SLANT_Y } from './Entity';
import type { Backdrop } from './Backdrop';
import { Portal } from './Portal';

/** Opacity of the 64 px floor grid. See `build()` for why it is this low now. */
const GRID_ALPHA = 0.12;

/** Whether standing walls take the directional-lighting filter on top of their hand-authored
 *  cap/face/side tints (2026-08-18). One render-target pass per wall segment, and a room has
 *  ~10-32 of them, so this is by far the most expensive thing in the wall pass.
 *
 *  **Off since 2026-08-19, because it was measured to do nothing.** An A/B of the live frame
 *  with every wall filter stripped differs by a MEAN of 0.48 out of 765 (0.06%), a maximum of
 *  5%, and only 0.05% of pixels move by more than 5/255 — the four probe points (cap, face,
 *  north-south cap, adjacent floor) come out 13/13, 62/62, 26/25, 40/40. The intent was
 *  per-stone relief; the tuning that made it safe (`WALL_LIT_AMBIENT` above `1 - key`, a much
 *  gentler gradient gain than an actor's, both needed to stop a wall going darker than its own
 *  floor) is also what left it with no visible amplitude. The relief the walls actually have
 *  now comes from `wallTone.ts` — cap wash, cap depth gradient, face ramp, fold line — which is
 *  free. Kept as a switch rather than deleted so the experiment is repeatable: the constants
 *  and the shader are still in `fx/filters/litFx.ts`, and re-tuning them is the open question,
 *  not whether to re-enable this as it stands. */
const LIT_WALLS = false;

/** A `NormalLitFilter` tuned for stone rather than for a character — see `WALL_LIT_*`
 *  (`fx/filters/litFx.ts`) for why a wall needs the opposite ambient bias from an actor.
 *  One instance per segment: filters carry per-instance uniform state, and Pixi does not
 *  support sharing one Filter across display objects with different bounds. */
function wallLitFilter(): NormalLitFilter {
  return new NormalLitFilter(0xfff2e0, WALL_LIT_KEY_INTENSITY, {
    ambient: WALL_LIT_AMBIENT,
    gradient: WALL_LIT_GRADIENT,
  });
}

/**
 * Render-side mirror of the engine's dungeon/arena room geometry (design/08 "render
 * only reads") — ground/grid, AABB walls, and the round Y-sortable pillars. Extracted
 * out of Game.ts 2026-07-28 alongside EventReactor: owns the pillar Entity list itself
 * so Game only calls `build()` (on `room_enter`, or once for the `?arenaDemo=1` harness)
 * and `clear()` (on a fresh run).
 */
export class RoomBuilder {
  private readonly pillars: Entity[] = [];
  // Standing wall segments (design/01's front face) — Entities on the Y-sortable
  // `entities` layer, so they must be destroyed explicitly like `pillars`; the flat
  // walls they replace lived on `ground`, which `build()` clears wholesale.
  private readonly wallEntities: Entity[] = [];
  // One shared Graphics carrying EVERY wall's ground shadow for the current room
  // (`wallRender.drawWallShadow`), on `layers.shadow`. A room has up to a couple of dozen
  // segments and their shadows never move, so one static display object beats one per wall.
  private wallShadows: Graphics | null = null;
  // Every standing block in the current room — wall segments AND pillars — paired with the band
  // of floor its art covers, for the occlusion x-ray (`updateOcclusion`). Rebuilt with the room;
  // one flat list because the fade rule does not care which kind of block it is looking at.
  private occluders: FadeableOccluder[] = [];
  // Index-aligned with `state.dungeonDoors` (design/05 "Room & door model") — a real
  // fixture per door, never a bare gap / never folded into the generic wall fill.
  // `updateDoors()` swaps textures on these in place on door_locked/door_unlocked
  // (DoorSystem), so a lock-state flip doesn't need a full room rebuild.
  private readonly doorSprites: Sprite[] = [];
  private portal: Portal | null = null;
  // World-px position of the current room's portal (its center), or null before the
  // first room ever loads. Game reads this to gate the popup's proximity check.
  portalPx: { x: number; y: number } | null = null;

  constructor(
    private readonly layers: Layers,
    private readonly backdrop: Backdrop,
  ) {}

  /** Rebuild the ground, AABB walls, and pillars for the CURRENTLY LOADED room. */
  build(s: GameState): void {
    const w = fpToPx(s.worldW);
    const h = fpToPx(s.worldH);

    for (const c of [...this.layers.ground.children]) c.destroy();
    this.clearWalls();
    // Dropped here rather than inside `clearWalls`, because pillars contribute to this list too
    // and `buildPillars` refills it further down this same method.
    this.occluders.length = 0;

    // design/13 "per-biome background palette" — derived from the run's dungeon
    // biomeId (undefined outside dungeon mode, e.g. flat EngineConfig.floors/PvP
    // arena, which fall back to today's neutral palette unchanged).
    const palette = biomePalette(s.dungeonConfig?.biomeId);
    const element = biomeElementOf(s.dungeonConfig?.biomeId);
    const floorTex = getFloorTexture(element);
    const wallTex = getWallTexture(element);
    this.backdrop.setPalette(palette);

    // Ground fill — a real tileable swatch (render/biomeTiles.ts) once one's been
    // generated for this element, else the same flat palette-colour fill as before.
    if (floorTex) {
      const floor = new TilingSprite({ texture: floorTex, width: w, height: h });
      this.layers.ground.addChild(floor);
    } else {
      const groundG = new Graphics();
      groundG.rect(0, 0, w, h).fill({ color: palette.ground });
      this.layers.ground.addChild(groundG);
    }

    // Grid overlay — always drawn (readability aid, independent of ground art), but only
    // just (2026-08-18): a regular full-strength lattice across the whole floor is the
    // loudest "this is a top-down blueprint" cue in the frame, and it fought every depth
    // cue this pass adds. Dropped to GRID_ALPHA so it still helps judge distance without
    // asserting that the world is flat.
    const grid = new Graphics();
    const step = 64;
    for (let x = 0; x <= w; x += step) grid.moveTo(x, 0).lineTo(x, h);
    for (let y = 0; y <= h; y += step) grid.moveTo(0, y).lineTo(w, y);
    grid.stroke({ color: palette.gridLine, width: 1, alpha: GRID_ALPHA });
    this.layers.ground.addChild(grid);

    // Per-room light pool (`roomLight.ts`) — the cheap static half of design/01's parked
    // lightmap milestone. Every room on this floor measured the same flat 39-53 luma before
    // this, which is both why a floor of rooms read as one sheet and why a black cast shadow
    // on a near-black floor had nothing to be darker than. Painted after the grid so the
    // lattice fades toward the walls with everything else.
    const roomsPx = this.roomRectsPx(s, w, h);
    const light = new Graphics();
    for (const room of roomsPx) drawRoomLight(light, room);
    this.layers.ground.addChild(light);

    // AABB walls (ROADMAP 1.2 — finally drawn): a tiled swatch + outline once wall art
    // exists for this element, else the same flat fill + outline as before. A
    // currently-locked door's passage rect lives in `s.walls` too (DoorSystem folds it
    // in while locked) but must render as a door fixture, not a generic wall segment —
    // `doorAabbs` is a reference-identity set (DoorSystem pushes the SAME `passageAabb`
    // object, never a copy) so this skip is exact and free for non-dungeon modes
    // (`dungeonDoors` is empty there).
    const doorAabbs = new Set(s.dungeonDoors.map((dr) => dr.passageAabb));
    // Px-space rects of every door passage, for `bordersDoorNorth` below — a door is never a
    // wall (it's skipped from `runs` just above), but it's a fixture standing in the room all
    // the same, and a run's cap must not be allowed to spill onto it (live report: the door
    // "随时清晰可见" — always clearly visible — was half swallowed by a run's cap standing south
    // of it, the exact "door passage between two rooms" case design/01 already called out).
    const doorRectsPx: RectPx[] = s.dungeonDoors.map((dr) => ({
      x: fpToPx(dr.passageAabb.x),
      y: fpToPx(dr.passageAabb.y),
      w: fpToPx(dr.passageAabb.w),
      h: fpToPx(dr.passageAabb.h),
    }));
    // Every wall now stands (2026-08-18 — see `wallGeometry.wallTier` for why the old
    // "east-west runs only" rule was what made a room read flat), at one of three heights.
    // Shadows all land on one shared Graphics, added to `layers.shadow` before the blocks so
    // it paints under both them and the actors.
    const shadows = new Graphics();
    const faceTex = getWallFaceTexture(element);
    // Tier FIRST, then merge same-tier neighbours into one mass (`wallRuns.ts`): adjacent rooms
    // each author their own perimeter wall, so a room boundary is two parallel 32 px rects and
    // drawing each as its own block put a lit-edge/dark-band seam down the middle of one stone
    // mass. Tier before merge, never after — see `mergeWallRuns` for why same-tier-only is
    // load-bearing rather than caution.
    const runs: WallRun[] = [];
    for (const wall of s.walls) {
      if (doorAabbs.has(wall)) continue;
      const rect: RectPx = { x: fpToPx(wall.x), y: fpToPx(wall.y), w: fpToPx(wall.w), h: fpToPx(wall.h) };
      runs.push({ rect, tier: wallTier(rect, roomsPx) });
    }
    // ...then, on the merged set, work out which edges are buried in an L/T corner. An L cannot
    // be merged (its union is not a rectangle), so without this every corner drew two blocks'
    // worth of "I end here" cues across one continuous stone top — see `wallJoins`.
    const merged = mergeWallRuns(runs);
    // The crown line a corner stops under is per-ELEMENT: the shipped face swatches disagree, ice
    // most of all (see `FACE_CROWN_ROWS`), so this has to come from the room's own biome.
    const joins = wallJoins(merged, faceCrownFraction(element));
    for (const [i, run] of merged.entries()) {
      if (bordersDoorNorth(run.rect, doorRectsPx)) joins[i] = { ...joins[i]!, doorClip: true };
    }
    for (const [i, run] of merged.entries()) {
      const height = wallHeight(run.tier);
      drawWallShadow(shadows, run.rect, height);
      const seg = buildWallBlock(run.rect, height, { palette, cap: wallTex, face: faceTex }, joins[i]);
      if (LIT_WALLS) seg.filters = [wallLitFilter()];
      this.layers.entities.addChild(seg);
      this.wallEntities.push(seg);
      // The block sorts on its south edge and paints upward from there, so the floor it covers
      // runs from its cap's north edge down to its own footprint — see `occlusion.Occluder`.
      const sortY = run.rect.y + run.rect.h;
      this.occluders.push(
        fadeableBlock(
          {
            left: run.rect.x,
            right: run.rect.x + run.rect.w,
            top: sortY + blockCapTop(run.rect, height, joins[i]),
            sortY,
            foldY: sortY - height, // the cap/face joint: below it, only a deep fade reaches
          },
          xrayLayers(seg.children),
          deepXrayLayers(seg.children),
        ),
      );
    }
    this.layers.shadow.addChild(shadows);
    this.wallShadows = shadows;

    this.buildPillars(s, palette);
    this.buildDoors(s);
    this.buildPortal(s, w, h);
  }

  /**
   * The occlusion x-ray, one render frame (design/01 "Limits of fake 3D", live report
   * *"角色跑到墙下面去了"*): any standing block that is currently drawing over the character
   * fades toward `XRAY_FADE` and back once it isn't.
   *
   * Called from `GameLoop.updateFx` at render rate. `foci` is the local player plus every live
   * enemy (an empty list whenever there is no local view at all — menus, between spawns), which
   * fades every block back to solid rather than freezing one mid-x-ray.
   */
  updateOcclusion(foci: readonly OcclusionFocus[], dtMs: number): void {
    updateOcclusion(this.occluders, foci, dtMs);
  }

  /** The floor's room footprints in world px, for `wallRises`. Dungeon floors and the PvP
   *  arena each keep their own list; a flat `EngineConfig.floors` run populates neither, so
   *  the world itself stands in as the single room (identical answer for a one-room world). */
  private roomRectsPx(s: GameState, w: number, h: number): RectPx[] {
    const src = s.dungeonRoomRects.length > 0 ? s.dungeonRoomRects : s.arenaRoomRects;
    if (src.length === 0) return [{ x: 0, y: 0, w, h }];
    return src.map(({ rect }) => ({
      x: fpToPx(rect.x),
      y: fpToPx(rect.y),
      w: fpToPx(rect.w),
      h: fpToPx(rect.h),
    }));
  }

  /** Destroy the standing wall segments (they live on the Y-sorted `entities` layer, which
   *  `build()`/`clear()` never sweep wholesale — actors live there too), plus the shared
   *  Graphics holding their ground shadows (`layers.shadow`, likewise never swept). */
  private clearWalls(): void {
    for (const e of this.wallEntities) e.destroy();
    this.wallEntities.length = 0;
    this.wallShadows?.destroy();
    this.wallShadows = null;
  }

  /** One sprite per dungeon door (design/05: "always-present physical fixtures with
   *  exactly two visual states, locked/open — never a bare gap"), sized to its own
   *  `passageAabb`. Rebuilt fresh each `build()`; `updateDoors()` is the cheap
   *  in-place path for a lock-state flip alone (same sprite, texture/tint swapped).
   *  Door sprites live on `layers.ground` alongside the walls, so `build()`'s own
   *  "destroy every ground child" sweep above already tore down the previous set —
   *  this only needs to drop the stale array references, not destroy again. */
  private buildDoors(s: GameState): void {
    this.doorSprites.length = 0;

    for (const dr of s.dungeonDoors) {
      const sprite = new Sprite();
      sprite.position.set(fpToPx(dr.passageAabb.x), fpToPx(dr.passageAabb.y));
      sprite.width = fpToPx(dr.passageAabb.w);
      sprite.height = fpToPx(dr.passageAabb.h);
      this.applyDoorTexture(sprite, dr.locked);
      this.layers.ground.addChild(sprite);
      this.doorSprites.push(sprite);
    }
  }

  /** `environmentSprites.getDoorTexture` once loaded; otherwise Pixi's built-in white
   *  texture tinted hazard-red (locked) / neutral grey (open) — `13`'s "hazard-
   *  saturated glowing barrier / desaturated inert frame" read without the real art
   *  yet, same texture-or-fallback convention as the floor/wall loop above. Tint (not
   *  a second Graphics branch) is what lets `updateDoors` restyle the SAME sprite. */
  private applyDoorTexture(sprite: Sprite, locked: boolean): void {
    const tex = getDoorTexture(locked);
    sprite.texture = tex ?? Texture.WHITE;
    sprite.tint = tex ? 0xffffff : locked ? 0xe53e3e : 0x4c566a;
  }

  /** Cheap reaction to `door_locked`/`door_unlocked` (DoorSystem) — swap each door's
   *  texture/tint in place, no destroy/rebuild of the room. No-op if called before
   *  any `build()` has run for this floor (index mismatch). */
  updateDoors(s: GameState): void {
    if (this.doorSprites.length !== s.dungeonDoors.length) return;
    for (let i = 0; i < s.dungeonDoors.length; i++) {
      this.applyDoorTexture(this.doorSprites[i]!, s.dungeonDoors[i]!.locked);
    }
  }

  /** Hidden until `setPortalOpen(true)` (Game, gated on the same checkpoint condition
   *  PortalPrompt uses). Rebuilt (not just repositioned) per room so a stale reference
   *  never survives a room swap.
   *
   *  Placement bug fix (2026-08-12, live screenshot report): this used to center on
   *  `(w/2, h/2)` — but in dungeon mode `w`/`h` are `fpToPx(s.worldW/worldH)`, the
   *  bounding box of the WHOLE floor's co-resident rooms (buildFloorGeometry), not the
   *  single room the checkpoint actually belongs to. On any floor with more than one
   *  room that box's center can land in a corridor or on top of a wall instead of
   *  inside the capstone (extraction/boss) room. `state.dungeonRoomRects` — populated
   *  per room by SpawnSystem, always with the capstone LAST (ExtractionSystem's own
   *  "capstone = last entry" convention, generateFloor always appends it last) — gives
   *  the correct room to center on. Flat (non-dungeon) runs never populate
   *  `dungeonRoomRects` (SpawnSystem only pushes into it in the dungeon branch), where
   *  `w/h` already IS the single room's own size, so the old `w/2, h/2` center is kept
   *  as the fallback for that mode. */
  private buildPortal(s: GameState, w: number, h: number): void {
    this.portal?.shadow?.destroy();
    this.portal?.destroy();
    const portal = new Portal();
    this.layers.entities.addChild(portal);
    this.layers.shadow.addChild(portal.shadow!);

    const capstone = s.dungeonRoomRects[s.dungeonRoomRects.length - 1]?.rect;
    const px = capstone
      ? { x: fpToPx(capstone.x) + fpToPx(capstone.w) / 2, y: fpToPx(capstone.y) + fpToPx(capstone.h) / 2 }
      : { x: w / 2, y: h / 2 };

    portal.place(px.x, px.y);
    this.portal = portal;
    this.portalPx = px;
  }

  /** Toggle the current room's portal visibility — open once the checkpoint condition
   *  is met (design/05 "the portal opens" — generalized to every checkpoint room). */
  setPortalOpen(open: boolean): void {
    this.portal?.setOpen(open);
  }

  /** Round pillars for the current room, from the engine's obstacle solids. Tall
   *  Y-sortable objects (occlusion + collision). Rebuilt per room; the drawn body is a
   *  little wider than the collision footprint so the player can stand against it. */
  private buildPillars(s: GameState, palette: BiomePalette): void {
    for (const p of this.pillars) {
      p.shadow?.destroy();
      p.destroy();
    }
    this.pillars.length = 0;

    for (const o of s.obstacles) {
      const rad = fpToPx(o.radius);
      const bodyW = rad * 2 + 16; // visual body a touch wider than the footprint
      const height = WALL_HEIGHT; // one height for every standing thing in a room
      const p = new Entity();
      // A round wall block, from the same two swatches and the same three-surface tints
      // (`wallRender.buildPillarBody`, 2026-08-18 — see its doc for why the old
      // palette-derived flat fill had to go once the walls read as real stone).
      p.addChild(buildPillarBody(bodyW, height, palette));
      // A pillar's shadow has to be displaced by hand (2026-08-18): the height that throws
      // it is the DRAWN body's, and a pillar is drawn upward from a grounded origin rather
      // than lifted by the transform, so `Entity`'s own height-driven offset sees z = 0.
      // Same slant constants as an actor's hover shadow and a wall's cast shadow, so all
      // three agree on where the key light is.
      p.makeShadow(rad + 12);
      p.shadowOffsetX = height * SHADOW_SLANT_X;
      p.shadowOffsetY = height * SHADOW_SLANT_Y;
      this.layers.entities.addChild(p);
      this.layers.shadow.addChild(p.shadow!);
      this.pillars.push(p);
      const gx = fpToPx(o.gx);
      const gy = fpToPx(o.gy);
      p.place(gx, gy);
      // A pillar hides the character exactly the way a wall block does — it is drawn upward from
      // its ground point over the same `height` of walkable floor to its north, and it is a
      // NARROWER target, so the player brushes past its blind side more often, not less. Same
      // x-ray. (design/01 used to call being hidden behind a pillar intended; a body that
      // vanishes completely is not, whatever shape the thing hiding it is.)
      const art = pillarArtExtent(bodyW, height);
      this.occluders.push(
        fadeableBlock(
          // `foldY: gy` — a pillar's whole body is one Graphics and fades together, so it has no
          // opaque remainder for a deep fade to reach and never asks for one.
          { left: gx - art.halfW, right: gx + art.halfW, top: gy + art.top, sortY: gy, foldY: gy },
          p.children,
        ),
      );
    }
  }

  /** Tear down the current room's ground + pillars (beginRun) so a restart doesn't
   *  leak the previous run's geometry. */
  clear(): void {
    for (const c of [...this.layers.ground.children]) c.destroy(); // also destroys door sprites (ground children)
    this.doorSprites.length = 0;
    this.clearWalls();
    this.occluders.length = 0;
    for (const p of this.pillars) {
      p.shadow?.destroy();
      p.destroy();
    }
    this.pillars.length = 0;
    this.portal?.shadow?.destroy();
    this.portal?.destroy();
    this.portal = null;
    this.portalPx = null;
  }
}
