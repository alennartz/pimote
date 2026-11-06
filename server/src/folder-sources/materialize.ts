import { mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import type { HubSourceEntry } from '@pimote/sdk/folders';
import { gitInitDir } from './git-init.js';

/** The worktree-hub mode marker. Membership stays shape-derived; the marker
 *  only preserves the worktree choice after the last code worktree is
 *  removed. It carries nothing else — no version, branch, or member list. */
export const HUB_MARKER_FILE = '.pimote-hub.json';

const WORKTREE_MARKER_CONTENT = '{"memberRepresentation":"worktree"}';

/** Whether `dir` carries a valid worktree-mode marker: `.pimote-hub.json`
 *  containing exactly `{ "memberRepresentation": "worktree" }`. Read and
 *  parse failures count as absent — one broken hub directory must never
 *  fail the listing. */
export async function hasWorktreeMarker(dir: string): Promise<boolean> {
  try {
    const parsed: unknown = JSON.parse(await readFile(join(dir, HUB_MARKER_FILE), 'utf8'));
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed) && JSON.stringify(parsed) === WORKTREE_MARKER_CONTENT;
  } catch {
    return false;
  }
}

/** Write the worktree-mode marker into an existing hub directory. */
export async function writeWorktreeMarker(dir: string): Promise<void> {
  await writeFile(join(dir, HUB_MARKER_FILE), `${WORKTREE_MARKER_CONTENT}\n`, 'utf8');
}

/** Exclusively create the hub directory: the layout is only ever built into
 *  a directory this call created, and a failed build removes it again. Both
 *  entry paths get the same guarantees this way — a retry (e.g. after a
 *  failed `git init`) rebuilds fully instead of inheriting a half-built hub
 *  that open-time materialization would then leave git-less forever. */
export async function createHubDirectory(path: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  try {
    await mkdir(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new Error(`Directory already exists: ${path}`, { cause: error });
    throw error;
  }
}

/** The worktree hub's .gitignore content: the mode marker plus every member
 *  basename, so the hub repository ignores its own layout. One root-anchored
 *  literal pattern per line. */
export function worktreeHubIgnore(memberNames: string[]): string {
  return [HUB_MARKER_FILE, ...memberNames].map((name) => `${memberIgnoreLine(name)}\n`).join('');
}

/**
 * The hub folder layout, owned by pimote: one absolute symlink
 * per member, a generated AGENTS.md declaring the sub-project convention
 * (each member is an independent git repo whose own AGENTS.md takes
 * precedence), plus `git init` and a .gitignore for the member links — the
 * hub is a self-describing git repo whose members surface as shortcuts.
 * Both `FolderRegistry.createHub` and the open-time
 * materialization of source-listed hubs render this same layout through this
 * function — user sources never replicate it by hand. Callers that own a
 * different AGENTS.md layout (registry `createHub`) pass it as `agentsMd`.
 */
export async function materializeHubFolder(entry: HubSourceEntry, agentsMd: string = agentsMarkdown(entry.name, entry.memberPaths)): Promise<void> {
  await createHubDirectory(entry.path);
  try {
    for (const memberPath of entry.memberPaths) {
      // Dangling symlinks are fine: members may themselves be listed-but-not-yet-
      // created. The link is by path and self-heals when the member materializes.
      await symlink(memberPath, join(entry.path, basename(memberPath)));
    }
    await writeFile(join(entry.path, 'AGENTS.md'), agentsMd, 'utf8');
    await writeFile(join(entry.path, '.gitignore'), memberIgnore(entry.memberPaths), 'utf8');
    await gitInitDir(entry.path);
  } catch (error) {
    await rm(entry.path, { recursive: true, force: true }).catch(() => {});
    throw error;
  }
}

/**
 * Escape one member basename into a literal gitignore pattern: valid
 * filesystem names contain gitignore syntax (`#member` must not become a
 * comment; `*`, `?`, or brackets must not hide unrelated hub files), and
 * trailing spaces are trimmed by git unless escaped.
 */
function gitignoreEscape(name: string): string {
  return name.replace(/([\\*?[\]!#])/g, '\\$1').replace(/ +$/, (run) => run.replace(/ /g, '\\ '));
}

/** One root-anchored literal .gitignore pattern for a member symlink
 *  basename — the single pattern rule shared by hub creation and member
 *  add/remove. No trailing newline. */
export function memberIgnoreLine(name: string): string {
  return `/${gitignoreEscape(name)}`;
}

/** The hub's .gitignore: one root-anchored literal pattern per member symlink
 *  basename, so the links stay untracked. */
function memberIgnore(memberPaths: string[]): string {
  return memberPaths.map((memberPath) => `${memberIgnoreLine(basename(memberPath))}\n`).join('');
}

/** The generated hub AGENTS.md: members plus the sub-project convention. */
export function agentsMarkdown(hubName: string, memberPaths: string[]): string {
  const members = memberPaths.map((memberPath) => `- ${basename(memberPath)} → ${memberPath}`).join('\n');
  return [
    `# ${hubName}`,
    '',
    'A multi-repo project. The member repositories below are symlinked into this directory:',
    '',
    members,
    '',
    '## Convention',
    '',
    'Each member directory is an independent git repository with its own AGENTS.md. When working',
    'inside a member directory, that repository is a sub-project: its AGENTS.md takes precedence',
    "over this file, and keep each repository's work inside its own directory.",
    '',
  ].join('\n');
}
