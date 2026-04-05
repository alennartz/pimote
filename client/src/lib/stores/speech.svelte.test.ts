import { describe, it, expect, beforeEach, vi } from 'vitest';
import { speak, stop, speechState } from './speech.svelte.js';

// ---------------------------------------------------------------------------
// Mock Setup — speechSynthesis & SpeechSynthesisUtterance
// ---------------------------------------------------------------------------

interface MockUtterance {
  text: string;
  onend: (() => void) | null;
  onerror: ((event: any) => void) | null;
}

let mockSpeechSynthesis: {
  speak: ReturnType<typeof vi.fn>;
  cancel: ReturnType<typeof vi.fn>;
};

let createdUtterances: MockUtterance[];

beforeEach(() => {
  createdUtterances = [];
  speechState.playingKey = null;

  mockSpeechSynthesis = {
    speak: vi.fn(),
    cancel: vi.fn(),
  };

  const MockUtteranceConstructor = vi.fn(function (this: MockUtterance, text: string) {
    this.text = text;
    this.onend = null;
    this.onerror = null;
    createdUtterances.push(this);
  });

  vi.stubGlobal('speechSynthesis', mockSpeechSynthesis);
  vi.stubGlobal('SpeechSynthesisUtterance', MockUtteranceConstructor);
});

// ---------------------------------------------------------------------------
// Helper: read the reactive playingKey from speechState
// ---------------------------------------------------------------------------
// speechState is a $state() object — property reads go through Svelte's
// reactive proxy. In tests we read it directly for assertions.

