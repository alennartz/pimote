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
  CreatePersonaInput,
  PersonaRow,
} from './types.js';
export { createManagerExtension } from './extension.js';
export { loadManagerExtension } from './attachment.js';
export type { ManagerAttachmentSession } from './attachment.js';
export { seedManagerRoot } from './seed.js';
