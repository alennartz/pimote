// Tests for VoiceCallStore — exercises the phase state machine through the
// injected seams (sendCommand / createPeerConnection / getUserMedia /
// openSignaling) without any real WebRTC or WebSockets.

import { describe, it, expect, vi } from 'vitest';
import { VoiceCallStore, type VoiceCallSeams, type VoicePeerConnection, type VoiceSignalingSocket } from './voice-call.svelte.js';
import type { CallBindResponse, PimoteResponse } from '@pimote/shared';

// --- Fakes -------------------------------------------------------------------

function fakePeer(): VoicePeerConnection & { closed: boolean; tracks: unknown[] } {
  const state = { closed: false, tracks: [] as unknown[] };
  return {
    ...state,
    close() {
      (this as any).closed = true;
    },
    addTrack(track: unknown) {
      (this as any).tracks.push(track);
    },
  } as any;
}

function fakeSignaling(): VoiceSignalingSocket & { closed: boolean; sent: unknown[] } {
  let resolveOpen!: () => void;
  const opened = new Promise<void>((r) => (resolveOpen = r));
  // Open immediately — mirrors the way WS onopen fires in a microtask.
  queueMicrotask(() => resolveOpen());
  const listeners: Array<(msg: unknown) => void> = [];
  const ws: any = {
    closed: false,
    sent: [] as unknown[],
    opened,
    send(msg: unknown) {
      this.sent.push(msg);
    },
    close() {
      this.closed = true;
    },
    onMessage(l: (msg: unknown) => void) {
      listeners.push(l);
      return () => {
        const idx = listeners.indexOf(l);
        if (idx >= 0) listeners.splice(idx, 1);
      };
    },
  };
  return ws;
}

function bindResponseData(): Omit<CallBindResponse, 'type' | 'id'> {
  return {
    sessionId: 's-1',
    webrtcSignalUrl: 'wss://speechmux/signal',
    callToken: 'tok',
    turn: { urls: ['turn:example.com'], username: 'u', credential: 'c' },
  };
}

function okResponse<T>(data: T): PimoteResponse<T> {
  return { id: 'r', success: true, data };
}

function errResponse(error: string): PimoteResponse<never> {
  return { id: 'r', success: false, error } as PimoteResponse<never>;
}

function setupStore(overrides: Partial<VoiceCallSeams> = {}) {
  const peer = fakePeer();
  const sig = fakeSignaling();
  const seams: VoiceCallSeams = {
    sendCommand: vi.fn(async () => okResponse(bindResponseData())) as any,
    createPeerConnection: vi.fn(() => peer),
    getUserMedia: vi.fn(async () => ({ stream: { id: 'stream' }, tracks: [{ kind: 'audio' }] })),
    openSignaling: vi.fn(() => sig),
    ...overrides,
  };
  const store = new VoiceCallStore(seams);
  return { store, seams, peer, sig };
}

// =============================================================================

describe('VoiceCallStore.startCall', () => {
  it('initial state is idle', () => {
    const { store } = setupStore();
    expect(store.state).toEqual({ phase: 'idle', sessionId: null, micMuted: false, lastError: null });
  });

  it('happy path: idle → binding → connecting, sends call_bind, opens peer + signalling', async () => {
    const { store, seams, peer, sig } = setupStore();
    await store.startCall('s-1');

    expect(store.state.phase).toBe('connecting');
    expect(store.state.sessionId).toBe('s-1');
    expect(store.state.lastError).toBeNull();

    expect(seams.sendCommand).toHaveBeenCalledWith(expect.objectContaining({ type: 'call_bind', sessionId: 's-1' }));
    expect(seams.createPeerConnection).toHaveBeenCalledTimes(1);
    expect(seams.getUserMedia).toHaveBeenCalledTimes(1);
    expect(seams.openSignaling).toHaveBeenCalledWith('wss://speechmux/signal', 'tok');
    expect(peer.tracks).toHaveLength(1);
    expect(sig.closed).toBe(false);
  });

  it('refuses to start a second call while one is in progress', async () => {
    const { store } = setupStore();
    await store.startCall('s-1');
    await expect(store.startCall('s-2')).rejects.toThrow('voice_call_already_in_progress');
  });

  it('server rejection returns store to idle and records error', async () => {
    const { store } = setupStore({ sendCommand: vi.fn(async () => errResponse('call_bind_failed_owned')) as any });
    await expect(store.startCall('s-1')).rejects.toThrow('call_bind_failed_owned');
    expect(store.state.phase).toBe('idle');
    expect(store.state.lastError).toBe('call_bind_failed_owned');
  });

  it('getUserMedia failure tears down the peer and returns to idle', async () => {
    const peer = fakePeer();
    const { store } = setupStore({
      createPeerConnection: () => peer,
      getUserMedia: vi.fn(async () => {
        throw new Error('no-mic');
      }),
    });
    await expect(store.startCall('s-1')).rejects.toThrow('no-mic');
    expect(peer.closed).toBe(true);
    expect(store.state.phase).toBe('idle');
    expect(store.state.lastError).toBe('no-mic');
  });

  it('signalling failure tears down peer and returns to idle', async () => {
    const peer = fakePeer();
    const { store } = setupStore({
      createPeerConnection: () => peer,
      openSignaling: () => {
        throw new Error('ws-fail');
      },
    });
    await expect(store.startCall('s-1')).rejects.toThrow('ws-fail');
    expect(peer.closed).toBe(true);
    expect(store.state.phase).toBe('idle');
  });
});