function getPlayingKey(): string | null {
  return speechState.playingKey;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('speech store', () => {
  // --------------------------------------------------------------------------
  // speak() — basic playback
  // --------------------------------------------------------------------------
  describe('speak() starts playback', () => {
    it('sets playingKey to the provided messageKey', () => {
      speak('Hello world', 'msg-1');
      expect(getPlayingKey()).toBe('msg-1');
    });

    it('calls speechSynthesis.speak with an utterance', () => {
      speak('Hello world', 'msg-1');
      expect(mockSpeechSynthesis.speak).toHaveBeenCalled();
      expect(createdUtterances.length).toBeGreaterThanOrEqual(1);
      expect(createdUtterances[0].text).toBe('Hello world');
    });
  });

  // --------------------------------------------------------------------------
  // speak() — stops previous playback first
  // --------------------------------------------------------------------------
  describe('speak() stops previous playback first', () => {
    it('calls speechSynthesis.cancel() before starting new playback when already playing', () => {
      speak('First message', 'msg-1');
      speak('Second message', 'msg-2');
      expect(mockSpeechSynthesis.cancel).toHaveBeenCalled();
    });

    it('updates playingKey to the new messageKey', () => {
      speak('First message', 'msg-1');
      speak('Second message', 'msg-2');
      expect(getPlayingKey()).toBe('msg-2');
    });
  });

  // --------------------------------------------------------------------------
  // speak() — paragraph chunking
  // --------------------------------------------------------------------------
  describe('speak() chunks text at paragraph boundaries', () => {
    it('splits on double newlines and creates multiple utterances', () => {
      const text = 'First paragraph.\n\nSecond paragraph.\n\nThird paragraph.';
      speak(text, 'msg-1');
      expect(createdUtterances).toHaveLength(3);
      expect(createdUtterances[0].text).toBe('First paragraph.');
      expect(createdUtterances[1].text).toBe('Second paragraph.');
      expect(createdUtterances[2].text).toBe('Third paragraph.');
    });

    it('queues all chunks via speechSynthesis.speak', () => {
      const text = 'Para one.\n\nPara two.';
      speak(text, 'msg-1');
      expect(mockSpeechSynthesis.speak).toHaveBeenCalledTimes(2);
    });

    it('handles text with no paragraph breaks as a single chunk', () => {
      speak('Just one paragraph with no breaks.', 'msg-1');
      expect(createdUtterances).toHaveLength(1);
      expect(createdUtterances[0].text).toBe('Just one paragraph with no breaks.');
    });

    it('trims whitespace from chunks', () => {
      const text = '  First paragraph.  \n\n  Second paragraph.  ';
      speak(text, 'msg-1');
      expect(createdUtterances.length).toBeGreaterThanOrEqual(2);
      expect(createdUtterances[0].text).toBe('First paragraph.');
      expect(createdUtterances[1].text).toBe('Second paragraph.');
    });

    it('skips empty chunks from multiple consecutive double newlines', () => {
      const text = 'First.\n\n\n\nSecond.';
      speak(text, 'msg-1');
      // Should produce 2 chunks (not empty ones in between)
      const nonEmptyUtterances = createdUtterances.filter((u) => u.text.trim() !== '');
      expect(nonEmptyUtterances).toHaveLength(2);
    });
  });

  // --------------------------------------------------------------------------
  // stop() — cancels playback
  // --------------------------------------------------------------------------
  describe('stop() cancels playback', () => {
    it('calls speechSynthesis.cancel()', () => {
      speak('Hello', 'msg-1');
      stop();
      expect(mockSpeechSynthesis.cancel).toHaveBeenCalled();
    });

    it('resets playingKey to null', () => {
      speak('Hello', 'msg-1');
      stop();
      expect(getPlayingKey()).toBeNull();
    });
  });

  // --------------------------------------------------------------------------
  // stop() — boundary: nothing playing
  // --------------------------------------------------------------------------
  describe('stop() when nothing is playing', () => {
    it('does not throw', () => {
      expect(() => stop()).not.toThrow();
    });

    it('playingKey remains null', () => {
      stop();
      expect(getPlayingKey()).toBeNull();
    });
  });

  // --------------------------------------------------------------------------
  // Playback completion resets state
  // --------------------------------------------------------------------------
  describe('playback completion resets state', () => {
    it('playingKey becomes null when the last utterance fires onend', () => {
      speak('Hello world', 'msg-1');
      expect(getPlayingKey()).toBe('msg-1');

      // Simulate the utterance finishing
      const utterance = createdUtterances[0];
      expect(utterance.onend).toBeTypeOf('function');
      utterance.onend!();

      expect(getPlayingKey()).toBeNull();
    });

    it('playingKey stays set until the LAST chunk finishes for multi-chunk text', () => {
      speak('Para one.\n\nPara two.\n\nPara three.', 'msg-1');
      expect(createdUtterances).toHaveLength(3);

      // First chunk ends — still playing
      createdUtterances[0].onend!();
      expect(getPlayingKey()).toBe('msg-1');

      // Second chunk ends — still playing
      createdUtterances[1].onend!();
      expect(getPlayingKey()).toBe('msg-1');

      // Last chunk ends — done
      createdUtterances[2].onend!();
      expect(getPlayingKey()).toBeNull();
    });
  });

  // --------------------------------------------------------------------------
  // Error resets state
  // --------------------------------------------------------------------------
  describe('error resets state', () => {
    it('playingKey becomes null when utterance fires onerror', () => {
      speak('Hello world', 'msg-1');
      expect(getPlayingKey()).toBe('msg-1');

      const utterance = createdUtterances[0];
      expect(utterance.onerror).toBeTypeOf('function');
      utterance.onerror!({ error: 'synthesis-failed' });

      expect(getPlayingKey()).toBeNull();
    });

    it('onerror on any chunk resets playingKey for multi-chunk text', () => {
      speak('Para one.\n\nPara two.', 'msg-1');
      expect(createdUtterances).toHaveLength(2);

      // Error on the first chunk should still reset everything
      createdUtterances[0].onerror!({ error: 'network' });
      expect(getPlayingKey()).toBeNull();
    });
  });

  // --------------------------------------------------------------------------
  // speak() with new message while playing replaces current
  // --------------------------------------------------------------------------
  describe('speak() with new message while playing replaces current', () => {
    it('playingKey updates to the new messageKey', () => {
      speak('First text', 'msg-1');
      expect(getPlayingKey()).toBe('msg-1');

      speak('Second text', 'msg-2');
      expect(getPlayingKey()).toBe('msg-2');
    });

    it('cancels previous synthesis before starting new', () => {
      speak('First text', 'msg-1');
      const cancelCountBefore = mockSpeechSynthesis.cancel.mock.calls.length;

      speak('Second text', 'msg-2');
      expect(mockSpeechSynthesis.cancel.mock.calls.length).toBeGreaterThan(cancelCountBefore);
    });

    it('onend of old utterance does NOT reset playingKey if new message started', () => {
      speak('First text', 'msg-1');
      const oldUtterance = createdUtterances[0];

      speak('Second text', 'msg-2');
      expect(getPlayingKey()).toBe('msg-2');

      // Old utterance fires onend (e.g., browser cancel event) — should NOT clear key
      oldUtterance.onend?.();
      expect(getPlayingKey()).toBe('msg-2');
    });
  });

  // --------------------------------------------------------------------------
  // Boundary: empty text
  // --------------------------------------------------------------------------
  describe('speak() with empty text', () => {
    it('does not create any utterances', () => {
      speak('', 'msg-1');
      const nonEmptyUtterances = createdUtterances.filter((u) => u.text.trim() !== '');
      expect(nonEmptyUtterances).toHaveLength(0);
    });

    it('does not call speechSynthesis.speak', () => {
      speak('', 'msg-1');
      expect(mockSpeechSynthesis.speak).not.toHaveBeenCalled();
    });

    it('does not set playingKey', () => {
      speak('', 'msg-1');
      expect(getPlayingKey()).toBeNull();
    });
  });

  // --------------------------------------------------------------------------
  // Boundary: consecutive speak() calls with different messageKeys
  // --------------------------------------------------------------------------
  describe('consecutive speak() calls with different messageKeys', () => {
    it('each call updates playingKey to the latest messageKey', () => {
      speak('Text A', 'msg-a');
      expect(getPlayingKey()).toBe('msg-a');

      speak('Text B', 'msg-b');
      expect(getPlayingKey()).toBe('msg-b');

      speak('Text C', 'msg-c');
      expect(getPlayingKey()).toBe('msg-c');
    });

    it('speechSynthesis.cancel is called between successive speak() calls', () => {
      speak('Text A', 'msg-a');
      speak('Text B', 'msg-b');
      speak('Text C', 'msg-c');

      // cancel should be called at least twice (before msg-b and msg-c)
      expect(mockSpeechSynthesis.cancel.mock.calls.length).toBeGreaterThanOrEqual(2);
    });

    it('only the final message completion resets playingKey', () => {
      speak('Text A', 'msg-a');
      speak('Text B', 'msg-b');
      speak('Text C', 'msg-c');

      // Complete old utterances — should not reset playingKey
      for (const u of createdUtterances.slice(0, -1)) {
        u.onend?.();
      }
      expect(getPlayingKey()).toBe('msg-c');

      // Complete the last utterance
      createdUtterances[createdUtterances.length - 1].onend?.();
      expect(getPlayingKey()).toBeNull();
    });
  });
});
