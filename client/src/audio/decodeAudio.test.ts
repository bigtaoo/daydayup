/**
 * `decodeAudio` — the one place two runtimes' `decodeAudioData` shapes are reconciled.
 *
 * Every case here is a shape a real host actually presents: the browser's promise (which
 * also honours the legacy callbacks), WeChat's documented callback form with no return value,
 * and the failure modes of both. Worth its own file because getting this wrong is invisible:
 * a promise never adopted, or a callback never wired, leaves `SampleBank` waiting forever and
 * the game playing its synth voices — which is exactly what it does when everything is fine,
 * only quieter about it.
 */
import { describe, it, expect, vi } from 'vitest';
import { decodeAudio, type AudioDecoder } from './decodeAudio';

const BYTES = new ArrayBuffer(16);
const BUFFER = { duration: 0.1 } as unknown as AudioBuffer;

describe('decodeAudio — promise-returning hosts (browser WebAudio)', () => {
  it('resolves with the decoded buffer', async () => {
    const ctx: AudioDecoder = { decodeAudioData: () => Promise.resolve(BUFFER) };
    await expect(decodeAudio(ctx, BYTES)).resolves.toBe(BUFFER);
  });

  it('rejects when the promise rejects, wrapping a non-Error reason', async () => {
    const ctx: AudioDecoder = { decodeAudioData: () => Promise.reject('EncodingError') };
    await expect(decodeAudio(ctx, BYTES)).rejects.toThrow('EncodingError');
  });
});

describe('decodeAudio — callback-only hosts (WeChat WebAudioContext)', () => {
  it('resolves from the success callback even with no return value', async () => {
    const ctx: AudioDecoder = {
      decodeAudioData: (_data, success) => {
        success?.(BUFFER);
      },
    };
    await expect(decodeAudio(ctx, BYTES)).resolves.toBe(BUFFER);
  });

  it('resolves from an ASYNCHRONOUS success callback', async () => {
    // The realistic case — a decoder that returns immediately and calls back later. A
    // synchronous-only test would pass against an implementation that never resolves.
    const ctx: AudioDecoder = {
      decodeAudioData: (_data, success) => {
        setTimeout(() => success?.(BUFFER), 0);
      },
    };
    await expect(decodeAudio(ctx, BYTES)).resolves.toBe(BUFFER);
  });

  it('rejects from the error callback', async () => {
    const ctx: AudioDecoder = {
      decodeAudioData: (_data, _success, error) => {
        error?.(new Error('unsupported format'));
      },
    };
    await expect(decodeAudio(ctx, BYTES)).rejects.toThrow('unsupported format');
  });

  it('rejects rather than throwing when the call itself throws', async () => {
    const ctx: AudioDecoder = {
      decodeAudioData: () => {
        throw new TypeError('callback form not supported');
      },
    };
    // A throw here would escape SampleBank's per-file try into boot, so the shape of the
    // failure matters as much as the fact of it.
    await expect(decodeAudio(ctx, BYTES)).rejects.toThrow('callback form not supported');
  });
});

describe('decodeAudio — a host that does both', () => {
  it('settles once, on whichever path fired first', async () => {
    const later = { duration: 9 } as unknown as AudioBuffer;
    const ctx: AudioDecoder = {
      decodeAudioData: (_data, success) => {
        success?.(BUFFER); // callback first...
        return Promise.resolve(later); // ...and the promise too, with a different buffer
      },
    };
    await expect(decodeAudio(ctx, BYTES)).resolves.toBe(BUFFER);
  });

  it('a late rejection after a successful callback does not surface', async () => {
    const onUnhandled = vi.fn();
    const ctx: AudioDecoder = {
      decodeAudioData: (_data, success) => {
        success?.(BUFFER);
        return Promise.reject(new Error('too late'));
      },
    };
    await expect(decodeAudio(ctx, BYTES)).resolves.toBe(BUFFER);
    expect(onUnhandled).not.toHaveBeenCalled();
  });

  it('passes the bytes through unchanged', () => {
    const spy = vi.fn(() => Promise.resolve(BUFFER));
    void decodeAudio({ decodeAudioData: spy }, BYTES);
    expect(spy).toHaveBeenCalledWith(BYTES, expect.any(Function), expect.any(Function));
  });
});
