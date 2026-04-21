// Wire the VoiceOrchestrator together with its runtime dependencies at
// server boot time. Kept separate from `index.ts` so the wiring is
// testable (no network / child_process side-effects at import time) and
// isolated from the plain HTTP/WS boot sequence.

import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import type { PimoteConfig } from './config.js';
import type { ClientConnection, PimoteSessionManager } from './session-manager.js';
import type { ClientRegistry } from './ws-handler.js';
import { VoiceOrchestrator, type VoiceSessionBusResolver } from './voice-orchestrator.js';

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
export function buildVoiceOrchestrator(args: { config: PimoteConfig; sessionManager: PimoteSessionManager; clientRegistry: ClientRegistry }): VoiceOrchestratorBootResult {
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
      // v1: random UUID. Speechmux per-call token registration is
      // speechmux-repo work (see docs/plans/voice-mode.md external deps).
      const token = randomUUID();
      const turn = {
        urls: [] as string[],
        username: '',
        credential: '',
      };
      return {
        token,
        turn,
        webrtcSignalUrl: config.voice?.speechmuxSignalUrl ?? '',
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
