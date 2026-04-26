import { describe, it, expect, vi } from 'vitest';
import { createCallAudioCues } from './call-audio-cues.js';

// --- Minimal AudioContext fake ----------------------------------------------

interface OscRecord {
  frequencyHz: number;
  start: number;
  stop: number;
  started: boolean;
  stopped: boolean;
  type: OscillatorType;
}

interface FakeContext {
  currentTime: number;
  destinationConnected: boolean;
  oscs: OscRecord[];
}

function fakeAudioContext(): FakeContext & AudioContext {
  const oscs: OscRecord[] = [];
  const dest = { _isDest: true };
  const ctx: any = {
    currentTime: 0,
    destination: dest,
    destinationConnected: false,
    oscs,
    createOscillator() {
      const rec: OscRecord = { frequencyHz: 0, start: 0, stop: 0, started: false, stopped: false, type: 'sine' };
      oscs.push(rec);
      const node: any = {
        get type() {
          return rec.type;
        },
        set type(v: OscillatorType) {
          rec.type = v;
        },
        frequency: {
          get value() {
            return rec.frequencyHz;
          },
          set value(v: number) {
            rec.frequencyHz = v;
          },
        },
        connect(_next: any) {
          return _next;
        },
        start(t: number) {
          rec.started = true;
          rec.start = t;
        },
        stop(t: number) {
          rec.stopped = true;
          rec.stop = t;
        },
      };
      return node;
    },
    createGain() {
      const node: any = {
        gain: {
          setValueAtTime: vi.fn(),
          linearRampToValueAtTime: vi.fn(),
        },
        connect(next: any) {
          if (next === dest) ctx.destinationConnected = true;
          return next;
        },
      };
      return node;
    },
  };
  return ctx;
}

// --- Tests ------------------------------------------------------------------

describe('createCallAudioCues', () => {
  it('lazy-creates the AudioContext only on the first cue', () => {
    const factory = vi.fn(() => fakeAudioContext());
    const cues = createCallAudioCues(factory);
    expect(factory).not.toHaveBeenCalled();
    cues.playMuteOn();
    expect(factory).toHaveBeenCalledTimes(1);
    cues.playMuteOff();
    cues.playAbortConfirm();
    expect(factory).toHaveBeenCalledTimes(1);
  });

  it('playMuteOn schedules a single higher-pitched oscillator beep', () => {
    const ctx = fakeAudioContext();
    const cues = createCallAudioCues(() => ctx);
    cues.playMuteOn();
    expect(ctx.oscs).toHaveLength(1);
    expect(ctx.oscs[0].started).toBe(true);
    expect(ctx.oscs[0].stopped).toBe(true);
    expect(ctx.oscs[0].frequencyHz).toBeGreaterThan(500);
  });

  it('playMuteOff uses a lower pitch than playMuteOn', () => {
    const ctxOn = fakeAudioContext();
    const ctxOff = fakeAudioContext();
    createCallAudioCues(() => ctxOn).playMuteOn();
    createCallAudioCues(() => ctxOff).playMuteOff();
    expect(ctxOff.oscs[0].frequencyHz).toBeLessThan(ctxOn.oscs[0].frequencyHz);
  });

  it('playAbortConfirm is a double-beep (two oscillators, second starts after the first)', () => {
    const ctx = fakeAudioContext();
    createCallAudioCues(() => ctx).playAbortConfirm();
    expect(ctx.oscs).toHaveLength(2);
    expect(ctx.oscs[0].started).toBe(true);
    expect(ctx.oscs[1].started).toBe(true);
    expect(ctx.oscs[1].start).toBeGreaterThan(ctx.oscs[0].start);
  });

  it('every beep is connected through to the destination', () => {
    const ctx = fakeAudioContext();
    createCallAudioCues(() => ctx).playMuteOn();
    expect(ctx.destinationConnected).toBe(true);
  });

  it('each beep schedules a finite duration (stop > start)', () => {
    const ctx = fakeAudioContext();
    const cues = createCallAudioCues(() => ctx);
    cues.playMuteOn();
    cues.playMuteOff();
    for (const osc of ctx.oscs) {
      expect(osc.stop).toBeGreaterThan(osc.start);
    }
  });
});
