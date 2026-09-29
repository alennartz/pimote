import type { ExtensionFactory } from '@earendil-works/pi-coding-agent';
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
export function createManagerExtension(context: ManagerToolContext): ExtensionFactory {
  void context;
  throw new Error('not implemented');
}
