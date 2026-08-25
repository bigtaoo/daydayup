// Split out of Actor.ts (2026-08-25, 500-line convention). The four conditionally-active
// PER-ACTOR skin shaders and the composition rule that turns them into one `filters` list:
// shield shell, hit-flash outline, death dissolve, burn heat-haze.
//
// This is the extraction `client/scripts/file-length-baseline.json`'s own note on Actor.ts
// nominated — *"the filter cluster (`applySkinFilters`/`setShieldActive`/`hitFlash`/
// `startDissolve`/`isDissolved`, all touching the same four lazily-built filter fields) is the
// natural form-(2) composition candidate if this gets revisited"* — taken when the element-badge
// pass pushed the file past its recorded baseline. It is form (2) from CLAUDE.md, not form (3):
// the cross-boundary call list is exactly ONE method (`setSkinFilters`), which is why the host
// dependency is declared as a one-method interface rather than as the whole `Actor`.
//
// Everything here is presentation state with no engine meaning: `Actor` mirrors sim values into
// it (`setShield`, `setBurning`) and drives its clocks from the render frame (`tick`). Nothing in
// this file reads or writes `GameState` (design/08 "render only reads").
import type { Filter } from 'pixi.js';
import { EnergyShieldFilter, OutlineFilter, DissolveFilter, HeatHazeFilter } from '../fx/filters';
import { THEME } from '../theme';

/** Outline "you were just hit" flash duration. */
const HIT_FLASH_MS = 160;
/** Death-dissolve shader duration. */
export const DISSOLVE_MS = 700;

/**
 * What this needs from the object it decorates. One method, so it is declared as one method —
 * CLAUDE.md's "narrow that dependency to a small interface declaring just those methods rather
 * than depending on the whole concrete class". There is deliberately no call in the other
 * direction: `Actor` asks this for state (`isDissolved`), this never reaches back into `Actor`.
 */
export interface ActorFilterHost {
  /** Apply the composed filter list to the body's display object, or clear it when empty. */
  setSkinFilters(filters: Filter[] | null): void;
}

export class ActorFilters {
  // All four are lazily built: most actors never carry a shield pool, never get hit while on
  // screen, never burn, and are destroyed rather than dissolved. A freshly spawned actor
  // therefore has no filter at all and costs no render-target pass — which is the property the
  // 2026-08-24 lighting pass existed to establish (every actor used to carry an always-on
  // `NormalLitFilter`, measured as the dominant cost of the frame; see `src/perf/README.md`).
  private shieldFilter: EnergyShieldFilter | null = null;
  private shieldActive = false;
  private shieldRatio = -1; // last-applied shield fraction (skip redundant work if unchanged)
  private outlineFilter: OutlineFilter | null = null;
  private outlineMs = 0; // remaining ms of the current hit flash, 0 = inactive
  private dissolveFilter: DissolveFilter | null = null;
  private dissolveMs = -1; // -1 = not dissolving; counts up from 0 once startDissolve fires
  private heatHazeFilter: HeatHazeFilter | null = null;
  private heatHazeActive = false;

  constructor(private readonly host: ActorFilterHost) {}

  /**
   * Mirror the engine actor's two-pool shield (design/02/05/07) as a translucent shell
   * (design/01 fidelity roadmap milestone 5, `EnergyShieldFilter`). `maxShield <= 0` is the
   * common case (most enemies, the 0-shield starter) and stays a cheap no-op — the filter is
   * only ever built for an actor that actually carries a shield pool. Ratio 0 (broken, but still
   * has a maxShield) removes it: the `shield_break` event's own flash already covers that
   * instant, so there is nothing left for the shell to do.
   */
  setShield(shield: number, maxShield: number): void {
    if (maxShield <= 0) {
      this.shieldRatio = -1;
      this.setShieldActive(false);
      return;
    }
    const ratio = Math.max(0, Math.min(1, shield / maxShield));
    if (ratio === this.shieldRatio) return;
    this.shieldRatio = ratio;
    if (ratio <= 0) {
      this.setShieldActive(false);
      return;
    }
    if (!this.shieldFilter) this.shieldFilter = new EnergyShieldFilter(THEME.colors.shield);
    this.shieldFilter.intensity = ratio;
    this.setShieldActive(true);
  }

