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
    succeeded: null,
    error: null,
  });

  private readonly seams: LoginStoreSeams;

  constructor(seams: LoginStoreSeams) {
    this.seams = seams;
  }

  /** Open the dialog: fetch the provider list and move to the picker. */
  open(): Promise<void> {
    throw new Error('not implemented');
  }

  /** Begin a login flow for the chosen provider. Resolves to false if server is busy. */
  begin(_providerId: string): Promise<boolean> {
    throw new Error('not implemented');
  }

  /** Submit a value for the current prompt/select step (keyed by its requestId). */
  submitInput(_value: string): Promise<void> {
    throw new Error('not implemented');
  }

  /** Cancel the in-flight flow and reset to idle. */
  cancel(): Promise<void> {
    throw new Error('not implemented');
  }

  /** Route an incoming `login_step` event into the state machine. */
  handleStep(_step: LoginStep): void {
    throw new Error('not implemented');
  }

  /** Reset the store to its initial idle state. */
  close(): void {
    throw new Error('not implemented');
  }
}

// Type-only references so unused-import checks stay quiet until implementation.
export type { LoginListResponseData, LoginBeginResponseData };
