import { Actor } from './Actor';

// Enemy view — a plain Actor with the enemy palette. All behaviour (aiming, firing
// cadence, HP) lives in the engine now; this is only how a mob looks on screen. An
// optional `tint` overrides the body colour so elemental variants read at a glance
// (design/07/09) — the tint comes from the engine blueprint, render-only.
export class Enemy extends Actor {
  constructor(radiusPx: number, tint?: number, boss = false) {
    super('enemy', radiusPx, tint, boss);
  }
}