  /**
   * Heat-haze distortion while burning (design/01 milestone 5, `HeatHazeFilter`) — the
   * silhouette itself shimmers, on top of whatever ring the status aura draws.
   *
   * Edge-detected in here rather than by the caller: a chill or poison toggle arriving alongside
   * an ongoing burn must not rebuild this filter, and putting that condition next to the state
   * it guards is what keeps the two from drifting apart.
   */
  setBurning(burning: boolean): void {
    if (burning === this.heatHazeActive) return;
    if (burning && !this.heatHazeFilter) this.heatHazeFilter = new HeatHazeFilter();
    this.heatHazeActive = burning;
    this.apply();
  }

  /**
   * Brief "you were just hit" silhouette flash (design/01 milestone 5, `OutlineFilter`) — real
   * alpha-edge detection, unlike the shield's UV-distance approximation, so it reads correctly
   * against any body shape. Fired from EventReactor's 'hit' case for BOTH factions (whichever
   * actor the event names as `target`), independent of the position-anchored `fx.flash()` burst
   * — that one reads as "impact happened here", this one as "THIS actor took it".
   */
  hitFlash(): void {
    if (!this.outlineFilter) this.outlineFilter = new OutlineFilter(0xffffff);
    this.outlineFilter.alpha = 1;
    this.outlineMs = HIT_FLASH_MS;
    this.apply();
  }

  /**
   * Kick off the death-dissolve shader (design/01 milestone 5, `DissolveFilter`) — called once by
   * `Actor.startDissolve` when this actor's id drops out of the engine's alive list, instead of
   * destroying the view that same tick. Hiding the actor's other furniture (weapon, aura, health
   * bar) stays with `Actor`: those are its children, not this object's business.
   */
  startDissolve(): void {
    if (this.dissolveMs >= 0) return; // already dissolving — defensive, shouldn't double-fire
    this.dissolveFilter = new DissolveFilter();
    this.dissolveMs = 0;
    this.apply();
  }

  /** True once the death-dissolve has fully played out — `Scene` destroys the view then. */
  get isDissolved(): boolean {
    return this.dissolveMs >= DISSOLVE_MS;
  }

  /** Advance every active shader's own clock. Call once per render frame (dt in ms). */
  tick(frameDt: number): void {
    if (this.shieldActive && this.shieldFilter) this.shieldFilter.tick(frameDt);
    if (this.heatHazeActive && this.heatHazeFilter) this.heatHazeFilter.tick(frameDt);
    if (this.outlineMs > 0) {
      this.outlineMs = Math.max(0, this.outlineMs - frameDt);
      this.outlineFilter!.alpha = this.outlineMs / HIT_FLASH_MS;
      if (this.outlineMs === 0) this.apply(); // expired — drop it back off the list
    }
    if (this.dissolveMs >= 0 && this.dissolveMs < DISSOLVE_MS) {
      this.dissolveMs = Math.min(DISSOLVE_MS, this.dissolveMs + frameDt);
      this.dissolveFilter!.progress = this.dissolveMs / DISSOLVE_MS;
    }
  }

  private setShieldActive(active: boolean): void {
    if (active === this.shieldActive) return;
    this.shieldActive = active;
    this.apply();
  }

  /**
   * Recompose the filter list from whichever of the four are currently live — most of the time
   * that is none, and the actor draws unfiltered, batched with its neighbours.
   *
   * Order is warp-then-glow-then-highlight-then-dissolve: the UV wobble should distort what the
   * shell/outline draw (not the other way around), a hit flash should still read on top of an
   * active shield, and a dying actor's dissolve should be the last word regardless of what else
   * was active the instant it died. Lighting is deliberately NOT in this list (2026-08-24): it is
   * one pass over the whole scene layer, running AFTER these composite rather than underneath
   * them — see `fx/filters/litFx.ts`.
   */
  private apply(): void {
    const list: Filter[] = [];
    if (this.heatHazeActive && this.heatHazeFilter) list.push(this.heatHazeFilter);
    if (this.shieldActive && this.shieldFilter) list.push(this.shieldFilter);
    if (this.outlineMs > 0 && this.outlineFilter) list.push(this.outlineFilter);
    if (this.dissolveMs >= 0 && this.dissolveFilter) list.push(this.dissolveFilter);
    this.host.setSkinFilters(list.length ? list : null);
  }
}
