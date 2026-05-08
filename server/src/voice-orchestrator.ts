// Voice orchestrator — owns per-call bind dispatch.
// See docs/plans/voice-mode.md → "Voice orchestrator".
//
// Speechmux is treated as an externally managed service (systemd, container,
// remote host, etc.). This orchestrator is only constructed when voice config
// is present (`voice.speechmuxSignalUrl` + `voice.speechmuxLlmWsUrl`); when
// it is absent, the server skips voice wiring entirely.

import type { EventBusController } from '@mariozechner/pi-coding-agent';
import type { CallBindErrorCode, CallBindResponse, CallEndReason } from '../../shared/dist/index.js';
import type { PimoteConfig } from './config.js';
import type { ClientConnection, ManagedSlot, PimoteSessionManager } from './session-manager.js';
import type { VoiceActivateMessage, VoiceDeactivateMessage } from './voice/index.js';

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
  /**
   * Displace the current owner of a session (if any). Implementations wrap
   * the session-manager's standard displacement path.
   */
  displaceOwner: (sessionId: string, newOwner: ClientConnection) => Promise<void>;
  /** Check whether a session is currently owned by a voice-call client. */
  isOwnedByVoiceCall: (sessionId: string) => boolean;
}

export class VoiceOrchestrator {
  private readonly activeCalls = new Set<string>();

  constructor(private readonly opts: VoiceOrchestratorOptions) {}

  /** Drop all active-call bookkeeping. Idempotent. Called on server shutdown. */
  async stop(): Promise<void> {
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

    // The orchestrator is only constructed when voice is configured, so
    // these URLs are guaranteed present. Re-read them per call so live
    // config edits (if/when supported) take effect on the next bind.
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
