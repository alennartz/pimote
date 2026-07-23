import { describe, expect, it, vi } from 'vitest';
import { LoginBusyError, LoginOrchestrator, type LoginInteraction, type LoginModelRuntime, type LoginTransport } from './login-orchestrator.js';
import type { LoginStep } from '../../shared/dist/index.js';

// --- Fakes -------------------------------------------------------------------

interface FakeRuntimeOptions {
  providers?: Array<{ id: string; name: string; oauth?: boolean }>;
  auth?: Record<string, 'api_key' | 'oauth' | undefined>;
  login?: (providerId: string, authType: 'oauth', interaction: LoginInteraction) => Promise<void>;
  logout?: (providerId: string) => Promise<void>;
  refresh?: () => Promise<void>;
}

type FakeModelRuntime = LoginModelRuntime & {
  loginCalls: Array<{ providerId: string; authType: 'oauth'; interaction: LoginInteraction }>;
  logoutCalls: string[];
  checkAuthCalls: string[];
  refreshCount: number;
};

function fakeModelRuntime(options: FakeRuntimeOptions = {}): FakeModelRuntime {
  const providers = options.providers ?? [
    { id: 'anthropic', name: 'Claude', oauth: true },
    { id: 'openai', name: 'ChatGPT', oauth: true },
  ];
  const auth = { ...(options.auth ?? {}) };
  const loginCalls: Array<{ providerId: string; authType: 'oauth'; interaction: LoginInteraction }> = [];
  const logoutCalls: string[] = [];
  const checkAuthCalls: string[] = [];

  const runtime = {
    loginCalls,
    logoutCalls,
    checkAuthCalls,
    refreshCount: 0,
    getProviders: () =>
      providers.map((provider) => ({
        id: provider.id,
        name: provider.name,
        auth: provider.oauth === false ? { apiKey: {} } : { oauth: {} },
      })),
    checkAuth: async (providerId: string) => {
      checkAuthCalls.push(providerId);
      const type = auth[providerId];
      return type ? { type } : undefined;
    },
    login: async (providerId: string, authType: 'oauth', interaction: LoginInteraction) => {
      loginCalls.push({ providerId, authType, interaction });
      await options.login?.(providerId, authType, interaction);
      return {};
    },
    logout: async (providerId: string) => {
      logoutCalls.push(providerId);
      delete auth[providerId];
      await options.logout?.(providerId);
    },
    refresh: async () => {
      runtime.refreshCount++;
      await options.refresh?.();
      return {};
    },
  };

  return runtime as unknown as FakeModelRuntime;
}

function fakeTransport(): LoginTransport & { emitted: LoginStep[]; abort: () => void } {
  const controller = new AbortController();
  const emitted: LoginStep[] = [];
  return {
    emitted,
    abort: () => controller.abort(),
    signal: controller.signal,
    emit: (step) => emitted.push(step),
    requestInput: async () => undefined,
    requestSelect: async () => undefined,
  };
}

function lastStep(transport: { emitted: LoginStep[] }): LoginStep | undefined {
  return transport.emitted.at(-1);
}

// =============================================================================
// listProviders
// =============================================================================

describe('LoginOrchestrator.listProviders', () => {
  it('returns only OAuth-capable providers with their id and name', async () => {
    const runtime = fakeModelRuntime({
      providers: [
        { id: 'anthropic', name: 'Claude' },
        { id: 'local', name: 'Local server', oauth: false },
        { id: 'github-copilot', name: 'GitHub Copilot' },
      ],
    });
    const list = await new LoginOrchestrator(runtime).listProviders();

    expect(list).toEqual([
      { id: 'anthropic', name: 'Claude', loggedIn: false },
      { id: 'github-copilot', name: 'GitHub Copilot', loggedIn: false },
    ]);
    expect(runtime.checkAuthCalls).toEqual(['anthropic', 'github-copilot']);
  });

  it('reports loggedIn only for an asynchronous OAuth auth check, not an API key', async () => {
    const runtime = fakeModelRuntime({
      auth: { anthropic: 'oauth', openai: 'api_key' },
    });

    await expect(new LoginOrchestrator(runtime).listProviders()).resolves.toEqual([
      { id: 'anthropic', name: 'Claude', loggedIn: true },
      { id: 'openai', name: 'ChatGPT', loggedIn: false },
    ]);
  });

  it('returns no entries when no provider supports OAuth', async () => {
    const runtime = fakeModelRuntime({ providers: [{ id: 'local', name: 'Local server', oauth: false }] });
    await expect(new LoginOrchestrator(runtime).listProviders()).resolves.toEqual([]);
  });
});

// =============================================================================
// isBusy / single-flight
// =============================================================================

