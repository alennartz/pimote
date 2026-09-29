import type { AgentSession } from '@earendil-works/pi-coding-agent';
import type { PimoteEvent } from '../../../shared/dist/index.js';
import type { ManagerToolContext } from './types.js';

/** One connection's live manager session. */
export interface ManagerSession {
  /** The ephemeral pi session (SessionManager.inMemory, temp cwd). */
  readonly session: AgentSession;
  /** Subscribe to mapped wire events from this manager's runs. Returns unsubscribe. */
  onEvent(cb: (event: PimoteEvent) => void): () => void;
  /** Tear down the underlying runtime. Idempotent. */
  dispose(): Promise<void> | void;
}

/**
 * Seam over session-manager's runtime factory: builds an ephemeral manager
 * session (createAgentSessionRuntime + SessionManager.inMemory + empty temp
 * cwd) and maps its streaming through the existing session event mapping.
 */
export type ManagerSessionFactory = (args: { clientId: string }) => Promise<ManagerSession>;

export interface ManagerServiceOptions {
  /** Idle reaper safety net: reap a manager session idle beyond this many ms. */
  idleTimeoutMs?: number;
  /** Injectable monotonic clock in ms, for deterministic reaper behavior. */
  now?: () => number;
}

/**
 * Global ephemeral manager, one per client connection: created on first
 * manager use, disposed on disconnect, with an idle reaper as a safety net
 * for connections whose disconnect event was missed.
 */
export class ManagerService {
  constructor(
    private readonly deps: {
      context: ManagerToolContext;
      factory: ManagerSessionFactory;
      options?: ManagerServiceOptions;
    },
  ) {}

  /** The connection's manager session, created on first use. */
  async getOrCreate(clientId: string): Promise<ManagerSession> {
    void clientId;
    void this.deps;
    throw new Error('not implemented');
  }

  /** Tear down the connection's manager session (disconnect path). */
  disposeClient(clientId: string): void {
    void clientId;
    throw new Error('not implemented');
  }

  /** Safety net: reap manager sessions idle beyond the configured timeout. */
  sweepIdle(): void {
    throw new Error('not implemented');
  }
}
