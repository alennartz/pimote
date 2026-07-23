// LoginOrchestrator — server singleton driving interactive OAuth provider login.
//
// See docs/plans/provider-login.md → "Login Orchestrator". This is the
// connection-bound adapter around the process-wide ModelRuntime. It owns:
//   - OAuth-only provider discovery and OAuth credential status
//   - global single-flight login state
//   - translation between Pi AuthInteraction and Pimote LoginStep events
//   - the refresh boundary before a flow is reported successful
//
// The injected seam is a narrow Pick of ModelRuntime's public API. This keeps
// tests independent of Pi storage while ensuring its interaction types remain
// derived from the SDK rather than mirrored locally.

import type { ModelRuntime } from '@earendil-works/pi-coding-agent';
import type { LoginProviderInfo, LoginStep } from '../../shared/dist/index.js';

/** The ModelRuntime surface this global OAuth adapter needs. */
export type LoginModelRuntime = Pick<ModelRuntime, 'getProviders' | 'checkAuth' | 'login' | 'logout' | 'refresh'>;

/** Derived from ModelRuntime.login so Pi changes remain type-visible here. */
export type LoginInteraction = Parameters<LoginModelRuntime['login']>[2];
type LoginPrompt = Parameters<LoginInteraction['prompt']>[0];
type LoginEvent = Parameters<LoginInteraction['notify']>[0];
type LoginProvider = ReturnType<LoginModelRuntime['getProviders']>[number];

// --- Connection-bound transport (ws-handler binds one per connection) ---

export interface LoginTransport {
  /** Emit a login step over the connection (→ login_step event). */
  emit(step: LoginStep): void;
  /** Request free-text input from the client; undefined denotes cancellation. */
  requestInput(p: { requestId: string; message: string; placeholder?: string; allowEmpty?: boolean }): Promise<string | undefined>;
  /** Request a selection from the client; undefined denotes cancellation. */
  requestSelect(p: { requestId: string; message: string; options: { id: string; label: string }[] }): Promise<string | undefined>;
  /** Fired when the client cancels the flow. */
  signal: AbortSignal;
}

/** Thrown by runLogin when a flow is already in progress. */
export class LoginBusyError extends Error {
  constructor() {
    super('A login flow is already in progress');
    this.name = 'LoginBusyError';
  }
}

function promptCancelled(): Error {
  return new Error('Login prompt cancelled');
}

/** Reject an interaction prompt when Pi cancels its prompt-specific signal. */
function rejectOnAbort<T>(response: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
  if (!signal) return response;
  if (signal.aborted) return Promise.reject(promptCancelled());

  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(promptCancelled());
    signal.addEventListener('abort', abort, { once: true });
    response.then(
      (value) => {
        signal.removeEventListener('abort', abort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener('abort', abort);
        reject(error);
      },
    );
  });
}

function hasOAuth(provider: LoginProvider): boolean {
  return provider.auth.oauth !== undefined;
}

export class LoginOrchestrator {
  private busy = false;
  private requestCounter = 0;

  constructor(private readonly modelRuntime: LoginModelRuntime) {}

  /** List only OAuth-capable providers and report stored OAuth credentials. */
  async listProviders(): Promise<LoginProviderInfo[]> {
    const providers = this.modelRuntime.getProviders().filter(hasOAuth);
    return Promise.all(
      providers.map(async (provider) => {
        const auth = await this.modelRuntime.checkAuth(provider.id);
        return {
          id: provider.id,
          name: provider.name,
          loggedIn: auth?.type === 'oauth',
        };
      }),
    );
  }

  /** Whether a login flow is currently running. */
  isBusy(): boolean {
    return this.busy;
  }

  /**
   * Remove a provider credential and wait until the shared runtime's model
   * availability has refreshed. Logout deliberately remains independent of an
   * in-flight login, matching the prior server-global transport semantics.
   */
  async logout(providerId: string): Promise<void> {
    await this.modelRuntime.logout(providerId);
    await this.modelRuntime.refresh();
  }

  /**
   * Run one provider-owned OAuth flow over a connection-bound transport.
   * Resolves after it emits its terminal `done` step; concurrent callers get
   * LoginBusyError before the first await.
   */
  async runLogin(providerId: string, transport: LoginTransport): Promise<void> {
    if (this.busy) {
      throw new LoginBusyError();
    }
    this.busy = true;

    const providerName = this.modelRuntime.getProviders().find((provider) => provider.id === providerId)?.name ?? providerId;

    try {
      await this.modelRuntime.login(providerId, 'oauth', this.createInteraction(transport));
      await this.modelRuntime.refresh();
      transport.emit({ kind: 'done', success: true, providerName });
    } catch (err) {
      transport.emit({
        kind: 'done',
        success: false,
        providerName,
        error: err instanceof Error ? err.message : String(err),
      });
    } finally {
      this.busy = false;
    }
  }

  private createInteraction(transport: LoginTransport): LoginInteraction {
    const nextRequestId = (): string => `login-${++this.requestCounter}`;

    return {
      signal: transport.signal,
      prompt: async (prompt) => this.requestPrompt(prompt, transport, nextRequestId()),
      notify: (event) => this.emitNotification(event, transport),
    };
  }

  private async requestPrompt(prompt: LoginPrompt, transport: LoginTransport, requestId: string): Promise<string> {
    const response =
      prompt.type === 'select'
        ? await rejectOnAbort(
            transport.requestSelect({
              requestId,
              message: prompt.message,
              options: prompt.options.map((option) => ({ id: option.id, label: option.label })),
            }),
            prompt.signal,
          )
        : await rejectOnAbort(
            transport.requestInput({
              requestId,
              message: prompt.message,
              placeholder: prompt.placeholder,
            }),
            prompt.signal,
          );

    if (response === undefined) throw promptCancelled();
    return response;
  }

  private emitNotification(event: LoginEvent, transport: LoginTransport): void {
    switch (event.type) {
      case 'auth_url':
        transport.emit({ kind: 'auth', url: event.url, instructions: event.instructions });
        return;
      case 'device_code':
        transport.emit({
          kind: 'device_code',
          userCode: event.userCode,
          verificationUri: event.verificationUri,
          expiresInSeconds: event.expiresInSeconds,
        });
        return;
      case 'progress':
        transport.emit({ kind: 'progress', message: event.message });
        return;
      case 'info':
        transport.emit({
          kind: 'info',
          message: event.message,
          links: event.links?.map((link) => ({ url: link.url, label: link.label })),
        });
        return;
      default: {
        const unhandled: never = event;
        throw new Error(`Unhandled login notification: ${String(unhandled)}`);
      }
    }
  }
}
