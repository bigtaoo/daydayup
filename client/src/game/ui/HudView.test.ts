import { describe, it, expect, afterEach } from 'vitest';
import type { Container, Text } from 'pixi.js';
import { createGameState } from '@dd/engine/state/GameState';
import type { GameState, EngineConfig } from '@dd/engine/state/GameState';
import { Layers } from '../scene/layers';
import { HudView, type HudContext } from './HudView';
import { setLocale, resetLocaleForTests } from '../../i18n';

// Children are appended in this fixed order in build() — indexing into `view.children`
// is the only way in from the outside (same convention as TouchControlsView.test.ts):
// statsPanel, hpBar, shieldBar, weaponText, cdBar, infoText, floorProgress, allyText,
// toasts, groundCard, groundHint. (The checkpoint banner that used to live here moved
// to PortalPrompt.ts, design/10 legibility fix 2026-08-02 — see PortalPrompt.test.ts.)
const enum Child { WeaponText = 3, InfoText = 5, AllyText = 7 }

function weaponTextOf(hud: HudView): Text {
  return hud.view.children[Child.WeaponText] as Text;
}
function infoTextOf(hud: HudView): Text {
  return hud.view.children[Child.InfoText] as Text;
}
function allyTextOf(hud: HudView): Text {
  return hud.view.children[Child.AllyText] as Text;
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
