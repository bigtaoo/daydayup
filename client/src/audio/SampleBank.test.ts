/**
 * `SampleBank` — the loading path, against a fake asset host and a fake decoder (no network,
 * no AudioContext; the plain-node vitest convention this repo already uses for audio).
 *
 * The interesting behaviour is all in the failure cases, because this is a best-effort loader
 * by design: every one of them has to leave the game audible rather than broken, and none of
 * them may reject into boot. The "partial cue keeps its remaining variants, in order" case is
 * the one worth spelling out — a naive `Promise.all` either throws away the whole cue on one
 * bad file, or keeps the gaps and hands a null to the mixer.
 */
import { describe, it, expect, vi } from 'vitest';
import { SampleBank } from './SampleBank';
import { allSfxPaths, variantPaths } from './cueCatalogue';

/** A decoded buffer that remembers which path produced it, so variant ORDER is assertable. */
type Tagged = AudioBuffer & { path: string };

interface Harness {
  bank: SampleBank;
  reads: string[];
  warn: ReturnType<typeof vi.fn>;
}

/** @param failing paths whose READ fails; @param undecodable paths whose DECODE fails. */
function harness(failing: string[] = [], undecodable: string[] = []): Harness {
  const reads: string[] = [];
  const bytes = new Map<ArrayBuffer, string>();
  const warn = vi.fn();
  const bank = new SampleBank({
    ctx: {
      decodeAudioData: (data: ArrayBuffer) => {
        const path = bytes.get(data)!;
        if (undecodable.includes(path)) return Promise.reject(new Error(`cannot decode ${path}`));
        return Promise.resolve({ duration: 0.1, path } as Tagged);
      },
    },
    readBinary: async (path: string) => {
      reads.push(path);
      if (failing.includes(path)) throw new Error(`404 ${path}`);
      const buf = new ArrayBuffer(8);
      bytes.set(buf, path);
      return buf;
    },
    warn,
  });
  return { bank, reads, warn };
}

const pathsOf = (bank: SampleBank, cue: Parameters<SampleBank['variantsOf']>[0]) =>
  (bank.variantsOf(cue) as Tagged[] | undefined)?.map((b) => b.path);

describe('SampleBank — a clean load', () => {
  it('reads exactly the catalogued files, and nothing for a synth-only cue', () => {
    const { bank, reads } = harness();
    return bank.load().then(() => {
      expect(reads.slice().sort()).toEqual(allSfxPaths().slice().sort());
      expect(reads).toHaveLength(50);
      expect(bank.variantsOf('status.burn')).toBeUndefined();
      expect(bank.loadedCues).toBe(19);
      expect(bank.loadedVariants).toBe(50);
    });
  });

  it('keeps variants in catalogue order', async () => {
    // The mixer picks by index and remembers the last one played; a shuffled list would make
    // "never repeat the previous variant" meaningless.
    const { bank } = harness();
    await bank.load();
    expect(pathsOf(bank, 'impact')).toEqual(variantPaths('impact'));
  });
});

describe('SampleBank — per-file failure', () => {
  it('keeps a cue’s surviving variants, in order, when one file 404s', async () => {
    const { bank, warn } = harness(['/audio/impact_02.mp3']);
    await bank.load();
    expect(pathsOf(bank, 'impact')).toEqual([
      '/audio/impact_00.mp3',
      '/audio/impact_01.mp3',
      '/audio/impact_03.mp3',
      '/audio/impact_04.mp3',
    ]);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]![0]).toContain('/audio/impact_02.mp3');
  });

  it('treats an undecodable file the same as a missing one', async () => {
    const { bank, warn } = harness([], ['/audio/win_00.mp3']);
    await bank.load();
    expect(bank.variantsOf('win')).toBeUndefined(); // its only variant is gone → synth voice
    expect(bank.variantsOf('impact')).toBeDefined(); // and nothing else is affected
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('leaves a cue absent when EVERY variant fails, so the mixer falls back', async () => {
    const { bank } = harness(variantPaths('clash') as string[]);
    await bank.load();
    expect(bank.variantsOf('clash')).toBeUndefined();
    expect(bank.loadedCues).toBe(18);
  });

  it('never rejects, even when the whole set fails', async () => {
    const { bank, warn } = harness(allSfxPaths() as string[]);
    await expect(bank.load()).resolves.toBeUndefined();
    expect(bank.loadedCues).toBe(0);
    expect(warn).toHaveBeenCalledTimes(50);
  });
});

describe('SampleBank — repeat calls', () => {
  it('joins an in-flight load instead of doubling the requests', async () => {
    const { bank, reads } = harness();
    const a = bank.load();
    const b = bank.load();
    expect(a).toBe(b);
    await Promise.all([a, b]);
    expect(reads).toHaveLength(50);
  });

  it('retries only what has nothing loaded', async () => {
    // The point of retrying at all: a boot with no network yet should not be permanent. The
    // point of retrying only the gaps: a second call must not re-download 95 kB.
    const { bank, reads } = harness(variantPaths('clash') as string[]);
    await bank.load();
    reads.length = 0;
    await bank.load();
    expect(reads.slice().sort()).toEqual(variantPaths('clash').slice().sort());
  });

  it('a partial cue is NOT retried — its surviving variants are enough', async () => {
    const { bank, reads } = harness(['/audio/impact_02.mp3']);
    await bank.load();
    reads.length = 0;
    await bank.load();
    expect(reads).toEqual([]);
  });
});
