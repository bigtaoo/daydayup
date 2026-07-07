# Tech-stack decision record

## Decision 1: Single engine — PixiJS v8, no Three.js

- **Conclusion:** The entire client is built with PixiJS v8, UI included. Three.js is not used.
- **Rationale:**
  - The game is a 2D top-down shooter (à la Soul Knight); spatial depth is faked with 2D techniques, no real 3D pipeline needed.
  - Three.js + Pixi means two separate WebGL contexts. Sharing one context on a single canvas means fighting over GL state; routing through a RenderTexture is complex and prone to artifacts. WeChat mini-games typically expose only one main canvas, so multiple contexts are poorly supported.
  - Single engine = single WebGL context = smallest WeChat adaptation surface.
- **Impact:** UI is drawn with Pixi (no DOM, no second engine). True per-pixel 3D occlusion is out of scope (see the limits section in `01-rendering.md`).

## Decision 2: Open-source stack — not Cocos Creator or other closed-editor engines

- **Conclusion:** Use PixiJS (MIT) with a hand-built project, not Cocos Creator.
- **Rationale:** The primary requirement is **control** — past experience hit unfixable black-box issues in closed engines/editors. Pixi and the WeChat adapter (`weapp-adapter`) are open source, so problems can be patched or forked.
- **Accepted cost:**
  - Cross-platform packaging is built by hand (Web-first; PC/mobile via Capacitor shell; WeChat built separately).
  - Toolchains for dynamic lighting, atlases, and animation are assembled by us.
- **Re-evaluation trigger:** If we later need true 3D continuous occlusion, or native action performance falls short, reconsider a Three.js orthographic-camera approach.

## Decision 3: Visual-fidelity direction

- **Conclusion:** Fidelity upgrades come from **normal-mapped dynamic lighting + post-processing (bloom / chromatic aberration / screen shake) + particles + custom GLSL shaders**, not from raising the dimension.
- **Verification order:** Verify the depth/gameplay core first (done in the demo), then incrementally verify lighting (lightmap / normal maps) performance on the lowest WeChat base library.

## Platform matrix

| Platform | Approach | Status |
|----------|----------|--------|
| Web | Pixi v8 directly (WebGL/WebGPU) | verified in demo |
| PC / Android / iOS | Capacitor shell over the web build | to do |
| WeChat mini-game | Pixi v8 + weapp-adapter, WebGL fallback | to verify (see 04) |
