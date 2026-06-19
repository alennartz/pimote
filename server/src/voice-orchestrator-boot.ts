// Wire the VoiceOrchestrator together with its runtime dependencies at
// server boot time. Kept separate from `index.ts` so the wiring is
// testable and isolated from the plain HTTP/WS boot sequence.
//
// Returns `null` when voice is not configured. Speechmux is treated as an
// externally managed service (systemd, container, remote host, etc.); pimote
// no longer spawns it as a sidecar.

import type { PimoteConfig } from './config.js';
import type { ClientConnection, PimoteSessionManager } from './session-manager.js';
import type { WsHandler } from './ws-handler.js';
import { VoiceOrchestrator, type VoiceSessionBusResolver } from './voice-orchestrator.js';

/** Narrow registry surface the voice orchestrator needs at boot time.
 *  Avoids constructing a Proxy over the real Map. */
export interface VoiceClientRegistry {
  get(clientId: string): WsHandler | undefined;
}

export interface VoiceOrchestratorBootResult {
  orchestrator: VoiceOrchestrator;
  /** Tear down the orchestrator. Safe to call multiple times. */
  shutdown: () => Promise<void>;
}

/** True iff the config has the URLs needed to bind a voice call. */
export function isVoiceConfigured(config: PimoteConfig): boolean {
  return Boolean(config.voice?.speechmuxSignalUrl && config.voice?.speechmuxLlmWsUrl);
}

/**
 * Construct a VoiceOrchestrator backed by real seams:
 * - displacement = looks up current owner via clientRegistry and calls its
 *   `sendDisplacedEvent(sessionId)`
 *
 * Auth on `/signal` is handled by Cloudflare Access at the edge, and
 * per-session TURN credentials are minted by speechmux and returned to the
 * PWA in its `/signal` `session` response. Pimote's orchestrator only
 * hands out the signalling URL.
 *
 * Returns `null` if voice is not configured \u2014 callers should skip all voice
 * wiring in that case.
 */
export function buildVoiceOrchestrator(args: {
  config: PimoteConfig;
  sessionManager: PimoteSessionManager;
  clientRegistry: VoiceClientRegistry;
}): VoiceOrchestratorBootResult | null {
  const { config, sessionManager, clientRegistry } = args;

  if (!isVoiceConfigured(config)) return null;

  const busResolver: VoiceSessionBusResolver = {
    getSlot: (sessionId) => sessionManager.getSlot(sessionId),
    getEventBus: (sessionId) => sessionManager.getSlot(sessionId)?.eventBusRef.current ?? null,
  };

  const orchestrator: VoiceOrchestrator = new VoiceOrchestrator({
    config,
    sessionManager,
    busResolver,
    displaceOwner: async (sessionId, _newOwner: ClientConnection) => {
      const slot = sessionManager.getSlot(sessionId);
      const existingClientId = slot?.connection?.connectedClientId;
      if (!existingClientId) return;
      const existing = clientRegistry.get(existingClientId);
      existing?.sendDisplacedEvent(sessionId);
    },
    isOwnedByVoiceCall: (sessionId: string): boolean => orchestrator.isCallActive(sessionId),
    notifyCallEnded: (sessionId: string) => {
      // The voice extension self-deactivated (speechmux WS failed/dropped).
      // Tell the owning client so its VoiceCallStore tears down instead of
      // waiting for WebRTC to time out. (review finding H4)
      const slot = sessionManager.getSlot(sessionId);
      const ownerClientId = slot?.connection?.connectedClientId;
      if (!ownerClientId) return;
      clientRegistry.get(ownerClientId)?.sendCallEndedEvent(sessionId, 'error');
    },
  });

  return {
    orchestrator,
    shutdown: async () => {
      await orchestrator.stop();
    },
  };
}
