import type { ExtensionFactory, ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { realpath } from 'node:fs/promises';
import { sep } from 'node:path';
import { Type } from 'typebox';
import { enrichActiveSessionCounts, isValidFolderName } from '../folder-registry.js';
import { errorToolResult, jsonToolResult, type JsonToolResult } from '../tool-result.js';
import { spillRows } from './spill.js';
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
 * - `pimote_find_folders` — rows + curation + git facts (`repo`, hub `repos`)
 *   + hub membership (`members`) + live counts; query/nature/hub/archived
 *   filters, the query on folder text only — session content search lives in
 *   `pimote_find_sessions` (revising the DR-074 two-tier fold). Identity
 *   and membership live on the rows; no separate repo or tree view (owner
 *   ruling 2026-01-14: the walk-structure report has no manager job).
 * - Sessions: `pimote_find_sessions` (one unified view — live state enriched
 *   onto disk records, optional query/open/folderPath/includeArchived
 *   filters), `pimote_start_session`, `pimote_archive_sessions`.
 *
 * Reads carry three cross-cutting policies:
 * - Spill guard (DR-071): list results past a 16KB serialized budget keep
 *   their first rows inline; the rest spills to a JSONL file the payload
 *   points at with a jq/grep hint (`spill.ts`).
 * - Interruption (DR-072): list tools race pi's turn-abort signal against
 *   the ports — callers reject at once; shared walks and cache fills always
 *   complete for the next reader. Mutations complete once started.
 * - Channel split (DR-073): the guard bounds only the model-facing view;
 *   `structuredContent` carries every row for codemode scripts, `details`
 *   carries truncation metadata only — never a payload copy.
 * - Mutations: `pimote_create_folder` (kind-parameterized: the four wizard
 *   shapes), `pimote_update_folder` (curation), `pimote_update_hub_members`
 *   (batch add/remove with per-member outcomes).
 *
 * No freshness flag (DR-074, revising DR-062): reads serve the shared
 * discovery cache as-is — stale while revalidating, up to one ~30s TTL —
 * and mutations invalidate and broadcast at once.
 */

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

/** Structured output for `pimote_find_folders`: the complete `FolderInfo`
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

/** One session row of `pimote_find_sessions`: a disk record with live state
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

/** One session row, as returned by pimote_find_sessions. */
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

/** Spill pointer on a list-tool payload: the rows past the inline budget
 *  live in a JSONL file the agent searches with jq/grep (see spill.ts). */
const SpillInfoSchema = Type.Object({
  file: Type.String({ description: 'Absolute path of the spill file holding the remaining rows (one JSON object per line).' }),
  rows: Type.Integer({ description: 'Number of rows in the spill file.' }),
  hint: Type.String({ description: 'How to search the spill file with jq/grep.' }),
});

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

/** Folder-text match: persona display name, name, path, tags. Session content
 *  never matches here — `pimote_find_sessions` owns it (revising the DR-074
 *  two-tier fold). */
function filterByQuery(rows: FolderInfo[], query: string): FolderInfo[] {
  return rows.filter((row) => [row.persona?.name ?? row.name, row.name, row.path, ...row.tags].some((text) => text.toLowerCase().includes(query)));
}

export function createManagerExtension(context: ManagerToolContext): ExtensionFactory {
  return (pi: ExtensionAPI) => {
    pi.registerTool({
      name: 'pimote_find_folders',
      label: 'Find folders',
      description: 'Find known folders — code, persona, and hub — by query across name, path, tags, and persona name, with curation state and live session counts.',
      promptGuidelines: ['Filter pimote_find_folders with query, nature, and hub instead of scanning full listings.'],
      parameters: Type.Object({
        query: Type.Optional(
          Type.String({
            description: 'Case-insensitive substring matched against folder name, path, tags, and persona name. ' + 'Session content search lives in pimote_find_sessions.',
          }),
        ),
        nature: Type.Optional(Type.Union([Type.Literal('code'), Type.Literal('persona')], { description: 'Restrict rows to this base nature (hub rows keep their base nature).' })),
        hub: Type.Optional(Type.Boolean({ description: 'true: only hub rows. false: exclude hub rows. Omit: both.' })),
        includeArchived: Type.Optional(Type.Boolean({ description: 'true: include folders flagged archived. Default false.' })),
      }),
      annotations: { readOnlyHint: true },
      outputSchema: Type.Object({ folders: Type.Array(FolderInfoSchema), spill: Type.Optional(SpillInfoSchema) }),
      execute: async (_callId, params, signal): Promise<JsonToolResult> => {
        signal?.throwIfAborted();
        let folders: FolderInfo[];
        try {
          folders = await context.folders.list(signal);
        } catch (error) {
          // An abort propagates as a throw: pi records cancellation, not a
          // tool failure the model would answer.
          if ((error as Error)?.name === 'AbortError') throw error;
          return errorToolResult(`failed to list folders: ${errorMessage(error)}`);
        }
        // Live counts, same rule the WS serve-paths use — the agent should
        // never see permanently-zeroed indicators.
        enrichActiveSessionCounts(folders, context.sessions.getAllSessions());
        let rows = folders.map(applyFolderDefaults);
        if (params.nature !== undefined) rows = rows.filter((row) => row.nature === params.nature);
        if (params.hub !== undefined) rows = rows.filter((row) => row.shortcutCount > 0 === params.hub);
        if (!params.includeArchived) rows = rows.filter((row) => !row.archived);
        const query = params.query?.trim().toLowerCase() || undefined;
        if (query !== undefined) rows = filterByQuery(rows, query);
        const outcome = await spillRows('pimote_find_folders', rows, signal);
        // Channel split (DR-073): the guard bounds only the model-facing view;
        // structuredContent carries every row for codemode scripts, details
        // carries renderer metadata for the list view: row counts, plus the
        // spill pointer when the guard truncated.
        return jsonToolResult(
          { folders: rows },
          {
            modelView: { folders: outcome.rows, ...(outcome.spill ? { spill: outcome.spill } : {}) },
            details: {
              totalRows: rows.length,
              inlineRows: outcome.rows.length,
              ...(outcome.spill ? { spill: { file: outcome.spill.file, rows: outcome.spill.rows } } : {}),
            },
          },
        );
      },
    });

    pi.registerTool({
      name: 'pimote_find_sessions',
      label: 'Find sessions',
      description: 'Find sessions across all folders, open and closed, newest first, filtered by query, folder, open, and archived state.',
      promptGuidelines: [
        'Prefer filtered pimote_find_sessions calls: pass folderPath and query first; use open: true for what is running now.',
        'Pass includeArchived only when you need archived history.',
      ],
      parameters: Type.Object({
        query: Type.Optional(Type.String({ description: 'Case-insensitive substring matched against session name and first message. Omit to list all.' })),
        folderPath: Type.Optional(Type.String({ description: 'Restrict the view to this folder path (must be a known folder — code or persona).' })),
        open: Type.Optional(Type.Boolean({ description: 'True: keep only sessions a live slot currently holds.' })),
        includeArchived: Type.Optional(Type.Boolean({ description: 'true: include sessions flagged archived. Default false.' })),
      }),
      annotations: { readOnlyHint: true },
      outputSchema: Type.Object({ sessions: Type.Array(SessionRowSchema), spill: Type.Optional(SpillInfoSchema) }),
      execute: async (_callId, params, signal): Promise<JsonToolResult> => {
        signal?.throwIfAborted();
        const query = params.query?.trim().toLowerCase() || undefined;
        let folders: FolderInfo[];
        try {
          folders = await context.folders.list(signal);
        } catch (error) {
          // An abort propagates as a throw: pi records cancellation, not a
          // tool failure the model would answer.
          if ((error as Error)?.name === 'AbortError') throw error;
          return errorToolResult(`failed to list sessions: ${errorMessage(error)}`);
        }
        let folderPaths: string[];
        if (params.folderPath !== undefined) {
          if (!folders.some((folder) => folder.path === params.folderPath)) {
            return errorToolResult(`unknown folder: ${params.folderPath} — use pimote_find_folders to see known folders`);
          }
          folderPaths = [params.folderPath];
        } else {
          folderPaths = [...new Set(folders.map((folder) => folder.path))];
        }

        const openById = new Map(context.sessions.getAllSessions().map((session) => [session.sessionId, session]));

        const rows: SessionRow[] = [];
        const recordsByFolder = await Promise.all(folderPaths.map(async (folderPath) => ({ folderPath, records: await context.sessions.listDiskSessions(folderPath, signal) })));
        // The per-folder port races its shared fills (DR-072); this boundary
        // check guarantees the tool rejects on abort even when a port
        // implementation completed its work anyway.
        signal?.throwIfAborted();
        for (const { folderPath, records } of recordsByFolder) {
          for (const record of records) {
            if (!params.includeArchived && record.archived) continue;
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
        const outcome = await spillRows('pimote_find_sessions', rows, signal);
        // Channel split (DR-073): see pimote_find_folders.
        return jsonToolResult(
          { sessions: rows },
          {
            modelView: { sessions: outcome.rows, ...(outcome.spill ? { spill: outcome.spill } : {}) },
            details: {
              totalRows: rows.length,
              inlineRows: outcome.rows.length,
              ...(outcome.spill ? { spill: { file: outcome.spill.file, rows: outcome.spill.rows } } : {}),
            },
          },
        );
      },
    });

    pi.registerTool({
      name: 'pimote_start_session',
      label: 'Start session',
      description: 'Start a new agent session in a known folder, optionally tasked with a first message that runs in the background.',
      parameters: Type.Object({
        folderPath: Type.String({ description: 'Absolute canonical path of the folder to start the session in (must be a known folder).' }),
        firstMessage: Type.Optional(Type.String({ description: 'Optional first user message, sent to the new session right away.' })),
      }),
      outputSchema: Type.Object({
        sessionId: Type.String(),
        folderPath: Type.String(),
        firstMessageSent: Type.Boolean(),
      }),
      execute: async (_callId, params): Promise<JsonToolResult> => {
        const folders = await context.folders.list();
        if (!folders.some((folder) => folder.path === params.folderPath)) {
          return errorToolResult(`unknown folder: ${params.folderPath} — use pimote_find_folders to see known folders`);
        }
        const firstMessage = params.firstMessage?.trim() || undefined;
        const sessionId = await context.sessions.openSession(params.folderPath, firstMessage);
        return jsonToolResult({ sessionId, folderPath: params.folderPath, firstMessageSent: firstMessage !== undefined });
      },
    });

    pi.registerTool({
      name: 'pimote_archive_sessions',
      label: 'Archive sessions',
      description: 'Archive sessions by id, evicting any open session, and return a per-id outcome.',
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
      description: 'Create one of the four folder shapes — code, persona, code-hub, persona-hub — at a chosen path inside a scan root.',
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
      execute: async (_callId, params): Promise<JsonToolResult> => {
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
            `failed to create hub: ${errorMessage(error)} — members must be discovered folders (see pimote_find_folders), ` +
              `must not contain or live inside the hub, and must have unique basenames. ${NESTING_HINT}`,
          );
        }
      },
    });

    pi.registerTool({
      name: 'pimote_update_folder',
      label: 'Update folder',
      description: 'Apply curation — favorite, archived, tags — to one folder by canonical path.',
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
      execute: async (_callId, params): Promise<JsonToolResult> => {
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
          return errorToolResult(`failed to update folder: ${errorMessage(error)} — use pimote_find_folders to see known folders`);
        }
        return jsonToolResult({ folderPath });
      },
    });

    pi.registerTool({
      name: 'pimote_update_hub_members',
      label: 'Update hub members',
      description: 'Add and remove hub members in one batched call, returning a per-member outcome.',
      parameters: Type.Object({
        hubPath: Type.String({ description: 'Canonical path of the hub folder.' }),
        add: Type.Optional(Type.Array(Type.String(), { description: 'Canonical paths of discovered folders to add as members.' })),
        remove: Type.Optional(Type.Array(Type.String(), { description: 'Canonical member paths to remove.' })),
      }),
      outputSchema: Type.Object({ results: Type.Array(MemberOutcomeSchema) }),
      execute: async (_callId, params): Promise<JsonToolResult> => {
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
