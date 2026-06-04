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

  constructor(authStorage: LoginAuthStorage, modelRegistry: LoginModelRegistry) {
    this.authStorage = authStorage;
    this.modelRegistry = modelRegistry;
  }

  /** List OAuth providers with logged-in status (from getOAuthProviders + getAuthStatus). */
  listProviders(): LoginProviderInfo[] {
    throw new Error('not implemented');
  }

  /** Whether a login flow is currently running. */
  isBusy(): boolean {
    throw new Error('not implemented');
  }

  /**
   * Run a login flow for `providerId`, driving the transport. Resolves when the
   * flow ends; emits a terminal `done` step itself (success or failure). Throws
   * LoginBusyError if a flow is already in progress.
   */
  runLogin(_providerId: string, _transport: LoginTransport): Promise<void> {
    throw new Error('not implemented');
  }
}
