import { Container, Graphics, Text } from 'pixi.js';
import { drawHudIcon, type HudIconId } from './hudIcons';
import { estimateMonoWidth } from './textWidth';

/**
 * One in-run stat, as a pill: a tinted icon, a small caps label, and the value under it
 * (design/10 HUD widget kit). Replaces a segment of the old single monospace info line
 * — the label survives so nothing became a guess-the-icon puzzle (the same reason
 * `FloorProgress` bakes its meaning into the dot shapes rather than dropping the
 * legend), but the icon + colour is what makes the row scannable mid-fight.
 *
 * Pure presentation, like every other widget here: it takes already-formatted strings.
 * Width is derived from `estimateMonoWidth`, never `Text.width` — see textWidth.ts.
 */
export class StatChip {
  readonly view = new Container();
  static readonly HEIGHT = 30;
  private static readonly ICON_CX = 15;
  private static readonly ICON_R = 7;
  private static readonly TEXT_X = 27;
  private static readonly LABEL_SIZE = 9;
  private static readonly VALUE_SIZE = 13;
  private static readonly PAD_RIGHT = 9;

  private readonly bg = new Graphics();
  private readonly icon = new Graphics();
  private readonly label: Text;
  private readonly value: Text;
  private readonly color: number;
  private w = 0;
  // Redraw cache. Deliberately NOT compared against the Text nodes' own strings: those
  // start empty, which would make `set('', '')` a silent no-op on a never-drawn chip —
  // the same trap WeaponCard's unarmed card fell into. Every real key contains the `|`
  // joiner below, so the initial `''` here can't be produced by a legitimate call.
  private lastKey = '';

  constructor(iconId: HudIconId, color: number) {
    this.color = color;
    drawHudIcon(this.icon, iconId, StatChip.ICON_CX, StatChip.HEIGHT / 2, StatChip.ICON_R, color);
    // `padding` on every Text style: Pixi's own measurement can come in narrower than
    // the canvas's paint-time glyph width and clip the last character(s) — the same
    // workaround `Button`/`HudView` already carry (see ui/widgets.ts).
    this.label = new Text({
      text: '',
      style: { fill: color, fontSize: StatChip.LABEL_SIZE, fontFamily: 'monospace', fontWeight: 'bold', padding: 6 },
    });
    this.label.alpha = 0.85;
    this.label.position.set(StatChip.TEXT_X, 4);
    this.value = new Text({
      text: '',
      style: { fill: 0xf7fafc, fontSize: StatChip.VALUE_SIZE, fontFamily: 'monospace', fontWeight: 'bold', padding: 6 },
    });
    this.value.position.set(StatChip.TEXT_X, 13);
    this.view.addChild(this.bg, this.icon, this.label, this.value);
  }

  set(label: string, value: string): void {
    const key = `${label}|${value}`;
    if (key === this.lastKey) return;
    this.lastKey = key;
    this.label.text = label;
    this.value.text = value;
    const w =
      Math.ceil(
        StatChip.TEXT_X +
          Math.max(estimateMonoWidth(label, StatChip.LABEL_SIZE), estimateMonoWidth(value, StatChip.VALUE_SIZE)),
      ) + StatChip.PAD_RIGHT;
    if (w !== this.w) {
      this.w = w;
      this.bg
        .clear()
        .roundRect(0, 0, w, StatChip.HEIGHT, 7)
        .fill({ color: 0x151b28, alpha: 0.72 })
        .roundRect(0.5, 0.5, w - 1, StatChip.HEIGHT - 1, 7)
        .stroke({ color: this.color, alpha: 0.35, width: 1 });
    }
  }

  /** Laid-out width — canvas-free, so the caller can pack a row of chips (and size the
   *  HUD's backing panel) without a live renderer. */
  get width(): number {
    return this.w;
  }

  /** Test seam (the widget owns its own Text nodes rather than exposing them). */
  get labelText(): string {
    return this.label.text;
  }
  get valueText(): string {
    return this.value.text;
  }
}
