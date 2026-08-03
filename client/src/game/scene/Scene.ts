// Scene — the read-only view mirror of the engine's authoritative state. Each sim
// tick, reconcile() diffs the engine's entity arrays against the live views by
// stable id: new ids spawn a view (snapped in place), surviving ids get a fresh
// position pushed (for interpolation), and ids that vanished (compacted out, dead)
// have their views removed. Nothing here decides gameplay — it only draws what the
// engine already computed (design/08 "render/server only read").
import type { GameState } from '@dd/engine';
import type { Layers } from './layers';
import type { LightRegistry } from '../fx/lighting';
import { Entity } from './Entity';
import { Actor } from './Actor';
import { Enemy } from './Enemy';
import { Bullet } from './Bullet';
import { Pickup } from './Pickup';
import { fpToPx, bradToRad } from '../coords';

export class Scene {
  private views = new Map<number, Entity>();
  private playerView: Actor | null = null;
  // Actors whose id just dropped out of the engine's alive list, still playing their
  // death-dissolve shader (design/01 milestone 5) — kept out of `views` so a same-id
  // respawn (shouldn't happen for players/enemies today, but not this file's contract to
  // assume) can never collide with one still fading out.
  private dying: Actor[] = [];
  // Reused every reconcile() instead of a fresh Set per tick — cleared and refilled
  // each call, never read across ticks.
  private readonly seenScratch = new Set<number>();

  constructor(private readonly layers: Layers) {}

  /** The LOCAL player's view, for the camera to follow (null before spawn / after death). */
  get player(): Actor | null {
    return this.playerView;
  }

  /** The live Actor/Enemy view for an engine entity id, for a render reaction that needs
   *  to target a SPECIFIC actor rather than just a world position (e.g. EventReactor's
   *  hit-flash outline). Undefined for a bullet/pickup id, or one that already died. */
  actorAt(id: number): Actor | undefined {
    const v = this.views.get(id);
    return v instanceof Actor ? v : undefined;
  }

  /** Drop every view — called on a fresh run before a new engine is created. */
  clear(): void {
    for (const v of this.views.values()) v.destroy();
    this.views.clear();
    for (const v of this.dying) v.destroy();
    this.dying = [];
    this.playerView = null;
  }

