import { describe, it, expect, afterEach } from 'vitest';
import type { Container, Text } from 'pixi.js';
import { createGameState } from '@dd/engine/state/GameState';
import type { GameState, EngineConfig } from '@dd/engine/state/GameState';
import type { ArenaMap } from '@dd/engine/content/arenas';
import { Layers } from './layers';
import { HudView, type HudContext } from './HudView';
import { setLocale, resetLocaleForTests } from '../i18n';

// Children are appended in this fixed order in build() — indexing into `view.children`
// is the only way in from the outside (same convention as TouchControlsView.test.ts):
// statsPanel, hpBar, shieldBar, weaponText, cdBar, infoText, floorProgress, allyText,
// toasts, groundCard, groundHint, checkpointPanel, checkpointText.
const enum Child { WeaponText = 3, InfoText = 5, AllyText = 7, CheckpointPanel = 11, CheckpointText = 12 }

function weaponTextOf(hud: HudView): Text {
  return hud.view.children[Child.WeaponText] as Text;
}
function infoTextOf(hud: HudView): Text {
  return hud.view.children[Child.InfoText] as Text;
}
function allyTextOf(hud: HudView): Text {
  return hud.view.children[Child.AllyText] as Text;
}
function checkpointPanelOf(hud: HudView): Container {
  return hud.view.children[Child.CheckpointPanel] as Container;
}
function checkpointTextOf(hud: HudView): Text {
  return hud.view.children[Child.CheckpointText] as Text;
}

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

const MINI_ARENA: ArenaMap = {
  id: 'hud_test_arena',
  sizeGrid: { w: 10, h: 10 },
  rooms: [{ id: 'A', rectGrid: { x: 0, y: 0, w: 10, h: 10 }, solids: [] }],
  doors: [],
  spawns: [{ x: 5, y: 5 }],
  eyeCandidates: [{ roomId: 'A' }],
};

function pvpState(): GameState {
  return createGameState({ seed: 1, worldW: 0, worldH: 0, waves: [], arena: MINI_ARENA });
}

describe('HudView — checkpoint banner (design/10 legibility fix, 2026-08-01)', () => {
  it('is hidden mid-floor (before waves are exhausted)', () => {
    const hud = newHud();
    const s = pveState();
    hud.update(s, 16, CTX);
    expect(checkpointPanelOf(hud).visible).toBe(false);
    expect(checkpointTextOf(hud).visible).toBe(false);
  });

  it('shows plain-language HOLD/TAP copy with the real pending count and next floor number', () => {
    const hud = newHud();
    const s = pveState();
    s.floorIndex = 0; // floor 1 of 3 — not the last floor
    s.wavesExhausted = true;
    s.enemies.length = 0;
    s.floorMaterials = { mat_fire: 5, mat_ice: 2 }; // pending = 7

    hud.update(s, 16, CTX);

    expect(checkpointPanelOf(hud).visible).toBe(true);
    expect(checkpointTextOf(hud).visible).toBe(true);
    const text = checkpointTextOf(hud).text;
    expect(text).toContain('FLOOR CLEARED');
    expect(text).toContain('HOLD [E]');
    expect(text).toContain('bank 7 materials');
    expect(text).toContain('TAP [E]');
    expect(text).toContain('Floor 2');
  });

  it('stays hidden on the last floor even at a checkpoint (that floor auto-extracts instead)', () => {
    const hud = newHud();
    const s = pveState();
    s.floorIndex = 2; // floor 3 of 3 — the last floor
    s.wavesExhausted = true;
    s.enemies.length = 0;

    hud.update(s, 16, CTX);

    expect(checkpointPanelOf(hud).visible).toBe(false);
  });

  it('stays hidden once the run has already ended (phase gameover)', () => {
    const hud = newHud();
    const s = pveState();
    s.floorIndex = 0;
    s.wavesExhausted = true;
    s.enemies.length = 0;
    s.phase = 'gameover';

    hud.update(s, 16, CTX);

    expect(checkpointPanelOf(hud).visible).toBe(false);
  });

  it('never shows in the PvP arena, regardless of wavesExhausted (that flag has no PvE meaning there)', () => {
    const hud = newHud();
    const s = pvpState();
    s.wavesExhausted = true;
    s.enemies.length = 0;

    hud.update(s, 16, CTX);

    expect(checkpointPanelOf(hud).visible).toBe(false);
    expect(checkpointTextOf(hud).visible).toBe(false);
  });

  it('hides again the frame after enemies respawn / waves reset (descend happened)', () => {
    const hud = newHud();
    const s = pveState();
    s.floorIndex = 0;
    s.wavesExhausted = true;
    s.enemies.length = 0;
    hud.update(s, 16, CTX);
    expect(checkpointPanelOf(hud).visible).toBe(true);

    s.wavesExhausted = false;
    hud.update(s, 16, CTX);
    expect(checkpointPanelOf(hud).visible).toBe(false);
  });
});

