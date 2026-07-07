// Run structure: a fixed sequence of enemy waves. The run is cleared when the
// last wave is defeated. This is the slice's stand-in for step 10-11 (Spawns /
// Win condition) of design/08 — a scripted WaveDirector, pre-determinism.

export interface WaveDef {
  spawns: [number, number][]; // enemy spawn positions in world coords
}

export class WaveDirector {
  private index = -1; // -1 = not started; 0-based into waves
  constructor(private readonly waves: WaveDef[]) {}

  reset() {
    this.index = -1;
  }

  // 1-based number of the wave currently spawned (0 before the run starts).
  get current(): number {
    return this.index + 1;
  }

  get total(): number {
    return this.waves.length;
  }

  // Advance to the next wave and return its spawn spots, or null when the run
  // is complete (no more waves) — the victory signal.
  next(): [number, number][] | null {
    this.index++;
    if (this.index >= this.waves.length) return null;
    return this.waves[this.index].spawns;
  }
}
