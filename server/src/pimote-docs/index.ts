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
    path: 'packages/sdk/docs/authoring.md',
    purpose: 'Pimote extension host and factory contract: where modules load, package manifests, registrations, reload, and diagnostics.',
  },
  {
    path: 'packages/sdk/docs/themes.md',
    purpose: 'Extension theme-file registration and the versioned paired palette format.',
  },
  {
    path: 'packages/sdk/docs/panels.md',
    purpose: 'Card data for the session panel: handle lifetime, colors, links, validation, and repaint on client claim.',
  },
  {
    path: 'packages/sdk/docs/activity.md',
    purpose: 'The reap-guard veto: when Pimote closes an idle session and how a responder holds it open.',
  },
  {
    path: 'packages/sdk/docs/folders.md',
    purpose: 'Folder source contract: entry shapes, which facts Pimote owns, open hooks, and promised hubs.',
  },
  {
    path: 'packages/sdk/docs/subagents.md',
    purpose: 'The interactive subagent provider: registration, operations, placement, leases, and replay.',
  },
  {
    path: 'docs/shipped/folders.md',
    purpose: 'Folder model: scan roots, prune rules, leaves, shortcuts, identity, curation, and cache freshness.',
  },
  {
    path: 'docs/shipped/hubs.md',
    purpose: 'Hub shapes: symlink and worktree layouts, the managed member block, membership edits, and disband guards.',
  },
  {
    path: 'docs/shipped/sessions.md',
    purpose: 'Session model: folders that accept sessions, live state, archive and resume, idle reaping, and interrupted runs.',
  },
  {
    path: 'docs/shipped/recipes.md',
    purpose: 'Creation recipes for the four folder kinds, with expected layouts and failure modes. Read it before you create or restructure folders or hubs.',
  },
  {
    path: 'docs/shipped/settings.md',
    purpose: 'Native config fields and the global Settings catalog: file set, validation, and when each change applies.',
  },
  {
    path: 'docs/shipped/themes.md',
    purpose: 'Theme files, catalog precedence, defaults, profile overrides, and PWA Appearance behavior.',
  },
  {
    path: 'docs/shipped/delivery.md',
    purpose: 'Report hosting and file download offers: serving rules, lifetime, and what a browser does with each.',
  },
  {
    path: 'docs/shipped/static-reports.md',
    purpose: 'Layout and visual design for HTML reports hosted with pimote_static_host.',
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
