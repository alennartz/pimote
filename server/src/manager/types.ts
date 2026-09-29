import type { ProjectInfo, RepoInfo } from '../../../shared/dist/index.js';
import type { PimoteConfig } from '../config.js';

/** Live snapshot of one open session, as the manager tools see it. */
export interface ManagedSessionSummary {
  sessionId: string;
  folderPath: string;
  status: 'working' | 'idle';
  needsAttention: boolean;
}

/**
 * Narrow session-manager seam for manager tools (DI port per DR-039 —
 * structural interfaces only where they serve dependency injection; the real
 * session manager is checked against this seam at the single construction
 * site).
 */
export interface SessionManagerPort {
  /** All currently open sessions across every folder. */
  getAllSessions(): ManagedSessionSummary[];
}

/** Narrow ProjectRegistry seam for manager tools. */
export interface ProjectRegistryPort {
  list(): Promise<ProjectInfo[]>;
}

/** Narrow RepoIndex seam for manager tools. */
export interface RepoIndexPort {
  list(): Promise<RepoInfo[]>;
}

/**
 * Everything the manager extension's pimote toolset may act through. Tools
 * act only via these ports — never raw fs, never the real server internals.
 */
export interface ManagerToolContext {
  sessions: SessionManagerPort;
  projects: ProjectRegistryPort;
  repos: RepoIndexPort;
  config: PimoteConfig;
}
