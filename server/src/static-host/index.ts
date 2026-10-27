import type { ExtensionFactory, ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';
import { Type } from 'typebox';
import type { Card } from '../../../shared/dist/index.js';
import { jsonToolResult } from '../tool-result.js';
import type { StaticHostRegistry } from './registry.js';
import type { StaticHostStore } from './store.js';
import { executeRegisterTool, executeRemoveTool, resolveSlugCollision, withStaticHostMutation, RegisterToolOutputSchema, RemoveToolOutputSchema, type ToolDeps } from './tools.js';
import type { StaticHostStoreEntry } from './store.js';
import {
  STATIC_HOST_TOOL_DESCRIPTION,
  STATIC_HOST_TOOL_GUIDELINES,
  STATIC_HOST_TOOL_SNIPPET,
  STATIC_HOST_REMOVE_TOOL_DESCRIPTION,
  STATIC_HOST_REMOVE_TOOL_SNIPPET,
} from './prompt.js';

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
  /** Manager artifacts outlive their ephemeral session until its resource lease expires. */
  retainOnShutdown?: boolean;
  /** Snapshot bundles owned by an ephemeral workspace before registration. */
  prepareFolder?: (folder: string) => Promise<string>;
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
      promptSnippet: STATIC_HOST_TOOL_SNIPPET,
      promptGuidelines: STATIC_HOST_TOOL_GUIDELINES,
      exposure: 'direct',
      annotations: { idempotentHint: true },
      parameters: Type.Object({
        slug: Type.String({
          description: 'Requested URL identifier of 1–64 characters, using lowercase letters, digits, and single separating hyphens.',
          pattern: '^[a-z0-9]+(?:-[a-z0-9]+)*$',
          minLength: 1,
          maxLength: 64,
        }),
        folder: Type.String({ description: 'Absolute path to a bundle directory containing index.html.' }),
        title: Type.String({ description: 'Title displayed on the panel card.' }),
        tag: Type.Optional(Type.String({ description: 'Short tag beside the title, with no tag displayed when omitted or empty.' })),
        color: Type.Optional(
          Type.Union([Type.Literal('accent'), Type.Literal('success'), Type.Literal('warning'), Type.Literal('error'), Type.Literal('muted')], {
            description: 'Card border color override, with no override and an ordinary border when omitted.',
          }),
        ),
      }),
      outputSchema: RegisterToolOutputSchema,
      execute: async (_callId, input, _abort, _meta, ctx) => {
        const sessionId = ctx.sessionManager.getSessionId();
        const folder = opts.prepareFolder ? await opts.prepareFolder(input.folder) : input.folder;
        return jsonToolResult(await executeRegisterTool({ ...input, folder }, toolDeps(pi, sessionId)));
      },
    });

    pi.registerTool({
      name: 'pimote_static_host_remove',
      label: 'Remove hosted bundle',
      description: STATIC_HOST_REMOVE_TOOL_DESCRIPTION,
      promptSnippet: STATIC_HOST_REMOVE_TOOL_SNIPPET,
      promptGuidelines: [],
      exposure: 'direct',
      parameters: Type.Object({
        slug: Type.String({ description: 'Resolved slug returned by pimote_static_host.' }),
      }),
      annotations: { destructiveHint: true },
      outputSchema: RemoveToolOutputSchema,
      execute: async (_callId, input, _abort, _meta, ctx) => {
        const sessionId = ctx.sessionManager.getSessionId();
        return jsonToolResult(await executeRemoveTool(input, toolDeps(pi, sessionId)));
      },
    });

    pi.on('session_start', async (_ev: unknown, ctx: ExtensionContext) => {
      const sessionId = ctx.sessionManager.getSessionId();
      await withStaticHostMutation(registry, async () => {
        const file = await store.read(sessionId);
        if (!file) return;
        // Replay persisted entries, re-suffixing any slug already taken by a
        // different folder. An already-active folder is reused when this session
        // already owns it, and dropped when another session owns it. This keeps
        // old duplicate entries from creating another live copy.
        const replayed: StaticHostStoreEntry[] = [];
        let mutated = false;
        for (const entry of file.entries) {
          const activeFolder = registry.findByFolderPath(entry.folderPath);
          if (activeFolder) {
            if (activeFolder.sessionId === sessionId && !replayed.some((replayedEntry) => replayedEntry.slug === activeFolder.slug)) {
              replayed.push(activeFolder.slug === entry.slug ? entry : { ...entry, slug: activeFolder.slug });
              if (activeFolder.slug !== entry.slug) mutated = true;
            } else {
              mutated = true;
            }
            continue;
          }

          let slug = entry.slug;
          if (registry.has(slug)) {
            slug = resolveSlugCollision(slug, registry);
            mutated = true;
          }
          try {
            registry.register({ slug, folderPath: entry.folderPath, sessionId, cardMetadata: entry.cardMetadata });
            replayed.push(slug === entry.slug ? entry : { ...entry, slug });
          } catch (err) {
            // Couldn't register even after re-suffixing — drop it from the file so
            // it doesn't linger as a phantom on the next write.
            mutated = true;
            console.warn(`[static-host] session_start: dropping unregisterable entry ${entry.slug} for session ${sessionId}`, err);
          }
        }
        // Persist the reconciled list only if something changed, so the common
        // conflict-free replay performs no write.
        if (mutated) {
          await store.write(sessionId, { version: 1, entries: replayed });
        }
        emitPanelCards(pi, sessionId);
      });
    });

    pi.on('session_shutdown', async (_ev: unknown, ctx: ExtensionContext) => {
      const sessionId = ctx.sessionManager.getSessionId();
      if (!opts.retainOnShutdown) {
        await withStaticHostMutation(registry, async () => {
          registry.unregisterAllForSession(sessionId);
        });
      }
    });
  };
}
