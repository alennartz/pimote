export type {
  ManagerToolContext,
  SessionManagerPort,
  FolderRegistryPort,
  FolderUpdatePatch,
  RepoIndexPort,
  FolderCreatorsPort,
  CodeFolderCreateInput,
  ManagedSessionSummary,
  DiskSessionRecord,
  SessionArchiveOutcome,
  CreateFolderKind,
} from './types.js';
export { createManagerExtension } from './extension.js';
export { loadManagerExtension } from './attachment.js';
export type { ManagerAttachmentSession } from './attachment.js';
export { seedManagerRoot } from './seed.js';
