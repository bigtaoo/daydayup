import { Graphics, Sprite, Texture, TilingSprite } from 'pixi.js';
import type { GameState } from '@dd/engine';
import type { Layers } from './layers';
import { Entity } from './Entity';
import { biomePalette, biomeElementOf, type BiomePalette } from '../theme';
import { fpToPx } from '../coords';
import { getFloorTexture, getWallTexture } from '../../render/biomeTiles';
import { getDoorTexture } from '../../render/environmentSprites';
import type { Backdrop } from './Backdrop';
import { Portal } from './Portal';

/**
 * Render-side mirror of the engine's dungeon/arena room geometry (design/08 "render
 * only reads") — ground/grid, AABB walls, and the round Y-sortable pillars. Extracted
 * out of Game.ts 2026-07-28 alongside EventReactor: owns the pillar Entity list itself
 * so Game only calls `build()` (on `room_enter`, or once for the `?arenaDemo=1` harness)
 * and `clear()` (on a fresh run).
 */
export class RoomBuilder {
  private readonly pillars: Entity[] = [];
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

    // Grid overlay — always drawn (readability aid, independent of ground art).
    const grid = new Graphics();
    const step = 64;
    for (let x = 0; x <= w; x += step) grid.moveTo(x, 0).lineTo(x, h);
    for (let y = 0; y <= h; y += step) grid.moveTo(0, y).lineTo(w, y);
    grid.stroke({ color: palette.gridLine, width: 1 });
    this.layers.ground.addChild(grid);

    // AABB walls (ROADMAP 1.2 — finally drawn): a tiled swatch + outline once wall art
    // exists for this element, else the same flat fill + outline as before. A
    // currently-locked door's passage rect lives in `s.walls` too (DoorSystem folds it
    // in while locked) but must render as a door fixture, not a generic wall segment —
    // `doorAabbs` is a reference-identity set (DoorSystem pushes the SAME `passageAabb`
    // object, never a copy) so this skip is exact and free for non-dungeon modes
    // (`dungeonDoors` is empty there).
    const doorAabbs = new Set(s.dungeonDoors.map((dr) => dr.passageAabb));
    for (const wall of s.walls) {
      if (doorAabbs.has(wall)) continue;
      const wx = fpToPx(wall.x);
      const wy = fpToPx(wall.y);
      const ww = fpToPx(wall.w);
      const wh = fpToPx(wall.h);
      if (wallTex) {
        const wallSprite = new TilingSprite({ texture: wallTex, width: ww, height: wh });
        wallSprite.position.set(wx, wy);
        this.layers.ground.addChild(wallSprite);
        const edge = new Graphics();
        edge.rect(wx, wy, ww, wh).stroke({ color: palette.wallEdge, width: 2 });
        this.layers.ground.addChild(edge);
      } else {
        const wallG = new Graphics();
        wallG.rect(wx, wy, ww, wh).fill({ color: palette.wall }).stroke({ color: palette.wallEdge, width: 2 });
        this.layers.ground.addChild(wallG);
      }
    }

    this.buildPillars(s, palette);
    this.buildDoors(s);
    this.buildPortal(w, h);
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

  /** One portal per room, centered — hidden until `setPortalOpen(true)` (Game, gated
   *  on the same checkpoint condition PortalPrompt uses). Rebuilt (not just repositioned)
   *  per room so a stale reference never survives a room swap. */
  private buildPortal(w: number, h: number): void {
    this.portal?.shadow?.destroy();
    this.portal?.destroy();
    const portal = new Portal();
    this.layers.entities.addChild(portal);
    this.layers.shadow.addChild(portal.shadow!);
    portal.place(w / 2, h / 2);
    this.portal = portal;
    this.portalPx = { x: w / 2, y: h / 2 };
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
      const height = 70;
      const p = new Entity();
      const body = new Graphics();
      body.roundRect(-bodyW / 2, -height, bodyW, height + 10, 6).fill({ color: palette.pillar });
      // Cheap faux-volumetric shading (design/10 legibility fix, 2026-08-02): the flat
      // single-colour fill above read as a placeholder cylinder next to the textured
      // floor/walls — a lit-from-upper-left highlight band + an opposite shadow band,
      // plus a dark rim stroke, fake enough depth without needing new pillar art.
      body.roundRect(-bodyW / 2, -height, bodyW * 0.32, height + 10, 6).fill({ color: 0xffffff, alpha: 0.1 });
      body.roundRect(bodyW * 0.18, -height, bodyW * 0.32, height + 10, 6).fill({ color: 0x000000, alpha: 0.22 });
      body.roundRect(-bodyW / 2, -height, bodyW, height + 10, 6).stroke({ color: 0x000000, alpha: 0.35, width: 2 });
      body.ellipse(0, -height, bodyW / 2 + 2, 12).fill({ color: palette.pillarTop });
      body.ellipse(0, -height, bodyW / 2 + 2, 12).stroke({ color: 0xffffff, alpha: 0.25, width: 1.5 });
      p.addChild(body);
      p.makeShadow(rad + 12);
      this.layers.entities.addChild(p);
      this.layers.shadow.addChild(p.shadow!);
      this.pillars.push(p);
      p.place(fpToPx(o.gx), fpToPx(o.gy));
    }
  }

  /** Tear down the current room's ground + pillars (beginRun) so a restart doesn't
   *  leak the previous run's geometry. */
  clear(): void {
    for (const c of [...this.layers.ground.children]) c.destroy(); // also destroys door sprites (ground children)
    this.doorSprites.length = 0;
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
