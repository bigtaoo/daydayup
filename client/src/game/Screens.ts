import { Container, Text } from 'pixi.js';
import { Panel } from './ui/widgets';

// Render-side screen overlay: the menu / victory / defeat panels that wrap a run
// (design/10 screen flow). It is pure presentation — it reads nothing from the
// engine and only calls back `onConfirm` to start/restart. Lives in the fixed
// `ui` layer, on top of the HUD.
export class Screens {
  readonly view = new Container();
  private panel = new Panel({ alpha: 0.72 });
  private title: Text;
  private sub: Text;
  private hint: Text;

  // Called when the player confirms (pointer tap or fire/jump edge — wired in Game).
  onConfirm: (() => void) | null = null;

  constructor() {
    this.title = new Text({
      text: '',
      style: { fill: 0xf7fafc, fontSize: 46, fontWeight: 'bold', fontFamily: 'sans-serif' },
    });
    this.sub = new Text({
      text: '',
      style: { fill: 0xcbd5e0, fontSize: 20, fontFamily: 'sans-serif', align: 'center' },
    });
    this.hint = new Text({
      text: '',
      style: { fill: 0x90cdf4, fontSize: 17, fontFamily: 'monospace' },
    });
    for (const t of [this.title, this.sub, this.hint]) t.anchor.set(0.5);

    this.view.addChild(this.panel.view, this.title, this.sub, this.hint);
    // Full-panel is clickable/tappable on web; the fire/jump fallback covers WeChat.
    this.view.eventMode = 'static';
    this.view.on('pointerdown', () => this.onConfirm?.());
    this.view.visible = false;
  }

  private layout(w: number, h: number) {
    this.panel.layout(w, h);
    const cx = w / 2;
    const cy = h / 2;
    this.title.position.set(cx, cy - 60);
    this.sub.position.set(cx, cy + 4);
    this.hint.position.set(cx, cy + 64);
  }

  show(w: number, h: number, title: string, sub: string, hint: string) {
    this.title.text = title;
    this.sub.text = sub;
    this.hint.text = hint;
    this.layout(w, h);
    this.view.visible = true;
  }

  hide() {
    this.view.visible = false;
  }
}
