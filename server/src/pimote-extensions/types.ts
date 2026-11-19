import type { PimoteExtension } from '@pimote/sdk/pimote';
import type { FolderSource } from '@pimote/sdk/folders';

/** The scopes Pi uses for configured package declarations. */
export type PimotePackageScope = 'user' | 'project';

/** The subset of a Pi package declaration needed by the global Pimote host. */
export interface PimoteConfiguredPackage {
  source: string;
  scope: PimotePackageScope;
  filtered: boolean;
  installedPath?: string;
}

/**
 * Narrow adapter over Pi's public package manager.
 *
 * The Pimote host asks only for configured package declarations and installed
 * paths. It never installs, updates, or resolves project-local packages.
 */
export interface PimotePackageManager {
  listConfiguredPackages(): readonly PimoteConfiguredPackage[];
  getInstalledPath(source: string, scope: PimotePackageScope): string | undefined;
}

/** A failure that did not prevent other Pimote extension entries from loading. */
export interface PimoteExtensionDiagnostic {
  path: string;
  message: string;
}

/** The registrations visible to the folder model, settings catalog, and theme catalog. */
export interface PimoteExtensionRegistry {
  /** Sources in deterministic extension discovery order. */
  readonly sources: readonly FolderSource[];
  /** Resolved settings-file paths in deterministic extension discovery order. */
  readonly settingsFiles: readonly string[];
  /** Resolved theme-file paths in deterministic extension discovery order. */
  readonly themeFiles?: readonly string[];
  /** Isolated entry/factory failures from the current runtime. */
  readonly diagnostics: readonly PimoteExtensionDiagnostic[];
}

/** Configuration for one process-global Pimote extension host. */
export interface PimoteExtensionHostOptions {
  /** User-level `$XDG_CONFIG_HOME/pimote/extensions` directory. */
  extensionDirectory: string;
  /** Pi's public package manager. Only user-scoped declarations are loaded. */
  packageManager?: PimotePackageManager;
}

/**
 * Process-global host lifecycle.
 *
 * `reload()` awaits old shutdown handlers, invalidates the old context, and
 * replaces the registry even when some new entries fail. Calls are serialized.
 * Shutdown handlers have no timeout; extension owners must let them settle.
 */
export interface PimoteExtensionHost {
  start(): Promise<PimoteExtensionRegistry>;
  reload(): Promise<PimoteExtensionRegistry>;
  getRegistry(): PimoteExtensionRegistry;
  shutdown(): Promise<void>;
}

/** Type guard-friendly module shape for a discovered Pimote entry. */
export interface PimoteExtensionModule {
  default?: PimoteExtension;
}
