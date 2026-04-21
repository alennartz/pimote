// Wire the VoiceOrchestrator together with its runtime dependencies at
// server boot time. Kept separate from `index.ts` so the wiring is
// testable (no network / child_process side-effects at import time) and
// isolated from the plain HTTP/WS boot sequence.

import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
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
 * - mint token = `crypto.randomUUID()` (production will POST to speechmux's
 *   admin surface once speechmux supports per-call auth tokens — out of
 *   scope for this phase; see docs/plans/voice-mode.md → "External
 *   dependencies")
 * - displacement = looks up current owner via clientRegistry and calls its
 *   `sendDisplacedEvent(sessionId)`
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
        console.warn('[voice] speechmuxBinary not configured; orchestrator disabled');
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
    mintCallToken: async (_sessionId) => {
      // Guard: if any piece of the speechmux wiring is missing, fail the
      // bind so the client sees `call_bind_failed_internal` instead of
      // succeeding with empty URLs (see review finding 3).
      if (!config.voice?.speechmuxBinary || !config.voice?.speechmuxSignalUrl || !config.voice?.speechmuxLlmWsUrl) {
        throw new Error('voice_disabled: speechmux binary / signal URL / llm WS URL not configured');
      }
      // TODO(speechmux external blocker): once speechmux exposes a per-call
      // auth admin endpoint, POST the minted token here (and pass sessionId
      // along). Until then we only generate a random token locally and rely
      // on speechmux's shared-env-token mode. Tracked in
      // docs/plans/voice-mode.md → "External dependencies" and review
      // finding 8.
      const token = randomUUID();
      const turn = {
        urls: [] as string[],
        username: '',
        credential: '',
      };
      return {
        token,
        turn,
        webrtcSignalUrl: config.voice.speechmuxSignalUrl,
      };
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
