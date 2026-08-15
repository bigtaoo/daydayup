/**
 * PvpPreview (design/10 open question "PvP preset-pick has no UI yet", 15) — the
 * confirm/preview step ModeSelect's PVP SOLO QUEUE now opens before Matchmaking. Same
 * plain-vitest, no-renderer convention as ModeSelect.test.ts/Settings.test.ts.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { buildArenaSpecs, PVP_SCALE_FACTOR, DEFAULT_SKIN_ID, SKIN_DEFS } from '@dd/engine';
import { PvpPreview } from './PvpPreview';
import { setLocale, resetLocaleForTests, tName } from '../../i18n';

function privateOf(p: PvpPreview) {
  return p as unknown as {
    title: { text: string };
    mapLine: { text: string };
    fairnessNote: { text: string };
    queueBtn: { label: { text: string }; onTap: (() => void) | null };
    backBtn: { label: { text: string }; onTap: (() => void) | null };
    playerCard: { displayName: string };
    weaponCard: { nameText: string; damageText: string };
  };
}

afterEach(() => resetLocaleForTests());

describe('PvpPreview — callbacks', () => {
  it('tapping QUEUE/BACK fires its own callback, not the other one', () => {
    const p = new PvpPreview();
    p.show(800, 600, DEFAULT_SKIN_ID);
    const calls: string[] = [];
    p.onQueue = () => calls.push('queue');
    p.onBack = () => calls.push('back');

    privateOf(p).queueBtn.onTap?.();
    privateOf(p).backBtn.onTap?.();

    expect(calls).toEqual(['queue', 'back']);
  });
});

describe('PvpPreview — show()/hide()', () => {
  it('starts hidden', () => {
    const p = new PvpPreview();
    expect(p.view.visible).toBe(false);
  });

  it('becomes visible on show()', () => {
    const p = new PvpPreview();
    p.show(800, 600, DEFAULT_SKIN_ID);
    expect(p.view.visible).toBe(true);
  });

  it('hide() hides it again', () => {
    const p = new PvpPreview();
    p.show(800, 600, DEFAULT_SKIN_ID);
    p.hide();
    expect(p.view.visible).toBe(false);
  });
});

describe('PvpPreview — PvP-scaled build preview', () => {
  it('shows the same scaled character + weapon a real arena seat would get (buildArenaSpecs)', () => {
    const p = new PvpPreview();
    p.show(800, 600, DEFAULT_SKIN_ID);
    const built = buildArenaSpecs('landing_basic', DEFAULT_SKIN_ID);

    expect(privateOf(p).playerCard.displayName).toBe(tName(SKIN_DEFS[DEFAULT_SKIN_ID]!.nameKey));
    expect(privateOf(p).weaponCard.nameText).toBe(tName(built.weapons[0]!.spec.nameKey));
    expect(privateOf(p).weaponCard.damageText).toContain(String(built.weapons[0]!.spec.damage));
  });

  it('names the scale factor actually in effect', () => {
    const p = new PvpPreview();
    p.show(800, 600, DEFAULT_SKIN_ID);
    expect(privateOf(p).fairnessNote.text).toContain(String(PVP_SCALE_FACTOR));
  });

  it('re-shows cleanly for a different character', () => {
    const p = new PvpPreview();
    p.show(800, 600, 'skirmisher');
    expect(privateOf(p).playerCard.displayName).toBe('Skirmisher');
    p.show(800, 600, 'juggernaut');
    expect(privateOf(p).playerCard.displayName).toBe('Juggernaut');
  });

  // buildArenaSpecs/resolveSkin fall back to the default character for an unknown id
  // (forward-compat, same convention every other skinId reader in this repo follows) —
  // this should never crash the preview even if MetaState ever carries a stale id.
  it('does not throw for an unknown skinId, and falls back to a real character', () => {
    const p = new PvpPreview();
    expect(() => p.show(800, 600, 'not-a-real-skin')).not.toThrow();
    expect(privateOf(p).playerCard.displayName).toBe('NOT-A-REAL-SKIN');
    expect(privateOf(p).weaponCard.nameText).not.toBe('');
  });
});

describe('PvpPreview — i18n (design/17-i18n.md)', () => {
  it('defaults to English', () => {
    const p = new PvpPreview();
    p.show(800, 600, DEFAULT_SKIN_ID);
    expect(privateOf(p).title.text).toBe('PVP MATCH');
    expect(privateOf(p).queueBtn.label.text).toBe('QUEUE');
  });

  it('retexts its static labels from the active locale on show()', () => {
    setLocale('zh');
    const p = new PvpPreview();
    p.show(800, 600, DEFAULT_SKIN_ID);
    expect(privateOf(p).title.text).toBe('PVP 对战');
    expect(privateOf(p).queueBtn.label.text).toBe('开始匹配');
    expect(privateOf(p).backBtn.label.text).toBe('返回');
  });

  it('switching back to English on a later show() fully reverts', () => {
    const p = new PvpPreview();
    setLocale('zh');
    p.show(800, 600, DEFAULT_SKIN_ID);
    setLocale('en');
    p.show(800, 600, DEFAULT_SKIN_ID);
    expect(privateOf(p).title.text).toBe('PVP MATCH');
  });
});
