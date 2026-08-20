import { Graphics, Texture } from 'pixi.js';
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
import {
  blockCapTop,
  bordersDoorNorth,
  doorFlankTier,
  effectiveWallHeight,
  mergeWallRuns,
  wallJoins,
  type WallRun,
} from './wallRuns';
import { buildDoorBlock, type DoorFixture } from './doorRender';
import { buildGroundLayer, floorRegionsPx, roomRectsPx } from './groundLayer';
import { faceCrownFraction } from './wallTone';
import { SHADOW_SLANT_X, SHADOW_SLANT_Y } from './Entity';
import type { Backdrop } from './Backdrop';
import { Portal } from './Portal';

// Standing walls used to optionally take a per-segment `NormalLitFilter` on top of their
// hand-authored cap/face/side tints (2026-08-18 — one render-target pass per segment, up to 32
// per room, by far the most expensive thing in the wall pass), gated behind a `LIT_WALLS`
// switch that had been off since 2026-08-19: an A/B of the live frame with the filter stripped
// differed by a MEAN of 0.48 out of 765 (0.06%), max 5%, only 0.05% of pixels moving more than
// 5/255. The tuning that made it safe (`WALL_LIT_AMBIENT` above `1 - key`, a much gentler
// gradient gain than an actor's — both needed to stop a wall going darker than its own floor)
// is also what left it with no visible amplitude, and the relief walls actually have now comes
// free from `wallTone.ts` (cap wash, cap depth gradient, face ramp, fold line). Removed
// entirely 2026-08-20 rather than left as a permanently-off switch: a re-tune was never
// scheduled, "kept for the experiment" had become "dead code nobody revisits," and the switch
// was still costing a render target per wall the one time it was ever flipped on. The shader
// itself (`NormalLitFilter`) and its actor-facing tuning (`ACTOR_*`) are unaffected — this only
// removes the wall-specific `WALL_LIT_*` look and its call site.

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
  // `updateDoors()` swaps the leaf texture on these in place on door_locked/door_unlocked
  // (DoorSystem), so a lock-state flip doesn't need a full room rebuild. STANDING fixtures
  // since 2026-08-20 (`doorRender.ts`) and therefore on the Y-sorted `entities` layer, which
  // means they must be destroyed explicitly like `wallEntities` — `build()`'s wholesale sweep
  // of `layers.ground` no longer covers them.
  private readonly doorFixtures: DoorFixture[] = [];
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

    // The ground layer — floor, its variation, the grid, the room light — is `groundLayer.ts`
    // (split out 2026-08-20, 500-line convention). It is painted AFTER the wall/door geometry below
    // is worked out, because the decals need the merged wall footprints (rubble must not sit on a
    // wall's own footprint) and the door rects (the worn patch across a doorway).
    const roomsPx = roomRectsPx(s, w, h);

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
      // `doorClip`ped run whose OWN footprint is shallower than its tier: shrink the height
      // itself, not just the cap — see `effectiveWallHeight` for why a cap-only clip still let
      // the FACE spill onto the door (measured: 72 px of pure face, on a 32 px-deep stub). A
      // no-op for every other run, tier height unchanged.
      const height = effectiveWallHeight(run.rect, wallHeight(run.tier), joins[i]!);
      drawWallShadow(shadows, run.rect, height);
      const seg = buildWallBlock(run.rect, height, { palette, cap: wallTex, face: faceTex }, joins[i]);
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
    buildGroundLayer(this.layers.ground, {
      rooms: roomsPx,
      floorRegions: floorRegionsPx(s, w, h),
      wallRects: merged.map((run) => run.rect),
      doorRects: doorRectsPx,
      palette,
      floorTex,
    });

    // Doors before the shadow Graphics is mounted, because a door is a piece of the wall it is
    // cut into and throws its own cast shadow onto the same shared Graphics.
    this.buildDoors(s, merged, doorRectsPx, roomsPx, { palette, cap: wallTex, face: faceTex }, shadows, element);
    this.layers.shadow.addChild(shadows);
    this.wallShadows = shadows;

    this.buildPillars(s, palette);
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

  /** Destroy the standing wall segments (they live on the Y-sorted `entities` layer, which
   *  `build()`/`clear()` never sweep wholesale — actors live there too), plus the shared
   *  Graphics holding their ground shadows (`layers.shadow`, likewise never swept). */
  private clearWalls(): void {
    for (const e of this.wallEntities) e.destroy();
    this.wallEntities.length = 0;
    this.wallShadows?.destroy();
    this.wallShadows = null;
  }

  /**
   * One STANDING fixture per dungeon door (design/05: "always-present physical fixtures with
   * exactly two visual states, locked/open — never a bare gap"), on its own `passageAabb`.
   *
   * Standing since 2026-08-20 (`doorRender.ts`): the two door swatches are front ELEVATIONS and
   * were being stretched flat over the passage rect on `layers.ground`, so the one fixture the
   * player has to read at a glance was the only thing in the room still painted on the floor.
   * A door now builds as a wall block whose face is an opening, at the tier of the wall it is
   * cut into (`doorFlankTier` over the MERGED runs — merged, so a boundary authored as two
   * parallel rects votes once per side rather than twice), and registers with the occlusion
   * x-ray like any other standing block: the passage floor is entirely inside the fixture's own
   * art, so a character walking through a doorway is behind it by construction.
   *
   * Rebuilt fresh each `build()`; `updateDoors()` is the cheap in-place path for a lock-state
   * flip alone. `doorRects` is index-aligned with `s.dungeonDoors` (built by the caller for
   * `bordersDoorNorth`), reused here rather than converted a second time.
   */
  private buildDoors(
    s: GameState,
    runs: readonly WallRun[],
    doorRects: readonly RectPx[],
    roomsPx: readonly RectPx[],
    skin: { palette: BiomePalette; cap: Texture | undefined; face: Texture | undefined },
    shadows: Graphics,
    element: string,
  ): void {
    this.clearDoors();
    // A door stands at the tier of the wall it interrupts (`doorFlankTier`), or — with nothing
    // abutting the passage at all (a mode with no wall model, a passage authored clear of its own
    // wall) — at whatever tier the passage rect itself would stand at, the same question asked of
    // the same room rects.
    const doorRuns: WallRun[] = doorRects.map((rect) => ({
      rect,
      tier: doorFlankTier(rect, runs) ?? wallTier(rect, roomsPx),
    }));
    // The doors' own joins, computed against the walls AND each other. Deliberately a SECOND
    // `wallJoins` pass rather than one combined list: a door has to know that its cap runs into
    // the flanking runs' caps (else it draws a lit coping and a dark silhouette straight across
    // one continuous stone top, which is the artifact `wallJoins` exists for), but feeding doors
    // back into the WALLS' joins would re-tier cues on every run beside a doorway — including
    // making a deep run `tuckNorth` under a door — and every one of those numbers was measured
    // without doors in that list. Doors see walls; walls see only walls and their own `doorClip`.
    const doorJoins = wallJoins([...runs, ...doorRuns], faceCrownFraction(element)).slice(runs.length);

    for (const [i, dr] of s.dungeonDoors.entries()) {
      const rect = doorRects[i]!;
      const height = wallHeight(doorRuns[i]!.tier);
      const joins = doorJoins[i]!;
      const fixture = buildDoorBlock(rect, height, { ...skin, leaf: getDoorTexture(dr.locked) }, dr.locked, joins);
      drawWallShadow(shadows, rect, height);
      this.layers.entities.addChild(fixture.view);
      this.doorFixtures.push(fixture);
      const sortY = rect.y + rect.h;
      this.occluders.push(
        fadeableBlock(
          {
            left: rect.x,
            right: rect.x + rect.w,
            top: sortY + blockCapTop(rect, height, joins),
            sortY,
            foldY: sortY - height,
          },
          fixture.capLayers,
          fixture.deepLayers,
        ),
      );
    }
  }

  /** Cheap reaction to `door_locked`/`door_unlocked` (DoorSystem) — swap each door's leaf
   *  texture and its hazard bloom in place, no destroy/rebuild of the room. No-op if called
   *  before any `build()` has run for this floor (index mismatch). */
  updateDoors(s: GameState): void {
    if (this.doorFixtures.length !== s.dungeonDoors.length) return;
    for (let i = 0; i < s.dungeonDoors.length; i++) {
      const locked = s.dungeonDoors[i]!.locked;
      this.doorFixtures[i]!.setLocked(locked, getDoorTexture(locked));
    }
  }

  /** Destroy the standing door fixtures — like `wallEntities`, they live on the Y-sorted
   *  `entities` layer, which `build()`/`clear()` never sweep wholesale. */
  private clearDoors(): void {
    for (const d of this.doorFixtures) d.view.destroy();
    this.doorFixtures.length = 0;
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
    for (const c of [...this.layers.ground.children]) c.destroy();
    this.clearDoors();
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
