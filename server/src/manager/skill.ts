// The server-provided `pimote-folders` skill. Its markdown is embedded here
// as code (the root package `files` list only packs compiled JS) and is
// materialized to disk at runtime by `ensurePimoteFoldersSkill()` for
// discovery via the manager extension's `resources_discover` handler — the
// same provision pattern as the static-host `static-report` skill.
//
// The skill is the agent-facing documentation of the folder model (DR-053),
// the topology recipes, and the pimote tool behavioral notes. It ships with
// the server version and is rewritten on drift, so upgrades propagate. The
// manager persona's `memory.md` stays tribal and per-installation; this skill
// is authoritative.

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

export const PIMOTE_FOLDERS_SKILL_NAME = 'pimote-folders';

const SKILL_MD = [
  '---',
  `name: ${PIMOTE_FOLDERS_SKILL_NAME}`,
  'description: Pimote folder, persona, hub, and session management. Covers the folder model (natures, canonical identity, the leaf and shortcut rules, discovery freshness), topology recipes for the four folder kinds, and behavioral notes for every pimote_* tool. Read before creating or restructuring folders, before building hubs, or when folder results look stale or missing.',
  '---',
  '',
  '# Pimote folders',
  '',
  'You manage folders through seven pimote tools. This skill explains the model behind them. Read `references/model.md` for the folder model and freshness rules. Read `references/recipes.md` before you create or restructure folders or hubs.',
  '',
  '## Tool surface',
  '',
  '| Tool | Job | Notes |',
  '| --- | --- | --- |',
  '| `pimote_list_folders` | Rows: every folder with nature, curation, git facts (`repo`, hub `repos`), hub membership (`members`), live session counts. | `nature` filter gives the team view (personas) or code view. `fresh: true` drops the discovery cache first. |',
  '| `pimote_list_sessions` | One sessions view: disk history with live state on open rows. | Filters: `query` (name + first message), `folderPath`, `open`. Newest first, capped. |',
  '| `pimote_start_session` | Open a session in a known folder. | `firstMessage` tasks it at once; the run continues in the background. |',
  '| `pimote_archive_sessions` | Mark records archived; evict open slots. | Per-id outcomes. No unarchive tool exists. |',
  '| `pimote_create_folder` | Create one of the four kinds. | `kind`: `code`, `persona`, `code-hub`, `persona-hub`. Persona kinds need `description`; hub kinds need `memberPaths`. |',
  '| `pimote_update_folder` | Curate: favorite, archive or restore, tags. | `archived: false` restores. Keyed by canonical path. |',
  '| `pimote_update_hub_members` | Batch hub membership. | Removals run before additions. Per-member outcomes. |',
  '',
  '## Freshness in one paragraph',
  '',
  'Discovery (the folder listing and its repo facts) is cached on a 30-second TTL with stale-while-revalidate. A plain read may serve data up to one TTL old while a background refresh runs — this explains stale rows after manual `mv` or `ln`. Pass `fresh: true` on a read to drop the cache and block on a fresh walk. Tool mutations invalidate and broadcast immediately, so results reflect them at once.',
  '',
  '## The one walk rule that prevents wrong shapes',
  '',
  'Every included folder — code or persona — is a leaf. Real subfolders inside it stay undiscovered. Only its top-level symlinks that point outside it are followed, as shortcuts to the target folder. Hub membership is symlinks, never nesting. When a folder seems missing after you moved or linked things by hand, do not conclude the model rejected it: read with `fresh: true` first.',
].join('\n');

