import { mkdir, symlink, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import type { MultiRepoSourceEntry } from './types.js';

/**
 * The multi-repo project folder layout, owned by pimote: one absolute symlink
 * per member plus a generated AGENTS.md declaring the sub-project convention
 * (each member is an independent git repo whose own AGENTS.md takes
 * precedence). Both `ProjectRegistry.createMultiRepoProject` and the
 * open-time materialization of source-listed projects render this same layout
 * through this function — user sources never replicate it by hand.
 */
export async function materializeMultiRepoFolder(entry: MultiRepoSourceEntry): Promise<void> {
  await mkdir(entry.path, { recursive: true });
  for (const memberPath of entry.memberPaths) {
    // Dangling symlinks are fine: members may themselves be listed-but-not-yet-
    // created. The link is by path and self-heals when the member materializes.
    await symlink(memberPath, join(entry.path, basename(memberPath)));
  }
  await writeFile(join(entry.path, 'AGENTS.md'), agentsMarkdown(entry.name, entry.memberPaths), 'utf8');
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
