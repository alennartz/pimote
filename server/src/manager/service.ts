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

/** Default idle reaper timeout: 30 min, matching the config `idleTimeout` default. */
const DEFAULT_IDLE_TIMEOUT_MS = 1_800_000;

/**
 * Global ephemeral manager, one per client connection: created on first
 * manager use, disposed on disconnect, with an idle reaper as a safety net
 * for connections whose disconnect event was missed.
 */
export class ManagerService {
  private readonly factory: ManagerSessionFactory;
  private readonly idleTimeoutMs: number;
  private readonly now: () => number;
  private readonly clients = new Map<string, ClientEntry>();

  constructor(deps: { context: ManagerToolContext; factory: ManagerSessionFactory; options?: ManagerServiceOptions }) {
    this.idleTimeoutMs = deps.options?.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS;
    this.now = deps.options?.now ?? Date.now;
    this.factory = deps.factory;
  }

  /** The connection's manager session, created on first use. */
  async getOrCreate(clientId: string): Promise<ManagerSession> {
    const existing = this.clients.get(clientId);
    if (existing) {
      existing.lastUsedMs = this.now();
      return existing.session;
    }
    const session = await this.factory({ clientId });
    this.clients.set(clientId, { session, lastUsedMs: this.now() });
    return session;
  }

  /** Tear down the connection's manager session (disconnect path). */
  disposeClient(clientId: string): void {
    const entry = this.clients.get(clientId);
    if (!entry) return;
    this.clients.delete(clientId);
    disposeQuietly(entry.session);
  }

  /** Safety net: reap manager sessions idle beyond the configured timeout. */
  sweepIdle(): void {
    const cutoff = this.now();
    for (const [clientId, entry] of this.clients) {
      if (cutoff - entry.lastUsedMs > this.idleTimeoutMs) {
        this.clients.delete(clientId);
        disposeQuietly(entry.session);
      }
    }
  }
}

interface ClientEntry {
  session: ManagerSession;
  lastUsedMs: number;
}

/** Dispose best-effort: `dispose` may be sync or async; rejections are swallowed. */
function disposeQuietly(session: ManagerSession): void {
  void Promise.resolve(session.dispose()).catch(() => {});
}
