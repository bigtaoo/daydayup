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
import { fpToPx, bradToRad } from './coords';

export class Scene {
  private views = new Map<number, Entity>();
  private playerView: Actor | null = null;

  constructor(private readonly layers: Layers) {}

  /** The player's view, for the camera to follow (null before spawn / after death). */
  get player(): Actor | null {
    return this.playerView;
  }

  /** Drop every view — called on a fresh run before a new engine is created. */
  clear(): void {
    for (const v of this.views.values()) v.destroy();
    this.views.clear();
    this.playerView = null;
  }

  reconcile(state: GameState): void {
    const seen = new Set<number>();

    for (const p of state.players) {
      if (!p.alive) continue;
      let v = this.views.get(p.id) as Actor | undefined;
      if (!v) {
        v = new Actor('player', fpToPx(p.radius));
        this.spawn(p.id, v, fpToPx(p.gx), fpToPx(p.gy), fpToPx(p.z), bradToRad(p.facing));
        this.playerView = v;
      } else {
        v.pushState(fpToPx(p.gx), fpToPx(p.gy), fpToPx(p.z), bradToRad(p.facing));
      }
      v.setWeaponKind(p.weapon?.spec.kind ?? null);
      seen.add(p.id);
    }

    for (const e of state.enemies) {
      if (!e.alive) continue;
      let v = this.views.get(e.id) as Enemy | undefined;
      if (!v) {
        v = new Enemy(fpToPx(e.radius), e.tint);
        this.spawn(e.id, v, fpToPx(e.gx), fpToPx(e.gy), fpToPx(e.z), bradToRad(e.facing));
      } else {
        v.pushState(fpToPx(e.gx), fpToPx(e.gy), fpToPx(e.z), bradToRad(e.facing));
      }
      v.setWeaponKind(e.weapon?.spec.kind ?? null);
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
      seen.add(b.id);
    }

    for (const it of state.pickups) {
      if (!it.alive) continue;
      let v = this.views.get(it.id) as Pickup | undefined;
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
      v.destroy();
      this.views.delete(id);
      if (v === this.playerView) this.playerView = null;
    }
  }

  interpolate(alpha: number, frameDt: number): void {
    for (const v of this.views.values()) v.interpolate(alpha, frameDt);
  }

  private spawn(id: number, v: Entity, x: number, y: number, z: number, facingRad: number): void {
    this.views.set(id, v);
    this.layers.entities.addChild(v);
    if (v.shadow) this.layers.shadow.addChild(v.shadow);
    v.pushState(x, y, z, facingRad);
    v.snap(); // appear at spawn, don't lerp in from (0,0)
  }
}
