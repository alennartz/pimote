export type {
  ManagerToolContext,
  SessionManagerPort,
  FolderRegistryPort,
  FolderUpdatePatch,
  RepoIndexPort,
  CodeFolderCreationPort,
  CodeFolderCreateInput,
  ManagerThemeAssignment,
  ManagerThemeDemoBundle,
  ManagerThemePort,
  ManagedSessionSummary,
  DiskSessionRecord,
  SessionArchiveOutcome,
  SessionResumeOutcome,
  CreateFolderKind,
} from './types.js';
export { createManagerExtension } from './extension.js';
export { createManagerThemePort } from './theme-port.js';
export type { ManagerThemePortOptions, ManagerThemePreferencesPort, ManagerThemeProfilesPort } from './theme-port.js';
export { loadManagerExtension } from './attachment.js';
export type { ManagerAttachmentSession } from './attachment.js';
export { seedManagerRoot } from './seed.js';
