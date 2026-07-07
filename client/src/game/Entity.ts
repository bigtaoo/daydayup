import { Container, Graphics } from 'pixi.js';
import { CONFIG } from './config';

// Base class for all world objects.
// Ground coords gx/gy drive sorting, shadows, and collision; z is visual height.
// See the coordinate & height model in design/01-rendering.md.
export class Entity extends Container {
  gx = 0;
  gy = 0;
  z = 0;

  alive = true;
  shadow: Graphics | null = null;

  // Create an elliptical soft shadow, added to the shadow layer by the caller.
  makeShadow(radius: number): Graphics {
    const s = new Graphics();
    s.ellipse(0, 0, radius, radius * 0.5).fill({ color: CONFIG.colors.shadow, alpha: 0.35 });
    this.shadow = s;
    return s;
  }

  // Sync the screen transform and shadow each frame. screen.y = gy - z; shadow stays on the ground (gy).
  sync() {
    this.x = this.gx;
    this.y = this.gy - this.z;
    this.zIndex = this.gy; // Y-sort

    if (this.shadow) {
      this.shadow.x = this.gx;
      this.shadow.y = this.gy;
      // Higher lift → smaller, fainter shadow
      const k = 1 / (1 + this.z * 0.012);
      this.shadow.scale.set(k);
      this.shadow.alpha = 0.35 * k;
    }
  }

  destroy() {
    this.alive = false;
    this.shadow?.parent?.removeChild(this.shadow);
    this.shadow?.destroy();
    super.destroy({ children: true });
  }
}
