import type { ExtensionAPI, ExtensionFactory } from '@earendil-works/pi-coding-agent';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Prompt section name. Pi renders it as the `<pimote-docs>` tag. */
export const PIMOTE_DOCS_SECTION = 'pimote-docs';

/** Package root, resolved from this module. Holds `docs/` and `packages/`. */
const PACKAGE_ROOT = fileURLToPath(new URL('../../../', import.meta.url));

/** Shipped documentation files, relative to the package root, with the task each one serves. */
export const PIMOTE_DOC_FILES: ReadonlyArray<{ path: string; purpose: string }> = [
  {
    path: 'docs/shipped/manager.md',
    purpose: 'Manager tool surface and freshness rules. Read it before folder, hub, or session work through the pimote_* tools.',
  },
  {
    path: 'docs/shipped/folders.md',
    purpose: 'Folder model: nature detection, identity, leaves, hubs, and curation. Read it before you change folder structure or membership.',
  },
  {
    path: 'docs/shipped/recipes.md',
    purpose: 'Creation recipes for the four folder kinds, with expected shapes and anti-patterns. Read it before you create or restructure folders or hubs.',
  },
  {
    path: 'docs/shipped/static-reports.md',
    purpose: 'Design guide for HTML reports hosted with pimote_static_host. Read it before you author a report bundle.',
  },
  {
    path: 'packages/sdk/README.md',
    purpose: 'The @pimote/sdk API for pi extensions: panels, folders, and activity. Read it before you write an extension that talks to pimote.',
  },
];

/** The `pimote-docs` section text: each file's absolute path and its purpose. */
export function pimoteDocsSection(root: string = PACKAGE_ROOT): string {
  const entries = PIMOTE_DOC_FILES.map((file) => `- ${join(root, file.path)}: ${file.purpose}`);
  return ['Pimote documentation ships with this installation. Read the file that matches your task before you act on it:', ...entries].join('\n');
}

/**
 * The pi `ExtensionFactory` that injects the documentation section into every
 * session. Same pattern as my-pi's `my-pi-docs`: a `before_agent_start` hook
 * sets one named section, and the path resolves from the running install.
 */
export function createPimoteDocsExtension(): ExtensionFactory {
  return (pi: ExtensionAPI) => {
    pi.on('before_agent_start', (event) => {
      event.systemPromptOptions.sections[PIMOTE_DOCS_SECTION] = pimoteDocsSection();
    });
  };
}
