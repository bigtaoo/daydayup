import { Container, Graphics, Sprite, Text, type Texture } from 'pixi.js';

/**
 * One craftable blueprint, as a tappable icon card — the Forge grid (design/14) this
 * replaces the old single-line list row with: weapon art front-and-center on a
 * rarity-bordered chip, name/cost/status stacked below it, a numbered key tag top-left
 * (mirrors the row list's old `[n]` shortcut), and a staged-count badge top-right when
 * the blueprint already has crafted copies in the loadout. The browse cursor (Forge's
 * `selectedIndex`) is a bright accent border instead of the old leading `»` glyph — a
 * glyph reads fine inline in a text row, but a grid of same-sized cards has no "line
 * start" for it to sit at, so the highlight moves to the one thing every card already
 * has: its own border.
 *
 * Fixed pool, reused across pages/slots (same "one instance per grid slot, relabeled on
 * each render()" shape Forge's old row Buttons used) — the widget count stays bounded
 * regardless of catalog size.
 *
 * Pure presentation: `set()` takes already-resolved strings/colors, same convention
 * `Button.setIcon`'s `chipColor` param already uses — it never reads `WeaponBlueprint`/
 * `WeaponSimSpec` itself, so it doesn't need an `@dd/engine` import.
 */
export class BlueprintCard {
  readonly view = new Container();
  static readonly W = 132;
  static readonly H = 132;
  private static readonly ICON = 44;

  private readonly bg = new Graphics();
  private readonly iconChip = new Graphics();
  private icon: Sprite | null = null;
  private readonly keyTag: Text;
  private readonly stagedTag: Text;
  private readonly name: Text;
  private readonly cost: Text;
  private readonly status: Text;
  onTap: (() => void) | null = null;

  constructor() {
    this.keyTag = new Text({ text: '', style: { fill: 0x90cdf4, fontSize: 11, fontFamily: 'monospace', fontWeight: 'bold', padding: 4 } });
    this.keyTag.position.set(6, 4);
    this.stagedTag = new Text({ text: '', style: { fill: 0xf6e05e, fontSize: 11, fontFamily: 'monospace', fontWeight: 'bold', padding: 4 } });
    this.stagedTag.anchor.set(1, 0);
    this.stagedTag.position.set(BlueprintCard.W - 6, 4);
    this.name = new Text({
      text: '',
      style: { fill: 0xe2e8f0, fontSize: 12, fontFamily: 'monospace', fontWeight: 'bold', padding: 4, wordWrap: true, wordWrapWidth: BlueprintCard.W - 16, breakWords: true, align: 'center' },
    });
    this.name.anchor.set(0.5, 0);
    this.name.position.set(BlueprintCard.W / 2, 58);
    this.cost = new Text({
      text: '',
      style: { fill: 0x94a3b8, fontSize: 10, fontFamily: 'monospace', padding: 4, align: 'center' },
    });
    this.cost.anchor.set(0.5, 0);
    this.cost.position.set(BlueprintCard.W / 2, 74);
    this.status = new Text({
      text: '',
      style: { fill: 0x68d391, fontSize: 10, fontFamily: 'monospace', fontWeight: 'bold', padding: 4, wordWrap: true, wordWrapWidth: BlueprintCard.W - 16, breakWords: true, align: 'center' },
    });
    this.status.anchor.set(0.5, 0);
    this.status.position.set(BlueprintCard.W / 2, 88);

    this.view.addChild(this.bg, this.iconChip, this.keyTag, this.stagedTag, this.name, this.cost, this.status);
    this.view.eventMode = 'static';
    this.view.cursor = 'pointer';
    this.view.on('pointertap', () => this.onTap?.());
    // Same double-fire guard Button's own pointerdown handler documents — a card nested
    // inside a screen with its own full-panel tap handler would otherwise double-fire.
    this.view.on('pointerdown', (e) => e.stopPropagation());
  }

  set(opts: {
    key: string;
    name: string;
    cost: string;
    status: string;
    statusColor: number;
    borderColor: number;
    selected: boolean;
    staged: number;
    locked: boolean;
    icon?: Texture;
  }): void {
    const { key, name, cost, status, statusColor, borderColor, selected, staged, locked, icon } = opts;
    const w = BlueprintCard.W;
    const h = BlueprintCard.H;
    this.bg
      .clear()
      .roundRect(0, 0, w, h, 8)
      .fill({ color: selected ? 0x1e2a3d : 0x18202f, alpha: 0.92 })
      .roundRect(0.5, 0.5, w - 1, h - 1, 8)
      .stroke({ color: selected ? 0x63b3ed : borderColor, alpha: selected ? 1 : 0.7, width: selected ? 2.5 : 1.5 });

    this.keyTag.text = `[${key}]`;
    this.stagedTag.text = staged > 0 ? `▸×${staged}` : '';
    this.name.text = name;
    this.name.style.fill = locked ? 0x718096 : borderColor;
    this.cost.text = cost;
    this.status.text = status;
    this.status.style.fill = statusColor;

    const box = BlueprintCard.ICON;
    const cx = w / 2;
    const cy = 8 + box / 2;
    this.iconChip.clear().roundRect(cx - box / 2, 8, box, box, 6).fill({ color: 0x0f1420, alpha: 0.9 });
    if (icon) {
      if (!this.icon) {
        this.icon = new Sprite();
        this.icon.anchor.set(0.5);
        this.view.addChildAt(this.icon, 2); // above the chip, below the text
      }
      this.icon.texture = icon;
      // Contain, not stretch — same fit `Button.setIcon`/`WeaponCard` already use for
      // this same weapon art (a wide "socket-to-tip" silhouette, not square).
      const fit = Math.min((box - 6) / icon.width, (box - 6) / icon.height);
      this.icon.scale.set(fit);
      this.icon.position.set(cx, cy);
      this.icon.alpha = locked ? 0.4 : 1;
    } else if (this.icon) {
      this.icon.destroy();
      this.icon = null;
    }
  }

  // Test-only readouts (same escape hatch every other screen test uses on the private
  // `Button.label`/`WeaponCard` text fields — see Forge.test.ts).
  get nameLabel(): string {
    return this.name.text;
  }
  get costLabel(): string {
    return this.cost.text;
  }
  get statusLabel(): string {
    return this.status.text;
  }
  get keyLabel(): string {
    return this.keyTag.text;
  }
  get stagedLabel(): string {
    return this.stagedTag.text;
  }
}
