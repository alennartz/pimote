// Wire the VoiceOrchestrator together with its runtime dependencies at
// server boot time. Kept separate from `index.ts` so the wiring is
// testable (no network / child_process side-effects at import time) and
// isolated from the plain HTTP/WS boot sequence.

import { spawn, type ChildProcess } from 'node:child_process';
import type { PimoteConfig } from './config.js';
import type { ClientConnection, PimoteSessionManager } from './session-manager.js';
import type { WsHandler } from './ws-handler.js';
import { VoiceOrchestrator, type VoiceSessionBusResolver } from './voice-orchestrator.js';

/** Narrow registry surface the voice orchestrator needs at boot time.
 *  Avoids constructing a Proxy over the real Map (see review finding 6). */
export interface VoiceClientRegistry {
  get(clientId: string): WsHandler | undefined;
}

export interface VoiceOrchestratorBootResult {
  orchestrator: VoiceOrchestrator;
  /** Tear down the orchestrator. Safe to call multiple times. */
  shutdown: () => Promise<void>;
}

/**
 * Construct a VoiceOrchestrator backed by real seams:
 * - speechmux sidecar via `child_process.spawn`
 * - displacement = looks up current owner via clientRegistry and calls its
 *   `sendDisplacedEvent(sessionId)`
 *
 * Auth on `/signal` is handled by Cloudflare Access at the edge, and
 * per-session TURN credentials are minted by speechmux and returned to the
 * PWA in its `/signal` `session` response. Pimote's orchestrator only
 * hands out the signalling URL.
 */
export function buildVoiceOrchestrator(args: { config: PimoteConfig; sessionManager: PimoteSessionManager; clientRegistry: VoiceClientRegistry }): VoiceOrchestratorBootResult {
  const { config, sessionManager, clientRegistry } = args;

  let speechmuxProc: ChildProcess | null = null;

  const busResolver: VoiceSessionBusResolver = {
    getSlot: (sessionId) => sessionManager.getSlot(sessionId),
    getEventBus: (sessionId) => sessionManager.getSlot(sessionId)?.eventBusRef.current ?? null,
  };

  const orchestrator: VoiceOrchestrator = new VoiceOrchestrator({
    config,
    sessionManager,
    busResolver,
    startSpeechmux: async () => {
      const bin = config.voice?.speechmuxBinary;
      if (!bin) {
        console.log('[voice] speechmuxBinary not configured; assuming speechmux is externally managed (systemd, container, remote host, etc.)');
        return;
      }
      if (speechmuxProc) return;
      speechmuxProc = spawn(bin, [], { stdio: ['ignore', 'inherit', 'inherit'] });
      speechmuxProc.on('exit', (code, signal) => {
        console.warn(`[voice] speechmux exited (code=${code}, signal=${signal})`);
        speechmuxProc = null;
      });
      // NB: we do not wait for a ready marker here — speechmux emits readiness
      // to its own logs. Callers should ensure startup ordering or implement a
      // readiness probe as part of the Step 14 smoke.
    },
    stopSpeechmux: async () => {
      if (!speechmuxProc) return;
      const proc = speechmuxProc;
      speechmuxProc = null;
      await new Promise<void>((resolve) => {
        const timer = setTimeout(() => {
          try {
            proc.kill('SIGKILL');
          } catch {
            /* ignore */
          }
          resolve();
        }, 2000);
        proc.once('exit', () => {
          clearTimeout(timer);
          resolve();
        });
        try {
          proc.kill('SIGTERM');
        } catch {
          clearTimeout(timer);
          resolve();
        }
      });
    },
    displaceOwner: async (sessionId, _newOwner: ClientConnection) => {
      const slot = sessionManager.getSlot(sessionId);
      const existingClientId = slot?.connection?.connectedClientId;
      if (!existingClientId) return;
      const existing = clientRegistry.get(existingClientId);
      existing?.sendDisplacedEvent(sessionId);
    },
    isOwnedByVoiceCall: (sessionId: string): boolean => orchestrator.isCallActive(sessionId),
  });

  return {
    orchestrator,
    shutdown: async () => {
      await orchestrator.stop();
    },
  };
}
