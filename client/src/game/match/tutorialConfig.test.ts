/**
 * tutorialConfig (design/10 screen-flow gap — the standalone tutorial level). Pure data
 * + a determinism check: same seed → byte-identical sim state, the same guarantee every
 * other fixed-seed config in this repo relies on (design/06/08).
 */
import { describe, it, expect } from 'vitest';
import { createGameEngine, hashState } from '@dd/engine';
import { makeCommand } from '@dd/engine/state/input';
import type { Brad } from '@dd/engine/math/trig';
import { buildTutorialConfig } from './tutorialConfig';

const idle = (tick: number) =>
  makeCommand({ owner: 0, tick, moveBrad: 0 as Brad, moveMag: 0, buttons: 0 });

describe('buildTutorialConfig', () => {
  it('is a flat, 2-floor config (floor 0 not last, floor 1 the last floor)', () => {
    const eng = createGameEngine(buildTutorialConfig({ skinId: 'vanguard' }));
    expect(eng.state.dungeonEnabled).toBe(false);
    expect(eng.state.floorsEnabled).toBe(true);
    expect(eng.state.extraFloors.length).toBe(1); // 1 extra floor beyond floor 0 → 2 total
  });

  it('carries the fixed 2-weapon loadout: one ranged, one melee (swap has something real to switch to)', () => {
    const eng = createGameEngine(buildTutorialConfig({ skinId: 'skirmisher' }));
    const p = eng.state.players[0]!;
    expect(p.weapons.map((w) => w.spec.kind)).toEqual(['ranged', 'melee']);
  });

  it('is fully deterministic: two engines from the same config stay byte-identical over many idle ticks', () => {
    const cfg = buildTutorialConfig({ skinId: 'vanguard' });
    const a = createGameEngine(buildTutorialConfig({ skinId: 'vanguard' }));
    const b = createGameEngine(cfg);
    for (let t = 1; t <= 60; t++) {
      a.step([idle(t)]);
      b.step([idle(t)]);
    }
    expect(hashState(a.state)).toBe(hashState(b.state));
  });
});
