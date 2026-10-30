/**
 * A server-global Pimote extension.
 *
 * The host creates a fresh context for each runtime. Extensions must keep all
 * registrations behind that context because the host invalidates it on reload.
 */
export type PimoteExtension = (context: PimoteExtensionContext) => void | Promise<void>;

/**
 * Context exposed to server-global Pimote extensions.
 *
 * This is intentionally separate from pi's session-scoped ExtensionAPI. Pimote
 * extensions contribute folder discovery and global settings files only.
 */
export interface PimoteExtensionContext {
  readonly folders: {
    registerSource(source: import('../folders/types.js').FolderSource): void;
  };
  readonly settings: {
    registerFile(path: string): void;
  };
  on(event: 'shutdown', handler: () => void | Promise<void>): () => void;
}

export type PimoteShutdownHandler = () => void | Promise<void>;
