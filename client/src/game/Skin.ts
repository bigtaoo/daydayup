import { Container, Graphics } from 'pixi.js';

// Appearance layer (see design/02-entity-model.md).
// The demo uses Graphics placeholders; a real project swaps in animated sprites + swappable atlases.
// Key: handAnchor() provides the weapon mount point — later driven by animation frames.
export class Skin {
  readonly view = new Container();
  private front: Graphics;

  constructor(bodyColor: number, frontColor: number, radius: number) {
    const body = new Graphics();
    // Tilted view: draw the body as a capsule with thickness (not a flat circle) to read volume
    body.roundRect(-radius, -radius * 0.7, radius * 2, radius * 1.9, radius * 0.7)
      .fill({ color: bodyColor });
    body.circle(0, -radius * 0.4, radius * 0.85).fill({ color: bodyColor });

    // "Front / facing" indicator, rotates with facing
    this.front = new Graphics();
    this.front.moveTo(0, 0).lineTo(radius * 1.1, -radius * 0.35)
      .lineTo(radius * 1.1, radius * 0.35).closePath()
      .fill({ color: frontColor });

    this.view.addChild(body, this.front);
    this.view.zIndex = 0;
  }

  setFacing(rad: number) {
    this.front.rotation = rad;
  }

  // Hand anchor (in actor-local coords). Fixed in the demo; later driven by animation frames.
  handAnchor(): { x: number; y: number } {
    return { x: 0, y: 2 };
  }
}
