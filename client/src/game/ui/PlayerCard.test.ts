/**
 * `PlayerCard`/`AllyRow` are the two widgets that answer "who is on this team and how
 * are they doing". Both cache on identity (skin id) while updating on value every
 * frame, so the things worth pinning are: the shield bar's presence tracks the
 * character's actual pool rather than being drawn always-empty, the portrait binding
 * survives a skin with no loaded art (art is best-effort everywhere in this codebase),
 * and the ally row's downed branch actually swaps.
 */
import { describe, it, expect, afterEach } from 'vitest';
import type { Container } from 'pixi.js';
import { PlayerCard, AllyRow } from './PlayerCard';
import { setLocale, resetLocaleForTests } from '../../i18n';

afterEach(() => resetLocaleForTests());

// Constructor child order: frame, fallback, name, hpBar.view, shieldBar.view.
const SHIELD_BAR = 4;

function shieldBarOf(card: PlayerCard): Container {
  return card.view.children[SHIELD_BAR] as Container;
}

describe('PlayerCard — identity', () => {
  it('titles the card with the character\'s translated display name', () => {
    const card = new PlayerCard();
    card.set('juggernaut', 11, 11, 0, 0);
    expect(card.displayName).toBe('Juggernaut');
  });

  it('re-titles when the character changes between runs', () => {
    const card = new PlayerCard();
    card.set('juggernaut', 11, 11, 0, 0);
    card.set('skirmisher', 6, 6, 5, 5);
    expect(card.displayName).toBe('Skirmisher');
  });

  it('survives a skin id with no registered art (portrait is best-effort)', () => {
    const card = new PlayerCard();
    expect(() => card.set('a-skin-that-does-not-exist', 10, 10, 0, 0)).not.toThrow();
    expect(card.displayName).toBe('A-SKIN-THAT-DOES-NOT-EXIST');
  });
});

describe('PlayerCard — the two defensive pools (design/07)', () => {
  it('hides the shield bar for a zero-shield body instead of drawing an empty track', () => {
    const card = new PlayerCard();
    card.set('juggernaut', 11, 11, 0, 0); // juggernaut: flat HP, no shield
    expect(shieldBarOf(card).visible).toBe(false);
  });

  it('shows the shield bar for a character that has a pool', () => {
    const card = new PlayerCard();
    card.set('skirmisher', 6, 6, 5, 5);
    expect(shieldBarOf(card).visible).toBe(true);
  });

  it('follows a character swap in both directions', () => {
    const card = new PlayerCard();
    card.set('skirmisher', 6, 6, 5, 5);
    expect(shieldBarOf(card).visible).toBe(true);
    card.set('juggernaut', 11, 11, 0, 0);
    expect(shieldBarOf(card).visible).toBe(false);
  });

  it('clamps a negative hp (over-kill damage) without throwing', () => {
    const card = new PlayerCard();
    expect(() => card.set('juggernaut', -5, 11, 0, 0)).not.toThrow();
  });

  it('update() advances both bars without throwing, shield present or not', () => {
    const card = new PlayerCard();
    card.set('juggernaut', 11, 11, 0, 0);
    expect(() => card.update(16)).not.toThrow();
    card.set('skirmisher', 6, 6, 5, 5);
    expect(() => card.update(16)).not.toThrow();
  });
});

describe('PlayerCard — layout width', () => {
  it('never reports narrower than the health bar it draws', () => {
    const card = new PlayerCard();
    card.set('x', 10, 10, 0, 0);
    expect(card.estimatedWidth()).toBeGreaterThanOrEqual(150);
  });

  it('grows for a name long enough to overrun the bar', () => {
    const card = new PlayerCard();
    card.set('x', 10, 10, 0, 0);
    const narrow = card.estimatedWidth();
    card.set('a-very-long-character-skin-name-indeed', 10, 10, 0, 0);
    expect(card.estimatedWidth()).toBeGreaterThan(narrow);
  });
});

describe('AllyRow', () => {
  it('names the teammate with their translated character name', () => {
    const row = new AllyRow();
    row.set('vanguard', 8, 10, false, 0);
    expect(row.nameText).toBe('ALLY · Vanguard');
    expect(row.statusText).toBe('');
  });

  it('echoes back an unrecognized skin id raw, rather than falling back to a default character', () => {
    const row = new AllyRow();
    row.set('not-a-real-skin', 8, 10, false, 0);
    expect(row.nameText).toBe('ALLY · not-a-real-skin');
  });

  it('shows the bleedout countdown while downed', () => {
    const row = new AllyRow();
    row.set('vanguard', 0, 10, true, 4);
    expect(row.statusText).toBe('DOWNED 4s');
  });

  it('clears the downed status once revived', () => {
    const row = new AllyRow();
    row.set('vanguard', 0, 10, true, 4);
    row.set('vanguard', 3, 10, false, 0);
    expect(row.statusText).toBe('');
  });

  it('translates both branches under zh', () => {
    setLocale('zh');
    const row = new AllyRow();
    row.set('vanguard', 8, 10, false, 0);
    expect(row.nameText).toBe('队友·先锋');
    row.set('vanguard', 0, 10, true, 2);
    expect(row.statusText).toBe('倒地 2秒');
  });

  it('widens to fit the downed status, which sits right of the bar', () => {
    const row = new AllyRow();
    row.set('vanguard', 8, 10, false, 0);
    const healthy = row.estimatedWidth();
    row.set('vanguard', 0, 10, true, 12);
    expect(row.estimatedWidth()).toBeGreaterThan(healthy);
  });

  it('update() advances the bar without throwing', () => {
    const row = new AllyRow();
    row.set('vanguard', 8, 10, false, 0);
    expect(() => row.update(16)).not.toThrow();
  });

  it('shows revive progress instead of the frozen bleedout countdown once a channel is active', () => {
    const row = new AllyRow();
    row.set('vanguard', 0, 10, true, 4, 225); // REVIVE_CHANNEL_TICKS is 450 → 50%
    expect(row.statusText).toBe('REVIVING 50%');
  });

  it('falls back to the bleedout countdown when no revive is in progress (default param)', () => {
    const row = new AllyRow();
    row.set('vanguard', 0, 10, true, 4);
    expect(row.statusText).toBe('DOWNED 4s');
  });
});
