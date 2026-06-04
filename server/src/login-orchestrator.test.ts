import { describe, it, expect, vi } from 'vitest';
import { LoginOrchestrator, LoginBusyError, type LoginAuthStorage, type LoginModelRegistry, type LoginOAuthCallbacks, type LoginTransport } from './login-orchestrator.js';
import type { LoginStep } from '../../shared/dist/index.js';

// --- Fakes -------------------------------------------------------------------

interface FakeAuthOptions {
  providers?: Array<{ id: string; name: string }>;
  /** Provider ids that report configured: true. */
  loggedIn?: string[];
  /** Custom login behaviour; defaults to immediate success. */
  login?: (providerId: string, callbacks: LoginOAuthCallbacks) => Promise<void>;
}

function fakeAuthStorage(opts: FakeAuthOptions = {}): LoginAuthStorage & {
  loginCalls: Array<{ providerId: string; callbacks: LoginOAuthCallbacks }>;
} {
  const providers = opts.providers ?? [
    { id: 'anthropic', name: 'Claude' },
    { id: 'openai', name: 'ChatGPT' },
  ];
  const loggedIn = new Set(opts.loggedIn ?? []);
  const loginCalls: Array<{ providerId: string; callbacks: LoginOAuthCallbacks }> = [];
  return {
    loginCalls,
    getOAuthProviders: () => providers,
    getAuthStatus: (provider: string) => ({ configured: loggedIn.has(provider) }),
    login: async (providerId: string, callbacks: LoginOAuthCallbacks) => {
      loginCalls.push({ providerId, callbacks });
      if (opts.login) return opts.login(providerId, callbacks);
    },
  };
}

function fakeModelRegistry(): LoginModelRegistry & { refreshCount: number } {
  const reg = {
    refreshCount: 0,
    refresh() {
      reg.refreshCount++;
    },
  };
  return reg;
}

function fakeTransport(): LoginTransport & { emitted: LoginStep[]; abort: () => void } {
  const controller = new AbortController();
  const emitted: LoginStep[] = [];
  return {
    emitted,
    abort: () => controller.abort(),
    signal: controller.signal,
    emit: (step: LoginStep) => emitted.push(step),
    requestInput: async () => '',
    requestSelect: async () => undefined,
  };
}

function lastStep(t: { emitted: LoginStep[] }): LoginStep | undefined {
  return t.emitted[t.emitted.length - 1];
}

// =============================================================================
// listProviders
// =============================================================================

describe('LoginOrchestrator.listProviders', () => {
  it('returns one entry per OAuth provider with id and name', () => {
    const auth = fakeAuthStorage({
      providers: [
        { id: 'anthropic', name: 'Claude' },
        { id: 'openai', name: 'ChatGPT' },
        { id: 'github-copilot', name: 'GitHub Copilot' },
      ],
    });
    const orch = new LoginOrchestrator(auth, fakeModelRegistry());
    const list = orch.listProviders();
    expect(list.map((p) => p.id)).toEqual(['anthropic', 'openai', 'github-copilot']);
    expect(list.map((p) => p.name)).toEqual(['Claude', 'ChatGPT', 'GitHub Copilot']);
  });

  it('marks loggedIn true for providers whose auth status is configured', () => {
    const auth = fakeAuthStorage({
      providers: [
        { id: 'anthropic', name: 'Claude' },
        { id: 'openai', name: 'ChatGPT' },
      ],
      loggedIn: ['anthropic'],
    });
    const orch = new LoginOrchestrator(auth, fakeModelRegistry());
    const byId = Object.fromEntries(orch.listProviders().map((p) => [p.id, p.loggedIn]));
    expect(byId).toEqual({ anthropic: true, openai: false });
  });

  it('returns an empty list when there are no OAuth providers', () => {
    const orch = new LoginOrchestrator(fakeAuthStorage({ providers: [] }), fakeModelRegistry());
    expect(orch.listProviders()).toEqual([]);
  });
});

// =============================================================================
// isBusy / single-flight
// =============================================================================

describe('LoginOrchestrator in-flight guard', () => {
  it('is not busy before any login starts', () => {
    const orch = new LoginOrchestrator(fakeAuthStorage(), fakeModelRegistry());
    expect(orch.isBusy()).toBe(false);
  });

  it('reports busy while a login flow is running', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const auth = fakeAuthStorage({ login: async () => gate });
    const orch = new LoginOrchestrator(auth, fakeModelRegistry());
    const t = fakeTransport();
    const running = orch.runLogin('anthropic', t);
    expect(orch.isBusy()).toBe(true);
    release();
    await running;
    expect(orch.isBusy()).toBe(false);
  });

  it('rejects a concurrent runLogin with LoginBusyError while one is in flight', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const auth = fakeAuthStorage({ login: async () => gate });
    const orch = new LoginOrchestrator(auth, fakeModelRegistry());
    const first = orch.runLogin('anthropic', fakeTransport());
    await expect(orch.runLogin('openai', fakeTransport())).rejects.toBeInstanceOf(LoginBusyError);
    release();
    await first;
  });

  it('allows a second login after the first one completes', async () => {
    const auth = fakeAuthStorage();
    const orch = new LoginOrchestrator(auth, fakeModelRegistry());
    await orch.runLogin('anthropic', fakeTransport());
    await orch.runLogin('openai', fakeTransport());
    expect(auth.loginCalls.map((c) => c.providerId)).toEqual(['anthropic', 'openai']);
  });
});

// =============================================================================
// runLogin — happy path
// =============================================================================

