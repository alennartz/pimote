// LoginStore — client-side interactive provider-login state machine.
//
// See docs/plans/provider-login.md → "Client LoginStore". Backs the global
// LoginDialog. Owns the reactive flow state, the provider list, and the current
// LoginStep. Uses constructor-injected seams so tests can substitute an
// in-memory command bus without a real WebSocket.
//
// Flow:
//   open()          → login_list, state 'listing' → 'picking'
//   begin(id)       → login_begin, state 'running'
//   submitInput(v)  → login_input (resolves a prompt/select step)
//   cancel()        → login_cancel
// Incoming `login_step` events are routed via handleStep(); the terminal
// `done` step moves to state 'done', and on success the store re-pulls
// get_available_models for the viewed session so the model picker refreshes.

import type { LoginStep, LoginProviderInfo, LoginListResponseData, LoginBeginResponseData, PimoteCommand, PimoteResponse } from '@pimote/shared';

export type LoginFlowState = 'idle' | 'listing' | 'picking' | 'running' | 'done';

export interface LoginStoreState {
  flow: LoginFlowState;
  providers: LoginProviderInfo[];
  /** The most recent step received from the server while running. */
  currentStep: LoginStep | null;
  /**
   * Persistent auth-URL info for the authorization-code (Claude/ChatGPT) flow.
   * pi calls onAuth and then immediately onManualCodeInput, so the `auth` step is
   * followed at once by a `prompt` step that overwrites currentStep. We latch the
   * auth URL here so the "Open auth page" link stays reachable while the paste
   * prompt is shown. Null for device-code (Copilot) flows. Cleared on each
   * begin()/close().
   */
  authInfo: { url: string; instructions?: string } | null;
  /** Set when the flow ended; mirrors the terminal `done` step's success flag. */
  succeeded: boolean | null;
  /** Error string from a failed terminal step, if any. */
  error: string | null;
}

export interface LoginStoreSeams {
  /** Sends a command over the pimote WS. Returns the server response. */
  sendCommand: <T = unknown>(cmd: PimoteCommand) => Promise<PimoteResponse<T>>;
  /** The session currently viewed by the operator — target for the model re-pull. */
  getViewedSessionId: () => string | null;
}

export class LoginStore {
  state: LoginStoreState = $state({
    flow: 'idle',
    providers: [],
    currentStep: null,
    authInfo: null,
    succeeded: null,
    error: null,
  });

  private readonly seams: LoginStoreSeams;

  constructor(seams: LoginStoreSeams) {
    this.seams = seams;
  }

  /** Open the dialog: fetch the provider list and move to the picker. */
  async open(): Promise<void> {
    this.state.flow = 'listing';
    const resp = await this.seams.sendCommand<LoginListResponseData>({
      type: 'login_list',
      id: crypto.randomUUID(),
    });
    this.state.providers = resp.data?.providers ?? [];
    this.state.flow = 'picking';
  }

  /** Begin a login flow for the chosen provider. Resolves to false if server is busy. */
  async begin(providerId: string): Promise<boolean> {
    const resp = await this.seams.sendCommand<LoginBeginResponseData>({
      type: 'login_begin',
      id: crypto.randomUUID(),
      providerId,
    });
    if (!resp.data?.ok) {
      return false;
    }
    this.state.flow = 'running';
    this.state.currentStep = null;
    this.state.authInfo = null;
    this.state.succeeded = null;
    this.state.error = null;
    return true;
  }

  /** Submit a value for the current prompt/select step (keyed by its requestId). */
  async submitInput(value: string): Promise<void> {
    const step = this.state.currentStep;
    if (!step || (step.kind !== 'prompt' && step.kind !== 'select')) {
      return;
    }
    await this.seams.sendCommand({
      type: 'login_input',
      id: crypto.randomUUID(),
      requestId: step.requestId,
      value,
    });
  }

  /** Cancel the in-flight flow and reset to idle. */
  async cancel(): Promise<void> {
    await this.seams.sendCommand({ type: 'login_cancel', id: crypto.randomUUID() });
    this.state.flow = 'idle';
  }

  /** Route an incoming `login_step` event into the state machine. */
  handleStep(step: LoginStep): void {
    if (step.kind === 'done') {
      this.state.flow = 'done';
      this.state.succeeded = step.success;
      this.state.error = step.error ?? null;
      if (step.success) {
        const sessionId = this.seams.getViewedSessionId();
        if (sessionId) {
          void this.seams.sendCommand({
            type: 'get_available_models',
            id: crypto.randomUUID(),
            sessionId,
          });
        }
      }
      return;
    }
    // Latch the auth URL so it survives the manual-code `prompt` step that pi
    // emits immediately after `auth` (which would otherwise overwrite it).
    if (step.kind === 'auth') {
      this.state.authInfo = { url: step.url, instructions: step.instructions };
    }
    this.state.currentStep = step;
  }

  /** Reset the store to its initial idle state. */
  close(): void {
    this.state.flow = 'idle';
    this.state.providers = [];
    this.state.currentStep = null;
    this.state.authInfo = null;
    this.state.succeeded = null;
    this.state.error = null;
  }
}

// Type-only references so unused-import checks stay quiet until implementation.
export type { LoginListResponseData, LoginBeginResponseData };
