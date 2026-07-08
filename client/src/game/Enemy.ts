import { Actor } from './Actor';

// Enemy view — a plain Actor with the enemy palette. All behaviour (aiming, firing
// cadence, HP) lives in the engine now; this is only how a mob looks on screen.
export class Enemy extends Actor {
  constructor(radiusPx: number) {
    super('enemy', radiusPx);
  }
}
