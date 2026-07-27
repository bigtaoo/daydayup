import { EventBus }              from './core/EventBus';
import { AppState }              from './core/AppState';
import { CommandManager }        from './core/CommandManager';
import { Rig, type RigDef }      from './skeleton/Rig';
import { ORB_CORE_RIG }          from './skeleton/rigs/orbCore';
import { BOSS_CORE_RIG }         from './skeleton/rigs/bossCore';
import { CRITTER_CORE_RIG }      from './skeleton/rigs/critterCore';
import { ImageController }       from './images/ImageController';
import { AnimationController }   from './animation/AnimationController';
import { Renderer }              from './rendering/Renderer';
import { InteractionController } from './interaction/InteractionController';
import { TimelineView }          from './timeline/TimelineView';
import { AnimListPanel }         from './ui/AnimListPanel';
import { BoneInspectorPanel }    from './ui/BoneInspectorPanel';
import { ImagePanel }            from './ui/ImagePanel';
import { AttachmentPanel }       from './ui/AttachmentPanel';
import { ToolbarPanel }          from './ui/ToolbarPanel';
import { StatusBar }             from './ui/StatusBar';
import { ErrorToast }            from './ui/ErrorToast';
import { ResizablePanels }       from './ui/ResizablePanels';
import { IOController }          from './io/IOController';
import { ProjectStore }          from './io/ProjectStore';
import { AutoSaveController }    from './io/AutoSaveController';
import { ProjectPanel }          from './ui/ProjectPanel';
import type { AttachmentPoint }  from './core/types';
import type { AppEvents }        from './core/EventBus';

/** The orb-core's preset clips (design/12). No walk cycle — 'move' is the
 *  lean-into-travel clip; the rest mirror the ported original's six slots. */
const PRESET_NAMES = ['idle', 'move', 'attack', 'hurt', 'death', 'spawn'] as const;

