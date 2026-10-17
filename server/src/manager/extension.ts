import type { ExtensionFactory, ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { realpath } from 'node:fs/promises';
import { sep } from 'node:path';
import { Type } from 'typebox';
import { enrichActiveSessionCounts, isValidFolderName } from '../folder-registry.js';
import { errorToolResult, jsonToolResult, type JsonToolResult } from '../tool-result.js';
import type { FolderInfo } from '../../../shared/dist/index.js';
import { MEMORY_MAINTENANCE_INSTRUCTION, seedPersonaFolder } from './seed.js';
import type { CreateFolderKind, ManagedSessionSummary, ManagerToolContext } from './types.js';

/**
 * Build the pi `ExtensionFactory` for the manager extension (DR-062: one
 * small, powerful tool surface). Registers the manager's seven pimote tools,
 * acting only through the injected `ManagerToolContext`. Folder recipes and
 * the folder model reach the manager through the `pimote-docs` section.
 *
 * Toolset shape — every dashboard folder mutation has a tool twin, and one
 * read answers the folder space:
 * - `pimote_list_folders` — rows + curation + git facts (`repo`, hub `repos`)
 *   + hub membership (`members`) + live counts, `nature` filter, `fresh`
 *   flag. Identity and membership live on the rows; no separate repo or tree
 *   view (owner ruling 2026-01-14: the walk-structure report has no manager
 *   job).
 * - Sessions: `pimote_list_sessions` (one unified view — live state enriched
 *   onto disk records, optional query/open/folderPath filters),
 *   `pimote_start_session`, `pimote_archive_sessions`.
 * - Mutations: `pimote_create_folder` (kind-parameterized: the four wizard
 *   shapes), `pimote_update_folder` (curation), `pimote_update_hub_members`
 *   (batch add/remove with per-member outcomes).
 *
 * `fresh: true` on a read drops the shared discovery cache first so
 * the read blocks on a fresh walk instead of serving data up to one TTL
 * (~30s) old. Absorbs a dedicated rescan tool.
 */

/** Default/capped result count for pimote_list_sessions. */
const LIST_DEFAULT_LIMIT = 20;
const LIST_MAX_LIMIT = 100;
/** Excerpt length for firstMessage in list rows. */
const FIRST_MESSAGE_EXCERPT_LENGTH = 200;

/** One-line structural hint, embedded at the error sites where the folder
 *  model's leaf rule decides between a retry and a different shape. */
const NESTING_HINT =
  'Included folders (code or persona) are leaves — real subfolders inside them stay undiscovered. ' + 'Hub members are symlinked in (kind "code-hub"/"persona-hub"), never nested.';

/** Collapse whitespace and truncate to `maxLength` with an ellipsis. */
function excerpt(text: string, maxLength = FIRST_MESSAGE_EXCERPT_LENGTH): string {
  const normalized = text.replace(/\s+/g, ' ').trim();
  return normalized.length <= maxLength ? normalized : `${normalized.slice(0, maxLength)}…`;
}

/** Human-readable message for a caught failure. */
function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Whether a creation failure is a name collision (existing destination). */
function isCollision(error: unknown): boolean {
  if ((error as NodeJS.ErrnoException)?.code === 'EEXIST') return true;
  return error instanceof Error && error.message.includes('already exists');
}

/** Live status of one open session, mirrored from ManagedSessionSummary. */
const SESSION_STATUS = Type.Union([Type.Literal('working'), Type.Literal('idle')]);

/** Freshness flag shared by the folder-space reads. */
const FRESH_PARAM = Type.Optional(
  Type.Boolean({
    description:
      'Drop the discovery cache before reading, so the result reflects the filesystem now. ' +
      'Without it, reads may serve data up to one TTL (~30s) old while a background refresh runs. ' +
      'Use after manual mv/ln, or to verify that a change converged.',
  }),
);

/** Output schemas: the machine-readable contract for each tool's
 *  structuredContent. */
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
 *  row. The defaulted fields (favorite/archived/missing false, tags empty,
 *  counts zero) are required and annotated with their defaults. Repo facts and
 *  hub member inventory stay explicit so the single list tool answers both. */
const FolderMemberInfoSchema = Type.Object({
  path: Type.String({ description: 'Canonical member path; the symlink target.' }),
  name: Type.String({ description: 'Hub-side symlink basename.' }),
  nature: Type.Union([Type.Literal('code'), Type.Literal('persona')]),
});

const FolderInfoSchema = Type.Object({
  path: Type.String({ description: 'Canonical path — the folder identity and curation key.' }),
  name: Type.String({ description: 'Folder basename; persona folders carry the basename here, never the persona name.' }),
  nature: Type.Union([Type.Literal('code'), Type.Literal('persona')]),
  persona: Type.Optional(PersonaInfoSchema),
  shortcutCount: Type.Integer({ default: 0, description: 'Immediate shortcut occurrences; > 0 marks a hub.' }),
  favorite: Type.Boolean({ default: false }),
  archived: Type.Boolean({ default: false }),
  tags: Type.Array(Type.String(), { default: [] }),
  missing: Type.Boolean({ default: false, description: 'Source-listed repo/hub absent on disk.' }),
  repos: Type.Optional(Type.Array(RepoInfoSchema, { description: 'Code hub-member git facts, derived from member symlinks or a source promise.' })),
  members: Type.Optional(Type.Array(FolderMemberInfoSchema, { description: 'Hub membership from the on-disk symlink inventory.' })),
  repo: Type.Optional(RepoInfoSchema),
  lastActivity: Type.Optional(Type.Integer()),
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

/** One session row of `pimote_list_sessions`: a disk record with live state
 *  patched on when the session is open. */
const SessionRowSchema = Type.Object({
  id: Type.String(),
  name: Type.Optional(Type.String()),
  firstMessage: Type.String(),
  modified: Type.String(),
  folderPath: Type.String(),
  open: Type.Boolean(),
  status: Type.Optional(SESSION_STATUS),
  needsAttention: Type.Optional(Type.Boolean({ description: 'Present when open: the live slot asks for a decision (permission prompt, dialog).' })),
  archived: Type.Boolean(),
  messageCount: Type.Integer(),
});

/** One session row, as returned by pimote_list_sessions. */
interface SessionRow {
  id: string;
  name?: string;
  firstMessage: string;
  modified: string;
  folderPath: string;
  /** True when a live slot currently holds this session. */
  open: boolean;
  /** Live status, present only when open. */
  status?: ManagedSessionSummary['status'];
  /** Live attention flag, present only when open. */
  needsAttention?: boolean;
  archived: boolean;
  messageCount: number;
}

const SessionArchiveOutcomeSchema = Type.Object({
  sessionId: Type.String(),
  outcome: Type.Union([Type.Literal('archived'), Type.Literal('open_slot_evicted'), Type.Literal('not_found')]),
});

/** Structured output for the folder/hub mutations that resolve to a path. */
const FolderPathResultSchema = Type.Object({
  folderPath: Type.String({ description: 'Canonical path of the affected folder.' }),
});

/** One per-member outcome of `pimote_update_hub_members`. */
const MemberOutcomeSchema = Type.Object({
  memberPath: Type.String(),
  action: Type.Union([Type.Literal('add'), Type.Literal('remove')]),
  outcome: Type.Union([Type.Literal('added'), Type.Literal('removed'), Type.Literal('error')]),
  error: Type.Optional(Type.String({ description: 'Registry message, present only on outcome "error".' })),
});

/** One per-member outcome row. */
interface MemberOutcome {
  memberPath: string;
  action: 'add' | 'remove';
  outcome: 'added' | 'removed' | 'error';
  error?: string;
}

/** The fixed persona prompt template: the shipped persona prompt with the
 *  maintain-`memory.md` instruction, no tool listing. */
const PERSONA_PROMPT_TEMPLATE = `You are a persona agent. This folder is your identity and home.

${MEMORY_MAINTENANCE_INSTRUCTION}`;

/** Compose the new persona's AGENTS.md body: the fixed template with the
 *  optional caller prompt folded in ahead of it. Pure: input in, text out.
 *  The front matter and the file writes belong to the seeding seam
 *  (`seedPersonaFolder`). */
function composePersonaBody(prompt?: string): string {
  const trimmed = prompt?.trim();
  return trimmed ? `${trimmed}\n\n${PERSONA_PROMPT_TEMPLATE}` : PERSONA_PROMPT_TEMPLATE;
}

/** Canonical containment: `path` is `root` itself or a true descendant. A
 *  sibling sharing only the root's string prefix is outside. */
function isCanonicalWithin(path: string, root: string): boolean {
  return path === root || path.startsWith(root.endsWith(sep) ? root : `${root}${sep}`);
}

/** Resolve parentPath and the configured roots to their canonical forms.
 *  Returns the canonical parent, or a string error when resolution fails or
 *  the parent sits outside every scan root (symlink escapes included). */
async function resolveParentInRoot(parentPath: string, roots: readonly string[]): Promise<{ parentPath: string } | { error: string }> {
  let canonicalParent: string;
  let canonicalRoots: string[];
  try {
    [canonicalParent, ...canonicalRoots] = await Promise.all([realpath(parentPath), ...roots.map((root) => realpath(root))]);
  } catch (error) {
    return { error: `cannot resolve paths: ${errorMessage(error)}` };
  }
  if (!canonicalRoots.some((root) => isCanonicalWithin(canonicalParent, root))) {
    return { error: `parentPath is not under any scan root: ${parentPath}` };
  }
  return { parentPath: canonicalParent };
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
        'separate folders — identity is the canonical path. Filter by nature for the team view (personas) or the ' +
        'code view. Pass fresh: true to drop the discovery cache first — plain reads may serve data up to ~30s ' +
        'stale while a background refresh runs.',
      parameters: Type.Object({
        fresh: FRESH_PARAM,
        nature: Type.Optional(Type.Union([Type.Literal('code'), Type.Literal('persona')], { description: 'Restrict rows to this nature.' })),
      }),
      annotations: { readOnlyHint: true },
      outputSchema: Type.Array(FolderInfoSchema),
      execute: async (_callId, params): Promise<JsonToolResult<{ error: string } | FolderInfo[]>> => {
        if (params.fresh) context.repos.invalidateListing();
        let folders: FolderInfo[];
        try {
          folders = await context.folders.list();
        } catch (error) {
          return errorToolResult(`failed to list folders: ${errorMessage(error)}`);
        }
        // Live counts, same rule the WS serve-paths use — the agent should
        // never see permanently-zeroed indicators.
        enrichActiveSessionCounts(folders, context.sessions.getAllSessions());
        const rows = folders.filter((folder) => params.nature === undefined || folder.nature === params.nature);
        return jsonToolResult(rows.map(applyFolderDefaults));
      },
    });

    pi.registerTool({
      name: 'pimote_list_sessions',
      label: 'List sessions',
      description:
        'One unified view of sessions across every known folder: on-disk history (open and closed sessions ' +
        'alike) with live state patched onto open rows (status, needsAttention). Newest first, capped by limit. ' +
        'Optional filters: query (case-insensitive substring against session name and first message), folderPath ' +
        '(must be a known folder), open (true keeps only live sessions). Use this for "what is running", ' +
        '"find the session about X", and "what happened in this folder" alike.',
      parameters: Type.Object({
        query: Type.Optional(Type.String({ description: 'Case-insensitive substring matched against session name and first message. Omit to list all.' })),
        folderPath: Type.Optional(Type.String({ description: 'Restrict the view to this folder path (must be a known folder — code or persona).' })),
        open: Type.Optional(Type.Boolean({ description: 'True: keep only sessions a live slot currently holds.' })),
        limit: Type.Optional(Type.Integer({ description: `Maximum number of rows (default ${LIST_DEFAULT_LIMIT}, max ${LIST_MAX_LIMIT}).` })),
      }),
      annotations: { readOnlyHint: true },
      outputSchema: Type.Object({ sessions: Type.Array(SessionRowSchema) }),
      execute: async (_callId, params): Promise<JsonToolResult<{ error: string } | { sessions: SessionRow[] }>> => {
        const query = params.query?.trim().toLowerCase() || undefined;
        let folders: FolderInfo[];
        try {
          folders = await context.folders.list();
        } catch (error) {
          return errorToolResult(`failed to list sessions: ${errorMessage(error)}`);
        }
        let folderPaths: string[];
        if (params.folderPath !== undefined) {
          if (!folders.some((folder) => folder.path === params.folderPath)) {
            return errorToolResult(`unknown folder: ${params.folderPath} — use pimote_list_folders to see known folders`);
          }
          folderPaths = [params.folderPath];
        } else {
          folderPaths = [...new Set(folders.map((folder) => folder.path))];
        }

        const limit = Math.min(Math.max(1, params.limit ?? LIST_DEFAULT_LIMIT), LIST_MAX_LIMIT);
        const openById = new Map(context.sessions.getAllSessions().map((session) => [session.sessionId, session]));

        const rows: SessionRow[] = [];
        const recordsByFolder = await Promise.all(folderPaths.map(async (folderPath) => ({ folderPath, records: await context.sessions.listDiskSessions(folderPath) })));
        for (const { folderPath, records } of recordsByFolder) {
          for (const record of records) {
            const openSession = openById.get(record.id);
            if (params.open === true && openSession === undefined) continue;
            if (query !== undefined) {
              const haystack = `${record.name ?? ''}\n${record.firstMessage}`.toLowerCase();
              if (!haystack.includes(query)) continue;
            }
            rows.push({
              id: record.id,
              name: record.name,
              firstMessage: excerpt(record.firstMessage),
              modified: record.modified,
              folderPath,
              open: openSession !== undefined,
              ...(openSession ? { status: openSession.status, needsAttention: openSession.needsAttention } : {}),
              archived: record.archived,
              messageCount: record.messageCount,
            });
          }
        }

        // Newest first; ISO 8601 timestamps compare chronologically as strings.
        rows.sort((a, b) => (a.modified < b.modified ? 1 : a.modified > b.modified ? -1 : 0));
        return jsonToolResult({ sessions: rows.slice(0, limit) });
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
        '"not_found". Find session ids with pimote_list_sessions.',
      parameters: Type.Object({
        sessionIds: Type.Array(Type.String(), { minItems: 1, description: 'Session ids to archive.' }),
      }),
      outputSchema: Type.Object({
        results: Type.Array(SessionArchiveOutcomeSchema),
      }),
      execute: async (_callId, params) => jsonToolResult({ results: await context.sessions.archiveSessions(params.sessionIds) }),
    });

    pi.registerTool({
      name: 'pimote_create_folder',
      label: 'Create folder',
      description:
        'Create a folder at <parentPath>/<name> — the four dashboard wizard shapes in one tool, selected by kind. ' +
        '"code": git-initialized repo folder (routed through the configured folder creator) plus a seeded ' +
        'AGENTS.md (body). "persona": agent home with persona-marker AGENTS.md (description required; prompt ' +
        'folds into the shipped template) and a memory.md stub. "code-hub"/"persona-hub": hub folder with one ' +
        'symlink per member (memberPaths, discovered folders of any nature), a managed member block in its ' +
        'AGENTS.md, git init, and a member .gitignore; the persona-hub variant is itself a persona (description ' +
        'required; prompt optional) and gains a memory.md stub. parentPath must be inside a scan root — the tool ' +
        'never invents a default location; choose (or ask) using the folder tree. Included folders are leaves: ' +
        'member folders must stay at their canonical homes and be symlinked in, never nested. Creation ' +
        'invalidates discovery and broadcasts folders_changed. Full recipes live in `recipes.md`, listed in the `pimote-docs` section.',
      parameters: Type.Object({
        kind: Type.Union([Type.Literal('code'), Type.Literal('persona'), Type.Literal('code-hub'), Type.Literal('persona-hub')], {
          description: 'Which of the four wizard shapes to create.',
        }),
        name: Type.String({ description: 'New folder basename — one nonempty segment, not "." or "..".' }),
        parentPath: Type.String({ description: 'Absolute path of the existing folder to create under; must be inside a scan root (a parent equal to a scan root is valid).' }),
        memberPaths: Type.Optional(Type.Array(Type.String(), { description: 'Hub kinds only: canonical paths of discovered member folders (any nature).' })),
        description: Type.Optional(Type.String({ description: 'Persona kinds only (required for them): written to the AGENTS.md front matter.' })),
        prompt: Type.Optional(Type.String({ description: 'Persona kinds only: caller persona prompt, folded into the shipped template.' })),
        body: Type.Optional(Type.String({ description: 'Code kinds only: seeded AGENTS.md body; a stub is written even when empty.' })),
      }),
      outputSchema: FolderPathResultSchema,
      execute: async (_callId, params): Promise<JsonToolResult<{ error: string } | { folderPath: string }>> => {
        const kind: CreateFolderKind = params.kind;
        if (!isValidFolderName(params.name)) {
          return errorToolResult(`invalid name ${JSON.stringify(params.name)} — use one nonempty basename segment (not "." or "..")`);
        }
        const isPersonaKind = kind === 'persona' || kind === 'persona-hub';
        if (isPersonaKind && !params.description?.trim()) {
          return errorToolResult(`description is required for kind ${JSON.stringify(kind)}`);
        }
        const isHubKind = kind === 'code-hub' || kind === 'persona-hub';
        if (isHubKind && (!params.memberPaths || params.memberPaths.length === 0)) {
          return errorToolResult(`memberPaths is required for kind ${JSON.stringify(kind)} — pass the canonical paths of discovered member folders`);
        }
        const parent = await resolveParentInRoot(params.parentPath, context.config.roots);
        if ('error' in parent) return errorToolResult(parent.error);

        if (kind === 'code') {
          let created: { folderPath: string };
          try {
            created = await context.creators.create({ root: parent.parentPath, name: params.name, ...(params.body !== undefined ? { body: params.body } : {}) });
          } catch (error) {
            return errorToolResult(`failed to create code folder: ${errorMessage(error)}${isCollision(error) ? ` — ${NESTING_HINT}` : ''}`);
          }
          context.repos.invalidateListing();
          context.notifyFoldersChanged([created.folderPath]);
          return jsonToolResult({ folderPath: created.folderPath });
        }

        if (kind === 'persona') {
          let folderPath: string;
          try {
            folderPath = await seedPersonaFolder(parent.parentPath, params.name, params.description!, composePersonaBody(params.prompt));
          } catch (error) {
            return errorToolResult(
              `failed to create persona folder: ${errorMessage(error)}${isCollision(error) ? ` — pick another name or remove it first. ${NESTING_HINT}` : ''}`,
            );
          }
          // Publish only after successful materialization: discovery
          // invalidation plus the folders_changed broadcast reflect the new
          // persona folder together. Failed creations do neither.
          context.repos.invalidateListing();
          context.notifyFoldersChanged([folderPath]);
          return jsonToolResult({ folderPath });
        }

        // Hub kinds: the registry materializes the hub, broadcasts its own
        // delta, and rolls back partial builds. Listing invalidation mirrors
        // the ws-handler create_hub command twin.
        if (kind !== 'code-hub' && kind !== 'persona-hub') {
          return errorToolResult(`unknown kind ${JSON.stringify(kind)} — use "code", "persona", "code-hub", or "persona-hub"`);
        }
        try {
          const created = await context.folders.createHub({
            name: params.name,
            root: parent.parentPath,
            memberPaths: params.memberPaths!,
            ...(kind === 'persona-hub' ? { description: params.description!, personaText: params.prompt ?? '' } : {}),
            ...(kind === 'code-hub' && params.body !== undefined ? { body: params.body } : {}),
          });
          return jsonToolResult({ folderPath: created.path });
        } catch (error) {
          return errorToolResult(
            `failed to create hub: ${errorMessage(error)} — members must be discovered folders (see pimote_list_folders), ` +
              `must not contain or live inside the hub, and must have unique basenames. ${NESTING_HINT}`,
          );
        }
      },
    });

    pi.registerTool({
      name: 'pimote_update_folder',
      label: 'Update folder',
      description:
        'Apply curation to one folder, keyed by its canonical path: favorite, archive/restore (archived: ' +
        'false restores), and tag changes (addTags/removeTags; source-contributed and inherited tags are not ' +
        'removable). The registry broadcasts the folders_changed delta. At least one field is required. ' +
        'folderPath must be a known folder — see pimote_list_folders.',
      parameters: Type.Object({
        folderPath: Type.String({ description: 'Canonical path of the folder to curate.' }),
        favorite: Type.Optional(Type.Boolean()),
        archived: Type.Optional(
          Type.Boolean({ description: 'true archives the row (hidden from the default dashboard view); false restores it. The folder stays on disk either way.' }),
        ),
        addTags: Type.Optional(Type.Array(Type.String(), { description: 'Tags to add.' })),
        removeTags: Type.Optional(Type.Array(Type.String(), { description: 'User tags to remove.' })),
      }),
      outputSchema: FolderPathResultSchema,
      execute: async (_callId, params): Promise<JsonToolResult<{ error: string } | { folderPath: string }>> => {
        const { folderPath, favorite, archived, addTags, removeTags } = params;
        if (favorite === undefined && archived === undefined && !addTags?.length && !removeTags?.length) {
          return errorToolResult('nothing to update — pass at least one of favorite, archived, addTags, removeTags');
        }
        try {
          await context.folders.update({
            folderPath,
            ...(favorite !== undefined ? { favorite } : {}),
            ...(archived !== undefined ? { archived } : {}),
            ...(addTags?.length ? { addTags } : {}),
            ...(removeTags?.length ? { removeTags } : {}),
          });
        } catch (error) {
          return errorToolResult(`failed to update folder: ${errorMessage(error)} — use pimote_list_folders to see known folders`);
        }
        return jsonToolResult({ folderPath });
      },
    });

    pi.registerTool({
      name: 'pimote_update_hub_members',
      label: 'Update hub members',
      description:
        'Add and remove hub members in one batched call: hub-side symlinks plus the managed member block in ' +
        'the hub AGENTS.md. Removals run first, then additions — a replace-by-same-name swap works in one call. ' +
        'Members must be discovered folders (any nature) with unique basenames; removing works by path even ' +
        'when the member folder is already gone and never touches the member folder itself. Returns one outcome ' +
        'per member path ("added", "removed", or "error" with the registry message). The registry broadcasts a ' +
        'folders_changed delta per accepted mutation. The dashboard performs one add or remove at a time; the ' +
        'manager surface batches (DR-062 over DR-061).',
      parameters: Type.Object({
        hubPath: Type.String({ description: 'Canonical path of the hub folder.' }),
        add: Type.Optional(Type.Array(Type.String(), { description: 'Canonical paths of discovered folders to add as members.' })),
        remove: Type.Optional(Type.Array(Type.String(), { description: 'Canonical member paths to remove.' })),
      }),
      outputSchema: Type.Object({ results: Type.Array(MemberOutcomeSchema) }),
      execute: async (_callId, params): Promise<JsonToolResult<{ error: string } | { results: MemberOutcome[] }>> => {
        const additions = params.add ?? [];
        const removals = params.remove ?? [];
        if (additions.length === 0 && removals.length === 0) {
          return errorToolResult('nothing to update — pass add and/or remove with at least one member path');
        }
        const results: MemberOutcome[] = [];
        for (const memberPath of removals) {
          try {
            await context.folders.removeMember(params.hubPath, memberPath);
            results.push({ memberPath, action: 'remove', outcome: 'removed' });
          } catch (error) {
            results.push({ memberPath, action: 'remove', outcome: 'error', error: errorMessage(error) });
          }
        }
        for (const memberPath of additions) {
          try {
            await context.folders.addMember(params.hubPath, memberPath);
            results.push({ memberPath, action: 'add', outcome: 'added' });
          } catch (error) {
            results.push({ memberPath, action: 'add', outcome: 'error', error: errorMessage(error) });
          }
        }
        return jsonToolResult({ results });
      },
    });
  };
}