const MODEL_MD = [
  '# The folder model',
  '',
  '## Scan roots and the walk',
  '',
  'Discovery starts at the configured scan roots (never at the manager root; its entry is excluded from every listing). The walk descends through skipped folders with no depth bound. It stops at included folders.',
  '',
  'Pruned names (`node_modules`, `.git`, `dist`, `build`, `target`, `.venv`) stop descent through skipped folders. They never disqualify a shortcut.',
  '',
  '## Nature detection',
  '',
  'A folder is a persona folder when its `AGENTS.md` begins with a YAML front-matter block that carries a string `name:` key. Otherwise it is a code folder when it has `.git`. Otherwise it is skipped structure the walk descends through. The marker wins over git: a git-initialized persona folder is a persona.',
  '',
  '## Entries, occurrences, identity',
  '',
  "Identity is the canonical real path (`entry.path`). An occurrence is one reach path — the walked scan path or a symlink shortcut path, with skipped segments collapsed inline. One folder reached several ways yields several occurrences that share one entry. Shortcut occurrences nest the target's own discoveries in `children`. Treat `entry.path` as the only identity: sessions, curation, and membership key on it.",
  '',
  '## The leaf and shortcut rule',
  '',
  'An included folder (code or persona) yields exactly one occurrence. The walk never descends into its real subfolders — they are invisible to the model, whatever markers they carry. The only children the walk takes from an included folder are its top-level symlinks whose targets lie outside it: each becomes a shortcut occurrence and discovery restarts at the target. This is why hub members are symlinked into hubs, and why a persona hub works exactly like a code hub.',
  '',
  '## Hubs',
  '',
  'A hub is any included folder whose top-level symlinks point to discovered folders outside it. The symlink inventory is the membership truth, whoever created the folder. `pimote_create_folder` builds the standard shape: absolute symlinks, a generated `AGENTS.md` with a managed member block, `git init`, and a `.gitignore` listing member names. A hub is a working folder, not a shell: code hubs can carry hub-level code; persona hubs are agents with their own prompt and `memory.md`. Source-listed hubs may be promised before their folder exists; once materialized, the same on-disk shape takes over. Hubs classify as code or persona by their own marker.',
  '',
  '## Curation',
  '',
  'Favorite, archived, order, and tags attach to the canonical path. A folder moved on disk orphans its curation state — the state is recorded and ignored. Restore an archived folder with `pimote_update_folder` (`archived: false`); the folder never leaves disk.',
  '',
  '## Freshness',
  '',
  'One cached walk feeds the folder listing and its repo facts. The cache holds for 30 seconds and serves stale entries while a background refresh runs (stale-while-revalidate). Consequences:',
  '',
  '- After manual `mv` or `ln`, expect stale rows for up to one TTL. Re-read with `fresh: true` before you treat a missing folder as a failure.',
  '- Creation and membership tools invalidate the cache; every folder mutation broadcasts a `folders_changed` delta. Follow-up reads converge at once.',
  '- `fresh: true` on any folder-space read drops the cache first and blocks on the walk. Use it to verify convergence.',
  '',
  '## Sessions',
  '',
  'Sessions persist per folder. Personas run rooted in their own folder. Any discovered folder accepts a new session through `pimote_start_session`; folders the model cannot see (nested inside an included folder, never discovered) accept none.',
].join('\n');