describe('LoginOrchestrator in-flight guard', () => {
  it('is not busy before a login starts', () => {
    expect(new LoginOrchestrator(fakeModelRuntime()).isBusy()).toBe(false);
  });

  it('reports busy while a login flow is running', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const orchestrator = new LoginOrchestrator(fakeModelRuntime({ login: async () => gate }));

    const running = orchestrator.runLogin('anthropic', fakeTransport());
    expect(orchestrator.isBusy()).toBe(true);
    release();
    await running;
    expect(orchestrator.isBusy()).toBe(false);
  });

  it('rejects a concurrent runLogin while the global flow is in flight', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const orchestrator = new LoginOrchestrator(fakeModelRuntime({ login: async () => gate }));

    const first = orchestrator.runLogin('anthropic', fakeTransport());
    await expect(orchestrator.runLogin('openai', fakeTransport())).rejects.toBeInstanceOf(LoginBusyError);
    release();
    await first;
  });

  it('allows another login after the first flow ends', async () => {
    const runtime = fakeModelRuntime();
    const orchestrator = new LoginOrchestrator(runtime);

    await orchestrator.runLogin('anthropic', fakeTransport());
    await orchestrator.runLogin('openai', fakeTransport());

    expect(runtime.loginCalls.map((call) => call.providerId)).toEqual(['anthropic', 'openai']);
  });
});

// =============================================================================
// logout
// =============================================================================

describe('LoginOrchestrator.logout', () => {
  it('removes the requested credential and refreshes the shared runtime', async () => {
    const runtime = fakeModelRuntime({ auth: { anthropic: 'oauth' } });
    const orchestrator = new LoginOrchestrator(runtime);

    await orchestrator.logout('anthropic');

    expect(runtime.logoutCalls).toEqual(['anthropic']);
    expect(runtime.refreshCount).toBe(1);
    await expect(orchestrator.listProviders()).resolves.toContainEqual({ id: 'anthropic', name: 'Claude', loggedIn: false });
  });

  it('does not refresh until asynchronous credential removal finishes', async () => {
    let releaseLogout!: () => void;
    const logoutGate = new Promise<void>((resolve) => (releaseLogout = resolve));
    const runtime = fakeModelRuntime({ logout: async () => logoutGate });
    const loggedOut = new LoginOrchestrator(runtime).logout('anthropic');

    expect(runtime.logoutCalls).toEqual(['anthropic']);
    expect(runtime.refreshCount).toBe(0);
    releaseLogout();
    await loggedOut;
    expect(runtime.refreshCount).toBe(1);
  });

  it('remains independent of the login single-flight guard', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const runtime = fakeModelRuntime({ login: async () => gate, auth: { openai: 'oauth' } });
    const orchestrator = new LoginOrchestrator(runtime);

    const running = orchestrator.runLogin('anthropic', fakeTransport());
    await orchestrator.logout('openai');

    expect(runtime.logoutCalls).toEqual(['openai']);
    release();
    await running;
  });
});

// =============================================================================
// runLogin — success and interaction mapping
// =============================================================================