describe('LoginOrchestrator.runLogin success', () => {
  it('calls authStorage.login with the requested provider id', async () => {
    const auth = fakeAuthStorage();
    const orch = new LoginOrchestrator(auth, fakeModelRegistry());
    await orch.runLogin('anthropic', fakeTransport());
    expect(auth.loginCalls[0]?.providerId).toBe('anthropic');
  });

  it('refreshes the model registry after a successful login', async () => {
    const registry = fakeModelRegistry();
    const orch = new LoginOrchestrator(fakeAuthStorage(), registry);
    await orch.runLogin('anthropic', fakeTransport());
    expect(registry.refreshCount).toBe(1);
  });

  it('emits a terminal done step with success true on completion', async () => {
    const orch = new LoginOrchestrator(fakeAuthStorage(), fakeModelRegistry());
    const t = fakeTransport();
    await orch.runLogin('anthropic', t);
    const step = lastStep(t);
    expect(step?.kind).toBe('done');
    expect(step).toMatchObject({ kind: 'done', success: true });
  });

  it('emits an auth step when the provider invokes onAuth', async () => {
    const auth = fakeAuthStorage({
      login: async (_id, cb) => {
        cb.onAuth({ url: 'https://auth.example/login' });
      },
    });
    const orch = new LoginOrchestrator(auth, fakeModelRegistry());
    const t = fakeTransport();
    await orch.runLogin('anthropic', t);
    expect(t.emitted).toContainEqual(expect.objectContaining({ kind: 'auth', url: 'https://auth.example/login' }));
  });

  it('emits a device_code step when the provider invokes onDeviceCode', async () => {
    const auth = fakeAuthStorage({
      login: async (_id, cb) => {
        cb.onDeviceCode({ userCode: 'WXYZ-1234', verificationUri: 'https://device.example' });
      },
    });
    const orch = new LoginOrchestrator(auth, fakeModelRegistry());
    const t = fakeTransport();
    await orch.runLogin('github-copilot', t);
    expect(t.emitted).toContainEqual(expect.objectContaining({ kind: 'device_code', userCode: 'WXYZ-1234', verificationUri: 'https://device.example' }));
  });

  it('routes onPrompt through the transport requestInput and returns its value', async () => {
    const auth = fakeAuthStorage({
      login: async (_id, cb) => {
        const code = await cb.onPrompt({ message: 'Paste the code' });
        if (code !== 'pasted-code') throw new Error('unexpected prompt value');
      },
    });
    const orch = new LoginOrchestrator(auth, fakeModelRegistry());
    const t = fakeTransport();
    t.requestInput = vi.fn(async () => 'pasted-code');
    await orch.runLogin('anthropic', t);
    expect(t.requestInput).toHaveBeenCalledOnce();
    expect(lastStep(t)).toMatchObject({ kind: 'done', success: true });
  });

  it('routes onSelect through the transport requestSelect and returns its value', async () => {
    const auth = fakeAuthStorage({
      login: async (_id, cb) => {
        const choice = await cb.onSelect({ message: 'Pick one', options: [{ id: 'a', label: 'A' }] });
        if (choice !== 'a') throw new Error('unexpected select value');
      },
    });
    const orch = new LoginOrchestrator(auth, fakeModelRegistry());
    const t = fakeTransport();
    t.requestSelect = vi.fn(async () => 'a');
    await orch.runLogin('anthropic', t);
    expect(t.requestSelect).toHaveBeenCalledOnce();
    expect(lastStep(t)).toMatchObject({ kind: 'done', success: true });
  });

  it('emits a progress step when the provider invokes onProgress', async () => {
    const auth = fakeAuthStorage({
      login: async (_id, cb) => {
        cb.onProgress?.('Exchanging tokens…');
      },
    });
    const orch = new LoginOrchestrator(auth, fakeModelRegistry());
    const t = fakeTransport();
    await orch.runLogin('anthropic', t);
    expect(t.emitted).toContainEqual(expect.objectContaining({ kind: 'progress', message: 'Exchanging tokens…' }));
  });

  it('passes the transport abort signal through to the login callbacks', async () => {
    let seenSignal: AbortSignal | undefined;
    const auth = fakeAuthStorage({
      login: async (_id, cb) => {
        seenSignal = cb.signal;
      },
    });
    const orch = new LoginOrchestrator(auth, fakeModelRegistry());
    const t = fakeTransport();
    await orch.runLogin('anthropic', t);
    expect(seenSignal).toBe(t.signal);
  });
});

// =============================================================================
// runLogin — failure / abort
// =============================================================================

describe('LoginOrchestrator.runLogin failure', () => {
  it('emits a terminal done step with success false and the error when login throws', async () => {
    const auth = fakeAuthStorage({
      login: async () => {
        throw new Error('oauth denied');
      },
    });
    const orch = new LoginOrchestrator(auth, fakeModelRegistry());
    const t = fakeTransport();
    await orch.runLogin('anthropic', t);
    const step = lastStep(t);
    expect(step?.kind).toBe('done');
    expect(step).toMatchObject({ kind: 'done', success: false });
    expect((step as { error?: string }).error).toContain('oauth denied');
  });

  it('does not refresh the model registry when login fails', async () => {
    const registry = fakeModelRegistry();
    const auth = fakeAuthStorage({
      login: async () => {
        throw new Error('boom');
      },
    });
    const orch = new LoginOrchestrator(auth, registry);
    await orch.runLogin('anthropic', fakeTransport());
    expect(registry.refreshCount).toBe(0);
  });

  it('clears busy state after a failed login so a retry can start', async () => {
    const auth = fakeAuthStorage({
      login: async () => {
        throw new Error('boom');
      },
    });
    const orch = new LoginOrchestrator(auth, fakeModelRegistry());
    await orch.runLogin('anthropic', fakeTransport());
    expect(orch.isBusy()).toBe(false);
  });
});
