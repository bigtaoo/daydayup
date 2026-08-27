// One promise-shaped `decodeAudioData`, over two runtimes that disagree about its shape.
//
// The browser's WebAudio `decodeAudioData` RETURNS a promise (and still accepts the older
// success/error callbacks). WeChat's `wx.createWebAudioContext()` is documented as the same
// Web Audio surface, but its `decodeAudioData` is the callback form, and the base library
// version that starts returning a promise is not something this repo can pin — so assuming
// either shape would leave one target loading nothing, silently, and falling back to the
// synth voices forever. That is exactly the failure this whole pass exists to end, and it
// would look identical to "it works".
//
// So: pass the callbacks AND adopt a returned promise, whichever arrives first wins, and a
// synchronous throw becomes a rejection like any other failure.

/** The single method this needs — declared structurally so a real `AudioContext`, a WeChat
 *  `WebAudioContext` and a test fake are all acceptable. The return type is deliberately
 *  wider than the DOM lib's `Promise<AudioBuffer>`: WeChat's may return nothing at all. */
export interface AudioDecoder {
  decodeAudioData(
    data: ArrayBuffer,
    success?: (buffer: AudioBuffer) => void,
    error?: (err: unknown) => void,
  ): Promise<AudioBuffer> | undefined | void;
}

export function decodeAudio(ctx: AudioDecoder, data: ArrayBuffer): Promise<AudioBuffer> {
  return new Promise<AudioBuffer>((resolve, reject) => {
    // Both shapes can fire, and a promise implementation may ALSO invoke the callbacks.
    // Promise semantics already ignore a second settle, but the flag keeps that explicit
    // rather than incidental.
    let settled = false;
    const ok = (buffer: AudioBuffer): void => {
      if (settled) return;
      settled = true;
      resolve(buffer);
    };
    const fail = (err: unknown): void => {
      if (settled) return;
      settled = true;
      reject(err instanceof Error ? err : new Error(String(err ?? 'decodeAudioData failed')));
    };

    let returned: Promise<AudioBuffer> | undefined | void;
    try {
      returned = ctx.decodeAudioData(data, ok, fail);
    } catch (err) {
      // A runtime that rejects the callback form outright throws here rather than calling
      // `error` — treat it as this file's failure, not as an unhandled boot exception.
      fail(err);
      return;
    }
    if (returned && typeof (returned as Promise<AudioBuffer>).then === 'function') {
      (returned as Promise<AudioBuffer>).then(ok, fail);
    }
  });
}
