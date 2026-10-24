// The `AudioContext` is lazy-initialised on first use because some browsers
// require a user gesture before instantiating one. Every cue here is invoked
// from a tap/swipe handler, so that requirement is met by construction.

export interface CallAudioCues {
  /** Higher-pitched short beep — played when the mic transitions to muted. */
  playMuteOn(): void;
  /** Lower-pitched short beep — played when the mic transitions to unmuted. */
  playMuteOff(): void;
  /** Distinct double-beep — played to confirm an agent abort. */
  playAbortConfirm(): void;
  /** Close the underlying AudioContext (if one was created) and release it.
   *  Browsers cap concurrent AudioContexts, so this must run when the owning
   *  component unmounts. Idempotent and safe to call before any cue played. */
  dispose(): void;
}

/**
 * Build the cues bound to a single `AudioContext`.
 *
 * @param audioContextFactory Test seam: returns the `AudioContext` to use.
 *        Defaults to `new AudioContext()` in browsers. The factory is
 *        invoked at most once — the returned context is cached and reused
 *        for subsequent cues.
 */
export function createCallAudioCues(audioContextFactory?: () => AudioContext): CallAudioCues {
  const factory = audioContextFactory ?? (() => new AudioContext());
  let ctx: AudioContext | null = null;

  const ensureCtx = (): AudioContext => {
    if (!ctx) ctx = factory();
    return ctx;
  };

  const beep = (frequencyHz: number, durationMs: number, startOffsetMs = 0): void => {
    const c = ensureCtx();
    const osc = c.createOscillator();
    const gain = c.createGain();
    osc.type = 'sine';
    osc.frequency.value = frequencyHz;

    const start = c.currentTime + startOffsetMs / 1000;
    const end = start + durationMs / 1000;
    gain.gain.setValueAtTime(0, start);
    gain.gain.linearRampToValueAtTime(0.4, start + 0.005);
    gain.gain.linearRampToValueAtTime(0, end);

    osc.connect(gain).connect(c.destination);
    osc.start(start);
    osc.stop(end);
  };

  return {
    playMuteOn(): void {
      beep(880, 80);
    },
    playMuteOff(): void {
      beep(440, 80);
    },
    playAbortConfirm(): void {
      beep(660, 80, 0);
      beep(660, 80, 120);
    },
    dispose(): void {
      if (ctx) {
        void ctx.close().catch(() => {});
        ctx = null;
      }
    },
  };
}
