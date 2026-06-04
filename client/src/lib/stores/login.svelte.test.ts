// Tests for LoginStore — exercises the provider-login flow state machine through
// the injected sendCommand seam without any real WebSocket.

import { describe, it, expect, vi } from 'vitest';
import { LoginStore, type LoginStoreSeams } from './login.svelte.js';
import type { LoginStep, LoginProviderInfo, PimoteCommand, PimoteResponse } from '@pimote/shared';

// --- Fakes -------------------------------------------------------------------

function okResponse<T>(data: T): PimoteResponse<T> {
  return { id: 'r', success: true, data };
}

const PROVIDERS: LoginProviderInfo[] = [
  { id: 'anthropic', name: 'Claude', loggedIn: false },
  { id: 'openai', name: 'ChatGPT', loggedIn: true },
];

interface SetupOptions {
  providers?: LoginProviderInfo[];
  /** Response for login_begin (defaults to { ok: true }). */
  beginData?: { ok: boolean; reason?: 'busy' };
  viewedSessionId?: string | null;
}

function setupStore(opts: SetupOptions = {}) {
  const sent: PimoteCommand[] = [];
  const sendCommand = vi.fn(async (cmd: PimoteCommand): Promise<PimoteResponse> => {
    sent.push(cmd);
    switch (cmd.type) {
      case 'login_list':
        return okResponse({ providers: opts.providers ?? PROVIDERS });
      case 'login_begin':
        return okResponse(opts.beginData ?? { ok: true });
      default:
        return okResponse({});
    }
  });
  const seams: LoginStoreSeams = {
    sendCommand: sendCommand as unknown as LoginStoreSeams['sendCommand'],
    getViewedSessionId: () => (opts.viewedSessionId === undefined ? 's-1' : opts.viewedSessionId),
  };
  const store = new LoginStore(seams);
  return { store, seams, sendCommand, sent };
}

function commandTypes(sent: PimoteCommand[]): string[] {
  return sent.map((c) => c.type);
}

// =============================================================================
// open / listing
// =============================================================================

describe('LoginStore.open', () => {
  it('sends a login_list command', async () => {
    const { store, sent } = setupStore();
    await store.open();
    expect(commandTypes(sent)).toContain('login_list');
  });

  it('populates the provider list from the response', async () => {
    const { store } = setupStore();
    await store.open();
    expect(store.state.providers.map((p) => p.id)).toEqual(['anthropic', 'openai']);
  });

  it('moves the flow to picking after listing', async () => {
    const { store } = setupStore();
    await store.open();
    expect(store.state.flow).toBe('picking');
  });
});

// =============================================================================
// begin / running
// =============================================================================

describe('LoginStore.begin', () => {
  it('sends a login_begin command carrying the provider id', async () => {
    const { store, sent } = setupStore();
    await store.open();
    await store.begin('anthropic');
    const begin = sent.find((c) => c.type === 'login_begin');
    expect(begin).toMatchObject({ type: 'login_begin', providerId: 'anthropic' });
  });

  it('moves the flow to running when the server accepts the begin', async () => {
    const { store } = setupStore();
    await store.open();
    await store.begin('anthropic');
    expect(store.state.flow).toBe('running');
  });

  it('returns true when the server accepts the begin', async () => {
    const { store } = setupStore();
    await store.open();
    await expect(store.begin('anthropic')).resolves.toBe(true);
  });

  it('returns false and does not enter running when the server reports busy', async () => {
    const { store } = setupStore({ beginData: { ok: false, reason: 'busy' } });
    await store.open();
    const accepted = await store.begin('anthropic');
    expect(accepted).toBe(false);
    expect(store.state.flow).not.toBe('running');
  });
});

// =============================================================================
// handleStep — routing
// =============================================================================

describe('LoginStore.handleStep routing', () => {
  it('stores an auth step as the current step', async () => {
    const { store } = setupStore();
    await store.open();
    await store.begin('anthropic');
    const step: LoginStep = { kind: 'auth', url: 'https://auth.example' };
    store.handleStep(step);
    expect(store.state.currentStep).toEqual(step);
  });

  it('stores a device_code step as the current step', async () => {
    const { store } = setupStore();
    await store.open();
    await store.begin('github-copilot');
    const step: LoginStep = { kind: 'device_code', userCode: 'WXYZ-1234', verificationUri: 'https://device.example' };
    store.handleStep(step);
    expect(store.state.currentStep).toEqual(step);
  });

  it('stores a prompt step (with requestId) as the current step', async () => {
    const { store } = setupStore();
    await store.open();
    await store.begin('anthropic');
    const step: LoginStep = { kind: 'prompt', requestId: 'req-1', message: 'Paste the code' };
    store.handleStep(step);
    expect(store.state.currentStep).toEqual(step);
  });

  it('stores a progress step as the current step', async () => {
    const { store } = setupStore();
    await store.open();
    await store.begin('anthropic');
    store.handleStep({ kind: 'progress', message: 'Exchanging tokens…' });
    expect(store.state.currentStep).toMatchObject({ kind: 'progress', message: 'Exchanging tokens…' });
  });
});

