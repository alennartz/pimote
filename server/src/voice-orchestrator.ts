// Voice orchestrator — owns the speechmux sidecar lifecycle and the per-call
// bind dispatch. See docs/plans/voice-mode.md → "Voice orchestrator".
//
// This file defines the interface surface + a stub implementation. The impl
// phase fills in start()/stop()/bindCall()/endCall() bodies.

import type { EventBusController } from '@mariozechner/pi-coding-agent';
import type { CallBindErrorCode, CallBindResponse, CallEndReason } from '@pimote/shared';
import type { PimoteConfig } from './config.js';
import type { ClientConnection, ManagedSlot, PimoteSessionManager } from './session-manager.js';
import type { VoiceActivateMessage, VoiceDeactivateMessage } from '@pimote/voice';

export type CallBindResultData = Omit<CallBindResponse, 'type' | 'id'>;

/** Typed error carrying the discriminable reason code used in PimoteResponse.error. */
export class CallBindError extends Error {
  constructor(
    public readonly code: CallBindErrorCode,
    message?: string,
  ) {
    super(message ?? code);
    this.name = 'CallBindError';
  }
}

export interface BindCallArgs {
  sessionId: string;
  clientConnection: ClientConnection;
  force: boolean;
}

export interface EndCallArgs {
  sessionId: string;
  reason: CallEndReason;
}

/**
 * Seam the orchestrator uses to talk to session-scoped EventBuses. In
 * production this resolves to the slot's eventBusRef; tests inject a fake.
 */
export interface VoiceSessionBusResolver {
  getSlot(sessionId: string): ManagedSlot | null;
  getEventBus(sessionId: string): EventBusController | null;
}

export interface VoiceOrchestratorOptions {
  config: PimoteConfig;
  sessionManager: PimoteSessionManager;
  busResolver: VoiceSessionBusResolver;
  /** Starts the speechmux sidecar process. */
  startSpeechmux: () => Promise<void>;
  /** Stops the speechmux sidecar process. Idempotent. */
  stopSpeechmux: () => Promise<void>;
  /**
   * Displace the current owner of a session (if any). Implementations wrap
   * the session-manager's standard displacement path.
   */
  displaceOwner: (sessionId: string, newOwner: ClientConnection) => Promise<void>;
  /** Check whether a session is currently owned by a voice-call client. */
  isOwnedByVoiceCall: (sessionId: string) => boolean;
}

export class VoiceOrchestrator {
  private started = false;
  private readonly activeCalls = new Set<string>();

  constructor(private readonly opts: VoiceOrchestratorOptions) {}

  /** Spawns speechmux sidecar. Throws if it fails to start. */
  async start(): Promise<void> {
    if (this.started) return;
    await this.opts.startSpeechmux();
    this.started = true;
  }

  /** Kills speechmux. Idempotent. */
  async stop(): Promise<void> {
    if (!this.started) return;
    await this.opts.stopSpeechmux();
    this.started = false;
    this.activeCalls.clear();
  }

  /** Called by ws-handler for CallBindCommand. */
  async bindCall(args: BindCallArgs): Promise<CallBindResultData> {
    const slot = this.opts.busResolver.getSlot(args.sessionId);
    if (!slot) {
      throw new CallBindError('call_bind_failed_session_not_found', `No session ${args.sessionId}`);
    }

    const alreadyOwned = this.opts.isOwnedByVoiceCall(args.sessionId);
    if (alreadyOwned && !args.force) {
      throw new CallBindError('call_bind_failed_owned', 'Session already bound to a voice call');
    }

    if (alreadyOwned && args.force) {
      await this.opts.displaceOwner(args.sessionId, args.clientConnection);
    }

    // Voice-disabled guard: if speechmux wiring isn't configured, fail the
    // bind here rather than handing the client empty URLs. Speechmux is
    // what mints the per-call TURN creds now (in the /signal `session`
    // response) and what authenticates peers (via Cloudflare Access at the
    // edge), so pimote no longer needs to mint anything.
    const signalUrl = this.opts.config.voice?.speechmuxSignalUrl;
    const llmWsUrl = this.opts.config.voice?.speechmuxLlmWsUrl;
    if (!signalUrl || !llmWsUrl) {
      throw new CallBindError('call_bind_failed_internal', 'voice_disabled: speechmux signal URL / llm WS URL not configured');
    }

    const bus = this.opts.busResolver.getEventBus(args.sessionId);
    if (!bus) {
      throw new CallBindError('call_bind_failed_internal', 'Session has no EventBus');
    }

    const activate: VoiceActivateMessage = {
      type: 'pimote:voice:activate',
      sessionId: args.sessionId,
      speechmuxWsUrl: llmWsUrl,
    };
    bus.emit(activate.type, activate);

    this.activeCalls.add(args.sessionId);

    return {
      sessionId: args.sessionId,
      webrtcSignalUrl: signalUrl,
    };
  }

  /** Called by ws-handler for CallEndCommand, or internally on displacement/error. Idempotent. */
  async endCall(args: EndCallArgs): Promise<void> {
    if (!this.activeCalls.has(args.sessionId)) return;
    this.activeCalls.delete(args.sessionId);

    const bus = this.opts.busResolver.getEventBus(args.sessionId);
    if (bus) {
      const deactivate: VoiceDeactivateMessage = { type: 'pimote:voice:deactivate', sessionId: args.sessionId };
      bus.emit(deactivate.type, deactivate);
    }
  }

  /** True if the given session currently has an active voice call bound. */
  isCallActive(sessionId: string): boolean {
    return this.activeCalls.has(sessionId);
  }
}
