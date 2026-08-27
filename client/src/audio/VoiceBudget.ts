// The concurrency cap (design/11 "Concurrency-capped, priority-mixed").
//
// Pure bookkeeping over "how many sample voices are sounding right now, and which is the
// most expendable" — no WebAudio types, so it is testable with plain numbers.
//
// Voices are retired by TIME, not by an `ended` event. Every claim states when its sample
// finishes, and the next claim purges whatever has passed. That is deliberate: `onended`
// exists in the browser but is one more thing to verify on a WeChat base library this repo
// cannot pin (design/11's open item 1), and a cap that silently stopped purging would fail
// closed — the mix would go quiet after the first N cues and look like "audio broke".
// A clip's length is already known before it starts, so this needs nothing from the runtime
// but its clock.

interface LiveVoice {
  priority: number;
  /** Context time (seconds) at which this voice stops being audible. */
  until: number;
  /** Cuts this voice short when a higher-priority cue steals its slot. */
  stop(): void;
}

export class VoiceBudget {
  private readonly live: LiveVoice[] = [];

  /** @param cap Maximum simultaneous sample voices. */
  constructor(private readonly cap: number) {}

  /**
   * Ask for a slot at `now` for a voice of `priority` that finishes at `until`.
   *
   * Returns false when the cap is full and this cue does not OUTRANK the weakest voice still
   * playing — the caller then plays nothing (design/11 "drop by a per-cue priority"). Equal
   * priority loses on purpose: at the cap, the `muzzle` already sounding is worth as much as
   * the next `muzzle`, and stealing it would only add a click. When the newcomer does
   * outrank, the weakest voice is stopped (oldest first among equals) and its slot handed on.
   */
  claim(priority: number, now: number, until: number, stop: () => void): boolean {
    this.purge(now);
    if (this.live.length >= this.cap) {
      // A cap of 0 (or a cap already met by nothing, which cannot happen above 0) leaves
      // nothing to steal — refuse rather than index into an empty list.
      if (this.live.length === 0) return false;
      let weakest = 0;
      for (let i = 1; i < this.live.length; i++) {
        if (this.live[i]!.priority < this.live[weakest]!.priority) weakest = i;
      }
      if (this.live[weakest]!.priority >= priority) return false;
      this.live[weakest]!.stop();
      this.live.splice(weakest, 1);
    }
    this.live.push({ priority, until, stop });
    return true;
  }

  private purge(now: number): void {
    for (let i = this.live.length - 1; i >= 0; i--) {
      if (this.live[i]!.until <= now) this.live.splice(i, 1);
    }
  }

  /** Voices still held, WITHOUT purging first (a caller that wants the count at a given
   *  moment passes that moment to `claim`). Exposed for tests and diagnostics. */
  get held(): number {
    return this.live.length;
  }
}
