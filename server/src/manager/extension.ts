import type { ExtensionFactory, ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { Type } from 'typebox';
import { enrichActiveSessionCounts } from '../project-registry.js';
import type { ManagerToolContext, ManagedSessionSummary } from './types.js';

/**
 * Build the pi `ExtensionFactory` for the manager extension. Registers the
 * manager's pimote toolset, acting only through the injected
 * `ManagerToolContext` — never raw fs.
 *
 * Toolset: the listing tools (`pimote_list_projects` → `projects.list()`,
 * `pimote_list_repos` → `repos.list()`, `pimote_list_sessions` →
 * `sessions.getAllSessions()`), plus the session-space tools: search over
 * on-disk history (`pimote_search_sessions`), starting sessions
 * (`pimote_start_session`), and archiving (`pimote_archive_sessions`).
 */

/** Default/capped result count for pimote_search_sessions. */
const SEARCH_DEFAULT_LIMIT = 20;
const SEARCH_MAX_LIMIT = 100;
/** Excerpt length for firstMessage in search results. */
const FIRST_MESSAGE_EXCERPT_LENGTH = 200;

/** A tool result whose text content is the JSON serialization of the details. */
function jsonToolResult<T>(details: T): { content: [{ type: 'text'; text: string }]; details: T } {
  return { content: [{ type: 'text', text: JSON.stringify(details) }], details };
}

/** A rejected-tool result: JSON details plus the error flag, so the model
 *  reacts to the failure instead of treating it as data. */
function errorToolResult(message: string): { content: [{ type: 'text'; text: string }]; details: { error: string }; isError: true } {
  const details = { error: message };
  return { content: [{ type: 'text', text: JSON.stringify(details) }], details, isError: true };
}

/** Collapse whitespace and truncate to `maxLength` with an ellipsis. */
function excerpt(text: string, maxLength = FIRST_MESSAGE_EXCERPT_LENGTH): string {
  const normalized = text.replace(/\s+/g, ' ').trim();
  return normalized.length <= maxLength ? normalized : `${normalized.slice(0, maxLength)}…`;
}

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

export function createManagerExtension(context: ManagerToolContext): ExtensionFactory {
  return (pi: ExtensionAPI) => {
    pi.registerTool({
      name: 'pimote_list_projects',
      label: 'List projects',
      description:
        'List every pimote project: curated single-repo projects and multi-repo hub projects, ' +
        'with path, kind, member repos, and favorite/order/archived flags. Takes no arguments.',
      parameters: Type.Object({}),
      execute: async () => {
        const projects = await context.projects.list();
        // Live counts, same rule the WS serve-paths use — the agent should
        // never see permanently-zeroed indicators.
        enrichActiveSessionCounts(projects, context.sessions.getAllSessions());
        return jsonToolResult(projects);
      },
    });

    pi.registerTool({
      name: 'pimote_list_repos',
      label: 'List repos',
      description:
        'List every git repository discovered across the configured roots (the discovery index), ' + 'with branch, dirty flag, and ahead/behind counts. Takes no arguments.',
      parameters: Type.Object({}),
      execute: async () => jsonToolResult(await context.repos.list()),
    });

    pi.registerTool({
      name: 'pimote_list_sessions',
      label: 'List sessions',
      description:
        'List all currently open pimote sessions across every project, with session id, ' +
        'folder path, working/idle status, and attention flag. This is the live open-sessions view only — ' +
        'for closed sessions and full history, use pimote_search_sessions. Takes no arguments.',
      parameters: Type.Object({}),
      execute: async () => jsonToolResult(context.sessions.getAllSessions()),
    });

    pi.registerTool({
      name: 'pimote_search_sessions',
      label: 'Search sessions',
      description:
        'Search on-disk session history across every pimote project (open and closed sessions alike), ' +
        'matching the query case-insensitively against session name and first message. Returns id, name, ' +
        'first-message excerpt, last-modified time, project folder path, open/closed state, and archived ' +
        'flag, newest first. Use pimote_list_sessions for the live open-sessions view only.',
      parameters: Type.Object({
        query: Type.String({ description: 'Case-insensitive substring matched against session name and first message.' }),
        projectPath: Type.Optional(Type.String({ description: 'Restrict the search to this project path (must be a known project). Omit to search every project.' })),
        limit: Type.Optional(Type.Integer({ description: `Maximum number of results (default ${SEARCH_DEFAULT_LIMIT}, max ${SEARCH_MAX_LIMIT}).` })),
      }),
      execute: async (_callId: string, params: { query: string; projectPath?: string; limit?: number }) => {
        const query = params.query.trim();
        if (!query) {
          return errorToolResult('query is required');
        }

        const projects = await context.projects.list();
        let folderPaths: string[];
        if (params.projectPath !== undefined) {
          if (!projects.some((project) => project.path === params.projectPath)) {
            return errorToolResult(`unknown project: ${params.projectPath} — use pimote_list_projects to see known projects`);
          }
          folderPaths = [params.projectPath];
        } else {
          folderPaths = [...new Set(projects.map((project) => project.path))];
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
    } as unknown as Parameters<ExtensionAPI['registerTool']>[0]);

    pi.registerTool({
      name: 'pimote_start_session',
      label: 'Start session',
      description:
        'Start a new agent session in a known pimote project and return its session id. ' +
        'With a firstMessage the new session is tasked immediately and the agent run continues in the ' +
        'background; the tool returns as soon as the session is open. projectPath must be one of the ' +
        'paths returned by pimote_list_projects.',
      parameters: Type.Object({
        projectPath: Type.String({ description: 'Absolute path of the project to start the session in (must be a known project).' }),
        firstMessage: Type.Optional(Type.String({ description: 'Optional first user message, sent to the new session right away.' })),
      }),
      execute: async (_callId: string, params: { projectPath: string; firstMessage?: string }) => {
        const projects = await context.projects.list();
        if (!projects.some((project) => project.path === params.projectPath)) {
          return errorToolResult(`unknown project: ${params.projectPath} — use pimote_list_projects to see known projects`);
        }
        const firstMessage = params.firstMessage?.trim() || undefined;
        const sessionId = await context.sessions.openSession(params.projectPath, firstMessage);
        return jsonToolResult({ sessionId, projectPath: params.projectPath, firstMessageSent: firstMessage !== undefined });
      },
    } as unknown as Parameters<ExtensionAPI['registerTool']>[0]);

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
      execute: async (_callId: string, params: { sessionIds: string[] }) => jsonToolResult({ results: await context.sessions.archiveSessions(params.sessionIds) }),
    });
  };
}
