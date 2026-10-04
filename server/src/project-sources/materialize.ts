import { mkdir, symlink, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import type { MultiRepoSourceEntry } from '@pimote/sdk/projects';
import { gitInitDir } from './git-init.js';

/**
 * The multi-repo hub folder layout, owned by pimote: one absolute symlink
 * per member, a generated AGENTS.md declaring the sub-project convention
 * (each member is an independent git repo whose own AGENTS.md takes
 * precedence), plus `git init` and a .gitignore for the member links — the
 * hub is a self-describing git repo whose members surface as shortcuts.
 * Both `FolderRegistry.createHub` and the open-time
 * materialization of source-listed hubs render this same layout through this
 * function — user sources never replicate it by hand.
 */
export async function materializeMultiRepoFolder(entry: MultiRepoSourceEntry): Promise<void> {
  await mkdir(entry.path, { recursive: true });
  for (const memberPath of entry.memberPaths) {
    // Dangling symlinks are fine: members may themselves be listed-but-not-yet-
    // created. The link is by path and self-heals when the member materializes.
    await symlink(memberPath, join(entry.path, basename(memberPath)));
  }
  await writeFile(join(entry.path, 'AGENTS.md'), agentsMarkdown(entry.name, entry.memberPaths), 'utf8');
  await writeFile(join(entry.path, '.gitignore'), memberIgnore(entry.memberPaths), 'utf8');
  await gitInitDir(entry.path);
}

/** The hub's .gitignore: the member symlink basenames, so the links stay untracked. */
function memberIgnore(memberPaths: string[]): string {
  return memberPaths.map((memberPath) => `${basename(memberPath)}\n`).join('');
}

/** The generated project AGENTS.md: members plus the sub-project convention. */
export function agentsMarkdown(projectName: string, memberPaths: string[]): string {
  const members = memberPaths.map((memberPath) => `- ${basename(memberPath)} → ${memberPath}`).join('\n');
  return [
    `# ${projectName}`,
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
