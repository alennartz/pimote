import type { ExtensionFactory } from '@earendil-works/pi-coding-agent';
import type { StaticHostRegistry } from './registry.js';
import type { StaticHostStore } from './store.js';

export { InMemoryStaticHostRegistry } from './registry.js';
export type { StaticHostRegistry, StaticHostRegistration, StaticHostCardMetadata } from './registry.js';
export { FileStaticHostStore } from './store.js';
export type { StaticHostStore, StaticHostStoreEntry, StaticHostStoreFile } from './store.js';
export { serveStaticHostRoute } from './http-handler.js';
export { gcStaticHostStore } from './gc.js';
export type { RegisterToolInput, RegisterToolOutput, RemoveToolInput, RemoveToolOutput } from './tools.js';

export interface CreateStaticHostExtensionOptions {
  registry: StaticHostRegistry;
  store: StaticHostStore;
}

/**
 * Build the pi `ExtensionFactory` for the static-host extension.
 *
 * The returned factory is threaded into every pi session via
 * `resourceLoaderOptions.extensionFactories`. It captures `registry` and
 * `store` by closure and resolves the per-session `sessionId` lazily through
 * the `ctx.sessionManager.getSessionId()` available on event handlers (the pi
 * `ExtensionFactory` itself receives only `ExtensionAPI`, not the sessionId).
 *
 * Lifecycle for one session S:
 *   - First handler invocation (`session_start`): reads
 *     `${storeDir}/${S}.json` if present, replays each entry into the registry,
 *     emits a panel snapshot.
 *   - Tools (`pimote_static_host`, `pimote_static_host_remove`): update the
 *     in-memory list, atomically rewrite the file, update the registry,
 *     re-emit the panel snapshot.
 *   - `session_shutdown` => `registry.unregisterAllForSession(S)`. The file
 *     stays on disk for the next session load.
 */
export function createStaticHostExtension(_opts: CreateStaticHostExtensionOptions): ExtensionFactory {
  throw new Error('not implemented');
}
