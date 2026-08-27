// The loading path (design/11 "Asset pipeline & loading"): cue ids in, decoded PCM out.
//
// Reaches the files through the SAME platform seam as the art (`render/assetHost.ts`), which
// is what makes one implementation cover both targets: on web `readBinary` is a `fetch`, on
// WeChat it is `FileSystemManager.readFileSync` on a package path rewritten by
// `assetManifest.packedPathFor`. Audio therefore inherits the design/12 bundle rules for
// free — a future music subpackage is a prefix rule in `assetPacks.json`, not code here.
//
// Everything is best-effort PER FILE, the same rule the art preload follows ("gameplay is
// never blocked on art", design/02/12) — with one difference that matters: a missing texture
// leaves a placeholder rectangle, while a missing sample leaves the synth voice that shipped
// before this pass. Degrading is therefore genuinely cheap here, and never worth a throw.
import type { AudioCue } from '../platform/types';
import { ALL_CUES, variantPaths } from './cueCatalogue';
import { decodeAudio, type AudioDecoder } from './decodeAudio';

export interface SampleBankDeps {
  /** Decodes compressed bytes into PCM. A real `AudioContext` decodes fine while still
   *  SUSPENDED, which is why the boot preload does not have to wait for the autoplay
   *  gesture (design/11 autoplay gate). */
  ctx: AudioDecoder;
  /** Platform read for a public-relative path — `render/assetHost.ts`'s `readBinaryAsset`. */
  readBinary(path: string): Promise<ArrayBuffer>;
  /** Where a per-file failure is reported. Defaults to `console.warn`; tests pass their own. */
  warn?(message: string, err: unknown): void;
}

export class SampleBank {
  /** Decoded variants per cue, in variant order. A cue is absent until at least one of its
   *  files has decoded — `CueMixer` reads absence as "use the synth voice". */
  private readonly buffers = new Map<AudioCue, AudioBuffer[]>();
  private inFlight: Promise<void> | null = null;

  constructor(private readonly deps: SampleBankDeps) {}

  /**
   * Fetch + decode every catalogued sample. Safe to call more than once: a second call
   * retries only the cues that have nothing loaded (a partial or total failure, e.g. the
   * network was down at boot), and a call while a load is still running joins it rather
   * than doubling the requests.
   */
  load(): Promise<void> {
    if (this.inFlight) return this.inFlight;
    const pending = ALL_CUES.filter((cue) => !this.buffers.has(cue) && variantPaths(cue).length > 0);
    this.inFlight = Promise.all(pending.map((cue) => this.loadCue(cue)))
      .then(() => undefined)
      .finally(() => {
        this.inFlight = null;
      });
    return this.inFlight;
  }

  private async loadCue(cue: AudioCue): Promise<void> {
    const decoded = await Promise.all(
      variantPaths(cue).map(async (path) => {
        try {
          return await decodeAudio(this.deps.ctx, await this.deps.readBinary(path));
        } catch (err) {
          this.warn(`audio: ${path} failed to load — that variant falls back to the synth voice`, err);
          return null;
        }
      }),
    );
    // Variant ORDER survives (Promise.all preserves it) and a failed variant simply is not
    // there, so a cue with 3 of 5 files still plays three-way variation instead of nothing.
    const usable = decoded.filter((b): b is AudioBuffer => b !== null);
    if (usable.length > 0) this.buffers.set(cue, usable);
  }

  private warn(message: string, err: unknown): void {
    if (this.deps.warn) this.deps.warn(message, err);
    else console.warn(message, err);
  }

  /** This cue's decoded variants, or undefined when it has none (synth-only, not loaded
   *  yet, or every file failed). */
  variantsOf(cue: AudioCue): readonly AudioBuffer[] | undefined {
    return this.buffers.get(cue);
  }

  /** How many cues currently have at least one decoded sample — the honest answer to
   *  "is the shipped set actually audible", used by the boot log. */
  get loadedCues(): number {
    return this.buffers.size;
  }

  /** Total decoded variants across every cue. */
  get loadedVariants(): number {
    let n = 0;
    for (const list of this.buffers.values()) n += list.length;
    return n;
  }
}
