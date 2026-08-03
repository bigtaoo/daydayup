import { describe, it, expect, afterEach } from 'vitest';
import type { Container } from 'pixi.js';
import { createGameState } from '@dd/engine/state/GameState';
import type { GameState, EngineConfig } from '@dd/engine/state/GameState';
import { Layers } from '../scene/layers';
import { HudView, type HudContext } from './HudView';
import { StatChip } from './StatChip';
import { setLocale, resetLocaleForTests } from '../../i18n';

afterEach(() => resetLocaleForTests());

function newHud(): HudView {
  const hud = new HudView();
  hud.build(new Layers(), { w: 1280, h: 720 });
  return hud;
}

const CTX: HudContext = {
  localOwner: 0,
  score: 0,
  selectedSkin: 'skirmisher',
  showAlly: false,
  allySkinId: '',
};

const PVE_CFG: EngineConfig = { seed: 1, worldW: 800, worldH: 600, waves: [] };

function pveState(): GameState {
  return createGameState(PVE_CFG);
}

/** `createGameState` only sets `zoneEnabled` when `EngineConfig.arena` is provided
 *  (same minimal-arena helper shape engine/systems/revive.test.ts uses). */
function pvpState(): GameState {
  return createGameState({
    ...PVE_CFG,
    players: [{}, {}],
    arena: {
      id: 'mini',
      sizeGrid: { w: 10, h: 10 },
      rooms: [{ id: 'A', rectGrid: { x: 0, y: 0, w: 10, h: 10 }, solids: [] }],
      doors: [],
      spawns: [{ x: 5, y: 5 }],
      eyeCandidates: [{ roomId: 'A' }],
    },
  });
}

/** statsPanel is the first child added in build() — the only widget with no public
 *  handle, since nothing but this test ever needs to look at it. */
function statsPanelOf(hud: HudView): Container {
  return hud.view.children[0] as Container;
}

describe('HudView — stat cluster backing panel', () => {
  it('widens to fit a long character name instead of clipping or leaving it unbacked', () => {
    const hud = newHud();
    const s = pveState();

    hud.update(s, 16, CTX);
    const narrowWidth = statsPanelOf(hud).width;

    hud.update(s, 16, { ...CTX, selectedSkin: 'a-very-long-character-skin-name-indeed' });

    expect(statsPanelOf(hud).width).toBeGreaterThan(narrowWidth);
  });

  it('grows taller when the co-op ally row is shown', () => {
    const hud = newHud();
    const s = createGameState({ ...PVE_CFG, players: [{}, {}] }); // a 2nd seat, ROADMAP 3.1

    hud.update(s, 16, CTX);
    const soloHeight = statsPanelOf(hud).height;

    hud.update(s, 16, { ...CTX, showAlly: true, allySkinId: 'juggernaut' });

    expect(statsPanelOf(hud).height).toBeGreaterThan(soloHeight);
  });
});

