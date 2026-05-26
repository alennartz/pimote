import type { ExtensionFactory, ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';
import { Type } from 'typebox';
import type { Card } from '../../../shared/dist/index.js';
import type { StaticHostRegistry } from './registry.js';
import type { StaticHostStore } from './store.js';
import { executeRegisterTool, executeRemoveTool, type RegisterToolInput, type RemoveToolInput, type ToolDeps } from './tools.js';
import { STATIC_HOST_TOOL_DESCRIPTION } from './prompt.js';

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
export function createStaticHostExtension(opts: CreateStaticHostExtensionOptions): ExtensionFactory {
  const { registry, store } = opts;

  function buildCardsFor(sessionId: string): Card[] {
    return registry.listForSession(sessionId).map((entry) => {
      const card: Card = {
        id: `static-host:${entry.slug}`,
        header: {
          title: entry.cardMetadata.title,
          ...(entry.cardMetadata.tag !== undefined ? { tag: entry.cardMetadata.tag } : {}),
        },
        href: `/s/${entry.slug}/`,
        ...(entry.cardMetadata.color !== undefined ? { color: entry.cardMetadata.color } : {}),
      };
      return card;
    });
  }

  function emitPanelCards(pi: ExtensionAPI, sessionId: string): void {
    const cards = buildCardsFor(sessionId);
    pi.events.emit('pimote:panels', { type: 'cards', namespace: 'static-host', cards });
  }

  function emitNavigate(pi: ExtensionAPI, url: string): void {
    pi.events.emit('pimote:navigate', { url });
  }

  function toolDeps(pi: ExtensionAPI, sessionId: string): ToolDeps {
    return {
      registry,
      store,
      sessionId,
      emitPanelCards: () => emitPanelCards(pi, sessionId),
      emitNavigate: (url) => emitNavigate(pi, url),
    };
  }

  return (pi: ExtensionAPI) => {
    pi.registerTool({
      name: 'pimote_static_host',
      label: 'Host static bundle',
      description: STATIC_HOST_TOOL_DESCRIPTION,
      parameters: Type.Object({
        slug: Type.String({ description: 'Short URL slug, lowercase [a-z0-9-]+ with no leading/trailing dash.' }),
        folder: Type.String({ description: 'Absolute path to the folder containing the bundle (must contain index.html).' }),
        title: Type.String({ description: 'Title displayed on the panel card.' }),
        tag: Type.Optional(Type.String({ description: 'Optional short tag shown next to the title.' })),
        color: Type.Optional(
          Type.Union([Type.Literal('accent'), Type.Literal('success'), Type.Literal('warning'), Type.Literal('error'), Type.Literal('muted')], {
            description: 'Optional card color.',
          }),
        ),
      }),
      execute: async (_callId: string, input: RegisterToolInput, _abort: unknown, _meta: unknown, ctx: ExtensionContext) => {
        const sessionId = ctx.sessionManager.getSessionId();
        const out = await executeRegisterTool(input, toolDeps(pi, sessionId));
        return { content: [{ type: 'text', text: JSON.stringify(out) }], details: out };
      },
    } as unknown as Parameters<ExtensionAPI['registerTool']>[0]);

    pi.registerTool({
      name: 'pimote_static_host_remove',
      label: 'Remove hosted bundle',
      description: 'Unregister a previously hosted static bundle by slug.',
      parameters: Type.Object({
        slug: Type.String({ description: 'Slug of the bundle to remove.' }),
      }),
      execute: async (_callId: string, input: RemoveToolInput, _abort: unknown, _meta: unknown, ctx: ExtensionContext) => {
        const sessionId = ctx.sessionManager.getSessionId();
        const out = await executeRemoveTool(input, toolDeps(pi, sessionId));
        return { content: [{ type: 'text', text: JSON.stringify(out) }], details: out };
      },
    } as unknown as Parameters<ExtensionAPI['registerTool']>[0]);

    pi.on('session_start', async (_ev: unknown, ctx: ExtensionContext) => {
      const sessionId = ctx.sessionManager.getSessionId();
      const file = await store.read(sessionId);
      if (!file) return;
      for (const entry of file.entries) {
        try {
          registry.register({
            slug: entry.slug,
            folderPath: entry.folderPath,
            sessionId,
            cardMetadata: entry.cardMetadata,
          });
        } catch (err) {
          // Defensive: a slug conflict (e.g. two sessions persisted the same
          // slug, or another session reloaded earlier this boot) must not
          // abort the whole replay loop and leave the session partially
          // loaded. Skip the conflicting entry and continue.
          console.warn(`[static-host] session_start: skipping persisted entry ${entry.slug} for session ${sessionId}`, err);
        }
      }
      emitPanelCards(pi, sessionId);
    });

    pi.on('session_shutdown', async (_ev: unknown, ctx: ExtensionContext) => {
      const sessionId = ctx.sessionManager.getSessionId();
      registry.unregisterAllForSession(sessionId);
    });
  };
}
