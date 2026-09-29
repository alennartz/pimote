import type { ExtensionFactory, ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { Type } from 'typebox';
import type { ManagerToolContext } from './types.js';

/**
 * Build the pi `ExtensionFactory` for the manager extension. Registers the
 * manager's pimote toolset, acting only through the injected
 * `ManagerToolContext` — never raw fs.
 *
 * Pinned toolset (listing tools; the agent filters client-side):
 * `pimote_list_projects` (→ `projects.list()`), `pimote_list_repos`
 * (→ `repos.list()`), `pimote_list_sessions` (→ `sessions.getAllSessions()`),
 * each with empty parameters. Session create/manage tools join this toolset
 * at implementation time alongside the ports they need; full tool-surface
 * semantics are settled in the impl plan, not here.
 */

/** A tool result whose text content is the JSON serialization of the details. */
function jsonToolResult<T>(details: T): { content: [{ type: 'text'; text: string }]; details: T } {
  return { content: [{ type: 'text', text: JSON.stringify(details) }], details };
}

export function createManagerExtension(context: ManagerToolContext): ExtensionFactory {
  return (pi: ExtensionAPI) => {
    pi.registerTool({
      name: 'pimote_list_projects',
      label: 'List projects',
      description:
        'List every pimote project: curated single-repo projects and multi-repo hub projects, ' +
        'with path, kind, member repos, and favorite/order/archived flags. Takes no arguments.',
      parameters: Type.Object({}),
      execute: async () => jsonToolResult(await context.projects.list()),
    });

    pi.registerTool({
      name: 'pimote_list_repos',
      label: 'List repos',
      description:
        'List every git repository discovered across the configured roots (the discovery index), ' + 'with branch, dirty flag, and ahead/behind counts. Takes no arguments.',
      parameters: Type.Object({}),
      execute: async () => jsonToolResult(await context.repos.list()),
    });

    pi.registerTool({
      name: 'pimote_list_sessions',
      label: 'List sessions',
      description: 'List all currently open pimote sessions across every project, with session id, ' + 'folder path, working/idle status, and attention flag. Takes no arguments.',
      parameters: Type.Object({}),
      execute: async () => jsonToolResult(context.sessions.getAllSessions()),
    });
  };
}