describe('HudView — stat chips (design/10, replaced the monospace info line)', () => {
  it('shows the dungeon chips and hides the PvP-only ones', () => {
    const hud = newHud();
    hud.update(pveState(), 16, CTX);

    expect(hud.chips.get('floor')!.view.visible).toBe(true);
    expect(hud.chips.get('room')!.view.visible).toBe(true);
    expect(hud.chips.get('enemies')!.view.visible).toBe(true);
    expect(hud.chips.get('banked')!.view.visible).toBe(true);
    expect(hud.chips.get('score')!.view.visible).toBe(true);
    expect(hud.chips.get('stage')!.view.visible).toBe(false);
    expect(hud.chips.get('alive')!.view.visible).toBe(false);
  });

  it('swaps to the PvP chip set once the arena zone is enabled', () => {
    const hud = newHud();
    const s = pvpState();
    expect(s.zoneEnabled).toBe(true);

    hud.update(s, 16, CTX);

    expect(hud.chips.get('stage')!.view.visible).toBe(true);
    expect(hud.chips.get('alive')!.valueText).toBe('2/2');
    expect(hud.chips.get('floor')!.view.visible).toBe(false);
    expect(hud.chips.get('enemies')!.view.visible).toBe(false);
  });

  it('drops the buffs chip out of the row while the run has none', () => {
    const hud = newHud();
    const s = pveState();

    hud.update(s, 16, CTX);
    expect(hud.chips.get('buffs')!.view.visible).toBe(false);

    s.players[0]!.buffs.push({ kind: 'damage', magnitude: 1, ticksLeft: 100 } as never);
    hud.update(s, 16, CTX);
    expect(hud.chips.get('buffs')!.view.visible).toBe(true);
    expect(hud.chips.get('buffs')!.valueText).toBe('1');
  });

  it('lays the visible chips out left to right without overlapping', () => {
    const hud = newHud();
    hud.update(pveState(), 16, CTX);

    const row = [...hud.chips.values()].filter((c) => c.view.visible).sort((a, b) => a.view.x - b.view.x);
    expect(row.length).toBeGreaterThan(1);
    for (let i = 1; i < row.length; i++) {
      expect(row[i]!.view.x).toBeGreaterThanOrEqual(row[i - 1]!.view.x + row[i - 1]!.width);
    }
    // All on one row.
    expect(new Set(row.map((c) => c.view.y)).size).toBe(1);
  });

  it('reports the floor and room the state is actually on', () => {
    const hud = newHud();
    const s = pveState();
    s.floorIndex = 1;
    s.roomIndex = 2;
    s.floorStages = ['combat', 'combat', 'combat', 'boss'] as never;

    hud.update(s, 16, CTX);

    expect(hud.chips.get('floor')!.valueText).toBe('2/3');
    expect(hud.chips.get('room')!.valueText).toBe('3/4');
  });

  // design/10 screen-flow gap: the floor chip used to hardcode EMBER_DUNGEON.floorCount
  // regardless of the run's actual config — harmless while the ember dungeon was the
  // only floored content, wrong for a flat (non-dungeon) floors config like the
  // tutorial level (ROADMAP totalFloorCount fix, floorCount.ts).
  it('reports a flat (non-dungeon) floors config\'s own floor count, not the ember-dungeon default', () => {
    const hud = newHud();
    const s = createGameState({ ...PVE_CFG, floors: [[[[100, 100]]]] }); // 1 extra floor → 2 total
    expect(s.dungeonEnabled).toBe(false);

    hud.update(s, 16, CTX);

    expect(hud.chips.get('floor')!.valueText).toBe('1/2');
  });
});

describe('HudView — weapon card', () => {
  it('names the equipped weapon and its damage badge', () => {
    const hud = newHud();
    const s = pveState();
    const spec = s.players[0]!.weapon!.spec;

    hud.update(s, 16, CTX);

    expect(hud.weaponCard.nameText).toBe(spec.name);
    expect(hud.weaponCard.damageText).toContain(String(spec.damage));
    expect(hud.weaponCard.subText).toContain(spec.damageType);
  });

  it('falls back to an unarmed card with no damage badge', () => {
    const hud = newHud();
    const s = pveState();
    s.players[0]!.weapon = null;

    hud.update(s, 16, CTX);

    expect(hud.weaponCard.nameText).toBe('NO WEAPON');
    expect(hud.weaponCard.damageText).toBe('');
  });
});

describe('HudView — player card', () => {
  it('titles the card with the selected character', () => {
    const hud = newHud();
    hud.update(pveState(), 16, CTX);
    expect(hud.playerCard.displayName).toBe('SKIRMISHER');
  });
});

describe('HudView — ground compare card placement (design/03:125)', () => {
  // Regression: the card used to sit at a hardcoded x=220, chosen when the HUD panel
  // was a fixed 220 wide. The rebuilt panel is wider (and varies with the locale and
  // the character name), so a fixed offset put the card straight on top of it.
  it('sits clear of the backing panel, not on top of it', () => {
    const hud = newHud();
    hud.update(pveState(), 16, CTX);
    expect(hud.groundCard.view.x).toBeGreaterThan(statsPanelOf(hud).width);
  });

  it('slides right when the panel grows', () => {
    const hud = newHud();
    const s = pveState();

    hud.update(s, 16, CTX);
    const near = hud.groundCard.view.x;

    hud.update(s, 16, { ...CTX, selectedSkin: 'a-very-long-character-skin-name-indeed' });

    expect(hud.groundCard.view.x).toBeGreaterThan(near);
    expect(hud.groundCard.view.x).toBeGreaterThan(statsPanelOf(hud).width);
  });

  it('stays hidden while no floor weapon is in reach', () => {
    const hud = newHud();
    hud.update(pveState(), 16, CTX);
    expect(hud.groundCard.view.visible).toBe(false);
  });
});