  // `localPlayerId` is the id of the seat this client controls (co-op, ROADMAP 3.1); the
  // camera follows ITS view, not "whichever player is last in the array". Default -1 (the
  // single-player caller passes the sole player's id, or omits it → the first player wins,
  // matching the old behaviour exactly).
  reconcile(state: GameState, localPlayerId = -1): void {
    const seen = this.seenScratch;
    seen.clear();

    for (const p of state.players) {
      if (!p.alive) continue;
      let v = this.views.get(p.id) as Actor | undefined;
      const aimRad = bradToRad(p.facing);
      // Body/legs face the movement direction, not the aim (upper/lower body split) —
      // held at its last value while idle, same "no snap-to-zero" convention as the
      // aim stick (CommandBuilder.lastAim). A fresh spawn has no last value yet, so it
      // starts facing its aim direction.
      const moving = p.vx !== 0 || p.vy !== 0;
      const bodyFacingRad = moving ? Math.atan2(p.vy, p.vx) : (v?.bodyFacingRad ?? aimRad);
      if (!v) {
        v = new Actor('player', fpToPx(p.radius), undefined, false, p.atlasKey);
        this.spawn(p.id, v, fpToPx(p.gx), fpToPx(p.gy), fpToPx(p.z), aimRad, bodyFacingRad);
      } else {
        v.pushState(fpToPx(p.gx), fpToPx(p.gy), fpToPx(p.z), aimRad, bodyFacingRad);
      }
      // The camera-follow target: the local seat if named, else the first player (the
      // single-player default — playerView is only unset, so the first alive player wins;
      // `this.playerView === v` keeps that choice sticky across later reconciles, which
      // is what the original `playerView === null` test did implicitly).
      const isLocal =
        p.id === localPlayerId ||
        (localPlayerId === -1 && (this.playerView === null || this.playerView === v));
      if (isLocal) this.playerView = v;
      // "Which one is me" cue (design/10 legibility, 2026-08-02) — a teal ground ring +
      // teal health-bar outline on the local seat only. See Actor.setLocal.
      v.setLocal(isLocal);
      v.setWeaponKind(p.weapon?.spec.kind ?? null, p.weapon?.spec.damageType, p.weapon?.spec.name);
      v.setStatus(p.status);
      v.setHealth(p.hp, p.maxHp);
      v.setShield(p.shield, p.maxShield);
      seen.add(p.id);
    }

    for (const e of state.enemies) {
      if (!e.alive) continue;
      let v = this.views.get(e.id) as Enemy | undefined;
      if (!v) {
        v = new Enemy(fpToPx(e.radius), e.tint, e.boss, e.bodyRig);
        this.spawn(e.id, v, fpToPx(e.gx), fpToPx(e.gy), fpToPx(e.z), bradToRad(e.facing));
      } else {
        v.pushState(fpToPx(e.gx), fpToPx(e.gy), fpToPx(e.z), bradToRad(e.facing));
      }
      v.setWeaponKind(e.weapon?.spec.kind ?? null, e.weapon?.spec.damageType, e.weapon?.spec.name);
      v.setStatus(e.status);
      v.setHealth(e.hp, e.maxHp);
      v.setShield(e.shield, e.maxShield);
      seen.add(e.id);
    }

    for (const b of state.projectiles) {
      if (!b.alive) continue;
      let v = this.views.get(b.id) as Bullet | undefined;
      if (!v) {
        v = new Bullet(fpToPx(b.radius));
        this.spawn(b.id, v, fpToPx(b.gx), fpToPx(b.gy), fpToPx(b.z), 0);
      } else {
        v.pushState(fpToPx(b.gx), fpToPx(b.gy), fpToPx(b.z), 0);
      }
      v.setFaction(b.faction);
      v.setElement(b.damageType);
      seen.add(b.id);
    }

    for (const it of state.pickups) {
      if (!it.alive) continue;
      let v = this.views.get(it.id) as Pickup | undefined;
      // A crate's kind changes in place once PickupSystem resolves it (design/15) —
      // same id, so the default "reuse by id" path below would otherwise leave it
      // drawn as an unresolved crate forever. Rebuild the view when kind flips.
      if (v && v.kind !== it.kind) {
        v.destroy();
        this.views.delete(it.id);
        v = undefined;
      }
      if (!v) {
        v = new Pickup(it.kind);
        this.spawn(it.id, v, fpToPx(it.gx), fpToPx(it.gy), 0, 0);
      } else {
        v.pushState(fpToPx(it.gx), fpToPx(it.gy), 0, 0);
      }
      seen.add(it.id);
    }

    for (const [id, v] of this.views) {
      if (seen.has(id)) continue;
      this.views.delete(id);
      if (v === this.playerView) this.playerView = null;
      // A dead player/enemy plays its death-dissolve instead of vanishing outright
      // (design/01 milestone 5) — bullets/pickups have no dissolve and destroy same as
      // ever. `interpolate()` below keeps stepping the dissolve until it finishes.
      if (v instanceof Actor) {
        v.startDissolve();
        this.dying.push(v);
      } else {
        v.destroy();
      }
    }
  }

  interpolate(alpha: number, frameDt: number): void {
    for (const v of this.views.values()) v.interpolate(alpha, frameDt);
    for (let i = this.dying.length - 1; i >= 0; i--) {
      const v = this.dying[i];
      v.interpolate(alpha, frameDt);
      if (v.isDissolved) {
        v.destroy();
        this.dying.splice(i, 1);
      }
    }
  }

  /** Shade every live Actor against this frame's strongest nearby point light (design/01
   *  milestone 2) — call once per render frame, any time after `lights` has this frame's
   *  positions registered (Game.ts registers the local-player glow first). Bullets/
   *  pickups aren't Actors and are skipped; a dying (dissolving) actor is left as it was
   *  lit the instant it died rather than kept updating for an animation already ending. */
  applyLighting(lights: LightRegistry): void {
    for (const v of this.views.values()) {
      if (v instanceof Actor) v.setLighting(lights.strongestAt(v.curX, v.curY));
    }
  }

  /**
   * Override the LOCAL player's view with a predicted pose (ROADMAP 3.3 follow-up, online
   * prediction). Call AFTER reconcile() and BEFORE interpolate(): it snaps the local view
   * onto the predicted (px, radians) position so the sprite — and the camera that follows
   * it — show the render-ahead prediction, while every remote view keeps its confirmed
   * reconcile+interpolate. No-op before the local view exists. Never touches the sim.
   */
  positionLocal(x: number, y: number, z: number, facingRad: number, bodyFacingRad: number = facingRad): void {
    if (!this.playerView) return;
    this.playerView.pushState(x, y, z, facingRad, bodyFacingRad);
    this.playerView.snap(); // prev == cur → no lerp; interpolate() draws it exactly here
  }

  private spawn(id: number, v: Entity, x: number, y: number, z: number, facingRad: number, bodyFacingRad: number = facingRad): void {
    this.views.set(id, v);
    this.layers.entities.addChild(v);
    if (v.shadow) this.layers.shadow.addChild(v.shadow);
    v.pushState(x, y, z, facingRad, bodyFacingRad);
    v.snap(); // appear at spawn, don't lerp in from (0,0)
  }
}