describe('HudView — stat cluster backing panel', () => {
  it('widens to fit a long info line instead of clipping or leaving it unbacked', () => {
    const hud = newHud();
    const s = pveState();
    const statsPanel = hud.view.children[0] as Container;

    hud.update(s, 16, CTX);
    const narrowWidth = statsPanel.width;

    // A long skin name forces a much longer infoText line than the default.
    hud.update(s, 16, { ...CTX, selectedSkin: 'a-very-long-character-skin-name-indeed' });
    const widerWidth = statsPanel.width;

    expect(widerWidth).toBeGreaterThan(narrowWidth);
  });
});

describe('HudView — i18n (design/17-i18n.md)', () => {
  it('translates the checkpoint banner under zh, interpolated values intact', () => {
    setLocale('zh');
    const hud = newHud();
    const s = pveState();
    s.floorIndex = 0;
    s.wavesExhausted = true;
    s.enemies.length = 0;
    s.floorMaterials = { mat_fire: 5, mat_ice: 2 }; // pending = 7

    hud.update(s, 16, CTX);

    const text = checkpointTextOf(hud).text;
    expect(text).toContain('楼层已清空');
    expect(text).toContain('7');
    expect(text).toContain('长按 [E]');
    expect(text).toContain('第 2 层');
  });

  it('translates the weapon and PvE info lines under zh', () => {
    setLocale('zh');
    const hud = newHud();
    const s = pveState();
    hud.update(s, 16, CTX);
    expect(weaponTextOf(hud).text).toContain('伤害'); // the starter weapon's own translated dmg label
    expect(infoTextOf(hud).text).toContain('楼层');
    expect(infoTextOf(hud).text).toContain('敌人');
  });

  it('translates the no-weapon fallback line under zh', () => {
    setLocale('zh');
    const hud = newHud();
    const s = pveState();
    s.players[0]!.weapon = null;
    hud.update(s, 16, CTX);
    expect(weaponTextOf(hud).text).toBe('武器：无');
  });

  it('translates the ally line under zh, including the downed/HP branch', () => {
    setLocale('zh');
    const hud = newHud();
    const s = createGameState({ ...PVE_CFG, players: [{}, {}] }); // a 2nd seat, ROADMAP 3.1
    hud.update(s, 16, { ...CTX, showAlly: true, allySkinId: 'juggernaut' });
    expect(allyTextOf(hud).text).toContain('队友（juggernaut）');
    expect(allyTextOf(hud).text).toMatch(/生命 \d+\/\d+/);
  });

  it('switching back to English on a later update() fully reverts', () => {
    const hud = newHud();
    const s = pveState();
    s.players[0]!.weapon = null;
    setLocale('zh');
    hud.update(s, 16, CTX);
    expect(weaponTextOf(hud).text).toBe('武器：无');
    setLocale('en');
    hud.update(s, 16, CTX);
    expect(weaponTextOf(hud).text).toBe('Weapon: none');
  });
});