describe('VoiceCallStore.handleServerEvent', () => {
  it('call_ready moves connecting → connected', async () => {
    const { store } = setupStore();
    await store.startCall('s-1');
    store.handleServerEvent({ type: 'call_ready', sessionId: 's-1' });
    expect(store.state.phase).toBe('connected');
  });

  it('call_ready for a different session is ignored', async () => {
    const { store } = setupStore();
    await store.startCall('s-1');
    store.handleServerEvent({ type: 'call_ready', sessionId: 's-other' });
    expect(store.state.phase).toBe('connecting');
  });

  it('call_ended returns store to idle and tears down the peer', async () => {
    const { store, peer, sig } = setupStore();
    await store.startCall('s-1');
    store.handleServerEvent({ type: 'call_ended', sessionId: 's-1', reason: 'user_hangup' });
    expect(store.state.phase).toBe('idle');
    expect(store.state.sessionId).toBeNull();
    expect(peer.closed).toBe(true);
    expect(sig.closed).toBe(true);
  });

  it('call_ended with reason=error records lastError', async () => {
    const { store } = setupStore();
    await store.startCall('s-1');
    store.handleServerEvent({ type: 'call_ended', sessionId: 's-1', reason: 'error' });
    expect(store.state.lastError).toBe('call_ended_error');
  });

  it('call_status ringing nudges binding → connecting', async () => {
    const { store } = setupStore({
      // Stall the bind so we can observe a ringing event in binding phase.
      sendCommand: vi.fn(async () => new Promise(() => {})) as any,
    });
    const startPromise = store.startCall('s-1').catch(() => {});
    // Micro-tick to let phase flip to 'binding'.
    await Promise.resolve();
    expect(store.state.phase).toBe('binding');
    store.handleServerEvent({ type: 'call_status', sessionId: 's-1', status: 'ringing' });
    expect(store.state.phase).toBe('connecting');
    void startPromise;
  });

  it('call_status connected does not regress a connected phase', async () => {
    const { store } = setupStore();
    await store.startCall('s-1');
    store.handleServerEvent({ type: 'call_ready', sessionId: 's-1' });
    store.handleServerEvent({ type: 'call_status', sessionId: 's-1', status: 'binding' });
    expect(store.state.phase).toBe('connected');
  });
});

describe('VoiceCallStore.endCall', () => {
  it('sends call_end, tears down, returns to idle', async () => {
    const { store, seams, peer } = setupStore();
    await store.startCall('s-1');
    await store.endCall();
    expect(store.state.phase).toBe('idle');
    expect(peer.closed).toBe(true);
    expect(seams.sendCommand).toHaveBeenLastCalledWith(expect.objectContaining({ type: 'call_end', sessionId: 's-1' }));
  });

  it('idempotent — endCall from idle is a no-op', async () => {
    const { store, seams } = setupStore();
    await store.endCall();
    expect(store.state.phase).toBe('idle');
    expect(seams.sendCommand).not.toHaveBeenCalled();
  });

  it('tears down locally even when the server call_end command fails', async () => {
    const { store, peer, sig } = setupStore({
      sendCommand: vi.fn(async (cmd: any) => {
        if (cmd.type === 'call_bind') return okResponse(bindResponseData());
        throw new Error('ws-down');
      }) as any,
    });
    await store.startCall('s-1');
    await store.endCall();
    expect(store.state.phase).toBe('idle');
    expect(peer.closed).toBe(true);
    expect(sig.closed).toBe(true);
  });
});

describe('VoiceCallStore.toggleMute', () => {
  it('toggles mic muted while a call is active', async () => {
    const { store } = setupStore();
    await store.startCall('s-1');
    expect(store.state.micMuted).toBe(false);
    store.toggleMute();
    expect(store.state.micMuted).toBe(true);
    store.toggleMute();
    expect(store.state.micMuted).toBe(false);
  });

  it('is a no-op when idle', () => {
    const { store } = setupStore();
    store.toggleMute();
    expect(store.state.micMuted).toBe(false);
  });
});