export class App {
  constructor(rootEl: HTMLElement) {
    // ── 1. Core infrastructure ──────────────────────────────────────────────
    const bus        = new EventBus<AppEvents>();
    const state      = new AppState(bus);
    const cmdManager = new CommandManager(bus);
    // Dev-only rig picker (`?rig=boss-core`), same convention as this project's
    // other opt-in query-param toggles (design/12's "a new rig is new data, not
    // new code" — this is that claim exercised for a second body archetype, not
    // a real multi-project rig-switcher UI). Defaults to the orb-core hero.
    const RIGS: Record<string, RigDef> = {
      'orb-core':    ORB_CORE_RIG,
      'boss-core':   BOSS_CORE_RIG,
      'critter-core': CRITTER_CORE_RIG,
    };
    const rigParam = new URLSearchParams(location.search).get('rig');
    const rigDef   = (rigParam && RIGS[rigParam]) || ORB_CORE_RIG;
    const rig      = new Rig(rigDef);

    // ── 2. Renderer ─────────────────────────────────────────────────────────
    const canvasWrap = rootEl.querySelector<HTMLElement>('#canvas-wrap')!;
    const renderer   = new Renderer(canvasWrap, rig);

    const { w, h } = renderer.logicalSize;
    state.setRootPos(w / 2, h / 2 + 30);

    // ── 3. Controllers ──────────────────────────────────────────────────────
    const imageCtrl  = new ImageController(bus, rig);
    const animCtrl   = new AnimationController(bus, state);
    new InteractionController(renderer, bus, state, animCtrl, cmdManager, rig);

    // ── 4. Timeline ─────────────────────────────────────────────────────────
    const tlCanvas    = rootEl.querySelector<HTMLCanvasElement>('#timeline-canvas')!;
    const tlLabels    = rootEl.querySelector<HTMLElement>('#tl-labels')!;
    const timelineView = new TimelineView(tlCanvas, tlLabels, bus, state, animCtrl, cmdManager, rig);

    // ── 5. UI panels ────────────────────────────────────────────────────────
    new AnimListPanel(
      rootEl.querySelector<HTMLElement>('#anim-list')!,
      bus, animCtrl, cmdManager,
    );
    new BoneInspectorPanel(
      rootEl.querySelector<HTMLElement>('.right-panel')!,
      bus, state, animCtrl, imageCtrl, cmdManager, rig,
    );
    new ImagePanel(
      rootEl.querySelector<HTMLElement>('#image-panel')!,
      bus, imageCtrl, state, rig,
    );
    new ToolbarPanel(
      rootEl.querySelector<HTMLElement>('.toolbar')!,
      bus, state, animCtrl, cmdManager,
    );
    new StatusBar(
      rootEl.querySelector<HTMLElement>('#status-text')!,
      bus,
    );
    new ErrorToast(bus);   // failures / blocked actions → floating popup
    new AttachmentPanel(
      rootEl.querySelector<HTMLElement>('#attachment-panel')!,
      bus, state, rig,
    );
    const ioCtrl = new IOController(state, animCtrl, imageCtrl, cmdManager, bus, rig);
    new ResizablePanels(rootEl);
    // Debug hook (same convention as client/src/main.ts's `__game`) — lets a
    // headless driver call buildTaoBlob()/buildEditorBlob() directly instead of
    // fighting the native save-file picker's user-activation requirement.
    (window as unknown as { __io?: IOController }).__io = ioCtrl;

    // ── 6. Auto-binding when images are loaded ───────────────────────────────
    // When an image is loaded for a bone slot, create a default binding if
    // none exists; then mark sprite order as dirty for re-sort.
    bus.on('images:change', (slotId: string) => {
      if (imageCtrl.allSlots.includes(slotId)) {
        if (!state.getBinding(slotId) && imageCtrl.getTexture(slotId)) {
          state.setBinding(slotId, {
            anchorX:  0.5,
            anchorY:  0.5,
            flipX:    false,
            zOrder:   imageCtrl.defaultZOrder[slotId] ?? 0,
            rotation: 0,
            scaleX:   1,
            scaleY:   1,
          });
        }
        renderer.markSpriteOrderDirty();

        if (state.previewMode !== 'sprite') {
          state.setPreviewMode('sprite');
          bus.emit('status', 'Image loaded — switched to Sprite mode');
        }
      }
    });

    // Re-sort whenever a binding's zOrder changes
    bus.on('binding:change', () => renderer.markSpriteOrderDirty());

    // ── 7. Resize handling ───────────────────────────────────────────────────
    const resizeObs = new ResizeObserver(entries => {
      const { width: nw, height: nh } = entries[0].contentRect;
      if (nw === 0 || nh === 0) return;
      const { w: oldW, h: oldH } = renderer.logicalSize;
      const dx = oldW > 0 ? state.rootX - oldW / 2 : 0;
      const dy = oldH > 0 ? state.rootY - (oldH / 2 + 30) : 0;
      renderer.resize(nw, nh);
      state.setRootPos(nw / 2 + dx, nh / 2 + 30 + dy);
    });
    resizeObs.observe(canvasWrap);

    // ── 8. Main render loop ──────────────────────────────────────────────────
    renderer.pixiApp.ticker.add(() => {
      // In Skin mode render the rest pose (all rotations = 0) so the artist
      // always adjusts binding parameters against the neutral rest pose.
      const frame     = state.editorMode === 'skin'
        ? new Map<string, import('./core/types').ResolvedBoneTransform>()
        : animCtrl.getCurrentFrame();
      const worldPose = rig.computeFK(state.rootX, state.rootY, frame, state.boneLengthScales);

      renderer.draw({
        worldPose,
        boneTransforms:      frame,
        bindings:            state.boneBindings,
        getTexture:          (boneId: string) => imageCtrl.getTexture(boneId),
        attachmentPoints:    state.attachmentPoints,
        previewMode:         state.previewMode,
        selectedBone:        state.selectedBone,
        showJoints:          state.showJoints,
        showSkeletonOverlay: state.showSkeletonOverlay,
        showGuide:           state.showGuide,
        showPivots:          state.showPivots,
        backgroundColor:     state.backgroundColor,
        rootX:               state.rootX,
        rootY:               state.rootY,
        onionData:           state.showOnion
          ? animCtrl.getOnionFrames().map(f => ({
              worldPose:      rig.computeFK(state.rootX, state.rootY, f, state.boneLengthScales),
              boneTransforms: f,
            }))
          : [],
      });
    });

    // ── 9. Timeline loop ────────────────────────────────────────────────────
    const tlLoop = () => { timelineView.render(); requestAnimationFrame(tlLoop); };
    requestAnimationFrame(tlLoop);

    // ── 10. Default-project factory ───────────────────────────────────────────
    // Resets all state to a blank orb-core: default attachments, no images,
    // the six preset clips, "idle" selected (the resting hover pose — there's
    // no walk cycle to default to). Used for "New" / "Delete last".
    const DEFAULT_ATTACHMENTS: AttachmentPoint[] = [
      { id: 'shadow', label: '🔵 Shadow', parentBone: 'root', offsetX: 0, offsetY: 4 },
    ];
    const resetToDefaults = () => {
      animCtrl.clearAll();
      [...state.boneBindings.keys()].forEach(id => state.removeBinding(id));
      imageCtrl.clearAll();
      state.setAllLengthScales({});
      state.setAllAttachmentPoints(DEFAULT_ATTACHMENTS.map(pt => ({ ...pt })));
      state.setPreviewMode('skeleton');
      // PRESET_NAMES are orb-core-specific clips (hover-bob, socket recoil, …) —
      // meaningless bone ids under a different rig, so a non-orb-core rig starts
      // with zero clips instead of silently authoring keyframes for bones that
      // don't exist.
      if (rig.id === 'orb-core') {
        for (const name of PRESET_NAMES) {
          animCtrl.loadPreset(name);
        }
        animCtrl.selectClip('idle');
      }
      cmdManager.clear();
    };
    resetToDefaults();

    // ── 11. Project library + auto-save ───────────────────────────────────────
    const projectStore = new ProjectStore();
    const autoSave = new AutoSaveController(projectStore, ioCtrl, bus, resetToDefaults);
    new ProjectPanel(
      rootEl.querySelector<HTMLElement>('.bottom-bar')!,
      bus, autoSave, projectStore,
    );
    void autoSave.bootstrap();

    bus.emit('status', 'Ready');
  }
}
