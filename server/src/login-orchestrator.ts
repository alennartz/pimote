// LoginOrchestrator — server singleton driving interactive OAuth provider login.
//
// See docs/plans/provider-login.md → "Login Orchestrator". Owns references to
// the shared pi-SDK AuthStorage + ModelRegistry. Responsibilities:
//   - list OAuth providers with logged-in status
//   - run a single login flow at a time (in-flight guard → "busy")
//   - translate a connection-bound transport into pi's OAuthLoginCallbacks
//   - on success call modelRegistry.refresh()
//
// Pure-ish and unit-testable: the AuthStorage / ModelRegistry dependencies are
// expressed as the narrow structural seams below (LoginAuthStorage /
// LoginModelRegistry), which the real pi-SDK classes satisfy. Tests inject
// in-memory fakes plus a fake LoginTransport.

import type { LoginProviderInfo, LoginStep } from '../../shared/dist/index.js';

// --- pi OAuth callback shape (mirrors @earendil-works/pi-ai OAuthLoginCallbacks) ---
// Re-declared locally so the orchestrator stays self-contained and unit-testable
// without a deep pi-ai import. The real AuthStorage.login accepts this shape.

export interface LoginOAuthAuthInfo {
  url: string;
  instructions?: string;
}

export interface LoginOAuthDeviceCodeInfo {
  userCode: string;
  verificationUri: string;
  intervalSeconds?: number;
  expiresInSeconds?: number;
}

export interface LoginOAuthPrompt {
  message: string;
  placeholder?: string;
  allowEmpty?: boolean;
}

export interface LoginOAuthSelectPrompt {
  message: string;
  options: { id: string; label: string }[];
}

export interface LoginOAuthCallbacks {
  onAuth: (info: LoginOAuthAuthInfo) => void;
  onDeviceCode: (info: LoginOAuthDeviceCodeInfo) => void;
  onPrompt: (prompt: LoginOAuthPrompt) => Promise<string>;
  onProgress?: (message: string) => void;
  onManualCodeInput?: () => Promise<string>;
  onSelect: (prompt: LoginOAuthSelectPrompt) => Promise<string | undefined>;
  signal?: AbortSignal;
}

// --- Dependency seams (real pi-SDK AuthStorage / ModelRegistry satisfy these) ---

export interface LoginAuthStorage {
  getOAuthProviders(): Array<{ id: string; name: string }>;
  getAuthStatus(provider: string): { configured: boolean };
  login(providerId: string, callbacks: LoginOAuthCallbacks): Promise<void>;
}

export interface LoginModelRegistry {
  refresh(): void;
}

// --- Connection-bound transport (ws-handler binds one per connection) ---

export interface LoginTransport {
  /** Emit a login step over the connection (→ login_step event). */
  emit(step: LoginStep): void;
  /** Request free-text input from the client; resolves with the submitted value. */
  requestInput(p: { requestId: string; message: string; placeholder?: string; allowEmpty?: boolean }): Promise<string>;
  /** Request a selection from the client; resolves with the chosen id or undefined on cancel. */
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

export class LoginOrchestrator {
  private readonly authStorage: LoginAuthStorage;
  private readonly modelRegistry: LoginModelRegistry;
  private busy = false;
  private requestCounter = 0;

  constructor(authStorage: LoginAuthStorage, modelRegistry: LoginModelRegistry) {
    this.authStorage = authStorage;
    this.modelRegistry = modelRegistry;
  }

  /** List OAuth providers with logged-in status (from getOAuthProviders + getAuthStatus). */
  listProviders(): LoginProviderInfo[] {
    return this.authStorage.getOAuthProviders().map((p) => ({
      id: p.id,
      name: p.name,
      loggedIn: this.authStorage.getAuthStatus(p.id).configured,
    }));
  }

  /** Whether a login flow is currently running. */
  isBusy(): boolean {
    return this.busy;
  }

  /**
   * Run a login flow for `providerId`, driving the transport. Resolves when the
   * flow ends; emits a terminal `done` step itself (success or failure). Throws
   * LoginBusyError if a flow is already in progress.
   */
  async runLogin(providerId: string, transport: LoginTransport): Promise<void> {
    // Synchronous in-flight guard (before the first await) so a concurrent
    // runLogin issued in the same tick rejects while the first is in flight.
    if (this.busy) {
      throw new LoginBusyError();
    }
    this.busy = true;

    const providerName = this.authStorage.getOAuthProviders().find((p) => p.id === providerId)?.name ?? providerId;

    const nextRequestId = (): string => `login-${++this.requestCounter}`;

    const callbacks: LoginOAuthCallbacks = {
      onAuth: (info) => {
        transport.emit({ kind: 'auth', url: info.url, instructions: info.instructions });
      },
      onDeviceCode: (info) => {
        transport.emit({
          kind: 'device_code',
          userCode: info.userCode,
          verificationUri: info.verificationUri,
          expiresInSeconds: info.expiresInSeconds,
        });
      },
      onProgress: (message) => {
        transport.emit({ kind: 'progress', message });
      },
      onPrompt: (prompt) =>
        transport.requestInput({
          requestId: nextRequestId(),
          message: prompt.message,
          placeholder: prompt.placeholder,
          allowEmpty: prompt.allowEmpty,
        }),
      onManualCodeInput: () =>
        transport.requestInput({
          requestId: nextRequestId(),
          message: 'Paste the authorization code',
        }),
      onSelect: (prompt) =>
        transport.requestSelect({
          requestId: nextRequestId(),
          message: prompt.message,
          options: prompt.options,
        }),
      signal: transport.signal,
    };

    try {
      await this.authStorage.login(providerId, callbacks);
      this.modelRegistry.refresh();
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
}