// =============================================================================
// submitInput
// =============================================================================

describe('LoginStore.submitInput', () => {
  it('sends a login_input echoing the current prompt step requestId and value', async () => {
    const { store, sent } = setupStore();
    await store.open();
    await store.begin('anthropic');
    store.handleStep({ kind: 'prompt', requestId: 'req-9', message: 'Paste the code' });
    await store.submitInput('the-code');
    const input = sent.find((c) => c.type === 'login_input');
    expect(input).toMatchObject({ type: 'login_input', requestId: 'req-9', value: 'the-code' });
  });

  it('sends a login_input echoing the current select step requestId', async () => {
    const { store, sent } = setupStore();
    await store.open();
    await store.begin('anthropic');
    store.handleStep({ kind: 'select', requestId: 'sel-3', message: 'Pick', options: [{ id: 'a', label: 'A' }] });
    await store.submitInput('a');
    const input = sent.find((c) => c.type === 'login_input');
    expect(input).toMatchObject({ type: 'login_input', requestId: 'sel-3', value: 'a' });
  });
});

// =============================================================================
// terminal done step
// =============================================================================

describe('LoginStore terminal step', () => {
  it('moves the flow to done and records success on a successful done step', async () => {
    const { store } = setupStore();
    await store.open();
    await store.begin('anthropic');
    store.handleStep({ kind: 'done', success: true, providerName: 'Claude' });
    expect(store.state.flow).toBe('done');
    expect(store.state.succeeded).toBe(true);
  });

  it('re-pulls get_available_models for the viewed session after a successful login', async () => {
    const { store, sent } = setupStore({ viewedSessionId: 's-42' });
    await store.open();
    await store.begin('anthropic');
    store.handleStep({ kind: 'done', success: true, providerName: 'Claude' });
    const refresh = sent.find((c) => c.type === 'get_available_models');
    expect(refresh).toMatchObject({ type: 'get_available_models', sessionId: 's-42' });
  });

  it('does not re-pull models when there is no viewed session', async () => {
    const { store, sent } = setupStore({ viewedSessionId: null });
    await store.open();
    await store.begin('anthropic');
    store.handleStep({ kind: 'done', success: true, providerName: 'Claude' });
    expect(commandTypes(sent)).not.toContain('get_available_models');
  });

  it('records failure and the error on an unsuccessful done step', async () => {
    const { store } = setupStore();
    await store.open();
    await store.begin('anthropic');
    store.handleStep({ kind: 'done', success: false, providerName: 'Claude', error: 'oauth denied' });
    expect(store.state.flow).toBe('done');
    expect(store.state.succeeded).toBe(false);
    expect(store.state.error).toContain('oauth denied');
  });

  it('does not re-pull models when the login failed', async () => {
    const { store, sent } = setupStore({ viewedSessionId: 's-42' });
    await store.open();
    await store.begin('anthropic');
    store.handleStep({ kind: 'done', success: false, providerName: 'Claude', error: 'nope' });
    expect(commandTypes(sent)).not.toContain('get_available_models');
  });
});

// =============================================================================
// cancel / close
// =============================================================================

describe('LoginStore.cancel', () => {
  it('sends a login_cancel command', async () => {
    const { store, sent } = setupStore();
    await store.open();
    await store.begin('anthropic');
    await store.cancel();
    expect(commandTypes(sent)).toContain('login_cancel');
  });

  it('returns the flow to idle after cancelling', async () => {
    const { store } = setupStore();
    await store.open();
    await store.begin('anthropic');
    await store.cancel();
    expect(store.state.flow).toBe('idle');
  });
});

describe('LoginStore.close', () => {
  it('resets the store to its initial idle state', async () => {
    const { store } = setupStore();
    await store.open();
    store.close();
    expect(store.state.flow).toBe('idle');
    expect(store.state.providers).toEqual([]);
    expect(store.state.currentStep).toBeNull();
  });
});
