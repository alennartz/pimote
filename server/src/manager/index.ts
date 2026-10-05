export type {
  ManagerToolContext,
  SessionManagerPort,
  FolderRegistryPort,
  FolderUpdatePatch,
  FolderModelPort,
  RepoIndexPort,
  ManagedSessionSummary,
  DiskSessionRecord,
  SessionArchiveOutcome,
} from './types.js';
export { ManagerService } from './service.js';
export type { ManagerSession, ManagerSessionFactory, ManagerServiceOptions } from './service.js';
export { createManagerExtension } from './extension.js';