describe('HudView — mode-dependent widgets', () => {
  it('hides the PvE floor track in a PvP arena (the room-graph Minimap covers it there)', () => {
    const hud = newHud();
    hud.update(pvpState(), 16, CTX);
    expect(hud.floorProgress.view.visible).toBe(false);
  });

  it('shows the PvE floor track outside an arena', () => {
    const hud = newHud();
    const s = pveState();
    s.floorStages = ['combat', 'combat', 'boss'] as never;

    hud.update(s, 16, CTX);

    expect(hud.floorProgress.view.visible).toBe(true);
  });

  it('hides the floor track for a flat (non-dungeon) config with no stages', () => {
    const hud = newHud();
    const s = pveState();
    s.floorStages = [] as never;

    hud.update(s, 16, CTX);

    expect(hud.floorProgress.view.visible).toBe(false);
  });

  it('survives a viewport resize (reposition is called on every relayout)', () => {
    const hud = newHud();
    hud.update(pveState(), 16, CTX);
    expect(() => hud.reposition({ w: 480, h: 900 })).not.toThrow();
    expect(() => hud.update(pveState(), 16, CTX)).not.toThrow();
  });

  it('accepts a toast without a live run behind it', () => {
    const hud = newHud();
    expect(() => hud.toast('+1 ember', 0xffffff)).not.toThrow();
    hud.update(pveState(), 16, CTX);
  });
});

describe('HudView — degenerate states', () => {
  it('does not throw when the local seat index has no player (post-death frame)', () => {
    const hud = newHud();
    const s = pveState();
    expect(() => hud.update(s, 16, { ...CTX, localOwner: 99 })).not.toThrow();
  });

  it('hides the ally row when showAlly is set but there is no second seat', () => {
    const hud = newHud();
    hud.update(pveState(), 16, { ...CTX, showAlly: true, allySkinId: 'juggernaut' });
    expect(hud.allyRow.view.visible).toBe(false);
  });

  it('re-runs cleanly for many frames (the per-frame path is cached, not rebuilt)', () => {
    const hud = newHud();
    const s = pveState();
    for (let i = 0; i < 200; i++) hud.update(s, 16, { ...CTX, score: 0 });
    expect(hud.chips.get('score')!.valueText).toBe('0');
    expect(hud.playerCard.displayName).toBe('SKIRMISHER');
  });
});

describe('HudView — i18n (design/17-i18n.md)', () => {
  it('translates the chip labels and the weapon subtitle under zh', () => {
    setLocale('zh');
    const hud = newHud();

    hud.update(pveState(), 16, CTX);

    expect(hud.chips.get('floor')!.labelText).toBe('楼层');
    expect(hud.chips.get('enemies')!.labelText).toBe('敌人');
    expect(hud.weaponCard.subText).toContain('普通'); // the starter weapon's rarity
    expect(hud.weaponCard.subText).toContain('远程');
    expect(hud.weaponCard.damageText).toContain('伤害');
  });

  it('translates the no-weapon fallback under zh', () => {
    setLocale('zh');
    const hud = newHud();
    const s = pveState();
    s.players[0]!.weapon = null;

    hud.update(s, 16, CTX);

    expect(hud.weaponCard.nameText).toBe('无武器');
  });

  it('translates the ally row, including the downed branch', () => {
    setLocale('zh');
    const hud = newHud();
    const s = createGameState({ ...PVE_CFG, players: [{}, {}] });
    const ally = s.players[1]!;

    hud.update(s, 16, { ...CTX, showAlly: true, allySkinId: 'juggernaut' });
    expect(hud.allyRow.nameText).toBe('队友·juggernaut');
    expect(hud.allyRow.statusText).toBe('');

    ally.downed = true;
    ally.bleedoutTicks = 60;
    hud.update(s, 16, { ...CTX, showAlly: true, allySkinId: 'juggernaut' });
    expect(hud.allyRow.statusText).toBe('倒地 2秒');
  });

  it('switching back to English on a later update() fully reverts', () => {
    const hud = newHud();
    const s = pveState();
    s.players[0]!.weapon = null;

    setLocale('zh');
    hud.update(s, 16, CTX);
    expect(hud.weaponCard.nameText).toBe('无武器');

    setLocale('en');
    hud.update(s, 16, CTX);
    expect(hud.weaponCard.nameText).toBe('NO WEAPON');
    expect(hud.chips.get('floor')!.labelText).toBe('FLOOR');
  });

  it('sizes a chip wider for a double-width CJK label than for its Latin one', () => {
    const latin = new StatChip('score', 0xffffff);
    latin.set('SCORE', '0');
    const cjk = new StatChip('score', 0xffffff);
    cjk.set('分数分数分数', '0');

    expect(cjk.width).toBeGreaterThan(latin.width);
  });
});
