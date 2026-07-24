import { Container, Graphics, Text } from 'pixi.js';
import {
  BLUEPRINT_CATALOG, SKIN_DEFS, DAMAGE_TYPES, PLAYER_BASE,
  type WeaponBlueprint, type DamageType,
} from '@dd/engine';
import type { MetaState } from '../meta';
import { bankTotal, canAfford, isUnlocked, purchasableBlueprints } from '../meta';

/**
 * The forge outpost (design/14, ROADMAP 2.2/2.3) — the between-run hub where the player
 * spends banked materials to craft weapons for the next run and picks a character. Pure
 * presentation: it reads a MetaState and renders it; all mutation goes through the meta/
 * forge transactions, driven by Game's key handling. This is a FIRST-PASS layout — the
 * outpost's real look / NPCs are design/13's to-design; the screen FLOW (design/10) is
 * what ships here. A monospace board keeps it legible without art.
 */
export class Forge {
  readonly view = new Container();
  private bg = new Graphics();
  private title: Text;
  private body: Text;
  private hint: Text;

  /** Stable blueprint order = display order = the number key that crafts each. */
  readonly order: string[] = Object.keys(BLUEPRINT_CATALOG);

  constructor() {
    this.title = new Text({ text: 'FORGE OUTPOST', style: { fill: 0xf7fafc, fontSize: 34, fontWeight: 'bold', fontFamily: 'sans-serif' } });
    this.body = new Text({ text: '', style: { fill: 0xcbd5e0, fontSize: 16, fontFamily: 'monospace', lineHeight: 22 } });
    this.hint = new Text({ text: '', style: { fill: 0x90cdf4, fontSize: 15, fontFamily: 'monospace', lineHeight: 20 } });
    this.view.addChild(this.bg, this.title, this.body, this.hint);
    this.view.eventMode = 'static';
    this.view.visible = false;
  }

  private costText(cost: readonly WeaponBlueprint['cost'][number][]): string {
    // Show the tier gate when a cost demands it (design/14): FIR×2≥t2 = two fire mats of
    // tier ≥ 2. Un-gated costs (minTier 0/absent) read as before.
    return cost.map((c) => `${short(c.element)}×${c.qty}${c.minTier ? `≥t${c.minTier}` : ''}`).join(' ');
  }

  render(m: MetaState, w: number, h: number) {
    this.bg.clear();
    this.bg.rect(0, 0, w, h).fill({ color: 0x0b0e14, alpha: 0.82 });

    // Material bank — the five elemental kinds (design/14), summed across every rolled tier.
    const bank = DAMAGE_TYPES.map((e) => `${short(e)} ${bankTotal(m, e)}`).join('   ');

    // Character line.
    const skin = SKIN_DEFS[m.selectedSkin];
    const skinLine = skin
      ? `${m.selectedSkin}  (${skin.maxHp}HP / ${skin.maxShield}SH)   owned: ${m.ownedCharacters.length}`
      : m.selectedSkin;

    // Blueprint board — [n] id  cost  status.
    const lines = this.order.map((id, i) => {
      const bp = BLUEPRINT_CATALOG[id]!;
      const unlocked = isUnlocked(m, id);
      const staged = m.loadout.filter((x) => x === id).length;
      const affordable = canAfford(m, bp);
      const status = !unlocked
        ? (bp.source === 'drop' ? 'locked (find it)' : `locked (${bp.source})`)
        : affordable ? 'craftable' : 'need materials';
      const stagedTag = staged > 0 ? `  ▸staged×${staged}` : '';
      return `[${i + 1}] ${id.padEnd(11)} ${this.costText(bp.cost).padEnd(14)} ${status}${stagedTag}`;
    });

    const loadout = m.loadout.length ? m.loadout.join(', ') : '(none → auto pistol)';
    const buyable = purchasableBlueprints(m);

    this.body.text =
      `Materials   ${bank}\n` +
      `Character   ${skinLine}\n` +
      `Loadout     ${loadout}   (${m.loadout.length}/${PLAYER_BASE.weaponSlots})\n` +
      `\nBLUEPRINTS\n${lines.join('\n')}` +
      (buyable.length ? `\n\nStore (demo: free): ${buyable.join(', ')}  — [B] acquire next` : '');

    this.hint.text =
      '[1-9] craft blueprint into loadout   [C] change character   [X] clear loadout\n' +
      '[Enter] / Fire  →  DESCEND';

    // Layout: title top, board left-aligned centre, hint bottom.
    this.title.anchor.set(0.5, 0);
    this.title.position.set(w / 2, Math.max(24, h * 0.08));
    this.body.anchor.set(0.5, 0);
    this.body.position.set(w / 2, this.title.y + 56);
    this.hint.anchor.set(0.5, 1);
    this.hint.position.set(w / 2, h - 24);

    this.view.visible = true;
  }

  hide() {
    this.view.visible = false;
  }
}

/** Short element tag for the material board (physical→PHY, fire→FIR, …). */
function short(e: DamageType): string {
  return e.slice(0, 3).toUpperCase();
}
