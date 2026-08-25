// Scene — the read-only view mirror of the engine's authoritative state. Each sim
// tick, reconcile() diffs the engine's entity arrays against the live views by
// stable id: new ids spawn a view (snapped in place), surviving ids get a fresh
// position pushed (for interpolation), and ids that vanished (compacted out, dead)
// have their views removed. Nothing here decides gameplay — it only draws what the
// engine already computed (design/08 "render/server only read").
import type { GameState } from '@dd/engine';
import type { Layers } from './layers';
import { Entity } from './Entity';
import { Actor } from './Actor';
import { Enemy } from './Enemy';
import { Bullet } from './Bullet';
import { Pickup } from './Pickup';
import { fpToPx, bradToRad } from '../coords';
import { turnToward, BODY_TURN_PER_TICK } from '../../render/facing';

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
  // Same pattern for `enemies` below: it runs at RENDER rate (GameLoop.updateFx, every
  // frame, not just once a sim tick), so a fresh array every call is needless churn in
  // a room with any real number of mobs. Cleared and refilled each call, never read
  // across calls, and never returned by reference to anything that outlives the call.
  private readonly enemiesScratch: Actor[] = [];

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

  /** Every currently live enemy view, for a render pass that must consider every mob rather
   *  than just the local player — the occlusion x-ray (`GameLoop.updateFx`) is the reason this
   *  exists: a wall block used to fade only against `player`, so a monster standing in the same
   *  hidden band got no x-ray at all. A dying (dissolving) enemy is excluded, same as `views`
   *  itself — it's already fading out, not something the x-ray needs to keep legible. Order is
   *  whatever the underlying Map iterates in, not meaningful. */
  get enemies(): readonly Actor[] {
    this.enemiesScratch.length = 0;
    for (const v of this.views.values()) if (v instanceof Enemy) this.enemiesScratch.push(v);
    return this.enemiesScratch;
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
      // The body turns to face the AIM, rate-limited (render/facing.ts — see its header
      // for why this is the aim and not the movement vector: the orb-core is an eye, and
      // an eye looks at what it is shooting). A fresh spawn has no previous angle to turn
      // from, so it starts already facing its aim.
      const bodyFacingRad = v ? turnToward(v.bodyFacingRad, aimRad, BODY_TURN_PER_TICK) : aimRad;
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
        v = new Enemy(fpToPx(e.radius), e.tint, e.boss, e.bodyRig, e.element);
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
        const bx = fpToPx(b.gx);
        const by = fpToPx(b.gy);
        const bz = fpToPx(b.z);
        this.spawn(b.id, v, bx, by, bz, 0);
        // Draw the shot leaving the shooter's actual barrel tip: the engine's spawn
        // point (`RangedSimSpec.muzzleOffset` along the aim ray on the ground plane,
        // lifted by `bulletZ`) is not where the rig draws the gun, so bullets read as
        // coming out of the body rather than the muzzle (user report, 2026-08-17: "子弹
        // 要从枪口打出"). `Bullet.setMuzzleOrigin` eases the difference out over its first
        // few ticks — see there for the geometry and for why this is corrected on the
        // view instead of by moving the sim's own muzzle (which stays authoritative for
        // hit detection, and which a player standing flush against a wall could
        // otherwise push through to the far side).
        //
        // `muzzlePos()` is null for anything with no rig-mounted module — a rig whose
        // `weaponMount` is 'none' (the boss), a skin still on the Graphics placeholder, and
        // the frames before a weapon texture finishes preloading. Those leave the bullet
        // exactly where the engine put it, as before. Enemies used to be in that list too,
        // for the wrong reason (they never mounted a module at all, see `Skin.weaponMount`);
        // since 2026-08-21 they mount one, so a mob's shots get the same barrel-tip spawn
        // correction the hero's have had since 2026-08-17.
        const muzzle = b.ownerId === undefined ? null : this.actorAt(b.ownerId)?.muzzlePos();
        if (muzzle) v.setMuzzleOrigin(muzzle.x - bx, muzzle.y - (by - bz));
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
        v = new Pickup(it.kind, it.weaponId, it.id);
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

  /**
   * Override the LOCAL player's view with a predicted pose (ROADMAP 3.3 follow-up, online
   * prediction). Call AFTER reconcile() and BEFORE interpolate(): it snaps the local view
   * onto the predicted (px, radians) position so the sprite — and the camera that follows
   * it — show the render-ahead prediction, while every remote view keeps its confirmed
   * reconcile+interpolate. No-op before the local view exists. Never touches the sim.
   *
   * `moving` is `LocalPredictor.pose.moving` — the snap just below collapses prev onto
   * cur, so `Actor.interpolate`'s own curX/prevX-delta heuristic can't tell idle from
   * moving here the way it does for every confirmed (non-predicted) entity; this is the
   * explicit substitute (`Entity.movingOverride`), fixing what was otherwise a local
   * player whose walk animation never played under prediction.
   */
  positionLocal(x: number, y: number, z: number, facingRad: number, moving = false): void {
    if (!this.playerView) return;
    // Body facing is deliberately NOT taken from the caller (it used to be
    // `LocalPredictor.pose.bodyFacing`, the predicted movement direction): since
    // 2026-08-18 the body turns toward the AIM, and `reconcile` above already advanced it
    // one rate-limited step this tick. Re-deriving it here — at render rate, from movement
    // — would both double the turn speed and reintroduce the movement-driven facing this
    // change removed. Carry the value the view already holds.
    this.playerView.pushState(x, y, z, facingRad, this.playerView.bodyFacingRad);
    this.playerView.snap(); // prev == cur → no lerp; interpolate() draws it exactly here
    this.playerView.movingOverride = moving;
  }

  private spawn(id: number, v: Entity, x: number, y: number, z: number, facingRad: number, bodyFacingRad: number = facingRad): void {
    this.views.set(id, v);
    this.layers.entities.addChild(v);
    if (v.shadow) this.layers.shadow.addChild(v.shadow);
    // An Actor's health bar owns itself but isn't a child (Actor.ts's constructor doc) — it
    // rides `layers.hud`, always in front of every wall/pillar/door regardless of Y-sort or
    // the occlusion x-ray's fade state (design/01, live report *"血条被墙挡住了"*).
    if (v instanceof Actor && v.healthBar) this.layers.hud.addChild(v.healthBar);
    v.pushState(x, y, z, facingRad, bodyFacingRad);
    v.snap(); // appear at spawn, don't lerp in from (0,0)
  }
}
