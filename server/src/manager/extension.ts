import type { ExtensionFactory } from '@earendil-works/pi-coding-agent';
import type { ManagerToolContext } from './types.js';

/**
 * Build the pi `ExtensionFactory` for the manager extension. Registers the
 * pimote toolset (project / repo / session tools) that acts only through the
 * injected `ManagerToolContext` — never raw fs.
 */
export function createManagerExtension(context: ManagerToolContext): ExtensionFactory {
  void context;
  throw new Error('not implemented');
}
