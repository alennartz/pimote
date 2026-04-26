import { describe, it, expect } from 'vitest';
import { deriveAgentState, formatCallDuration } from './call-state.js';

describe('deriveAgentState', () => {
  it('returns "listening" by default when nothing is happening', () => {
    expect(deriveAgentState({ isStreaming: false, remoteAudioLevel: 0, speakingThreshold: 0.02 })).toBe('listening');
  });

  it('returns "thinking" when the worker is streaming and no audio is playing', () => {
    expect(deriveAgentState({ isStreaming: true, remoteAudioLevel: 0, speakingThreshold: 0.02 })).toBe('thinking');
  });

  it('returns "speaking" when remoteAudioLevel exceeds the threshold', () => {
    expect(deriveAgentState({ isStreaming: false, remoteAudioLevel: 0.5, speakingThreshold: 0.02 })).toBe('speaking');
  });

  it('"speaking" wins over "thinking" — audio out is the strongest signal', () => {
    expect(deriveAgentState({ isStreaming: true, remoteAudioLevel: 0.5, speakingThreshold: 0.02 })).toBe('speaking');
  });

  it('a level exactly at the threshold is not yet "speaking"', () => {
    expect(deriveAgentState({ isStreaming: false, remoteAudioLevel: 0.02, speakingThreshold: 0.02 })).toBe('listening');
  });

  it('a level just above the threshold is "speaking"', () => {
    expect(deriveAgentState({ isStreaming: false, remoteAudioLevel: 0.021, speakingThreshold: 0.02 })).toBe('speaking');
  });
});

describe('formatCallDuration', () => {
  it('formats sub-minute durations as MM:SS', () => {
    expect(formatCallDuration(0)).toBe('00:00');
    expect(formatCallDuration(1_000)).toBe('00:01');
    expect(formatCallDuration(59_000)).toBe('00:59');
  });

  it('formats minutes and seconds', () => {
    expect(formatCallDuration(60_000)).toBe('01:00');
    expect(formatCallDuration(125_000)).toBe('02:05');
    expect(formatCallDuration(59 * 60_000 + 59_000)).toBe('59:59');
  });

  it('formats hour-plus durations as H:MM:SS', () => {
    expect(formatCallDuration(3_600_000)).toBe('1:00:00');
    expect(formatCallDuration(3_600_000 + 65_000)).toBe('1:01:05');
  });

  it('truncates sub-second remainders rather than rounding', () => {
    expect(formatCallDuration(1_900)).toBe('00:01');
    expect(formatCallDuration(59_999)).toBe('00:59');
  });

  it('clamps negative values to zero', () => {
    expect(formatCallDuration(-5_000)).toBe('00:00');
  });
});
