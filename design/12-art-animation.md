# Art & animation pipeline

How pixels get onto the screen: **skins** (the `02` appearance layer made concrete), the **spritesheet/atlas + animation-data format**, the **asset-loading path** (web and WeChat), and the **art constraints the tilted view imposes** (`01`). It builds on the Actor/Skin/Weapon split (`02`), the rendering/depth model (`01`), the WeChat asset constraints (`04`), and the events channel (`08`). This doc is the source of truth for **what an art asset looks like, how it loads, and the hard rule that art is pure presentation — it never feeds the engine**.

> **Status:** the current vertical slice is **Graphics-only** (procedural rectangles/ellipses/glows in `Game.ts`, `Skin.ts`) — deliberately, so WeChat boot+render was verified with zero image loaders (`04`). This doc defines the pipeline that replaces those placeholders when real art lands; nothing here is built yet.

## The decisions (locked)

- **Art is pure presentation and never decides an outcome.** Animation, textures, and particles read `GameState` + the per-frame `events` queue (`08`) and draw. They **never** write back to engine state, never gate a hit, never advance a tick. A frame event may *trigger* a muzzle flash, but the engine already decided the shot (`08`'s "events are the only engine→render channel"). This keeps determinism intact (`06`): two clients can run different art/quality tiers and stay byte-identical in simulation.
- **Skin = animation-rig + swappable atlas, decoupled (`02`).** Animation data (frame timing, anchors, event frames) is authored **once per rig** and shared; a skin is just "which atlas fills this rig." Swapping a skin swaps the texture atlas key, not the animation logic (`02`'s "build it this way from the start, or adding skins later hurts").
- **Characters carry no gameplay; weapons do (`02`).** So art variety is cheap: new skins are cosmetic (`05`'s horizontal meta), addable without touching combat. A skin's optional "minor passive" (`02`) must stay cosmetic/utility and is **normalized out of PvP** (`05`/`09` fairness wall) — art can never be a power source.
- **Tilted-view-native art (`01`).** Every actor/prop is drawn with a small front face (not a pure top-down sprite), authored for `screen.y = gy - z` and Y-sort by `gy`. Sprites have a defined **ground anchor** (feet at `gy`) and a **height extent** so shadows and occlusion read correctly (`01`).
- **Placeholder-first, atlas-later.** Systems consume a `Skin`/texture interface; the *slice* fills it with `Graphics`, real art fills it with atlas frames — same interface. Gameplay is never blocked on art (`02`/`03`'s data-driven intent).

## Skin & animation-data format

The concrete form of `02`'s `Skin { atlasKey, anim, handAnchor() }`.

```
AnimationRig {                 // authored once, shared across skins of the same body type
  fps                          // authoring frame rate (render interpolates; sim is 30Hz, 08)
  states: {                    // idle / run / attack (melee swing = the parry) / hurt / death ...
    [name]: {
      frames: FrameRef[]       // ordered atlas-region ids
      durations: number[]      // per-frame hold (ms or frame-count)
      loop: boolean
      anchors: {               // per-frame, in the atlas frame's local space
        ground: [x,y]          // feet → maps to gy (01)
        hand:  [x,y]           // weapon mount → 02's handAnchor(), tracked every frame
      }
      events: { frame, tag }[] // "hit-active", "footstep", "muzzle" → fx/audio triggers
    }
  }
}

Skin {                         // 02: appearance only
  atlasKey                     // which packed atlas fills the rig (swap = swap this)
  rig: AnimationRig            // shared reference
  handAnchor(): [x,y]          // 02: current-frame hand anchor for weapon mounting
  facing z-order per 01        // weapon front/back by facing handled by the actor container
}
```

- **`anchors.hand` is the seam to `02`/`01`:** the weapon container tracks the hand anchor of the *current animation frame* every render frame; it is never hard-coded (`02` constraint 3). Front/back z-switch by facing is the actor container's job (`01` "per-weapon local z-order").
- **`events` frames are advisory to fx/audio only.** An "attack" state's `hit-active` frame tells the *render* when to show a swing trail; the *engine* independently decides the melee hit window in `step()` (`07`/`08`). They are tuned to line up but are separate systems — art drift can never desync a match.
- **Animation is time-driven on the render clock, not the sim clock.** Sim runs at 30 Hz (`08`); art can play at any authoring fps and interpolate. Animation state is chosen from `GameState` (moving? attacking? `hp<=0`?) each render frame — a pure function of state + events, holding no authoritative data.

## Atlas / spritesheet format

- **Packed texture atlases** (Pixi spritesheet JSON + a single page image per skin, multi-page if it overflows max texture size). One atlas per skin keeps swaps to a single texture bind.
- **Power-of-two pages, trimmed frames, documented max size.** Low-end WeChat/Android GPUs cap texture size (verify on device, `04`); pick a page cap (e.g. 2048) and pack within it. Trim transparent margins but **keep the ground/hand anchors in original (untrimmed) frame space** so `02`'s mounting math stays stable.
- **Premultiplied alpha**, consistent across pages, matching the renderer's blend setup (the fx layer already uses additive, `01`).
- **Props & environment** (pillars, crates, walls, floor decals) are atlas frames too, authored tilted (front face + top cap, like the slice's procedural pillar in `Game.ts:buildPillars`) with a ground anchor and height extent for Y-sort/shadow (`01`).

## Asset loading (web + WeChat)

- **Pixi `Assets` is the single loader**, fed a manifest of atlas bundles keyed by skin/room-set. Load a **core bundle** at boot (player, common enemies, UI, current room set); lazy-load per-biome/enemy bundles between rooms (`05`) so the initial download stays small.
- **WeChat path (`04`):** the current adapter is Graphics-only and loads no remote assets; real art requires extending the adapter's `fetch` → `wx.request` / `wx.downloadFile`, and verifying the **texture loaders' reliance on `Image` / `ImageBitmap` on the lowest base library** — flagged in `04` as the thing that only surfaces once real assets land. Prefer formats the WeChat loader handles without `createImageBitmap` where that path is shaky.
- **Bundle with code vs. fetch at runtime** interacts with `09`/`06`: bundled assets version with the client and the `ENGINE_VERSION`/replay guarantee; runtime-fetched content can update without a release but must not carry anything the engine reads (it doesn't — art is presentation, so fetched art is safe for determinism; only fetched *config/rooms* touches `09`'s versioning concern).
- **No runtime canvas texture generation on WeChat** beyond the adapter's `createCanvas` (`04`); procedural looks are done with Pixi `Graphics` (portable, as the slice's glow already is) or shaders — subject to `04`'s no-`eval` shader-upload constraint.

## Tilted-view art requirements (from `01`)

Authoring rules so 2D art produces the fake-3D feel and doesn't hit `01`'s known break cases:

- **Front face + implied top**, fixed camera angle — every sprite drawn as if seen slightly forward-leaning (`01`).
- **Ground anchor at the feet** → `gy`; **height extent upward** → the sprite occupies `gy-height .. gy`, so Y-sort and the separate shadow layer work (`01`).
- **Shadows are a separate layer element** (`01`), not baked into the sprite — drawn at ground coords, shrinking/fading with `z`. Author sprites without a baked shadow.
- **Avoid `01`'s break cases:** don't author one giant sprite that must be simultaneously in front of and behind a tall prop; split tall objects into Y-sortable segments; keep occlusion silhouettes clean.
- **Fidelity roadmap alignment (`01`):** art must be authorable for later normal-map lighting (milestone 2) — keep a consistent light direction in hand-painted shading, or author flat + normal maps, so the lightmap pass composites cleanly.

## Naming & authoring conventions

- **Stable ids, not filenames, in data.** Rig states, frame refs, atlas keys, and event tags are the contract with `02`/`08`; renaming a source file must not break a skin. Map files→ids in the manifest.
- **Kebab-case, namespaced keys:** `enemy.slime.run`, `player.hand-anchor`, `fx.muzzle.small`. Event tags are a small closed vocabulary shared with fx/audio (`11`, when it lands): `footstep`, `muzzle`, `hit-active`, `impact`, `death`.
- **One rig per body archetype**, many skins per rig — enforced so a new cosmetic is a new atlas + manifest row, no new animation code (`02`, `05` horizontal meta).

## Relationship to the other docs

- **`02`:** Skin/animation decoupling, hand-anchor mounting, "characters are only skins" — this doc is that model's concrete data format.
- **`01`:** depth/Y-sort/shadow/height and the fake-3D limits art must respect; the fidelity roadmap art must stay compatible with.
- **`04`:** WeChat asset-loader constraints; the adapter `fetch` extension and lowest-base-library texture verification.
- **`08`:** the `events` queue that triggers animation events / fx; the render-vs-sim clock split.
- **`06`/`09`:** determinism (art never feeds logic) and the PvP fairness wall (skin passives normalized out).
- **`10`:** UI art (HUD icons, buttons) shares this pipeline but is authored for the `ui` layer and screen space, not world tilt.
- **`11` (audio, reserved):** animation event frames are the shared trigger vocabulary for sound.

## To design

- **Concrete atlas tooling** — packer (TexturePacker / free-tex-packer / custom), whether spritesheet JSON is hand-tuned or fully generated; anchor authoring workflow (in-tool vs. a sidecar).
- **Animation-data source of truth** — hand-written JSON, an editor (Aseprite/Spine export), or code; `09`'s "TS for balance, JSON for bulky tool-authored content" logic applies here (art data is bulky → likely JSON/generated).
- **Bundle boundaries** — what's in the boot core bundle vs. lazy per-biome/enemy, sized against WeChat download limits (`04`).
- **Placeholder→final swap process** — keep the `Skin` interface stable so the Graphics slice and atlas art are interchangeable during production.
- **Normal-map / lighting authoring** for `01`'s milestone-2 lightmap — flat+normal vs. pre-shaded.

## Open questions

- **Texture format & max page size on the lowest base library** — must be measured on a real device (`04` checklist), not chosen from docs; affects atlas packing.
- **`ImageBitmap` availability in the WeChat loader** — if unreliable, which decode path does `Assets` take, and does it force a specific image format? (`04` flags this as surfacing "once real assets land" — this is that moment.)
- **Bundled vs. fetched art** — fetched art is determinism-safe (presentation only) but complicates release/versioning; where's the line, and does it share `09`'s content-delivery decision?
- **Animation-event vs. engine-window alignment** — how tightly must the *visual* hit-active frame match the *engine's* `07` hit window before it feels wrong, given render interpolates and sim is 30 Hz (`08`)? Tune against play.
- **Rig granularity** — one humanoid rig for all bipeds vs. per-creature rigs; trade-off between animation reuse and silhouette variety (`02`).