const RECIPES_MD = [
  '# Topology recipes',
  '',
  'All four recipes are one `pimote_create_folder` call. `parentPath` must sit inside a scan root. Pick parent and members with `pimote_list_folders` (hub rows carry `members`).',
  '',
  '## Code folder',
  '',
  '```',
  'pimote_create_folder { kind: "code", name: "app", parentPath: "/srv/repos", body: "What this repo is for." }',
  '```',
  '',
  'Creates `app/` with `git init` and a seeded `AGENTS.md`. Discovery follows from the `.git` marker.',
  '',
  '## Persona folder',
  '',
  '```',
  'pimote_create_folder { kind: "persona", name: "ada", parentPath: "/srv/repos", description: "debugging specialist", prompt: "You are Ada." }',
  '```',
  '',
  'Creates `ada/` with a persona-marker `AGENTS.md` (description required; prompt folds into the shipped template) and a `memory.md` stub. The persona runs sessions rooted in this folder.',
  '',
  '## Code hub',
  '',
  '```',
  'pimote_create_folder { kind: "code-hub", name: "platform", parentPath: "/srv/repos", memberPaths: ["/srv/repos/api", "/srv/repos/web"] }',
  '```',
  '',
  'Creates `platform/`: symlinks `api` and `web`, generated `AGENTS.md` with the managed member block, `git init`, member `.gitignore`. Members keep their canonical homes and appear at top level too.',
  '',
  '## Persona hub',
  '',
  '```',
  'pimote_create_folder { kind: "persona-hub", name: "danny", parentPath: "/srv/repos", description: "crew lead", prompt: "You are Danny Ocean.", memberPaths: ["/srv/repos/rusty", "/srv/repos/livingston"] }',
  '```',
  '',
  'Same as the code hub, plus the persona marker and a `memory.md` stub — the hub itself is a persona. Expected folder shape (as `pimote_list_folders` reports it — one hub row with two members, plus one row per member):',
  '',
  '```',
  '/srv/repos/',
  '├── danny/                  persona (the hub)',
  '│   ├── AGENTS.md           marker + managed member block',
  '│   ├── memory.md',
  '│   ├── rusty      -> ../rusty        (shortcut)',
  '│   └── livingston -> ../livingston   (shortcut)',
  '├── rusty/                  persona (canonical home)',
  '└── livingston/             persona (canonical home)',
  '```',
  '',
  'Sessions can start at any of the three folders. Membership changes later go through `pimote_update_hub_members`; never hand-edit inside the managed member block of a hub `AGENTS.md` (the lines between `<!-- pimote:members (managed block) -->` and `<!-- /pimote:members -->`).',
  '',
  '## Anti-patterns and their symptoms',
  '',
  '| Attempt | Symptom | Fix |',
  '| --- | --- | --- |',
  '| Nest a real persona folder inside another persona folder. | Parent shows no children; the nested folder never registers; no session can start in it. | Move the member back to its canonical home at top level, then link it: `pimote_update_hub_members` with `add`. |',
  '| Build a hub by hand with symlinks and custom AGENTS.md prose. | Membership tools work from the symlink shape, but custom member lines do not match the seeded strings and stay untouched on removal. | Use `pimote_update_hub_members`; it edits only exact seeded lines and adds a managed block for later edits. |',
  '| Manual `mv` of a folder, then an immediate read. | Stale rows, missing rows, or orphaned curation for up to ~30 seconds. | Re-read with `fresh: true`; expect curation loss after a real move. |',
  '| Hand-edit the managed member block. | Membership tools and the block drift apart. | Use `pimote_update_hub_members`; edits outside the block markers stay yours. |',
].join('\n');

/** Every file of the skill, relative to its directory, with its exact content.
 *  One source of truth for what the materialized skill contains. */
const SKILL_FILES: ReadonlyArray<{ relative: string; markdown: string }> = [
  { relative: 'SKILL.md', markdown: SKILL_MD },
  { relative: join('references', 'model.md'), markdown: MODEL_MD },
  { relative: join('references', 'recipes.md'), markdown: RECIPES_MD },
];

/**
 * Materialize the `pimote-folders` skill under `skillsDir` and return its
 * `SKILL.md` path for use in a `resources_discover` `skillPaths` result.
 *
 * Idempotent per file: rewrites only when the on-disk content differs, so
 * concurrent sessions sharing the directory stay read-only in the common case
 * and version upgrades still propagate.
 */
export async function ensurePimoteFoldersSkill(skillsDir: string): Promise<string> {
  const skillDir = join(skillsDir, PIMOTE_FOLDERS_SKILL_NAME);
  await mkdir(join(skillDir, 'references'), { recursive: true });
  for (const file of SKILL_FILES) {
    const filePath = join(skillDir, file.relative);
    const existing = await readFile(filePath, 'utf8').catch(() => undefined);
    if (existing !== file.markdown) {
      await writeFile(filePath, file.markdown, 'utf8');
    }
  }
  return join(skillDir, 'SKILL.md');
}
