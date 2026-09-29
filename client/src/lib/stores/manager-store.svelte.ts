// ManagerStore — client state for the connection's ephemeral manager agent.
//
// The server streams manager output as `manager_event` wrappers around the same
// session event mapping used for regular sessions. Reduction therefore reuses
// SessionRegistry's event→message machinery verbatim, into a private synthetic
// session slot, so manager rendering stays byte-identical with session
// rendering. The manager session lives and dies with the WebSocket connection —
// the store resets when the socket drops.

import type { ManagerStreamEvent, PimoteEvent } from '@pimote/shared';
import { connection } from './connection.svelte.js';
import { SessionRegistry, type PerSessionState } from './session-registry.svelte.js';

/** Synthetic registry slot the manager stream is normalized onto. */
export const MANAGER_SESSION_ID = 'manager';

/** Re-target one mapped session event onto the manager's synthetic slot. The
 *  wrapped event carries the manager session's internal pi id, which is
 *  meaningless to the client. */
function retargetToManager(event: PimoteEvent): PimoteEvent {
  return { ...event, sessionId: MANAGER_SESSION_ID } as PimoteEvent;
}

export class ManagerStore {
  private registry = new SessionRegistry();

  constructor() {
    this.reset();
  }

  /** Manager transcript in the same shape regular sessions render. */
  get session(): PerSessionState | null {
    return this.registry.sessions[MANAGER_SESSION_ID] ?? null;
  }

  get messages(): PerSessionState['messages'] {
    return this.session?.messages ?? [];
  }

  get status(): 'idle' | 'working' {
    return this.session?.status ?? 'idle';
  }

  /** Reduce one `manager_event` payload into the transcript. */
  handleManagerEvent(event: ManagerStreamEvent): void {
    this.registry.handleEvent(retargetToManager(event.event));
  }

  /** Prompt the manager. The optimistic user echo lands only after the server
   *  admits the prompt; the stream replays the canonical user message. */
  async send(text: string): Promise<void> {
    const trimmed = text.trim();
    if (!trimmed) return;
    try {
      const response = await connection.send({ type: 'manager_prompt', text: trimmed });
      if (response.success) {
        this.registry.addOptimisticUserMessage(MANAGER_SESSION_ID, trimmed);
      }
    } catch (err) {
      console.error('[ManagerStore] Failed to send manager prompt:', err);
    }
  }

  /** Abort the running manager prompt, if any. */
  async abort(): Promise<void> {
    try {
      await connection.send({ type: 'manager_abort' });
    } catch (err) {
      console.error('[ManagerStore] Failed to abort manager:', err);
    }
  }

  /** Drop the transcript — the manager is ephemeral per connection, so a
   *  reconnect starts from an empty state. */
  reset(): void {
    this.registry.sessions = {};
    this.registry.sessions[MANAGER_SESSION_ID] = this.registry.createEphemeralState(MANAGER_SESSION_ID, '', 'Manager');
  }
}

export function createManagerStore(): ManagerStore {
  return new ManagerStore();
}

/** Singleton manager store for the app. */
export const managerStore = createManagerStore();

// Route the manager stream into the store; reset when the socket drops so the
// reconnect finds a clean transcript for its fresh manager.
connection.onEvent((event) => {
  if (event.type === 'manager_event') {
    managerStore.handleManagerEvent(event as ManagerStreamEvent);
  }
});
connection.onDisconnect(() => managerStore.reset());