describe('LoginOrchestrator.runLogin success', () => {
  it('starts the provider-owned OAuth flow for the requested provider', async () => {
    const runtime = fakeModelRuntime();
    await new LoginOrchestrator(runtime).runLogin('anthropic', fakeTransport());

    expect(runtime.loginCalls).toHaveLength(1);
    expect(runtime.loginCalls[0]).toMatchObject({ providerId: 'anthropic', authType: 'oauth' });
  });

  it('waits for refresh before reporting successful completion', async () => {
    let releaseRefresh!: () => void;
    const refreshGate = new Promise<void>((resolve) => (releaseRefresh = resolve));
    const runtime = fakeModelRuntime({ refresh: async () => refreshGate });
    const transport = fakeTransport();
    const running = new LoginOrchestrator(runtime).runLogin('anthropic', transport);

    await vi.waitFor(() => expect(runtime.refreshCount).toBe(1));
    expect(transport.emitted).toEqual([]);

    releaseRefresh();
    await running;
    expect(lastStep(transport)).toMatchObject({ kind: 'done', success: true });
  });

  it('maps auth URLs, device codes, progress, and information notices', async () => {
    const runtime = fakeModelRuntime({
      login: async (_providerId, _authType, interaction) => {
        interaction.notify({ type: 'auth_url', url: 'https://auth.example/login', instructions: 'Sign in' });
        interaction.notify({ type: 'device_code', userCode: 'WXYZ-1234', verificationUri: 'https://device.example', expiresInSeconds: 120 });
        interaction.notify({ type: 'progress', message: 'Exchanging tokens…' });
        interaction.notify({
          type: 'info',
          message: 'Choose a subscription tier',
          links: [{ url: 'https://example.test/plans', label: 'View plans' }],
        });
      },
    });
    const transport = fakeTransport();

    await new LoginOrchestrator(runtime).runLogin('anthropic', transport);

    expect(transport.emitted).toEqual(
      expect.arrayContaining([
        { kind: 'auth', url: 'https://auth.example/login', instructions: 'Sign in' },
        { kind: 'device_code', userCode: 'WXYZ-1234', verificationUri: 'https://device.example', expiresInSeconds: 120 },
        { kind: 'progress', message: 'Exchanging tokens…' },
        { kind: 'info', message: 'Choose a subscription tier', links: [{ url: 'https://example.test/plans', label: 'View plans' }] },
      ]),
    );
  });

  it('maps text, manual-code, and select prompts through the bound transport', async () => {
    const runtime = fakeModelRuntime({
      login: async (_providerId, _authType, interaction) => {
        await expect(interaction.prompt({ type: 'text', message: 'Paste the code', placeholder: 'code' })).resolves.toBe('pasted-code');
        await expect(interaction.prompt({ type: 'manual_code', message: 'Manual code' })).resolves.toBe('manual-code');
        await expect(interaction.prompt({ type: 'select', message: 'Choose', options: [{ id: 'pro', label: 'Pro', description: 'Subscription' }] })).resolves.toBe('pro');
      },
    });
    const transport = fakeTransport();
    transport.requestInput = vi.fn().mockResolvedValueOnce('pasted-code').mockResolvedValueOnce('manual-code');
    transport.requestSelect = vi.fn().mockResolvedValue('pro');

    await new LoginOrchestrator(runtime).runLogin('anthropic', transport);

    expect(transport.requestInput).toHaveBeenCalledWith(expect.objectContaining({ message: 'Paste the code', placeholder: 'code' }));
    expect(transport.requestInput).toHaveBeenCalledWith(expect.objectContaining({ message: 'Manual code' }));
    expect(transport.requestSelect).toHaveBeenCalledWith({ requestId: 'login-3', message: 'Choose', options: [{ id: 'pro', label: 'Pro' }] });
  });

  it('passes the connection abort signal into the Pi interaction', async () => {
    let signal: AbortSignal | undefined;
    const runtime = fakeModelRuntime({
      login: async (_providerId, _authType, interaction) => {
        signal = interaction.signal;
      },
    });
    const transport = fakeTransport();

    await new LoginOrchestrator(runtime).runLogin('anthropic', transport);
    expect(signal).toBe(transport.signal);
  });
});

// =============================================================================
// runLogin — failure and cancellation
// =============================================================================

describe('LoginOrchestrator.runLogin failure', () => {
  it('rejects a cancelled select prompt instead of passing an empty value to Pi', async () => {
    const runtime = fakeModelRuntime({
      login: async (_providerId, _authType, interaction) => {
        await interaction.prompt({ type: 'select', message: 'Choose', options: [{ id: 'pro', label: 'Pro' }] });
      },
    });
    const transport = fakeTransport();
    transport.requestSelect = vi.fn().mockResolvedValue(undefined);

    await new LoginOrchestrator(runtime).runLogin('anthropic', transport);

    expect(lastStep(transport)).toMatchObject({ kind: 'done', success: false, error: 'Login prompt cancelled' });
  });

  it('rejects a prompt when Pi aborts its prompt-specific signal', async () => {
    const runtime = fakeModelRuntime({
      login: async (_providerId, _authType, interaction) => {
        const controller = new AbortController();
        controller.abort();
        await interaction.prompt({ type: 'manual_code', message: 'Manual code', signal: controller.signal });
      },
    });
    const transport = fakeTransport();
    transport.requestInput = vi.fn(() => new Promise<string>(() => {}));

    await new LoginOrchestrator(runtime).runLogin('anthropic', transport);

    expect(lastStep(transport)).toMatchObject({ kind: 'done', success: false, error: 'Login prompt cancelled' });
  });

  it('emits failure and skips the explicit refresh when login throws', async () => {
    const runtime = fakeModelRuntime({
      login: async () => {
        throw new Error('oauth denied');
      },
    });
    const transport = fakeTransport();

    await new LoginOrchestrator(runtime).runLogin('anthropic', transport);

    expect(lastStep(transport)).toMatchObject({ kind: 'done', success: false, error: 'oauth denied' });
    expect(runtime.refreshCount).toBe(0);
  });

  it('clears busy state after a failed flow so a retry can start', async () => {
    const runtime = fakeModelRuntime({
      login: async () => {
        throw new Error('boom');
      },
    });
    const orchestrator = new LoginOrchestrator(runtime);

    await orchestrator.runLogin('anthropic', fakeTransport());
    expect(orchestrator.isBusy()).toBe(false);
  });
});
