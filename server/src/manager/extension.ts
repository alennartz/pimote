import type { ExtensionFactory, ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { mkdir, realpath, rm, writeFile } from 'node:fs/promises';
import { join, sep } from 'node:path';
import { Type } from 'typebox';
import { enrichActiveSessionCounts, isValidFolderName } from '../folder-registry.js';
import type { FolderOccurrence, SparseTree } from '../folder-model/index.js';
import { errorToolResult, jsonToolResult, type JsonToolResult } from '../tool-result.js';
import type { FolderInfo } from '../../../shared/dist/index.js';
import { MEMORY_MAINTENANCE_INSTRUCTION, MEMORY_STUB } from './seed.js';
import type { CreatePersonaInput, ManagerToolContext, ManagedSessionSummary, PersonaRow } from './types.js';

/**
 * Build the pi `ExtensionFactory` for the manager extension. Registers the
 * manager's pimote toolset, acting only through the injected
 * `ManagerToolContext`. Persona creation owns its documented disk effects.
 *
 * Toolset: the folder-view tools (`pimote_list_folders` → `folders.list()`,
 * `pimote_folder_tree` → `tree.tree()`, `pimote_list_repos` → `repos.list()`,
 * `pimote_list_sessions` → `sessions.getAllSessions()`), plus the
 * session-space tools: search over on-disk history (`pimote_search_sessions`),
 * starting sessions (`pimote_start_session`), and archiving
 * (`pimote_archive_sessions`). The persona tools (`pimote_create_persona`,
 * `pimote_list_personas`, plan: manager-lifecycle) round out the toolset.
 */

/** Default/capped result count for pimote_search_sessions. */
const SEARCH_DEFAULT_LIMIT = 20;
const SEARCH_MAX_LIMIT = 100;
/** Excerpt length for firstMessage in search results. */
const FIRST_MESSAGE_EXCERPT_LENGTH = 200;

/** Collapse whitespace and truncate to `maxLength` with an ellipsis. */
function excerpt(text: string, maxLength = FIRST_MESSAGE_EXCERPT_LENGTH): string {
  const normalized = text.replace(/\s+/g, ' ').trim();
  return normalized.length <= maxLength ? normalized : `${normalized.slice(0, maxLength)}…`;
}

/** Live status of one open session, mirrored from ManagedSessionSummary. */
const SESSION_STATUS = Type.Union([Type.Literal('working'), Type.Literal('idle')]);

/** Output schemas: the machine-readable contract for each tool's
 *  structuredContent (see the matching interfaces in ./types.js). */
const ManagedSessionSummarySchema = Type.Object({
  sessionId: Type.String(),
  folderPath: Type.String(),
  status: SESSION_STATUS,
  needsAttention: Type.Boolean(),
});

const RepoInfoSchema = Type.Object({
  path: Type.String(),
  name: Type.String(),
  branch: Type.Union([Type.String(), Type.Null()]),
  dirty: Type.Boolean(),
  ahead: Type.Integer(),
  behind: Type.Integer(),
  lastActivity: Type.Optional(Type.Integer()),
  missing: Type.Optional(Type.Boolean()),
  tags: Type.Optional(Type.Array(Type.String())),
});

/** Persona metadata on a persona folder's entry. `name` is optional: a
 *  nameless marker parses to `{}` (see parsePersonaFrontMatter), matching the
 *  `FolderInfo['persona']` wire shape. */
const PersonaInfoSchema = Type.Object({
  name: Type.Optional(Type.String()),
  description: Type.Optional(Type.String()),
});

/** Structured output for `pimote_list_folders`: the complete `FolderInfo`
 *  wire row (shared/src/protocol.ts). The defaulted fields
 *  (favorite/archived/missing false, tags empty, counts zero) are required and
 *  annotated with their defaults; only `persona`, `repos` (hub members), and
 *  `userTags` are optional. */
const FolderInfoSchema = Type.Object({
  path: Type.String({ description: 'Canonical path — the folder identity and curation key.' }),
  name: Type.String({ description: 'Folder basename; persona folders carry the basename here, never the persona name.' }),
  nature: Type.Union([Type.Literal('code'), Type.Literal('persona')]),
  persona: Type.Optional(PersonaInfoSchema),
  shortcutCount: Type.Integer({ default: 0, description: 'Immediate shortcut occurrences; > 0 marks a hub.' }),
  favorite: Type.Boolean({ default: false }),
  archived: Type.Boolean({ default: false }),
  tags: Type.Array(Type.String(), { default: [] }),
  missing: Type.Boolean({ default: false, description: 'Source-listed repo/hub or registry hub absent on disk.' }),
  repos: Type.Optional(Type.Array(RepoInfoSchema)),
  userTags: Type.Optional(Type.Array(Type.String())),
  activeSessionCount: Type.Integer({ default: 0 }),
  externalProcessCount: Type.Integer({ default: 0 }),
});

/** Pure row shaping at the tool boundary: the `FolderInfo` row with every
 *  defaulted field made concrete, so each emitted row satisfies the output
 *  schema even when a source row omits a defaulted field. */
function applyFolderDefaults(folder: FolderInfo): FolderInfo {
  return {
    ...folder,
    shortcutCount: folder.shortcutCount ?? 0,
    favorite: folder.favorite ?? false,
    archived: folder.archived ?? false,
    tags: folder.tags ?? [],
    missing: folder.missing ?? false,
    activeSessionCount: folder.activeSessionCount ?? 0,
    externalProcessCount: folder.externalProcessCount ?? 0,
  };
}

/**
 * Structured output for `pimote_folder_tree`: the folder-model `SparseTree`
 * shape as one self-contained recursive JSON schema — occurrences reference
 * their entry and recurse through `children`. The tree types stay in
 * folder-model/manager (there is no tree wire command); this schema is the
 * tool's structured-output contract only. The root object gains an optional
 * `truncated` flag because the in-memory tree is a shared-entry DAG and JSON
 * serialization unfolds shared shortcut subtrees once per reach (see
 * `boundedTree`).
 */
const SparseTreeSchema = Type.Cyclic(
  {
    FolderEntry: Type.Object({
      path: Type.String({ description: 'Canonical (real) path — the entry identity.' }),
      name: Type.String({ description: 'Folder basename; never the persona name.' }),
      nature: Type.Union([Type.Literal('code'), Type.Literal('persona')]),
      persona: Type.Optional(PersonaInfoSchema),
    }),
    FolderOccurrence: Type.Object({
      path: Type.String({ description: 'Reach path: walked scan path or symlink shortcut path, skipped segments collapsed inline. Identity is entry.path.' }),
      via: Type.Union([Type.Literal('scan'), Type.Literal('shortcut')]),
      entry: Type.Ref('FolderEntry'),
      children: Type.Array(Type.Ref('FolderOccurrence')),
    }),
    SparseTree: Type.Object({
      occurrences: Type.Array(Type.Ref('FolderOccurrence')),
      truncated: Type.Optional(
        Type.Boolean({ description: 'True when the tree was too large to serialize in full: occurrences past the output budget were dropped from children.' }),
      ),
    }),
  },
  'SparseTree',
);

/** Serialized tree output budget, in occurrences. */
const TREE_OUTPUT_BUDGET = 5_000;

/**
 * Bounded serialization of the sparse tree. In-memory, shared entries make the
 * tree a DAG, but JSON.stringify unfolds a shared subtree once per reach — a
 * symlink-dense shortcut DAG serializes exponentially (tens of MB from a few
 * dozen folders), which would block the shared server event loop. Past the
 * budget, children are dropped and the result carries `truncated: true`.
 */
function boundedTree(tree: SparseTree): SparseTree & { truncated?: boolean } {
  let budget = TREE_OUTPUT_BUDGET;
  let truncated = false;
  const visit = (occurrence: FolderOccurrence): FolderOccurrence => {
    if (budget <= 0) {
      truncated = true;
      return { path: occurrence.path, via: occurrence.via, entry: occurrence.entry, children: [] };
    }
    budget--;
    const children: FolderOccurrence[] = [];
    for (const child of occurrence.children) {
      if (budget <= 0) {
        truncated = true;
        break;
      }
      children.push(visit(child));
    }
    return { path: occurrence.path, via: occurrence.via, entry: occurrence.entry, children };
  };
  const occurrences = tree.occurrences.map(visit);
  return truncated ? { occurrences, truncated: true } : { occurrences };
}

const SessionSearchHitSchema = Type.Object({
  id: Type.String(),
  name: Type.Optional(Type.String()),
  firstMessage: Type.String(),
  modified: Type.String(),
  folderPath: Type.String(),
  open: Type.Boolean(),
  status: Type.Optional(SESSION_STATUS),
  archived: Type.Boolean(),
  messageCount: Type.Integer(),
});

const SessionArchiveOutcomeSchema = Type.Object({
  sessionId: Type.String(),
  outcome: Type.Union([Type.Literal('archived'), Type.Literal('open_slot_evicted'), Type.Literal('not_found')]),
});

/** Output row for `pimote_list_personas` (see PersonaRow in ./types.js). */
const PersonaRowSchema = Type.Object({
  name: Type.String(),
  description: Type.String(),
  folderPath: Type.String({ description: 'Canonical identity path of the persona folder.' }),
  workingDirectory: Type.String({ description: 'Personas run rooted in their folder: the same path as folderPath.' }),
});

/** Structured output for `pimote_create_persona` (plan: manager-lifecycle). */
const CreatePersonaResultSchema = Type.Object({
  folderPath: Type.String({ description: 'Canonical path of the new persona folder.' }),
});

/** One search hit, as returned by pimote_search_sessions. */
interface SessionSearchHit {
  id: string;
  name?: string;
  firstMessage: string;
  modified: string;
  folderPath: string;
  /** True when a live slot currently holds this session. */
  open: boolean;
  /** Live status, present only when open. */
  status?: ManagedSessionSummary['status'];
  archived: boolean;
  messageCount: number;
}

/** Human-readable message for a caught failure. */
function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** The fixed persona prompt template: the shipped persona prompt with the
 *  maintain-`memory.md` instruction, no tool listing. */
const PERSONA_PROMPT_TEMPLATE = `You are a persona agent. This folder is your identity and home.

${MEMORY_MAINTENANCE_INSTRUCTION}`;

/** Compose the new persona's AGENTS.md: persona-marker front matter plus the
 *  fixed template with the optional caller prompt folded in ahead of it.
 *  Pure: input in, text out. Front-matter values are JSON-quoted (a valid YAML
 *  double-quoted scalar), so `parsePersonaFrontMatter` round-trips them
 *  exactly on one line each. */
function composePersonaAgentsMd(input: CreatePersonaInput): string {
  const frontMatter = `---
kind: persona\nname: ${JSON.stringify(input.name)}\ndescription: ${JSON.stringify(input.description)}\n---`;
  const prompt = input.prompt?.trim();
  const body = prompt ? `${prompt}\n\n${PERSONA_PROMPT_TEMPLATE}` : PERSONA_PROMPT_TEMPLATE;
  return `${frontMatter}\n\n${body}\n`;
}

/** Canonical containment: `path` is `root` itself or a true descendant. A
 *  sibling sharing only the root's string prefix is outside. */
function isCanonicalWithin(path: string, root: string): boolean {
  return path === root || path.startsWith(root.endsWith(sep) ? root : `${root}${sep}`);
}

/** Materialize one persona folder on disk: create the folder, then write the
 *  composed AGENTS.md and the memory stub. The deliberate disk effect behind
 *  `pimote_create_persona`'s documented tool contract. Refuses existing
 *  destinations without touching them; removes the folder again when a write
 *  fails after creation. Returns the created folder's canonical path. */
async function materializePersonaFolder(folderPath: string, agentsMd: string): Promise<string> {
  let created = false;
  try {
    await mkdir(folderPath);
    created = true;
    await writeFile(join(folderPath, 'AGENTS.md'), agentsMd, 'utf8');
    await writeFile(join(folderPath, 'memory.md'), MEMORY_STUB, 'utf8');
    return await realpath(folderPath);
  } catch (error) {
    if (created) await rm(folderPath, { recursive: true, force: true }).catch(() => undefined);
    throw error;
  }
}

/** The persona rows the tool reports: nature = persona, hubs excluded (a hub
 *  row carries member repos and/or shortcut children). */
function isListedPersonaRow(folder: FolderInfo): boolean {
  return folder.nature === 'persona' && folder.repos === undefined && folder.shortcutCount === 0;
}

/** Shape one immutable PersonaRow: persona name, string description (empty
 *  when absent), canonical identity path doing double duty as the working
 *  directory. */
function toPersonaRow(folder: FolderInfo): PersonaRow {
  return {
    name: folder.persona?.name ?? folder.name,
    description: folder.persona?.description ?? '',
    folderPath: folder.path,
    workingDirectory: folder.path,
  };
}

export function createManagerExtension(context: ManagerToolContext): ExtensionFactory {
  return (pi: ExtensionAPI) => {
    pi.registerTool({
      name: 'pimote_list_folders',
      label: 'List folders',
      description:
        'List every known folder: code folders (git-initialized — repos and hub folders) and persona folders ' +
        '(agent homes whose AGENTS.md carries persona marker front matter), each keyed by its canonical path. ' +
        'Rows carry nature and persona metadata, shortcut count (hub variant), favorite/archived/tags curation, ' +
        'the missing flag, member repos on hub rows, and live session counts. Shortcut reach paths are not ' +
        'separate folders — identity is the canonical path. Takes no arguments.',
      parameters: Type.Object({}),
      annotations: { readOnlyHint: true },
      outputSchema: Type.Array(FolderInfoSchema),
      execute: async (_callId, _params) => {
        const folders = await context.folders.list();
        // Live counts, same rule the WS serve-paths use — the agent should
        // never see permanently-zeroed indicators.
        enrichActiveSessionCounts(folders, context.sessions.getAllSessions());
        return jsonToolResult(folders.map(applyFolderDefaults));
      },
    });

    pi.registerTool({
      name: 'pimote_folder_tree',
      label: 'Folder tree',
      description:
        'Report the sparse folder tree over the configured scan roots as structured JSON: every discovered ' +
        'folder entry (code or persona) with its shortcut occurrences. Each occurrence carries a reach path — ' +
        'the walked scan path or symlink shortcut path with skipped segments collapsed inline — plus the entry, ' +
        'whose canonical path is the folder identity; occurrences reached several ways share one entry. ' +
        'Shortcut occurrences nest their target discoveries in children. Computed on demand from the scan roots. ' +
        'Output is bounded: on very large trees, children past the output budget are dropped and the result ' +
        'carries truncated: true. Takes no arguments.',
      parameters: Type.Object({}),
      annotations: { readOnlyHint: true },
      outputSchema: SparseTreeSchema,
      execute: async (_callId, _params) => jsonToolResult(boundedTree(await context.tree.tree())),
    });

    pi.registerTool({
      name: 'pimote_list_repos',
      label: 'List repos',
      description:
        'List every git repository in the complete code-folder view: folders discovered below the scan roots, ' +
        'hub folders, shortcut targets outside the roots, and folders contributed by registered sources — ' +
        'deliberately not filtered to the configured scan roots. Persona folders are excluded even when ' +
        'git-initialized. Each row carries branch, dirty flag, and ahead/behind counts. Takes no arguments.',
      parameters: Type.Object({}),
      annotations: { readOnlyHint: true },
      outputSchema: Type.Array(RepoInfoSchema),
      execute: async () => jsonToolResult(await context.repos.list()),
    });

    pi.registerTool({
      name: 'pimote_list_sessions',
      label: 'List sessions',
      description:
        'List all currently open pimote sessions across every folder, with session id, ' +
        'folder path, working/idle status, and attention flag. This is the live open-sessions view only — ' +
        'for closed sessions and full history, use pimote_search_sessions. Takes no arguments.',
      parameters: Type.Object({}),
      annotations: { readOnlyHint: true },
      outputSchema: Type.Array(ManagedSessionSummarySchema),
      execute: async () => jsonToolResult(context.sessions.getAllSessions()),
    });

    pi.registerTool({
      name: 'pimote_search_sessions',
      label: 'Search sessions',
      description:
        'Search on-disk session history across every known folder (open and closed sessions alike), ' +
        'matching the query case-insensitively against session name and first message. Returns id, name, ' +
        'first-message excerpt, last-modified time, folder path, open/closed state, and archived ' +
        'flag, newest first. Use pimote_list_sessions for the live open-sessions view only.',
      parameters: Type.Object({
        query: Type.String({ description: 'Case-insensitive substring matched against session name and first message.' }),
        folderPath: Type.Optional(Type.String({ description: 'Restrict the search to this folder path (must be a known folder — code or persona). Omit to search every folder.' })),
        limit: Type.Optional(Type.Integer({ description: `Maximum number of results (default ${SEARCH_DEFAULT_LIMIT}, max ${SEARCH_MAX_LIMIT}).` })),
      }),
      annotations: { readOnlyHint: true },
      outputSchema: Type.Object({
        query: Type.String(),
        results: Type.Array(SessionSearchHitSchema),
      }),
      execute: async (_callId, params): Promise<JsonToolResult<{ error: string } | { query: string; results: SessionSearchHit[] }>> => {
        const query = params.query.trim();
        if (!query) {
          return errorToolResult('query is required');
        }

        const folders = await context.folders.list();
        let folderPaths: string[];
        if (params.folderPath !== undefined) {
          if (!folders.some((folder) => folder.path === params.folderPath)) {
            return errorToolResult(`unknown folder: ${params.folderPath} — use pimote_list_folders to see known folders`);
          }
          folderPaths = [params.folderPath];
        } else {
          folderPaths = [...new Set(folders.map((folder) => folder.path))];
        }

        const limit = Math.min(Math.max(1, params.limit ?? SEARCH_DEFAULT_LIMIT), SEARCH_MAX_LIMIT);
        const needle = query.toLowerCase();
        const openById = new Map(context.sessions.getAllSessions().map((session) => [session.sessionId, session]));

        const hits: SessionSearchHit[] = [];
        const recordsByFolder = await Promise.all(folderPaths.map(async (folderPath) => ({ folderPath, records: await context.sessions.listDiskSessions(folderPath) })));
        for (const { folderPath, records } of recordsByFolder) {
          for (const record of records) {
            const haystack = `${record.name ?? ''}\n${record.firstMessage}`.toLowerCase();
            if (!haystack.includes(needle)) continue;
            const openSession = openById.get(record.id);
            hits.push({
              id: record.id,
              name: record.name,
              firstMessage: excerpt(record.firstMessage),
              modified: record.modified,
              folderPath,
              open: openSession !== undefined,
              ...(openSession ? { status: openSession.status } : {}),
              archived: record.archived,
              messageCount: record.messageCount,
            });
          }
        }

        // Newest first; ISO 8601 timestamps compare chronologically as strings.
        hits.sort((a, b) => (a.modified < b.modified ? 1 : a.modified > b.modified ? -1 : 0));
        return jsonToolResult({ query, results: hits.slice(0, limit) });
      },
    });

    pi.registerTool({
      name: 'pimote_start_session',
      label: 'Start session',
      description:
        'Start a new agent session in a known folder and return its session id. ' +
        'With a firstMessage the new session is tasked immediately and the agent run continues in the ' +
        'background; the tool returns as soon as the session is open. folderPath must be one of the ' +
        'paths returned by pimote_list_folders.',
      parameters: Type.Object({
        folderPath: Type.String({ description: 'Absolute canonical path of the folder to start the session in (must be a known folder).' }),
        firstMessage: Type.Optional(Type.String({ description: 'Optional first user message, sent to the new session right away.' })),
      }),
      outputSchema: Type.Object({
        sessionId: Type.String(),
        folderPath: Type.String(),
        firstMessageSent: Type.Boolean(),
      }),
      execute: async (_callId, params): Promise<JsonToolResult<{ error: string } | { sessionId: string; folderPath: string; firstMessageSent: boolean }>> => {
        const folders = await context.folders.list();
        if (!folders.some((folder) => folder.path === params.folderPath)) {
          return errorToolResult(`unknown folder: ${params.folderPath} — use pimote_list_folders to see known folders`);
        }
        const firstMessage = params.firstMessage?.trim() || undefined;
        const sessionId = await context.sessions.openSession(params.folderPath, firstMessage);
        return jsonToolResult({ sessionId, folderPath: params.folderPath, firstMessageSent: firstMessage !== undefined });
      },
    });

    pi.registerTool({
      name: 'pimote_archive_sessions',
      label: 'Archive sessions',
      description:
        'Archive one or more sessions by id: each on-disk record is marked archived, and a session that ' +
        'is currently open has its live slot evicted (closed) as part of archiving. Returns a per-id ' +
        'outcome: "archived", "open_slot_evicted" (was open; slot closed and record archived), or ' +
        '"not_found". Find session ids with pimote_search_sessions or pimote_list_sessions.',
      parameters: Type.Object({
        sessionIds: Type.Array(Type.String(), { minItems: 1, description: 'Session ids to archive.' }),
      }),
      outputSchema: Type.Object({
        results: Type.Array(SessionArchiveOutcomeSchema),
      }),
      execute: async (_callId, params) => jsonToolResult({ results: await context.sessions.archiveSessions(params.sessionIds) }),
    });

    pi.registerTool({
      name: 'pimote_create_persona',
      label: 'Create persona',
      description:
        'Create a new persona folder at <parentPath>/<name> containing AGENTS.md (front matter: kind persona, name, ' +
        'description; body: the persona prompt template with the instruction to maintain memory.md, plus the ' +
        "caller's prompt folded into the template's fixed sections) and a memory.md stub. parentPath is " +
        'required and must be inside a scan root — the tool never invents a default location; the manager ' +
        'chooses (or asks) using the folder tree. After creation, folder-model discovery is invalidated and a ' +
        'folders_changed delta is broadcast so the dashboard list picks the persona up. Errors: parentPath not under any ' +
        'scan root, name collision (folder exists), fs failure. Canonicalize parentPath and scan roots; ' +
        'a parent equal to a scan root is valid. Reject symlink escapes and names that are not a single ' +
        'nonempty basename segment (including dot and dot-dot). Validation failures return tool errors.',
      parameters: Type.Object({
        name: Type.String({ description: 'New persona folder basename.' }),
        parentPath: Type.String({ description: 'Absolute path of the existing folder to create the persona folder under; must be inside a scan root.' }),
        description: Type.String({ description: 'Persona description; written to the AGENTS.md front matter.' }),
        prompt: Type.Optional(Type.String({ description: "Optional caller persona prompt, folded into the template's fixed sections." })),
      }),
      outputSchema: CreatePersonaResultSchema,
      execute: async (_callId, params): Promise<JsonToolResult<{ error: string } | { folderPath: string }>> => {
        const input: CreatePersonaInput = params;
        if (!isValidFolderName(input.name)) {
          return errorToolResult(`invalid name ${JSON.stringify(input.name)} — use one nonempty basename segment (not "." or "..")`);
        }
        let parentPath: string;
        let roots: string[];
        try {
          [parentPath, roots] = await Promise.all([realpath(input.parentPath), Promise.all(context.config.roots.map((root) => realpath(root)))]);
        } catch (error) {
          return errorToolResult(`cannot resolve paths: ${errorMessage(error)}`);
        }
        if (!roots.some((root) => isCanonicalWithin(parentPath, root))) {
          return errorToolResult(`parentPath is not under any scan root: ${input.parentPath}`);
        }
        let folderPath: string;
        try {
          folderPath = await materializePersonaFolder(join(parentPath, input.name), composePersonaAgentsMd(input));
        } catch (error) {
          return errorToolResult(`failed to create persona folder: ${errorMessage(error)}`);
        }
        // Publish only after successful materialization: discovery
        // invalidation plus the folders_changed broadcast reflect the new
        // persona folder together. Failed creations do neither.
        context.repos.invalidateListing();
        context.notifyFoldersChanged([folderPath]);
        return jsonToolResult({ folderPath });
      },
    });

    pi.registerTool({
      name: 'pimote_list_personas',
      label: 'List personas',
      description:
        'List every persona folder known to the folder model (nature = persona), each row carrying the persona ' +
        'name, description, canonical folderPath (the identity path), and workingDirectory — personas run ' +
        'rooted in their folder, so workingDirectory is the folderPath. Rows come from the folder model over ' +
        'the injected ports; code folders and hubs are excluded. This is groundwork for spawn-and-confer. ' +
        'Takes no arguments. Dependency failures return tool errors.',
      parameters: Type.Object({}),
      annotations: { readOnlyHint: true },
      outputSchema: Type.Object({ personas: Type.Array(PersonaRowSchema) }),
      execute: async (): Promise<JsonToolResult<{ error: string } | { personas: PersonaRow[] }>> => {
        let folders: FolderInfo[];
        try {
          folders = await context.folders.list();
        } catch (error) {
          return errorToolResult(`failed to list personas: ${errorMessage(error)}`);
        }
        return jsonToolResult({ personas: folders.filter(isListedPersonaRow).map(toPersonaRow) });
      },
    });
  };
}
