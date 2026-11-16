import type { WebSocket } from 'ws';
import { randomUUID } from 'node:crypto';
import { basename, dirname, sep } from 'node:path';
import type {
  PimoteCommand,
  PimoteResponse,
  PimoteEvent,
  SessionState,
  BufferedEventsEvent,
  ConnectionRestoredEvent,
  FullResyncEvent,
  FullResyncStartEvent,
  RestoreMode,
  SessionRestoreEvent,
  SessionClosedEvent,
  SessionStateChangedEvent,
  SessionCommandsChangedEvent,
  CommandInfo,
  FolderInfo,
  PromptOutcome,
  PromptResponseData,
  GetGlobalSettingsResponseData,
  GetTreeResponseData,
  ServerCapabilitiesEvent,
  SubagentCommand,
  SubagentOpenViewResponseData,
  SubagentViewSnapshot,
  SubagentViewEvent,
  SubagentViewClosedEvent,
  UserSessionsChangedEvent,
  ReorderSessionsResponseData,
} from '../../shared/dist/index.js';
import type { PimoteSessionManager, ManagedSlot, SessionResetOutcome, SessionObserver, EventSocket } from './session-manager.js';
import {
  createCommandContextActions,
  makeDownloadSnapshot,
  makeSessionSettingsEvent,
  replaySlotPendingUiRequests,
  requestSlotPanelResync,
  resolveAllSlotPendingUi,
  resolveSlotPendingUi,
  sendBatchedEvent,
  runSlotLifecycle,
  isNestedSlotLifecycle,
  sendSlotEvent,
} from './session-manager.js';
import { LoginBusyError, type LoginTransport } from './login-orchestrator.js';
import { getMergedPanelCards } from './panel-state.js';
import { resolveSessionAcrossFolders, type SessionRecordLocation, type SessionRecords } from './session-records.js';
import type { RepoIndex } from './repo-index.js';
import { enrichActiveSessionCounts, isValidFolderName, type FolderRegistry } from './folder-registry.js';
import { seedPersonaFolder } from './manager/seed.js';
import { createCodeFolder } from './folder-create.js';
import type { FolderListingService } from './folder-listing.js';
import type { UserProfiles } from './user-profiles.js';
import { classifyFolder, nodeFolderFs } from './folder-model/index.js';
import { findExternalPiProcesses, killExternalPiProcesses } from './takeover.js';
import type { PushNotificationService } from './push-notification.js';
import type { FileSessionMetadataStore } from './session-metadata.js';
import { mapAgentMessage, mapAgentMessageUsage, mapContextEntries, rendererRegisteredVisibility } from './message-mapper.js';
import { resolveImageInputs } from './image-registry.js';
import type { TreeNavigationStartEvent, TreeNavigationEndEvent } from './event-buffer.js';
import { makeSessionMeta } from './session-usage.js';
import { completeFileRefs } from './file-references.js';
import { readEditableFile, writeEditableFile } from './file-edit.js';
import { attributeDrained, type Intent } from './queue-ownership.js';
import type { AgentSession } from '@earendil-works/pi-coding-agent';
import type { VoiceOrchestrator } from './voice-orchestrator.js';
import { CallBindError } from './voice-orchestrator.js';
import type { ConfigRuntime } from './config-runtime.js';
import type { SubagentSurfaceCommand, SubagentViewAttachment, SubagentViewChange } from './subagent-host.js';
import type { SessionSurfaceCallerContext, SessionSurfaceCommand } from './session-surface.js';
import { mapTreeNodes, serializeTreeResponse, type SessionTreeNode } from './session-tree.js';
export { mapTreeNodes, serializeTreeResponse } from './session-tree.js';

export interface WsGlobalSettingsDependencies {
  manifest?: () => Promise<GetGlobalSettingsResponseData>;
  reloadPimoteExtensions?: () => Promise<void>;
  configRuntime?: ConfigRuntime;
  capabilities?: () => ServerCapabilitiesEvent;
}

/**
 * Hand user input to pi and resolve with pi's dispatch outcome. Input that
 * meets an active run joins the `streamingBehavior` queue; input that meets an
 * idle session starts a run. Extension commands run either way. `onStarted`
 * runs inside pi's `started` preflight, before pi emits the run's messages.
 * Rejects when pi refuses the prompt before dispatch.
 */
/** True when the forwarded input's first token is the retired `/new`
 *  command: such input never dispatches to pi. */
function isForwardedNew(message: string): boolean {
  return message.trim().split(/\s+/)[0] === '/new';
}

function dispatchPrompt(
  session: Pick<AgentSession, 'prompt'>,
  text: string,
  images: Awaited<ReturnType<typeof resolveImageInputs>>,
  streamingBehavior: 'steer' | 'followUp',
  onStarted: () => void,
): Promise<PromptOutcome> {
  return new Promise((resolve, reject) => {
    let dispatched = false;
    session
      .prompt(text, {
        images,
        streamingBehavior,
        preflightResult: (disposition) => {
          dispatched = true;
          if (disposition === 'started') onStarted();
          resolve(disposition);
        },
      })
      .then(
        // pi defers a prompt submitted while it emits agent_settled and returns
        // without a preflight. The deferred run echoes unstamped, like a queued one.
        () => {
          if (!dispatched) resolve('queued');
        },
        (err: unknown) => {
          if (dispatched) console.error(`[WsHandler] prompt error:`, err);
          else reject(err);
        },
      );
  });
}

function getSessionCommands(session: AgentSession): CommandInfo[] {
  const commands: CommandInfo[] = [];

  // Skills
  const { skills } = session.resourceLoader.getSkills();
  for (const skill of skills) {
    commands.push({
      name: `skill:${skill.name}`,
      description: skill.description,
      hasArgCompletions: false,
    });
  }

  // Prompt templates
  for (const template of session.promptTemplates) {
    commands.push({
      name: template.name,
      description: template.description,
      hasArgCompletions: false,
    });
  }

  // Extension commands
  const extensionCommands = session.extensionRunner?.getRegisteredCommands() ?? [];
  for (const cmd of extensionCommands) {
    commands.push({
      name: cmd.name,
      description: cmd.description ?? '',
      hasArgCompletions: !!cmd.getArgumentCompletions,
    });
  }

  // Pimote built-in commands
  commands.push(
    { name: 'new', description: 'Start a new session', hasArgCompletions: false },
    { name: 'reload', description: 'Reload extensions and skills', hasArgCompletions: false },
    { name: 'tree', description: 'Navigate session history tree', hasArgCompletions: false },
    { name: 'login', description: 'Log in to a model provider', hasArgCompletions: false },
    { name: 'logout', description: 'Log out from a model provider', hasArgCompletions: false },
    { name: 'compact', description: 'Manually compact the session context', hasArgCompletions: false },
  );

  return commands;
}

/** The synthetic folder row for a session cwd the registry does not list:
 *  classified on the fly (marker/git → nature/persona) with plain defaults.
 *  Pure construction from explicit inputs — the cwd is never listed or
 *  curated merely because a session was opened there. */
async function buildFallbackFolder(folderPath: string): Promise<FolderInfo> {
  const { nature, persona } = await classifyFolder(nodeFolderFs, folderPath);
  return {
    path: folderPath,
    name: basename(folderPath),
    nature,
    ...(persona ? { persona } : {}),
    shortcutCount: 0,
    favorite: false,
    archived: false,
    tags: [],
    missing: false,
    activeSessionCount: 0,
    externalProcessCount: 0,
  };
}

async function resolveFolderInfoForSession(
  folderPath: string,
  sessionManager: PimoteSessionManager,
  folderRegistry: FolderRegistry | undefined,
  fallbackOnError = false,
): Promise<FolderInfo> {
  const listed = folderRegistry ? (await folderRegistry.listLazy()).find((folder) => folder.path === folderPath) : undefined;
  let folder: FolderInfo;
  if (listed) {
    folder = listed;
  } else {
    try {
      folder = await buildFallbackFolder(folderPath);
    } catch (error) {
      if (!fallbackOnError) throw error;
      folder = {
        path: folderPath,
        name: basename(folderPath),
        nature: 'code',
        shortcutCount: 0,
        favorite: false,
        archived: false,
        tags: [],
        missing: false,
        activeSessionCount: 0,
        externalProcessCount: 0,
      };
    }
  }
  if (listed && folderRegistry) void folderRegistry.requestStatusRefresh([folder]).catch(() => {});
  enrichActiveSessionCounts([folder], sessionManager.getAllSessions());
  return folder;
}

/** The canonical folder key containing an edited file — folder rows are keyed
 *  by canonical path, and a file path is not a folder key. Falls back to the
 *  lexical containing directory when canonicalization fails. */
async function resolveContainingFolder(filePath: string): Promise<string> {
  const folder = dirname(filePath);
  try {
    return await nodeFolderFs.realpath(folder);
  } catch {
    return folder;
  }
}

/** Keep the legacy ws-handler import path for command-context tests and consumers. */
export { createCommandContextActions };

/** Client ID → WsHandler lookup for targeted cross-client notifications. */
export type ClientRegistry = Map<string, WsHandler>;

/**
 * Register `handler` as the live connection for `clientId`, evicting the
 * previous owner of that id (stale-connection takeover on same-tab reconnect).
 *
 * Ordering invariant: the registry is repointed BEFORE the stale handler is
 * cleaned up and closed, so its close handler skips its own cleanup (the
 * registry no longer names it) and cannot orphan the sessions the replacement
 * now owns. Pending UI responses survive on the ManagedSlot for replay when
 * the replacement's reconnect commands reclaim sessions via claimSession().
 */
export function takeOverClientSlot(clientRegistry: ClientRegistry, clientId: string, handler: WsHandler): void {
  const existing = clientRegistry.get(clientId);
  clientRegistry.set(clientId, handler);
  if (existing) {
    existing.cleanup();
    existing.closeWebSocket();
  }
}

/** Close one live session for every observer and resolve its pending UI. */
export async function closeSessionForObservers(
  sessionManager: Pick<PimoteSessionManager, 'closeSession'>,
  clientRegistry: ClientRegistry,
  sessionId: string,
  slot: ManagedSlot,
  reason?: SessionClosedEvent['reason'],
): Promise<void> {
  await runSlotLifecycle(slot, 'close', async () => {
    const observerClientIds = slot.observers ? [...slot.observers.keys()] : [];
    for (const clientId of observerClientIds) {
      clientRegistry.get(clientId)?.sendSessionClosedEvent(sessionId, reason);
    }
    if (slot.sessionState) resolveAllSlotPendingUi(slot);
    await sessionManager.closeSession(sessionId);
  });
}

export class WsHandler {
  private subscribedSessions = new Set<string>();
  private fdWarningEmitted = false;
  private viewedSessionId: string | null = null;
  /** Pending login prompt/select inputs keyed by requestId (mirrors pendingUiResponses). */
  private pendingLoginInputs = new Map<string, { resolve: (v: string) => void; reject: (e: unknown) => void }>();
  /** AbortController for the in-flight login flow this connection initiated, if any. */
  private loginAbort: AbortController | null = null;
  private readonly folderConnectionId = randomUUID();
  private readonly boundSubagentViewListeners = new Map<ManagedSlot, (change: SubagentViewChange, incarnation?: string, viewCursor?: number) => void>();
  /** Token owned by this socket for each concrete root host. */
  private readonly subagentConnectionTokens = new Map<ManagedSlot, { host: NonNullable<ManagedSlot['subagentHost']>; token: number }>();
  /** Slots with a `/reload` waiting for their next idle boundary. */
  private readonly deferredReloads = new Set<ManagedSlot>();
  readonly clientId: string;

  constructor(
    private readonly managerRoot: string,
    private readonly sessionManager: PimoteSessionManager,
    private readonly sessionRecords: SessionRecords,
    private readonly ws: WebSocket,
    private readonly pushNotificationService: PushNotificationService,
    private readonly sessionMetadataStore: FileSessionMetadataStore,
    clientId: string,
    private readonly clientRegistry: ClientRegistry,
    private readonly voiceOrchestrator?: VoiceOrchestrator,
    private readonly repoIndex?: RepoIndex,
    private readonly folderRegistry?: FolderRegistry,
    private readonly folderListing?: FolderListingService,
    private readonly reloadPimoteExtensions?: () => Promise<void>,
    private readonly globalSettings?: WsGlobalSettingsDependencies,
    private readonly userProfiles?: UserProfiles,
    /** Honor-system connection identity resolved from the `?user=` query param at socket open. */
    private readonly user: string = 'default',
  ) {
    this.clientId = clientId;
    // Open-time pin initialization, nonblocking: a folder command arriving
    // before it completes awaits the pending pin. A start failure (including a
    // service that fails synchronously) is contained here — no unhandled
    // rejection — and retried through the next folder command's error path.
    if (this.folderListing && this.repoIndex && this.folderRegistry) {
      // Open-time pin initialization, nonblocking. The listing service owns
      // the connection's pin (one business operation, one layer): early
      // folder commands await its pending pin, omitted-token queries reuse
      // it, and `repin` replaces it. A start failure is contained here — no
      // unhandled rejection — and retried by the next folder command.
      try {
        void this.folderListing.pin(this.folderConnectionId).catch(() => {});
      } catch {
        // No pending pin: the next folder command retries initialization.
      }
    }
  }

  getViewedSessionId(): string | null {
    return this.viewedSessionId;
  }

  async handleMessage(raw: string): Promise<void> {
    let command: PimoteCommand;
    try {
      command = JSON.parse(raw);
    } catch {
      this.sendResponse('unknown', false, undefined, 'Invalid JSON');
      return;
    }

    // Guard against non-object payloads (e.g. `null`, a bare number/string):
    // dereferencing `command.id` on those throws outside the response try block.
    if (command === null || typeof command !== 'object') {
      this.sendResponse('unknown', false, undefined, 'Invalid command');
      return;
    }

    const id = command.id ?? 'unknown';

    try {
      switch (command.type) {
        // ---- Server-level commands ----
        case 'list_folders': {
          const { repoIndex, folderListing } = this.requireFolderDeps();
          if (!folderListing) throw new Error('Folder management is not available on this connection');
          // Raw-param delegation: the listing service owns pinning, ordering,
          // search, windowing, and normalization — including the connection's
          // pin. Omitted tokens reuse it (awaiting the open-time pin), an
          // explicit token passes through, and `repin` replaces the pin and
          // serves the window under its fresh token.
          const result = await folderListing.query({
            connectionId: this.folderConnectionId,
            token: command.orderToken,
            repin: command.repin,
            offset: command.offset,
            limit: command.limit,
            query: command.query,
            includeArchived: command.includeArchived,
          });
          this.sendResponse(id, true, {
            folders: result.rows,
            roots: repoIndex.roots,
            managerRoot: this.managerRoot,
            total: result.total,
            orderToken: result.orderToken,
            more: result.more,
            epoch: result.epoch,
          });
          break;
        }

        case 'list_repos': {
          const { repoIndex } = this.requireFolderDeps();
          const repos = await repoIndex.listLazy();
          this.sendResponse(id, true, { repos });
          void repoIndex.requestStatusRefresh(repos.map((repo) => repo.path)).catch(() => {});
          break;
        }

        case 'update_folder': {
          const { folderRegistry } = this.requireFolderDeps();
          await folderRegistry.update({
            folderPath: command.folderPath,
            favorite: command.favorite,
            archived: command.archived,
            addTags: command.addTags,
            removeTags: command.removeTags,
          });
          this.sendResponse(id, true);
          break;
        }

        case 'create_hub': {
          const { repoIndex, folderRegistry } = this.requireFolderDeps();
          if (!repoIndex.roots.includes(command.root)) {
            this.sendResponse(id, false, undefined, 'Root is not a configured scan root');
            break;
          }
          const created = await folderRegistry.createHub({
            name: command.name,
            root: command.root,
            memberPaths: command.memberPaths,
            ...(command.memberRepresentation !== undefined ? { memberRepresentation: command.memberRepresentation } : {}),
            ...(command.body !== undefined ? { body: command.body } : {}),
            ...(command.description !== undefined ? { description: command.description } : {}),
            ...(command.personaText !== undefined ? { personaText: command.personaText } : {}),
          });
          // FolderRegistry.createHub invalidates discovery before it
          // broadcasts; the next list is backed by the on-disk hub shape.
          this.sendResponse(id, true, { folderPath: created.path });
          break;
        }

        case 'create_persona_folder': {
          const { repoIndex, folderListing } = this.requireFolderDeps();
          if (!isValidFolderName(command.name)) {
            this.sendResponse(id, false, undefined, 'Invalid folder name');
            break;
          }
          if (!repoIndex.roots.includes(command.root)) {
            this.sendResponse(id, false, undefined, 'Root is not a configured scan root');
            break;
          }
          try {
            const folderPath = await seedPersonaFolder(command.root, command.name, command.description, command.personaText);
            repoIndex.invalidateListing();
            WsHandler.broadcastFoldersChanged(folderListing, [folderPath], [], this.clientRegistry);
            this.sendResponse(id, true, { folderPath });
          } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            this.sendResponse(id, false, undefined, `Failed to create persona folder: ${message}`);
          }
          break;
        }

        case 'add_hub_member': {
          const { folderRegistry } = this.requireFolderDeps();
          // Validation errors fall through to the outer catch, which responds
          // with the user-presentable message. The registry's onChange (wired
          // in server.ts) broadcasts the folders_changed delta.
          await folderRegistry.addMember(command.hubPath, command.memberPath);
          this.sendResponse(id, true);
          break;
        }

        case 'remove_hub_member': {
          const { folderRegistry } = this.requireFolderDeps();
          await folderRegistry.removeMember(command.hubPath, command.memberPath);
          this.sendResponse(id, true);
          break;
        }

        case 'disband_hub': {
          const { folderRegistry } = this.requireFolderDeps();
          // Validation errors fall through to the outer catch, which responds
          // with the user-presentable message. The registry's onChange (wired
          // in server.ts) broadcasts the folders_changed delta with the hub
          // path in removedPaths.
          const disbanded = await folderRegistry.disbandHub(command.hubPath);
          this.sendResponse(id, true, { removedWorktreePaths: disbanded.removedWorktreePaths });
          break;
        }

        case 'create_folder': {
          const name = command.name;
          const root = command.root;

          // Validate name: non-empty, no path separators, not . or ..
          if (!isValidFolderName(name)) {
            this.sendResponse(id, false, undefined, 'Invalid folder name');
            break;
          }

          // Validate root is one of the configured roots
          if (!this.repoIndex?.roots.includes(root)) {
            this.sendResponse(id, false, undefined, 'Root is not a configured scan root');
            break;
          }

          const deps = this.requireFolderDeps();

          // Route through the shared creator routing (the creator whose form
          // matches { root, name } — built-in or user-authored — plus the
          // best-effort AGENTS.md seed); see folder-create.ts (DR-062).
          try {
            const created = await createCodeFolder(root, name, command.body);
            // Otherwise the 30s listing TTL hides the new repo from the index.
            // Listing-only: the new folder's first probe fills its own slot;
            // untouched repos keep warm git probes.
            deps.repoIndex.invalidateListing();
            WsHandler.broadcastFoldersChanged(deps.folderListing, [created.folderPath], [], this.clientRegistry);
            this.sendResponse(id, true, { folderPath: created.folderPath });
          } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            this.sendResponse(id, false, undefined, `Failed to create folder: ${message}`);
          }
          break;
        }

        case 'list_sessions': {
          const sessions = await this.sessionRecords.listSessionRecords(command.folderPath);
          const archivedLookup = this.sessionMetadataStore.getArchivedLookup(sessions.map((s) => s.path));

          // Build lookup from session ID to managed session for live-state enrichment
          const activeSessions = this.sessionManager.getAllSessions();
          const slotById = new Map<string, ManagedSlot>();
          for (const s of activeSessions) {
            slotById.set(s.sessionState.id, s);
          }

          // Enrich each session with live status and archived state
          const diskSessionIds = new Set(sessions.map((s) => s.id));
          const enriched = sessions
            .map((s) => {
              const sl = slotById.get(s.id);
              return {
                id: s.id,
                name: s.name,
                created: s.created.toISOString(),
                modified: s.modified.toISOString(),
                messageCount: s.messageCount,
                firstMessage: s.firstMessage || undefined,
                archived: archivedLookup.get(s.path) === true,
                liveStatus: sl ? sl.sessionState.status : null,
                cwd: s.cwd !== command.folderPath ? s.cwd : undefined,
              };
            })
            .filter((s) => command.includeArchived || !s.archived);

          // Include active in-memory sessions not yet persisted to disk
          for (const slot of activeSessions) {
            if (slot.folderPath === command.folderPath && !diskSessionIds.has(slot.sessionState.id)) {
              const session = slot.session;
              const firstUserMsg = session.messages.find((m) => m.role === 'user');
              const rawContent = firstUserMsg?.content;
              const firstText = typeof rawContent === 'string' ? rawContent : Array.isArray(rawContent) ? rawContent.find((c) => c.type === 'text')?.text : undefined;
              const now = new Date().toISOString();
              enriched.push({
                id: slot.sessionState.id,
                name: session.sessionName ?? '',
                created: now,
                modified: now,
                messageCount: session.messages.length,
                firstMessage: firstText || undefined,
                archived: false,
                liveStatus: slot.sessionState.status,
                cwd: slot.folderPath !== command.folderPath ? slot.folderPath : undefined,
              });
            }
          }

          this.sendResponse(id, true, { sessions: enriched });
          break;
        }

        case 'open_session': {
          // New session creation
          if (!command.sessionId) {
            if (!command.folderPath) {
              this.sendResponse(id, false, undefined, 'folder_required');
              break;
            }
            const { sessionId, folderPath, folder } = await this.openNewSessionInFolder(command.folderPath);
            const newSlot = this.sessionManager.getSession(sessionId);
            this.sendResponse(id, true, {
              sessionId,
              folderPath,
              folder,
              ...(newSlot
                ? {
                    meta: makeSessionMeta(newSlot.session, this.sessionManager.getLastKnownGitBranch(sessionId)),
                    commands: getSessionCommands(newSlot.session),
                    initialSnapshot: this.makeFullResyncEvent(sessionId, newSlot),
                  }
                : {}),
            });
            await this.sendConflictEventIfNeeded(sessionId, folderPath);
            break;
          }

          // Existing session: attach this observer to the live runtime when present.
          const requestedSessionId = command.sessionId;
          await this.sessionManager.withSessionOperation(requestedSessionId, async () => {
            const existing = this.sessionManager.getSession(requestedSessionId);
            if (existing) {
              const existingSessionPath = existing.session.sessionFile;
              if (existingSessionPath && this.sessionMetadataStore.isArchived(existingSessionPath)) {
                this.sendResponse(id, false, undefined, 'session_archived');
                return;
              }
              const restoreMode = await this.syncSessionToClient(requestedSessionId, existing, command.lastCursor);
              WsHandler.broadcastSidebarUpdate(requestedSessionId, existing.folderPath, this.sessionManager, this.clientRegistry);
              await this.linkSessionForUser(requestedSessionId, existing.folderPath);
              this.sendResponse(id, true, {
                sessionId: requestedSessionId,
                folderPath: existing.folderPath,
                restoreMode,
                folder: await this.resolveFolderInfo(existing.folderPath),
                meta: makeSessionMeta(existing.session, this.sessionManager.getLastKnownGitBranch(requestedSessionId)),
                commands: getSessionCommands(existing.session),
              });
              return;
            }

            // Reopen from disk. A folderless deep link carries no folder: resolve
            // the session's record by searching known folders (archived included).
            // No record anywhere → the session is gone for good (never persisted,
            // pruned idle slot): report it as a definitive not-found so the client
            // drops its orphan instead of retrying forever.
            const record = await this.findSessionRecord(requestedSessionId, command.folderPath);
            if (!record) {
              this.sendResponse(id, false, undefined, 'session_not_found');
              return;
            }
            const { folderPath, sessionFilePath } = record;
            if (this.sessionMetadataStore.isArchived(sessionFilePath)) {
              this.sendResponse(id, false, undefined, 'session_archived');
              return;
            }

            await this.repoIndex?.runOpenHooks(folderPath);
            const sessionId = await this.sessionManager.openSession(folderPath, sessionFilePath);
            const reopenedSlot = this.sessionManager.getSession(sessionId)!;
            await this.syncSessionToClient(sessionId, reopenedSlot, undefined, 'disk_full_resync');
            WsHandler.broadcastSidebarUpdate(sessionId, reopenedSlot.folderPath, this.sessionManager, this.clientRegistry);
            await this.linkSessionForUser(sessionId, reopenedSlot.folderPath);
            await this.sendConflictEventIfNeeded(sessionId, reopenedSlot.folderPath);
            this.sendResponse(id, true, {
              sessionId,
              folderPath: reopenedSlot.folderPath,
              restoreMode: 'disk_full_resync',
              folder: await this.resolveFolderInfo(reopenedSlot.folderPath),
              meta: makeSessionMeta(reopenedSlot.session, this.sessionManager.getLastKnownGitBranch(sessionId)),
              commands: getSessionCommands(reopenedSlot.session),
            });
          });
          break;
        }

        case 'detach_session': {
          const detachSessionId = command.sessionId;
          if (!detachSessionId) {
            this.sendResponse(id, false, undefined, 'sessionId is required');
            break;
          }
          await this.detachSessionForUser(detachSessionId, this.clientId);
          this.sendResponse(id, true);
          break;
        }

        case 'list_users': {
          this.sendResponse(id, true, { users: this.userProfiles?.summaries() ?? [] });
          break;
        }

        case 'close_session': {
          const closeSessionId = command.sessionId;
          if (!closeSessionId) {
            this.sendResponse(id, false, undefined, 'sessionId is required');
            break;
          }

          await this.sessionManager.withSessionOperation(closeSessionId, async () => {
            const closingSlot = this.sessionManager.getSession(closeSessionId);
            if (closingSlot) {
              const wasObserver = closingSlot.observers.has(this.clientId);
              await this.closeSessionForObservers(closeSessionId, closingSlot);
              if (!wasObserver) this.sendSessionClosedEvent(closeSessionId);
            } else {
              this.sendSessionClosedEvent(closeSessionId);
            }
            // Closed sessions leave every user's profile — close_session only
            // arrives from cancelled opens and legacy clients, and a surviving
            // link would reopen the session the user closed. No exclusion,
            // mirroring the archive path.
            if (this.userProfiles) {
              for (const affectedUser of await this.userProfiles.unlinkAll(closeSessionId)) {
                WsHandler.broadcastUserSessionsChanged(this.userProfiles, this.clientRegistry, affectedUser);
              }
            }
          });

          this.sendResponse(id, true);
          break;
        }

        case 'delete_session': {
          const deleteSessionId = command.sessionId;
          const deleteFolderPath = command.folderPath;
          if (!deleteSessionId || !deleteFolderPath) {
            this.sendResponse(id, false, undefined, 'sessionId and folderPath are required');
            break;
          }

          await this.sessionManager.withSessionOperation(deleteSessionId, async () => {
            const deleteSlot = this.sessionManager.getSession(deleteSessionId);
            const deleteSessionPath = deleteSlot?.session.sessionFile ?? (await this.sessionRecords.resolveSessionPath(deleteFolderPath, deleteSessionId));

            // If the session is active in memory, close it first.
            if (deleteSlot) {
              await this.closeSessionForObservers(deleteSessionId, deleteSlot, 'killed');
            }

            // Delete the file from disk
            const deleted = await this.sessionRecords.deleteSession(deleteFolderPath, deleteSessionId);
            if (!deleted) {
              this.sendResponse(id, false, undefined, `Session not found: ${deleteSessionId}`);
              return;
            }

            if (deleteSessionPath) {
              await this.sessionMetadataStore.delete(deleteSessionPath);
            }

            // Deleted sessions leave every user's profile; each affected
            // user's connections are told alongside session_deleted.
            if (this.userProfiles) {
              for (const affectedUser of await this.userProfiles.unlinkAll(deleteSessionId)) {
                WsHandler.broadcastUserSessionsChanged(this.userProfiles, this.clientRegistry, affectedUser);
              }
            }

            // Broadcast deletion to all clients so sidebar lists update
            const deleteEvent = {
              type: 'session_deleted' as const,
              sessionId: deleteSessionId,
              folderPath: deleteFolderPath,
            };
            for (const [, handler] of this.clientRegistry) {
              handler.sendToClient(deleteEvent);
            }

            this.subscribedSessions.delete(deleteSessionId);
            if (this.viewedSessionId === deleteSessionId) {
              this.viewedSessionId = null;
            }

            this.folderListing?.invalidateSessionMetadata([deleteFolderPath]);
            this.sendResponse(id, true);
          });
          break;
        }

        case 'archive_session': {
          const archiveSessionIds = command.sessionIds;
          const archiveFolderPath = command.folderPath;
          if (!archiveSessionIds?.length || !archiveFolderPath) {
            this.sendResponse(id, false, undefined, 'sessionIds and folderPath are required');
            break;
          }

          let archivedCount = 0;
          for (const archiveSessionId of archiveSessionIds) {
            await this.sessionManager.withSessionOperation(archiveSessionId, async () => {
              const archiveSlot = this.sessionManager.getSession(archiveSessionId);
              const archiveSessionPath = archiveSlot?.session.sessionFile ?? (await this.sessionRecords.resolveSessionPath(archiveFolderPath, archiveSessionId));
              if (!archiveSessionPath) return;

              if (command.archived) {
                // Mark the record before runtime disposal closes the slot. A
                // concurrent open then sees session_archived instead of attaching
                // to a runtime that is already closing. Admit the close first so
                // a reset in progress cannot leave a half-archived record.
                if (archiveSlot) {
                  await runSlotLifecycle(archiveSlot, 'close', async () => {
                    await this.sessionMetadataStore.setArchived(archiveSessionPath, true);
                    await this.closeSessionForObservers(archiveSessionId, archiveSlot, 'archived');
                  });
                } else {
                  await this.sessionMetadataStore.setArchived(archiveSessionPath, true);
                }
              } else {
                await this.sessionMetadataStore.setArchived(archiveSessionPath, false);
              }
              // Archived sessions leave every user's profile; each affected
              // user's connections (including any that archived) are told —
              // no exclusion, the archiving connection can belong to another
              // user. Unarchive does not relink; reopening links (open_session).
              if (command.archived && this.userProfiles) {
                for (const affectedUser of await this.userProfiles.unlinkAll(archiveSessionId)) {
                  WsHandler.broadcastUserSessionsChanged(this.userProfiles, this.clientRegistry, affectedUser);
                }
              }
              this.broadcastSessionArchived(archiveSessionId, archiveFolderPath, command.archived);
              archivedCount++;
            });
          }

          this.folderListing?.invalidateSessionMetadata([archiveFolderPath]);
          this.sendResponse(id, true, { archived: command.archived, count: archivedCount });
          break;
        }

        case 'rename_session': {
          const renameSessionId = command.sessionId;
          const renameFolderPath = command.folderPath;
          const renameName = command.name.trim();
          if (!renameSessionId || !renameFolderPath) {
            this.sendResponse(id, false, undefined, 'sessionId and folderPath are required');
            break;
          }
          if (!renameName) {
            this.sendResponse(id, false, undefined, 'name is required');
            break;
          }

          const renameSlot = this.sessionManager.getSession(renameSessionId);
          if (renameSlot) {
            renameSlot.session.setSessionName(renameName);
          } else {
            const renamed = await this.sessionRecords.renameSession(renameFolderPath, renameSessionId, renameName);
            if (!renamed) {
              this.sendResponse(id, false, undefined, `Session not found: ${renameSessionId}`);
              break;
            }
          }

          const renameEvent = {
            type: 'session_renamed' as const,
            sessionId: renameSessionId,
            folderPath: renameFolderPath,
            name: renameName,
          };
          for (const [, handler] of this.clientRegistry) {
            handler.sendToClient(renameEvent);
          }

          this.folderListing?.invalidateSessionMetadata([renameFolderPath]);
          this.sendResponse(id, true, { name: renameName });
          break;
        }

        case 'takeover_folder': {
          const killedCount = await killExternalPiProcesses(command.folderPath);

          const takeoverSessionId = await this.sessionManager.openSession(command.folderPath);

          const takeoverSlot = this.sessionManager.getSession(takeoverSessionId)!;
          await this.claimSession(takeoverSessionId, takeoverSlot);
          await this.linkSessionForUser(takeoverSessionId, takeoverSlot.folderPath);
          const folder = await WsHandler.broadcastSessionOpened(
            takeoverSessionId,
            takeoverSlot.folderPath,
            this.sessionManager,
            this.folderRegistry,
            this.clientRegistry,
            this.clientId,
          );

          WsHandler.broadcastSidebarUpdate(takeoverSessionId, takeoverSlot.folderPath, this.sessionManager, this.clientRegistry);
          this.sendResponse(id, true, {
            sessionId: takeoverSessionId,
            folderPath: takeoverSlot.folderPath,
            folder,
            killedProcesses: killedCount,
          });
          break;
        }

        // ---- Voice call control ----
        case 'call_bind': {
          if (!this.voiceOrchestrator) {
            this.sendResponse(id, false, undefined, 'call_bind_failed_internal');
            break;
          }
          const reopenResult = await this.sessionManager
            .withSessionOperation(command.sessionId, async () => {
              const existingSlot = this.sessionManager.getSlot(command.sessionId);
              if (existingSlot) return { slot: existingSlot, reopened: false };
              // A voice call needs a holder, not an observer: reopen a dormant
              // (idle-reaped or never-opened) session from its disk record so
              // thin clients can call sessions they are not viewing. No observer
              // attaches and no transcript syncs — the call-holder reap guard
              // holds the session for the call, then idle reaping reclaims it.
              return { slot: await this.attemptCallReopen(command.sessionId), reopened: true };
            })
            .catch((err: unknown) => {
              console.warn('[voice] call_bind reopen failed:', err instanceof Error ? err.message : err);
              return { error: true as const };
            });
          if ('error' in reopenResult) {
            this.sendResponse(id, false, undefined, 'call_bind_failed_internal');
            break;
          }
          if (!reopenResult.slot) {
            this.sendResponse(id, false, undefined, 'call_bind_failed_session_not_found');
            break;
          }
          if (reopenResult.reopened) {
            // A dormant folder's sidebar counts changed: the session is live again.
            WsHandler.broadcastSidebarUpdate(command.sessionId, reopenResult.slot.folderPath, this.sessionManager, this.clientRegistry);
          }
          try {
            const data = await this.voiceOrchestrator.bindCall({
              sessionId: command.sessionId,
              clientId: this.clientId,
              force: command.force ?? false,
            });
            this.sendResponse(id, true, data);
            this.sendEvent({ type: 'call_status', sessionId: command.sessionId, status: 'binding' });
          } catch (err) {
            if (err instanceof CallBindError) {
              this.sendResponse(id, false, undefined, err.code);
            } else {
              console.warn('[voice] call_bind failed', err);
              this.sendResponse(id, false, undefined, 'call_bind_failed_internal');
            }
          }
          break;
        }

        case 'call_end': {
          const holder = this.voiceOrchestrator?.callHolder.get(command.sessionId);
          await this.voiceOrchestrator?.endCall({ sessionId: command.sessionId, reason: 'user_hangup' });
          this.sendResponse(id, true);
          (holder ? (this.clientRegistry.get(holder) ?? this) : this).sendCallEndedEvent(command.sessionId, 'user_hangup');
          break;
        }

        // ---- Client diagnostic logs (voice/call tracing) ----
        case 'client_log': {
          // Forward to the server's logger so client-side traces interleave
          // with the server-side voice extension logs in the same journal.
          const clientWall = new Date(command.clientTimestampMs).toISOString();
          const serverWall = new Date().toISOString();
          const driftMs = Date.now() - command.clientTimestampMs;
          const line = `[voice_trace][client/${command.tag}] ${command.message} ${JSON.stringify({ clientWall, serverWall, driftMs, ...(command.data ?? {}) })}`;
          if (command.level === 'error') console.error(line);
          else if (command.level === 'warn') console.warn(line);
          else console.log(line);
          this.sendResponse(id, true);
          break;
        }

        // ---- Extension UI ----
        case 'extension_ui_response': {
          const uiSessionId = command.sessionId;
          const uiSlot = uiSessionId ? this.sessionManager.getSession(uiSessionId) : undefined;
          if (uiSlot) {
            let value: unknown;
            if (command.cancelled) {
              value = undefined;
            } else if (typeof command.confirmed === 'boolean') {
              value = command.confirmed;
            } else if (command.value !== undefined) {
              value = command.value;
            } else {
              value = undefined;
            }
            const resolved = resolveSlotPendingUi(uiSlot, command.requestId, value);
            if (resolved) {
              sendSlotEvent(uiSlot, { type: 'extension_ui_resolved', sessionId: uiSessionId!, requestId: command.requestId }, { exceptClientId: this.clientId });
            }
          }
          this.sendResponse(id, true);
          break;
        }

        // ---- Multi-session & push commands ----
        case 'view_session': {
          this.viewedSessionId = command.sessionId;
          const viewedSlot = this.sessionManager.getSession(command.sessionId);
          if (viewedSlot) {
            viewedSlot.sessionState.needsAttention = false;
            // Always send current panel state so the client syncs after switching sessions
            this.sendEvent({ type: 'panel_update', sessionId: command.sessionId, cards: getMergedPanelCards(viewedSlot.sessionState.panelState) });
            this.sendSilentDownloadSnapshot(viewedSlot);
          }
          await this.selectSessionForUser(command.sessionId, command.folderPath);
          this.sendResponse(id, true);
          break;
        }

        case 'reorder_sessions': {
          if (!this.userProfiles) {
            this.sendResponse(id, false, undefined, 'user profiles unavailable');
            break;
          }
          const reorder = await this.userProfiles.reorder(this.user, command.order, command.baseVersion);
          if (reorder.accepted) {
            // The acting connection applied its own order — no echo.
            WsHandler.broadcastUserSessionsChanged(this.userProfiles, this.clientRegistry, this.user, this.clientId);
          } else {
            // A superseded order loses whole; hand the actor the current facts.
            this.sendToClient(WsHandler.userSessionsEvent(this.userProfiles, this.user));
          }
          this.sendResponse(id, true, { accepted: reorder.accepted, orderVersion: reorder.version } satisfies ReorderSessionsResponseData);
          break;
        }

        // ---- File editing commands ----
        case 'get_global_settings': {
          const manifest = this.globalSettings?.manifest ? await this.globalSettings.manifest() : { files: [] };
          this.sendResponse(id, true, manifest);
          break;
        }
        case 'file_get': {
          this.sendResponse(id, true, await readEditableFile(command.path));
          break;
        }

        case 'file_put': {
          const runtime = this.globalSettings?.configRuntime;
          const nativeTarget = runtime ? await runtime.isNativeConfig(command.path) : false;
          const data = runtime ? await runtime.putFile(command.path, command.content) : await writeEditableFile(command.path, command.content);
          if (nativeTarget) {
            const capabilities = this.globalSettings?.capabilities?.() ?? runtime?.capabilities();
            if (capabilities) {
              for (const handler of this.clientRegistry.values()) handler.sendToClient(capabilities);
            }
          }
          if (basename(data.path) === 'AGENTS.md') {
            // Folder rows are keyed by folder roots: the edit maps to the row
            // that owns it (the enclosing registered root), never to a bare
            // directory. An AGENTS.md owned by no row — the global agent
            // instructions — touches no folder state: no cache bust, no
            // no-op delta, no epoch bump.
            const folderPath = await this.resolveOwningFolderRow(data.path).catch((err: unknown) => {
              console.warn('[WsHandler] AGENTS.md folder resolution failed:', err instanceof Error ? err.message : String(err));
              return undefined;
            });
            if (folderPath !== undefined) {
              // Discovery can reclassify the folder (persona marker), so the
              // listing must re-walk — but warm git probes stay: an edit does
              // not move git facts, and a full invalidate() would re-probe
              // every repo before the delta can resolve its row.
              this.repoIndex?.invalidateListing();
              WsHandler.broadcastFoldersChanged(this.folderListing, [folderPath], [], this.clientRegistry);
            }
          }
          this.sendResponse(id, true, data);
          break;
        }

        case 'register_push': {
          const sub = command.subscription;
          if (
            !sub ||
            typeof sub !== 'object' ||
            typeof sub.endpoint !== 'string' ||
            !sub.endpoint ||
            !sub.keys ||
            typeof sub.keys !== 'object' ||
            typeof sub.keys.p256dh !== 'string' ||
            !sub.keys.p256dh ||
            typeof sub.keys.auth !== 'string' ||
            !sub.keys.auth
          ) {
            this.sendResponse(id, false, undefined, 'Invalid push subscription: endpoint, keys.p256dh, and keys.auth are required');
            break;
          }
          try {
            await this.pushNotificationService.addSubscription(sub);
          } catch {
            this.sendResponse(id, false, undefined, 'Failed to save push subscription');
            break;
          }
          this.sendResponse(id, true);
          break;
        }

        case 'unregister_push': {
          await this.pushNotificationService.removeSubscription(command.endpoint);
          this.sendResponse(id, true);
          break;
        }

        case 'kill_conflicting_sessions': {
          for (const targetSessionId of command.sessionIds) {
            const targetSlot = this.sessionManager.getSession(targetSessionId);
            if (!targetSlot) continue;

            await this.closeSessionForObservers(targetSessionId, targetSlot, 'killed');
          }
          this.sendResponse(id, true);
          break;
        }

        case 'kill_conflicting_processes': {
          const killManaged = this.sessionManager.getSession(command.sessionId);
          if (!killManaged) {
            this.sendResponse(id, false, undefined, `Session not found: ${command.sessionId}`);
            break;
          }
          const killedProcessCount = await killExternalPiProcesses(killManaged.folderPath, command.pids);
          this.sendResponse(id, true, { killedCount: killedProcessCount });
          break;
        }

        // ---- Root-scoped subagent child-view commands ----
        case 'subagent_open_view':
        case 'subagent_close_view':
        case 'subagent_prompt':
        case 'subagent_steer':
        case 'subagent_follow_up':
        case 'subagent_abort':
        case 'subagent_stop':
        case 'subagent_bash':
        case 'subagent_abort_bash':
        case 'subagent_set_model':
        case 'subagent_cycle_model':
        case 'subagent_get_available_models':
        case 'subagent_set_thinking_level':
        case 'subagent_cycle_thinking_level':
        case 'subagent_compact':
        case 'subagent_set_auto_compaction':
        case 'subagent_get_state':
        case 'subagent_get_messages':
        case 'subagent_get_session_stats':
        case 'subagent_get_session_meta':
        case 'subagent_get_commands':
        case 'subagent_complete_args':
        case 'subagent_complete_file_refs':
        case 'subagent_get_tree':
        case 'subagent_navigate_tree':
        case 'subagent_set_tree_label':
        case 'subagent_teardown':
        case 'subagent_resurrect': {
          await this.handleSubagentCommand(command as SubagentCommand, id);
          break;
        }

        // ---- Session control commands ----
        case 'prompt':
        case 'steer':
        case 'follow_up':
        case 'abort':
        case 'bash':
        case 'abort_bash':
        case 'set_model':
        case 'cycle_model':
        case 'get_available_models':
        case 'set_thinking_level':
        case 'cycle_thinking_level':
        case 'compact':
        case 'set_auto_compaction':
        case 'get_state':
        case 'get_messages':
        case 'new_session':
        case 'get_session_stats':
        case 'get_tree':
        case 'get_session_meta':
        case 'get_commands':
        case 'complete_args':
        case 'complete_file_refs':
        case 'set_session_name':
        case 'dequeue_steering':
        case 'fork':
        case 'navigate_tree':
        case 'set_tree_label': {
          await this.handleSessionCommand(command, id);
          break;
        }

        // -- Global login commands (NOT session-scoped) --
        case 'login_list': {
          const providers = await this.sessionManager.getLoginOrchestrator().listProviders();
          this.sendResponse(id, true, { providers });
          break;
        }

        case 'login_begin': {
          const orchestrator = this.sessionManager.getLoginOrchestrator();
          if (orchestrator.isBusy()) {
            this.sendResponse(id, true, { ok: false, reason: 'busy' });
            break;
          }
          const transport = this.createLoginTransport();
          const flowController = this.loginAbort;
          // Drive the flow async — it emits login_step events as it goes and a
          // terminal `done` step on completion. Respond `ok` immediately.
          orchestrator
            .runLogin(command.providerId, transport)
            .catch((err) => {
              if (err instanceof LoginBusyError) return;
              console.error('[WsHandler] login flow error:', err);
            })
            .finally(() => {
              // Settle any inputs still outstanding when the flow ends for a
              // reason other than a client cancel (provider-side timeout,
              // network error during the manual-input race) so the promises pi
              // awaited don't dangle, and clear the now-completed controller.
              this.settlePendingLoginInputs();
              if (this.loginAbort === flowController) {
                this.loginAbort = null;
              }
            });
          this.sendResponse(id, true, { ok: true });
          break;
        }

        case 'login_input': {
          const pending = this.pendingLoginInputs.get(command.requestId);
          if (pending) {
            this.pendingLoginInputs.delete(command.requestId);
            pending.resolve(command.value);
          }
          this.sendResponse(id, true);
          break;
        }

        case 'login_cancel': {
          this.loginAbort?.abort();
          this.settlePendingLoginInputs('login cancelled');
          this.sendResponse(id, true);
          break;
        }

        case 'logout': {
          await this.sessionManager.getLoginOrchestrator().logout(command.providerId);
          this.sendResponse(id, true, { ok: true });
          break;
        }

        default: {
          this.sendResponse(id, false, undefined, `Unknown command type: ${(command as { type: string }).type}`);
        }
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[WsHandler] Error handling command ${command.type}:`, message);
      this.sendResponse(id, false, undefined, message);
    }
  }

  private subagentHostFor(sessionId: string): { slot: ManagedSlot; host: NonNullable<ManagedSlot['subagentHost']> } {
    const slot = this.sessionManager.getSession(sessionId);
    if (!slot) throw new Error(`Session not found: ${sessionId}`);
    const host = slot.subagentHost;
    if (!host) throw new Error('Subagent provider is not available for this session');
    return { slot, host };
  }

  private subagentConnectionToken(slot: ManagedSlot): number | undefined {
    const host = slot.subagentHost;
    if (!host) return undefined;
    const known = this.subagentConnectionTokens.get(slot);
    if (known?.host === host) return known.token;
    if (known) this.subagentConnectionTokens.delete(slot);
    const token = host.connectionToken?.(this.clientId);
    if (token !== undefined) this.subagentConnectionTokens.set(slot, { host, token });
    return token;
  }

  private rememberSubagentConnectionToken(slot: ManagedSlot): number | undefined {
    const host = slot.subagentHost;
    if (!host) return undefined;
    const token = host.connectionToken?.(this.clientId);
    if (token !== undefined) this.subagentConnectionTokens.set(slot, { host, token });
    return token;
  }

  private forgetSubagentConnectionToken(slot: ManagedSlot): void {
    this.subagentConnectionTokens.delete(slot);
  }

  private ensureSubagentViewListener(slot: ManagedSlot): void {
    const listeners = (slot.subagentViewListeners ??= new Map());
    const existing = listeners.get(this.clientId);
    if (existing) return;
    const listener = (change: SubagentViewChange, incarnation?: string, viewCursor?: number) => this.sendSubagentViewChange(slot, change, incarnation, viewCursor);
    listeners.set(this.clientId, listener);
    this.boundSubagentViewListeners.set(slot, listener);
  }

  private subagentIncarnation(slot: ManagedSlot, path: readonly string[]): string {
    try {
      return slot.subagentHost?.snapshot().nodes.find((node) => node.path.length === path.length && node.path.every((part, index) => part === path[index]))?.incarnation ?? '';
    } catch {
      return '';
    }
  }

  private makeSubagentViewSnapshot(rootSessionId: string, attachment: SubagentViewAttachment, incarnation = ''): SubagentViewSnapshot {
    const snapshot = attachment.snapshot;
    return {
      type: 'subagent_view_snapshot',
      sessionId: rootSessionId,
      childSessionId: snapshot.state.sessionId,
      path: attachment.path,
      incarnation,
      attachmentGeneration: attachment.attachmentGeneration,
      viewCursor: snapshot.cursor,
      state: snapshot.state,
      messages: snapshot.messages,
      ...(snapshot.pendingSteeringMessages !== undefined ? { pendingSteeringMessages: [...snapshot.pendingSteeringMessages] } : {}),
      ...(snapshot.activeSubagentContent !== undefined ? { activeSubagentContent: snapshot.activeSubagentContent } : {}),
      ...(snapshot.branchEntryIds !== undefined ? { branchEntryIds: [...snapshot.branchEntryIds] } : {}),
      ...(snapshot.streamingMessage ? { streamingMessage: snapshot.streamingMessage } : {}),
      ...(snapshot.runningToolCallIds ? { runningToolCallIds: snapshot.runningToolCallIds } : {}),
    };
  }

  private sendSubagentViewChange(slot: ManagedSlot, change: SubagentViewChange, incarnation?: string, viewCursor?: number): void {
    const rootSessionId = slot.sessionState.id;
    if (change.type === 'snapshot') {
      const attachment: SubagentViewAttachment = {
        path: change.path,
        attachmentGeneration: change.attachmentGeneration,
        snapshot: change.snapshot,
      };
      this.sendEvent(this.makeSubagentViewSnapshot(rootSessionId, attachment, incarnation ?? this.subagentIncarnation(slot, change.path)));
      return;
    }
    if (change.type === 'event') {
      const childSessionId = change.event.sessionId;
      const cursor = 'cursor' in change.event && typeof change.event.cursor === 'number' ? change.event.cursor : (viewCursor ?? 0);
      const event: SubagentViewEvent = {
        type: 'subagent_view_event',
        sessionId: rootSessionId,
        childSessionId,
        path: change.path,
        incarnation: incarnation ?? 'unknown',
        attachmentGeneration: change.attachmentGeneration,
        viewCursor: cursor,
        event: change.event,
      };
      this.sendEvent(event);
      return;
    }
    const event: SubagentViewClosedEvent = {
      type: 'subagent_view_closed',
      sessionId: rootSessionId,
      path: change.path,
      incarnation: incarnation ?? 'unknown',
      attachmentGeneration: change.attachmentGeneration,
      reason: change.reason,
    };
    this.sendEvent(event);
  }

  private makeSubagentSurfaceCommand(command: SubagentCommand): SubagentSurfaceCommand {
    const {
      type,
      sessionId: _sessionId,
      path: _path,
      incarnation: _incarnation,
      attachmentGeneration: _attachmentGeneration,
      ...rest
    } = command as unknown as {
      type: string;
      sessionId?: unknown;
      path?: unknown;
      incarnation?: unknown;
      attachmentGeneration?: unknown;
      [key: string]: unknown;
    };
    void _sessionId;
    void _path;
    void _incarnation;
    void _attachmentGeneration;
    return {
      ...(rest as Omit<SubagentSurfaceCommand, 'type'>),
      type: type.slice('subagent_'.length),
    } as SubagentSurfaceCommand;
  }

  private async handleSubagentCommand(command: SubagentCommand, id: string): Promise<void> {
    // A displaced socket must not borrow the replacement socket's host token.
    // Reject its command before token lookup or child dispatch.
    this.assertCurrentConnection();
    const { slot, host } = this.subagentHostFor(command.sessionId);
    this.ensureSubagentViewListener(slot);

    if (command.type === 'subagent_open_view') {
      // Bind the host token before the first await. Cleanup can then invalidate
      // an in-flight open instead of losing the late lease.
      const opening = host.openView(this.clientId, command.path, this.subagentConnectionToken(slot));
      this.rememberSubagentConnectionToken(slot);
      const attachment = await opening;
      const data: SubagentOpenViewResponseData = {
        path: attachment.path,
        incarnation: this.subagentIncarnation(slot, attachment.path),
        attachmentGeneration: attachment.attachmentGeneration,
        snapshot: this.makeSubagentViewSnapshot(slot.sessionState.id, attachment, this.subagentIncarnation(slot, attachment.path)),
      };
      this.sendResponse(id, true, data);
      return;
    }

    if (command.type === 'subagent_close_view') {
      await host.closeView(
        this.clientId,
        {
          path: command.path,
          incarnation: command.incarnation,
          attachmentGeneration: command.attachmentGeneration,
        },
        this.subagentConnectionToken(slot),
      );
      this.sendResponse(id, true);
      return;
    }

    if (command.type === 'subagent_stop') {
      await host.stop({ path: command.path, incarnation: command.incarnation, expectedSessionId: command.expectedSessionId }, this.clientId, this.subagentConnectionToken(slot));
      this.rememberSubagentConnectionToken(slot);
      this.sendResponse(id, true);
      return;
    }

    if (command.type === 'subagent_teardown') {
      const result = await host.teardown(command.path, command.incarnation, this.clientId, command.attachmentGeneration, this.subagentConnectionToken(slot));
      this.rememberSubagentConnectionToken(slot);
      this.sendResponse(id, true, result);
      return;
    }

    if (command.type === 'subagent_resurrect') {
      const result = await host.resurrect(
        {
          sessionId: command.savedSessionId,
          parentPath: command.parentPath,
          localId: command.localId,
          task: command.task,
          channels: command.channels,
          ...(command.model !== undefined ? { model: command.model } : {}),
        },
        this.clientId,
        this.subagentConnectionToken(slot),
      );
      this.rememberSubagentConnectionToken(slot);
      this.sendSubagentSnapshot(slot, host.snapshot());
      this.sendResponse(id, true, result);
      return;
    }

    const view = {
      path: command.path,
      incarnation: command.incarnation,
      attachmentGeneration: command.attachmentGeneration,
    };
    // Child queues belong to the borrowed child surface. Never pass the root
    // ledger, because child queue updates do not reconcile against it.
    const caller: SessionSurfaceCallerContext = { clientId: this.clientId };
    const result = await host.dispatch(this.clientId, view, this.makeSubagentSurfaceCommand(command), this.subagentConnectionToken(slot), caller);
    if (command.type === 'subagent_get_tree' || (command.type === 'subagent_prompt' && command.message.trim().split(/\s+/, 1)[0].toLowerCase() === '/tree')) {
      this.sendTreeResponse(id, result as GetTreeResponseData);
    } else {
      this.sendResponse(id, true, result);
    }
  }

  private rootSurfaceCommand(command: PimoteCommand): SessionSurfaceCommand | undefined {
    const shared = new Set([
      'prompt',
      'steer',
      'follow_up',
      'abort',
      'bash',
      'abort_bash',
      'set_model',
      'cycle_model',
      'get_available_models',
      'set_thinking_level',
      'cycle_thinking_level',
      'compact',
      'set_auto_compaction',
      'get_state',
      'get_messages',
      'get_session_stats',
      'get_session_meta',
      'get_commands',
      'complete_args',
      'complete_file_refs',
      'get_tree',
      'navigate_tree',
      'set_tree_label',
    ]);
    if (!shared.has(command.type)) return undefined;
    const { sessionId: _sessionId, ...surfaceCommand } = command as PimoteCommand & { sessionId?: string };
    void _sessionId;
    return surfaceCommand as unknown as SessionSurfaceCommand;
  }

  private async dispatchRootSurfaceCommand(slot: ManagedSlot, command: PimoteCommand): Promise<{ handled: boolean; data?: unknown }> {
    const surface = slot.sessionSurface;
    const surfaceCommand = this.rootSurfaceCommand(command);
    if (!surface || !surfaceCommand) return { handled: false };
    const caller: SessionSurfaceCallerContext = { clientId: this.clientId, queueOwnership: slot.sessionState.queueOwnership };

    if (surfaceCommand.type === 'navigate_tree') {
      if (slot.sessionState.treeNavigationInProgress && !isNestedSlotLifecycle(slot)) throw new Error('Tree navigation already in progress');
      slot.sessionState.treeNavigationInProgress = true;
      slot.sessionState.treeNavigationSummarizing = (surfaceCommand as { summarize?: boolean }).summarize === true;
      try {
        const result = await runSlotLifecycle(slot, 'reset', async () => {
          const navigation = await surface.dispatch(surfaceCommand, caller);
          // Navigation is over: drop the flag before the reset notification so
          // the reset's full_resync does not report a navigation still in
          // progress and re-show the client indicator after tree_navigation_end.
          slot.sessionState.treeNavigationInProgress = false;
          slot.sessionState.treeNavigationSummarizing = false;
          if (!navigation || typeof navigation !== 'object' || (navigation as { cancelled?: unknown }).cancelled !== true) await this.sessionManager.applySessionReset(slot);
          return navigation;
        });
        return { handled: true, data: result };
      } finally {
        slot.sessionState.treeNavigationInProgress = false;
        slot.sessionState.treeNavigationSummarizing = false;
      }
    }

    const result = await surface.dispatch(surfaceCommand, caller);
    if (['set_model', 'cycle_model', 'set_thinking_level', 'cycle_thinking_level', 'set_auto_compaction'].includes(surfaceCommand.type)) {
      this.sendSessionSettingsToObservers(slot.sessionState.id, slot);
    }
    return { handled: true, data: result };
  }

  private async handleSessionCommand(command: PimoteCommand, id: string): Promise<void> {
    const sessionId = command.sessionId;
    if (!sessionId) {
      this.sendResponse(id, false, undefined, 'sessionId is required');
      return;
    }

    const slot = this.sessionManager.getSession(sessionId);
    if (!slot) {
      this.sendResponse(id, false, undefined, `Session not found: ${sessionId}`);
      return;
    }

    const session = slot.session;

    // Pimote handles its own slash commands before pi sees the input. Keep this
    // boundary shared by prompt, steer, and follow-up so a streaming composer
    // cannot turn a built-in command into a queued user message.
    if ((command.type === 'prompt' || command.type === 'steer' || command.type === 'follow_up') && (await this.dispatchPimoteSlashCommand(id, sessionId, slot, command.message))) {
      return;
    }

    const sharedRoot = await this.dispatchRootSurfaceCommand(slot, command);
    if (sharedRoot.handled) {
      if (command.type === 'get_tree') this.sendTreeResponse(id, sharedRoot.data as GetTreeResponseData);
      else this.sendResponse(id, true, sharedRoot.data);
      return;
    }

    switch (command.type) {
      case 'prompt': {
        // A prompt that races a run start joins the steering queue.
        await this.dispatchInput(id, slot, {
          text: command.message,
          images: command.images,
          behavior: 'steer',
          intent: session.isStreaming ? slot.sessionState.queueOwnership.intend('steering', this.clientId, command.message) : undefined,
          clientMessageId: command.clientMessageId,
        });
        break;
      }

      case 'steer': {
        await this.dispatchInput(id, slot, {
          text: command.message,
          images: command.images,
          behavior: 'steer',
          intent: slot.sessionState.queueOwnership.intend('steering', this.clientId, command.message),
        });
        break;
      }

      case 'dequeue_steering': {
        const result = session.clearQueue();
        this.sendResponse(id, true, { steering: result.steering, followUp: result.followUp });
        break;
      }

      case 'follow_up': {
        await this.dispatchInput(id, slot, {
          text: command.message,
          behavior: 'followUp',
          intent: slot.sessionState.queueOwnership.intend('followUp', this.clientId, command.message),
        });
        break;
      }

      case 'abort': {
        // Capture only lifecycle/state metadata, never prompt or tool content.
        const startedAt = Date.now();
        const trace = (phase: string) =>
          console.info(
            '[abort_trace]',
            JSON.stringify({
              requestId: id,
              sessionId,
              phase,
              elapsedMs: Date.now() - startedAt,
              sdkStreaming: session.isStreaming,
              sdkIdle: session.isIdle,
              coreStreaming: session.state?.isStreaming,
              compacting: session.isCompacting,
              serverStatus: slot.sessionState.status,
              pendingUi: slot.sessionState.pendingUiResponses.size,
              pendingMessages: session.pendingMessageCount,
              cursor: slot.sessionState.eventBuffer.currentCursor,
            }),
          );
        const unsubscribe = session.subscribe((event) => {
          if (['agent_start', 'agent_end', 'agent_settled', 'auto_retry_start', 'auto_retry_end', 'auto_compaction_start', 'auto_compaction_end'].includes(event.type)) {
            trace(event.type);
          }
        });
        let abortWatchdog: ReturnType<typeof setTimeout> | undefined;
        // Read ownership before clearing. Clearing emits queue_update, which empties the ledger.
        const owners = slot.sessionState.queueOwnership.snapshot();
        // Remove queued input synchronously before cancellation can emit agent_end.
        // The client restores it as a draft only after receiving this response.
        slot.eventBusRef.current?.emit('pimote:voice:cancel-pending', undefined);
        const drained = session.clearQueue();
        const drafts = attributeDrained(owners, drained, this.clientId);
        // Each other sender restores its own messages now. This client restores its own from the response.
        for (const [clientId, group] of drafts) {
          if (clientId === this.clientId) continue;
          const sender = this.clientRegistry.get(clientId);
          if (sender) {
            sender.sendToClient({ type: 'queued_drafts_restored', sessionId, ...group });
          } else {
            // Hold an offline sender's drafts until its next claim of this session.
            const held = (slot.sessionState.undeliveredDrafts ??= new Map());
            const prior = held.get(clientId) ?? { steering: [], followUp: [] };
            held.set(clientId, { steering: [...prior.steering, ...group.steering], followUp: [...prior.followUp, ...group.followUp] });
          }
        }
        const queued = drafts.get(this.clientId) ?? { steering: [], followUp: [] };
        try {
          trace('requested');
          // Resolve pending UI responses first so stuck dialogs unblock.
          resolveAllSlotPendingUi(slot);
          const abortResult = await Promise.race([
            session.abort().then(() => 'ok' as const),
            new Promise<'timeout'>((resolve) => {
              abortWatchdog = setTimeout(() => resolve('timeout'), 30_000);
            }),
          ]);
          trace(abortResult === 'ok' ? 'resolved' : 'timeout');
          if (abortResult === 'timeout') {
            console.error(`[WsHandler] session.abort() did not resolve within 30s (sessionId=${sessionId})`);
          }
          this.sendResponse(id, abortResult === 'ok', queued, abortResult === 'timeout' ? 'abort_timeout' : undefined);
        } catch (err) {
          trace('rejected');
          console.error('[WsHandler] abort failed:', err);
          this.sendResponse(id, false, queued, err instanceof Error ? err.message : String(err));
        } finally {
          if (abortWatchdog !== undefined) clearTimeout(abortWatchdog);
          unsubscribe();
        }
        break;
      }

      case 'bash': {
        // Pi's native bash executor permits only one concurrent execution. The
        // admission marker is set synchronously before the extension hook is
        // awaited, so a second request cannot slip through while an extension
        // is deciding whether to handle the command.
        if (session.isBashRunning || slot.sessionState.bashDispatchInProgress === true) {
          this.sendResponse(id, false, undefined, 'bash_already_running');
          break;
        }

        slot.sessionState.bashDispatchInProgress = true;
        slot.sessionState.bashAbortRequested = false;
        try {
          const excludeFromContext = command.excludeFromContext === true;
          let extensionResult: Awaited<ReturnType<typeof session.extensionRunner.emitUserBash>>;
          try {
            extensionResult = await session.extensionRunner.emitUserBash({
              type: 'user_bash',
              command: command.command,
              excludeFromContext,
              cwd: session.sessionManager.getCwd(),
            });
          } catch (err) {
            // pi 0.87 user_bash fails closed: a throwing extension handler or an
            // invalid defined result aborts the command instead of falling through
            // to local execution. Surface a distinct code rather than leaking the
            // raw extension error through the generic command-error path.
            console.error('[WsHandler] user_bash extension handler failed:', err);
            this.sendResponse(id, false, undefined, 'bash_extension_error');
            break;
          }

          if (extensionResult?.result) {
            // Extensions that fully handle the command bypass executeBash, so
            // they must explicitly record exactly one native result.
            session.recordBashResult(command.command, extensionResult.result, { excludeFromContext });
            this.sendResponse(id, true, { result: extensionResult.result });
            break;
          }

          // executeBash emits live SDK chunks and records its own result. Pass
          // through the caller ID, exclusion flag, and any custom operations
          // supplied by an extension without duplicating the history entry.
          const execution = session.executeBash(command.command, undefined, {
            id,
            excludeFromContext,
            operations: extensionResult?.operations,
          });
          // abort_bash can arrive during extension interception, before the
          // native executor has installed its AbortController. Re-issue the
          // cancellation immediately after admission so that request is not
          // lost in that window.
          if ((slot.sessionState.bashAbortRequested as boolean | undefined) === true) {
            session.abortBash();
          }
          const result = await execution;
          this.sendResponse(id, true, { result });
        } finally {
          slot.sessionState.bashDispatchInProgress = false;
          slot.sessionState.bashAbortRequested = false;
        }
        break;
      }

      case 'abort_bash': {
        // Bash cancellation is independent from the model abort path: the
        // session may continue streaming while this request is issued. Keep a
        // marker for the admission window so the bash branch can cancel again
        // once native execution has installed its AbortController.
        if (slot.sessionState.bashDispatchInProgress === true) {
          slot.sessionState.bashAbortRequested = true;
        }
        session.abortBash();
        this.sendResponse(id, true);
        break;
      }

      case 'set_model': {
        const models = await session.modelRuntime.getAvailable();
        const model = models.find((m) => m.provider === command.provider && m.id === command.modelId);
        if (!model) {
          this.sendResponse(id, false, undefined, `Model not found: ${command.provider}/${command.modelId}`);
          break;
        }
        await session.setModel(model);
        this.sendSessionSettingsToObservers(sessionId, slot);
        const currentModel = session.model;
        this.sendResponse(id, true, {
          model: currentModel ? { provider: currentModel.provider, id: currentModel.id, name: currentModel.name } : null,
          thinkingLevel: session.thinkingLevel,
          availableThinkingLevels: session.getAvailableThinkingLevels(),
        });
        break;
      }

      case 'cycle_model': {
        const result = await session.cycleModel();
        this.sendSessionSettingsToObservers(sessionId, slot);
        if (result) {
          this.sendResponse(id, true, {
            model: { provider: result.model.provider, id: result.model.id, name: result.model.name },
            thinkingLevel: result.thinkingLevel,
            isScoped: result.isScoped,
          });
        } else {
          this.sendResponse(id, true, null);
        }
        break;
      }

      case 'get_available_models': {
        const models = await session.modelRuntime.getAvailable();
        const mapped = models.map((m) => ({
          provider: m.provider,
          id: m.id,
          name: m.name,
        }));
        this.sendResponse(id, true, { models: mapped });
        break;
      }

      case 'set_thinking_level': {
        session.setThinkingLevel(command.level as AgentSession['thinkingLevel']);
        this.sendSessionSettingsToObservers(sessionId, slot);
        this.sendResponse(id, true);
        break;
      }

      case 'cycle_thinking_level': {
        const level = session.cycleThinkingLevel();
        this.sendSessionSettingsToObservers(sessionId, slot);
        this.sendResponse(id, true, { level });
        break;
      }

      case 'compact': {
        const result = await session.compact(command.customInstructions);
        this.sendResponse(id, true, { result });
        break;
      }

      case 'set_auto_compaction': {
        session.setAutoCompactionEnabled(command.enabled);
        this.sendSessionSettingsToObservers(sessionId, slot);
        this.sendResponse(id, true);
        break;
      }

      case 'get_state': {
        const model = session.model;
        const state: SessionState = {
          model: model ? { provider: model.provider, id: model.id, name: model.name } : null,
          thinkingLevel: session.thinkingLevel,
          availableThinkingLevels: session.getAvailableThinkingLevels(),
          isStreaming: session.isStreaming,
          isCompacting: session.isCompacting,
          sessionFile: session.sessionFile,
          sessionId: session.sessionId,
          sessionName: session.sessionName,
          autoCompactionEnabled: session.autoCompactionEnabled,
          messageCount: session.messages.length,
        };
        this.sendResponse(id, true, { state });
        break;
      }

      case 'get_messages': {
        const messages = mapContextEntries(session.sessionManager.buildContextEntries(), rendererRegisteredVisibility(session));
        this.sendResponse(id, true, { messages });
        break;
      }

      case 'new_session': {
        const result = await runSlotLifecycle(slot, 'reset', () => slot.runtime.newSession());
        this.sendResponse(id, true, { success: !result.cancelled });
        break;
      }

      case 'get_tree': {
        const treeResponse = this.getTreeResponse(session);
        this.sendTreeResponse(id, treeResponse);
        break;
      }

      case 'get_session_stats': {
        const stats = session.getSessionStats();
        this.sendResponse(id, true, { stats });
        break;
      }

      case 'get_session_meta': {
        this.sendResponse(id, true, { meta: makeSessionMeta(session, this.sessionManager.getLastKnownGitBranch(sessionId)) });
        break;
      }

      case 'get_commands': {
        this.sendResponse(id, true, { commands: getSessionCommands(session) });
        break;
      }

      case 'complete_args': {
        const runner = session.extensionRunner;
        if (!runner) {
          this.sendResponse(id, true, { items: null });
          break;
        }
        const cmd = runner.getCommand(command.commandName);
        if (!cmd || !cmd.getArgumentCompletions) {
          this.sendResponse(id, true, { items: null });
          break;
        }
        const items = await cmd.getArgumentCompletions(command.prefix);
        this.sendResponse(id, true, { items: items ?? null });
        break;
      }

      case 'complete_file_refs': {
        const result = await completeFileRefs({ prefix: command.prefix, cwd: slot.folderPath });
        if (!result.fdAvailable) {
          this.emitFdMissingWarning(sessionId);
        }
        this.sendResponse(id, true, { items: result.items });
        break;
      }

      case 'set_session_name': {
        session.setSessionName(command.name);
        this.sendResponse(id, true);
        break;
      }

      case 'fork': {
        if (!command.entryId) {
          this.sendResponse(id, false, undefined, 'entryId is required');
          break;
        }
        const forkResult = await runSlotLifecycle(slot, 'reset', () => slot.runtime.fork(command.entryId));
        const forkData: { cancelled: boolean; selectedText?: string } = { cancelled: forkResult.cancelled };
        if (forkResult.selectedText !== undefined) {
          forkData.selectedText = forkResult.selectedText;
        }
        this.sendResponse(id, true, forkData);
        break;
      }

      case 'navigate_tree': {
        const data = await runSlotLifecycle(slot, 'reset', async () => {
          if (slot.sessionState.treeNavigationInProgress && !isNestedSlotLifecycle(slot)) {
            throw new Error('Tree navigation already in progress');
          }

          const options: {
            summarize?: boolean;
            customInstructions?: string;
            replaceInstructions?: boolean;
            label?: string;
          } = {};

          if (command.summarize !== undefined) options.summarize = command.summarize;
          if (command.customInstructions !== undefined) options.customInstructions = command.customInstructions;
          if (command.replaceInstructions !== undefined) options.replaceInstructions = command.replaceInstructions;
          if (command.label !== undefined) options.label = command.label;

          slot.sessionState.treeNavigationInProgress = true;
          slot.sessionState.treeNavigationSummarizing = !!command.summarize;
          this.emitBufferedSessionEvent(slot, sessionId, {
            type: 'tree_navigation_start',
            targetId: command.targetId,
            summarizing: !!command.summarize,
          });

          let result: { cancelled: boolean; editorText?: string };
          try {
            result = (await session.navigateTree(command.targetId, options)) as { cancelled: boolean; editorText?: string };
          } finally {
            slot.sessionState.treeNavigationInProgress = false;
            slot.sessionState.treeNavigationSummarizing = false;
            this.emitBufferedSessionEvent(slot, sessionId, {
              type: 'tree_navigation_end',
            });
          }

          if (!result.cancelled) {
            await this.sessionManager.applySessionReset(slot);
          }

          return {
            cancelled: result.cancelled,
            ...(result.editorText !== undefined ? { editorText: result.editorText } : {}),
          };
        });

        this.sendResponse(id, true, data);
        break;
      }

      case 'set_tree_label': {
        const normalizedLabel = command.label === '' ? undefined : command.label;
        session.sessionManager.appendLabelChange(command.entryId, normalizedLabel);
        this.sendResponse(id, true, { success: true });
        break;
      }
    }
  }

  private getTreeResponse(session: AgentSession): GetTreeResponseData {
    return {
      tree: mapTreeNodes(session.sessionManager.getTree() as SessionTreeNode[]),
      currentLeafId: session.sessionManager.getLeafId(),
    };
  }

  /** Dispatch slash commands owned by Pimote before pi can queue them as text. */
  private async dispatchPimoteSlashCommand(id: string, sessionId: string, slot: ManagedSlot, message: string): Promise<boolean> {
    const session = slot.session;
    const trimmed = message.trim();

    if (isForwardedNew(trimmed)) {
      // A forwarded /new never dispatches to pi. Run the composer's additive
      // sequence: a fresh session in this folder opened and linked for the
      // acting user, then their user-level detach of the old id. The old slot
      // stays live for its other holders. This actor intercepted nothing
      // locally, so the detach broadcast excludes no one and the response
      // carries the new session pointer — otherwise the actor would display a
      // session it no longer receives until its next reconnect.
      const oldId = slot.sessionState.id;
      const created = await this.openNewSessionInFolder(slot.folderPath);
      await this.detachSessionForUser(oldId);
      this.sendResponse(id, true, { sessionId: created.sessionId, folderPath: created.folderPath });
      await this.sendConflictEventIfNeeded(created.sessionId, created.folderPath);
      return true;
    }

    if (trimmed === '/reload') {
      if (session.isStreaming || session.isCompacting) {
        // Pi refuses a reload that lands on a live run or compaction. Answer
        // now and reload at the next idle boundary.
        this.sendResponse(id, true);
        this.deferReloadUntilIdle(sessionId, slot);
        return true;
      }
      await this.reloadSession(sessionId, slot);
      this.sendResponse(id, true);
      return true;
    }

    if (trimmed === '/tree') {
      const treeResponse = this.getTreeResponse(session);
      this.sendTreeResponse(id, treeResponse);
      return true;
    }

    return false;
  }

  /**
   * Dispatch prompt, steer, or follow-up input through pi's prompt path and
   * answer with pi's outcome, so the sender can settle its optimistic entry
   * or pending-queue pill. Only a `started` prompt stamps its echo with
   * `clientMessageId`. Slash input is answered at once without an outcome:
   * pi reports an extension command only after its handler finishes, and a
   * handler can wait on a dialog.
   */
  private async dispatchInput(
    id: string,
    slot: ManagedSlot,
    input: { text: string; images?: string[]; behavior: 'steer' | 'followUp'; intent?: Intent; clientMessageId?: string },
  ): Promise<void> {
    const ownership = slot.sessionState.queueOwnership;
    // A queued input already consumed its intent in pi's queue_update; any
    // other outcome leaves one behind that would mis-tag a later entry.
    const releaseIntent = () => {
      if (input.intent) ownership.cancel(input.intent);
    };
    const fail = (err: unknown) => {
      releaseIntent();
      this.sendResponse(id, false, undefined, err instanceof Error ? err.message : String(err));
    };
    let dispatch: Promise<PromptOutcome>;
    try {
      const images = await resolveImageInputs(input.images);
      dispatch = dispatchPrompt(slot.session, input.text, images, input.behavior, () => {
        if (input.clientMessageId !== undefined) slot.sessionState.eventBuffer.expectPromptEcho(input.clientMessageId);
      });
    } catch (err) {
      fail(err);
      return;
    }
    if (input.text.trimStart().startsWith('/')) {
      dispatch.then(releaseIntent, (err) => {
        releaseIntent();
        console.error(`[WsHandler] input dispatch error:`, err);
      });
      this.sendResponse(id, true);
      return;
    }
    let outcome: PromptOutcome;
    try {
      outcome = await dispatch;
    } catch (err) {
      fail(err);
      return;
    }
    releaseIntent();
    this.sendResponse(id, true, { outcome } satisfies PromptResponseData);
  }

  /** Attach this client as an observer. Session startup is manager-owned. */
  async claimSession(sessionId: string, slot: ManagedSlot): Promise<void> {
    const observer: SessionObserver = {
      ws: this.ws as unknown as EventSocket,
      clientId: this.clientId,
      cursor: slot.sessionState.eventBuffer.currentCursor,
      onSessionReset: (s, outcome, isFirstObserver) => this.handleSessionReset(s, outcome, isFirstObserver),
    };
    this.assertCurrentConnection();
    await this.sessionManager.attachObserver(sessionId, observer);
    if (!this.isCurrentConnection()) {
      if (slot.observers.get(this.clientId)?.ws === observer.ws) this.sessionManager.detachObserver(sessionId, this.clientId, observer.ws);
      throw new Error('WebSocket is no longer connected');
    }
    this.subscribedSessions.add(sessionId);
    this.ensureSubagentViewListener(slot);
    if (slot.subagentHost) {
      const restored = await slot.subagentHost.reconnect(this.clientId, this.subagentConnectionToken(slot));
      this.rememberSubagentConnectionToken(slot);
      this.sendSubagentSnapshot(slot);
      for (const attachment of restored) this.sendEvent(this.makeSubagentViewSnapshot(slot.sessionState.id, attachment, this.subagentIncarnation(slot, attachment.path)));
    }

    // Note: do NOT touch `idleSince`. Idleness is an agent-level concept driven by
    // agent_start/agent_settled — attaching an observer does not extend its clock.
    if (!this.isCurrentConnection()) {
      if (slot.observers.get(this.clientId)?.ws === observer.ws) this.sessionManager.detachObserver(sessionId, this.clientId, observer.ws);
      throw new Error('WebSocket is no longer connected');
    }

    // Re-deliver pending UI requests only to this observer. Other observers
    // already have their dialogs; broadcasting here would duplicate them.
    replaySlotPendingUiRequests(slot, (event) => this.sendEvent(event));
    const heldDrafts = slot.sessionState.undeliveredDrafts?.get(this.clientId);
    if (heldDrafts) {
      slot.sessionState.undeliveredDrafts!.delete(this.clientId);
      this.sendEvent({ type: 'queued_drafts_restored', sessionId, ...heldDrafts });
    }
    this.sendSilentDownloadSnapshot(slot);
    requestSlotPanelResync(slot, 'claim');
  }

  private isCurrentConnection(): boolean {
    return this.clientRegistry.get(this.clientId) === this && this.ws.readyState === 1;
  }

  private assertCurrentConnection(): void {
    if (!this.isCurrentConnection()) throw new Error('WebSocket is no longer connected');
  }

  /** Notify this observer after the session manager has rebuilt and re-keyed a slot. */
  private async handleSessionReset(slot: ManagedSlot, outcome: SessionResetOutcome, firstObserver?: boolean): Promise<void> {
    if (outcome.kind === 'unchanged') {
      this.sendFullResyncForSession(slot.sessionState.id, slot);
      this.sendSilentDownloadSnapshot(slot);
      return;
    }

    const { oldId, newId, folderPath } = outcome;
    this.subscribedSessions.delete(oldId);
    this.subscribedSessions.add(newId);
    if (this.viewedSessionId === oldId) this.viewedSessionId = newId;

    const isFirstObserver = firstObserver ?? slot.observers.keys().next().value === this.clientId;

    this.sendEvent({
      type: 'session_replaced',
      oldSessionId: oldId,
      newSessionId: newId,
      folder: await this.resolveFolderInfo(folderPath),
      meta: makeSessionMeta(slot.session, this.sessionManager.getLastKnownGitBranch(newId)),
      commands: getSessionCommands(slot.session),
    });
    this.sendSilentDownloadSnapshot(slot);

    if (isFirstObserver) {
      requestSlotPanelResync(slot, 'reset');
      WsHandler.broadcastSidebarUpdate(oldId, folderPath, this.sessionManager, this.clientRegistry);
      WsHandler.broadcastSidebarUpdate(newId, folderPath, this.sessionManager, this.clientRegistry);
    }
  }

  /** Surface the fd-missing warning at most once per connection (fire-and-forget toast). */
  private emitFdMissingWarning(sessionId: string): void {
    if (this.fdWarningEmitted) return;
    this.fdWarningEmitted = true;
    this.sendEvent({
      type: 'extension_ui_request',
      sessionId,
      requestId: `fd-missing-${Date.now()}`,
      method: 'notify',
      message: 'fd not found — file autocomplete is unavailable. Install fd to enable it.',
      notifyType: 'warning',
    });
  }

  /** The folder row for a session's working directory, for session events
   *  (open, takeover, replacement). Listed paths serve the registry's FolderInfo
   *  row so persona metadata and curation survive; unlisted arbitrary cwds are
   *  classified on the fly and served as a synthetic row — opening a session
   *  there never lists or curates the folder. Live session counts come from the
   *  same enrichment every serve path uses. */
  /**
   * Locate a session's record on disk. With a folder, only that folder is
   * searched. A folderless deep link searches every known folder, including
   * archived folders, plus the manager root (`resolveSessionAcrossFolders`
   * owns that rule). The caller checks the archived flag before opening.
   * Returns undefined when no folder holds the session.
   */
  /** Reopen a dormant session on behalf of an incoming `call_bind`. Returns
   *  the fresh slot, or null when no session record exists or the record is
   *  archived — both definitive, reported as `call_bind_failed_session_not_found`.
   *  Throws on reopen failure (corrupt file, open hooks) — the caller maps
   *  that to `call_bind_failed_internal`. */
  private async attemptCallReopen(sessionId: string): Promise<ManagedSlot | null> {
    const record = await this.findSessionRecord(sessionId);
    if (!record) return null;
    if (this.sessionMetadataStore.isArchived(record.sessionFilePath)) return null;
    await this.repoIndex?.runOpenHooks(record.folderPath);
    const openedId = await this.sessionManager.openSession(record.folderPath, record.sessionFilePath);
    const slot = this.sessionManager.getSlot(openedId);
    if (!slot) return null;
    return slot;
  }

  private async findSessionRecord(sessionId: string, folderPath?: string): Promise<SessionRecordLocation | undefined> {
    if (folderPath) {
      const sessionFilePath = await this.sessionRecords.resolveSessionPath(folderPath, sessionId);
      return sessionFilePath ? { folderPath, sessionFilePath } : undefined;
    }
    const folders = this.folderRegistry ? await this.folderRegistry.listLazy() : [];
    return resolveSessionAcrossFolders(
      this.sessionRecords,
      folders.map((folder) => folder.path),
      this.managerRoot,
      sessionId,
    );
  }

  private async resolveFolderInfo(folderPath: string): Promise<FolderInfo> {
    return resolveFolderInfoForSession(folderPath, this.sessionManager, this.folderRegistry);
  }

  /** Record the requesting user's link to a session after a successful open,
   *  then push the new set to their other connections (the acting connection
   *  applied its open locally — no echo). */
  private async linkSessionForUser(sessionId: string, folderPath: string): Promise<void> {
    if (!this.userProfiles) return;
    if (await this.userProfiles.link(this.user, { sessionId, folderPath })) {
      WsHandler.broadcastUserSessionsChanged(this.userProfiles, this.clientRegistry, this.user, this.clientId);
    }
  }

  /** Selection is one fact per user, so a view on one connection moves every
   *  connection of that user (highlight plus follow) and clears the session's
   *  attention for all of them. Selecting a session the profile does not hold
   *  links it first — selection is never outside the set. The acting
   *  connection applied its own navigation, so it is not echoed. */
  private async selectSessionForUser(sessionId: string, folderPath?: string): Promise<void> {
    if (!this.userProfiles) return;
    let changed = false;
    const held = this.userProfiles.get(this.user).some((ref) => ref.sessionId === sessionId);
    if (!held) {
      const record = folderPath ? await this.findSessionRecord(sessionId, folderPath) : await this.findSessionRecord(sessionId);
      if (!record) return;
      changed = await this.userProfiles.link(this.user, { sessionId, folderPath: record.folderPath });
    }
    if (await this.userProfiles.select(this.user, sessionId)) changed = true;
    if (changed) {
      WsHandler.broadcastUserSessionsChanged(this.userProfiles, this.clientRegistry, this.user, this.clientId);
    }
  }

  /** Move every holder's profile link across a session rekey, then push each
   *  changed set to that user's connections. A rekey is shared — holders with
   *  no live observer follow too. Connections in `excludeClientIds` applied
   *  the swap locally via session_replaced, so their user's broadcast skips
   *  them (no echo). Wired to the manager's onSlotRekeyed hook at boot: one
   *  sweep per rekey, observerless slots included. */
  static async relinkSessionAcrossRekey(
    userProfiles: UserProfiles,
    clientRegistry: ClientRegistry,
    oldId: string,
    newId: string,
    folderPath: string,
    excludeClientIds: ReadonlySet<string>,
  ): Promise<void> {
    for (const user of await userProfiles.unlinkAll(oldId)) {
      if (await userProfiles.link(user, { sessionId: newId, folderPath })) {
        WsHandler.broadcastUserSessionsChanged(userProfiles, clientRegistry, user, (clientId) => excludeClientIds.has(clientId));
      }
    }
  }

  /** Create a session in `folderPath`, claim it for this connection, and link
   *  it into the user's profile — the server side of the composer's
   *  new-session flow (the open_session creation path). Folder-source open
   *  hooks run before the session does: a source can materialize a
   *  listed-but-missing folder on first open. The caller sends its response
   *  first, then pushes the conflict event (response before conflict push). */
  private async openNewSessionInFolder(folderPath: string): Promise<{ sessionId: string; folderPath: string; folder: FolderInfo }> {
    await this.repoIndex?.runOpenHooks(folderPath);
    const sessionId = await this.sessionManager.openSession(folderPath);
    const newSlot = this.sessionManager.getSession(sessionId)!;
    await this.claimSession(sessionId, newSlot);
    const folder = await WsHandler.broadcastSessionOpened(sessionId, newSlot.folderPath, this.sessionManager, this.folderRegistry, this.clientRegistry, this.clientId);
    await this.linkSessionForUser(sessionId, newSlot.folderPath);
    WsHandler.broadcastSidebarUpdate(sessionId, newSlot.folderPath, this.sessionManager, this.clientRegistry);
    return { sessionId, folderPath: newSlot.folderPath, folder };
  }

  /** User-level unlink: the requesting user's link to the session drops
   *  everywhere. Every connection of that user detaches from the session
   *  (their views exit; the broadcast tells them to drop the entry);
   *  other users' links are untouched. The socket-scoped detach API stays
   *  server-side — only the wire semantics changed. Socket death never
   *  reaches here: cleanup() stays detach-only (sticky membership).
   *  `exceptClientId` omits a connection that applied the change locally
   *  (no echo); the forwarded-/new guard passes none, so its actor is told. */
  private async detachSessionForUser(sessionId: string, exceptClientId?: string): Promise<void> {
    await this.sessionManager.withSessionOperation(sessionId, async () => {
      const detachSlot = this.sessionManager.getSession(sessionId);
      for (const handler of this.clientRegistry.values()) {
        if (handler.user !== this.user) continue;
        if (detachSlot?.observers.has(handler.clientId)) {
          this.sessionManager.detachObserver(sessionId, handler.clientId, handler.ws as unknown as EventSocket);
        }
        if (detachSlot?.subagentHost) {
          const tokenRecord = handler.subagentConnectionTokens.get(detachSlot);
          const token = tokenRecord?.host === detachSlot.subagentHost ? tokenRecord.token : undefined;
          if (token !== undefined) await detachSlot.subagentHost.releaseConnection(handler.clientId, token);
          handler.forgetSubagentConnectionToken(detachSlot);
          const listener = handler.boundSubagentViewListeners.get(detachSlot);
          if (listener && detachSlot.subagentViewListeners?.get(handler.clientId) === listener) detachSlot.subagentViewListeners.delete(handler.clientId);
          handler.boundSubagentViewListeners.delete(detachSlot);
        }
        handler.subscribedSessions.delete(sessionId);
        if (handler.viewedSessionId === sessionId) handler.viewedSessionId = null;
      }
      if (this.userProfiles && (await this.userProfiles.unlink(this.user, sessionId))) {
        WsHandler.broadcastUserSessionsChanged(this.userProfiles, this.clientRegistry, this.user, exceptClientId);
      }
    });
  }

  private async sendConflictEventIfNeeded(sessionId: string, folderPath: string): Promise<void> {
    const openConflictPids = await findExternalPiProcesses(folderPath);

    if (openConflictPids.length > 0) {
      this.sendEvent({
        type: 'session_conflict',
        sessionId,
        processes: openConflictPids.map((pid) => ({ pid, command: 'pi' })),
      });
    }
  }

  private async syncSessionToClient(sessionId: string, slot: ManagedSlot, lastCursor?: number, noCursorRestoreMode: RestoreMode = 'full_resync_no_cursor'): Promise<RestoreMode> {
    let replayResult: ReturnType<import('./event-buffer.js').EventBuffer['replay']> | null = null;
    let cursorBeforeClaim: number | null = null;

    let restoreMode: RestoreMode;

    if (lastCursor !== undefined) {
      replayResult = slot.sessionState.eventBuffer.replay(lastCursor);
      const reconnectActiveOperations = (() => {
        try {
          return (slot.sessionSurface?.snapshot?.().activeSubagentContent?.length ?? 0) > 0;
        } catch {
          return false;
        }
      })();
      if (replayResult !== null) {
        restoreMode = 'incremental_replay';
        this.sendEvent({ type: 'session_restore', sessionId, mode: restoreMode, status: 'started' } as SessionRestoreEvent);
        this.sendEvent({
          type: 'buffered_events',
          sessionId,
          events: replayResult,
        } as BufferedEventsEvent);
        this.sendEvent({
          type: 'connection_restored',
          sessionId,
        } as ConnectionRestoredEvent);
        if (reconnectActiveOperations) {
          // Delta events are live-only. Replay the durable boundaries first,
          // then replace the card with the accumulated projected snapshot so
          // a missed response delta cannot leave an active card incomplete.
          this.sendFullResyncForSession(sessionId, slot);
        }
        cursorBeforeClaim = slot.sessionState.eventBuffer.currentCursor;
      } else {
        restoreMode = 'full_resync_cursor_stale';
        this.sendEvent({ type: 'session_restore', sessionId, mode: restoreMode, status: 'started' } as SessionRestoreEvent);
        this.sendFullResyncForSession(sessionId, slot);
      }
    } else {
      restoreMode = noCursorRestoreMode;
      this.sendEvent({ type: 'session_restore', sessionId, mode: restoreMode, status: 'started' } as SessionRestoreEvent);
      this.sendFullResyncForSession(sessionId, slot);
    }

    await this.claimSession(sessionId, slot);

    if (replayResult !== null && cursorBeforeClaim !== null) {
      // claimSession attaches the observer synchronously at cursorBeforeClaim,
      // so every event buffered since then was already fanned out live by
      // sendSlotEvent, which also advanced the observer's cursor. Replay from
      // the observer's cursor — never from cursorBeforeClaim — or the catch-up
      // re-delivers those events and the client appends each message_end twice.
      // The observer cursor still trails when a live send was skipped (socket
      // not open), which is the gap the catch-up legitimately retries.
      const observer = slot.observers.get(this.clientId);
      const catchUp = slot.sessionState.eventBuffer.replay(observer ? observer.cursor : cursorBeforeClaim);
      if (catchUp && catchUp.length > 0) {
        this.sendEvent({
          type: 'buffered_events',
          sessionId,
          events: catchUp,
        } as BufferedEventsEvent);
      }
    }

    if (replayResult !== null) {
      // Always send panel state after reconnect so the client clears stale cards.
      this.sendEvent({ type: 'panel_update', sessionId, cards: getMergedPanelCards(slot.sessionState.panelState) });
    }

    this.sendEvent({ type: 'session_restore', sessionId, mode: restoreMode, status: 'completed' } as SessionRestoreEvent);

    return restoreMode;
  }

  /** Close one live session for every observer and resolve its pending UI. */
  private async closeSessionForObservers(sessionId: string, slot: ManagedSlot, reason?: SessionClosedEvent['reason']): Promise<void> {
    await closeSessionForObservers(this.sessionManager, this.clientRegistry, sessionId, slot, reason);
  }

  /** Close this handler's WebSocket connection. */
  closeWebSocket(): void {
    try {
      this.ws.close();
    } catch {
      // Already closed or errored — ignore
    }
  }

  /** Send a `call_ended` event to this client for a server-initiated teardown. */
  sendCallEndedEvent(sessionId: string, reason: 'user_hangup' | 'displaced' | 'server_ended' | 'error'): void {
    this.sendEvent({
      type: 'call_ended',
      sessionId,
      reason,
    });
  }

  /** Send a session_closed event to this client and drop its subscription. */
  sendSessionClosedEvent(sessionId: string, reason?: SessionClosedEvent['reason']): void {
    this.subscribedSessions.delete(sessionId);
    if (this.viewedSessionId === sessionId) this.viewedSessionId = null;
    const event: SessionClosedEvent = reason ? { type: 'session_closed', sessionId, reason } : { type: 'session_closed', sessionId };
    this.sendEvent(event);
  }

  private broadcastSessionArchived(sessionId: string, folderPath: string, archived: boolean): void {
    const event = {
      type: 'session_archived' as const,
      sessionId,
      folderPath,
      archived,
    };
    for (const [, handler] of this.clientRegistry) {
      handler.sendToClient(event);
    }
  }

  private sendTreeResponse(id: string, { tree, currentLeafId }: GetTreeResponseData): void {
    this.sendSerializedResponse(serializeTreeResponse(id, tree, currentLeafId));
  }

  private sendResponse(id: string, success: boolean, data?: unknown, error?: string): void {
    const response: PimoteResponse = { id, success };
    if (data !== undefined) response.data = data;
    if (error !== undefined) response.error = error;

    try {
      this.ws.send(JSON.stringify(response));
    } catch (err) {
      console.error('[WsHandler] Failed to send response:', err);
    }
  }

  private sendSerializedResponse(serialized: string): void {
    try {
      this.ws.send(serialized);
    } catch (err) {
      console.error('[WsHandler] Failed to send response:', err);
    }
  }

  private sendEvent(event: PimoteEvent): void {
    sendBatchedEvent(this.ws as unknown as EventSocket, event);
  }

  private sendSerializedEvent(serialized: string): void {
    try {
      this.ws.send(serialized);
    } catch (err) {
      console.error('[WsHandler] Failed to send event:', err);
    }
  }

  /** Reject + clear any outstanding login prompt/select inputs for this
   *  connection. pi attaches a `.catch` to the manual-code promise, so rejecting
   *  is safe and won't surface an unhandled rejection. */
  private settlePendingLoginInputs(reason = 'login flow ended'): void {
    for (const [, pending] of this.pendingLoginInputs) {
      pending.reject(new Error(reason));
    }
    this.pendingLoginInputs.clear();
  }

  /** Build a connection-bound LoginTransport: events flow to this client, and
   *  prompt/select inputs resolve via this connection's pendingLoginInputs map. */
  private createLoginTransport(): LoginTransport {
    const controller = new AbortController();
    this.loginAbort = controller;
    const awaitInput = (requestId: string): Promise<string> =>
      new Promise<string>((resolve, reject) => {
        this.pendingLoginInputs.set(requestId, { resolve, reject });
      });
    return {
      emit: (step) => {
        this.sendEvent({ type: 'login_step', step });
      },
      requestInput: ({ requestId, message, placeholder, allowEmpty }) => {
        this.sendEvent({ type: 'login_step', step: { kind: 'prompt', requestId, message, placeholder, allowEmpty } });
        return awaitInput(requestId);
      },
      requestSelect: ({ requestId, message, options }) => {
        this.sendEvent({ type: 'login_step', step: { kind: 'select', requestId, message, options } });
        return awaitInput(requestId);
      },
      signal: controller.signal,
    };
  }

  private emitBufferedSessionEvent(slot: ManagedSlot, sessionId: string, sdkEvent: TreeNavigationStartEvent | TreeNavigationEndEvent): void {
    slot.sessionState.eventBuffer.onEvent(
      sdkEvent,
      sessionId,
      (event) => {
        this.sendEvent(event);
        // Tree-navigation events are sent directly to the issuer so the
        // unopen command path can receive them. Keep an attached issuer's
        // replay position in sync with the direct delivery as well.
        const issuer = slot.observers.get(this.clientId);
        if (issuer && 'cursor' in event && typeof event.cursor === 'number') issuer.cursor = event.cursor;
        sendSlotEvent(slot, event, { exceptClientId: this.clientId });
      },
      () => slot.session.messages[slot.session.messages.length - 1],
    );
  }

  /** Send the current download state without treating any item as newly offered. */
  private sendSilentDownloadSnapshot(slot: ManagedSlot): void {
    this.sendEvent(makeDownloadSnapshot(slot.sessionState.id, slot.sessionState.downloads));
  }

  private makeFullResyncEvent(pimoteSessionId: string, slot: ManagedSlot): FullResyncEvent {
    const session = slot.session;
    const model = session.model;
    const state: SessionState = {
      model: model ? { provider: model.provider, id: model.id, name: model.name } : null,
      thinkingLevel: session.thinkingLevel,
      availableThinkingLevels: session.getAvailableThinkingLevels(),
      isStreaming: session.isStreaming,
      isCompacting: session.isCompacting,
      isNavigatingTree: slot.sessionState.treeNavigationInProgress,
      treeNavigationSummarizing: slot.sessionState.treeNavigationSummarizing ?? false,
      sessionFile: session.sessionFile,
      sessionId: session.sessionId,
      sessionName: session.sessionName,
      autoCompactionEnabled: session.autoCompactionEnabled,
      messageCount: session.messages.length,
    };
    let projectedSnapshot: ReturnType<NonNullable<ManagedSlot['sessionSurface']>['refreshSnapshot']> | undefined;
    try {
      projectedSnapshot = slot.sessionSurface?.snapshot?.() ?? slot.sessionSurface?.refreshSnapshot();
    } catch {
      projectedSnapshot = undefined;
    }
    const messages = projectedSnapshot?.messages ?? mapContextEntries(session.sessionManager.buildContextEntries(), rendererRegisteredVisibility(session));
    const branch = typeof session.sessionManager.getBranch === 'function' ? session.sessionManager.getBranch() : undefined;
    const branchEntryIds = branch?.flatMap((entry) => (typeof entry.id === 'string' ? [entry.id] : []));
    // A mid-run snapshot carries the in-flight message and running tool calls.
    // The observer missed their start events, so without them it drops the
    // deltas and tool output that follow.
    const partial = session.isStreaming ? session.state.streamingMessage : undefined;
    const streamingMessage = projectedSnapshot
      ? projectedSnapshot.streamingMessage
      : (() => {
          if (partial === undefined) return undefined;
          if ('content' in partial && Array.isArray(partial.content) && partial.content.length === 0) {
            const usage = mapAgentMessageUsage(partial);
            return { role: partial.role, content: [], ...(usage ? { usage } : {}) };
          }
          return mapAgentMessage(partial);
        })();
    const runningToolCallIds = [...session.state.pendingToolCalls];
    return {
      type: 'full_resync',
      sessionId: pimoteSessionId,
      state,
      messages,
      ...(projectedSnapshot?.activeSubagentContent ? { activeSubagentContent: projectedSnapshot.activeSubagentContent } : {}),
      ...(branchEntryIds !== undefined ? { branchEntryIds } : {}),
      ...(streamingMessage ? { streamingMessage } : {}),
      ...(runningToolCallIds.length > 0 ? { runningToolCallIds } : {}),
    };
  }

  /** Send the current provider hierarchy without advancing the root replay cursor. */
  private sendSubagentSnapshot(slot: ManagedSlot, snapshot?: ReturnType<NonNullable<ManagedSlot['subagentHost']>['snapshot']>): void {
    if (!snapshot) {
      try {
        snapshot = slot.subagentHost?.snapshot();
      } catch {
        return;
      }
    }
    if (!snapshot) return;
    this.sendEvent({
      type: 'subagent_snapshot',
      sessionId: slot.sessionState.id,
      ...snapshot,
    });
  }

  /** Send a full_resync event to the client for the given managed session.
   *  Used when the underlying pi session is reset (newSession, switchSession, fork, navigateTree). */
  private sendFullResyncForSession(pimoteSessionId: string, slot: ManagedSlot): void {
    const snapshot = this.makeFullResyncEvent(pimoteSessionId, slot);
    const maxChunkBytes = 256 * 1024;
    let estimatedBytes = Buffer.byteLength(JSON.stringify({ ...snapshot, messages: [], branchEntryIds: [] }));
    for (const message of snapshot.messages) {
      estimatedBytes += Buffer.byteLength(JSON.stringify(message)) + 1;
      if (estimatedBytes > maxChunkBytes) break;
    }
    if (estimatedBytes <= maxChunkBytes) {
      for (const entryId of snapshot.branchEntryIds ?? []) {
        estimatedBytes += Buffer.byteLength(JSON.stringify(entryId)) + 1;
        if (estimatedBytes > maxChunkBytes) break;
      }
    }

    // Small snapshots retain the compact legacy shape. Large transcripts are
    // split before crossing the socket so the browser parses bounded frames.
    if (estimatedBytes <= maxChunkBytes) {
      this.sendEvent(snapshot);
    } else {
      const { type: _type, sessionId: _sessionId, messages, branchEntryIds, streamingMessage, activeSubagentContent, runningToolCallIds, ...snapshotFields } = snapshot;
      const snapshotId = randomUUID();
      const start: FullResyncStartEvent = {
        type: 'full_resync_start',
        sessionId: pimoteSessionId,
        snapshotId,
        totalMessages: messages.length,
        ...(branchEntryIds !== undefined ? { totalBranchEntryIds: branchEntryIds.length } : {}),
        ...(streamingMessage !== undefined ? { hasStreamingMessage: true } : {}),
        ...(activeSubagentContent !== undefined ? { hasActiveSubagentContent: true } : {}),
        ...(runningToolCallIds !== undefined ? { hasRunningToolCallIds: true } : {}),
        ...snapshotFields,
      };
      this.sendEvent(start);

      // Parse message objects incrementally on the client. Keep raw JSON
      // fragments small even when one message contains a very large text block.
      const jsonChunkTargetBytes = 32 * 1024;
      let data = '';
      let dataBytes = 0;
      let dataOffset = 0;
      const flushJsonChunk = (final: boolean) => {
        if (data.length === 0 && !final) return;
        this.sendEvent({ type: 'full_resync_json_chunk', sessionId: pimoteSessionId, snapshotId, offset: dataOffset, data, final });
        dataOffset += data.length;
        data = '';
        dataBytes = 0;
      };
      const appendJson = (value: string) => {
        for (let offset = 0; offset < value.length; ) {
          let end = Math.min(offset + 8192, value.length);
          const last = value.charCodeAt(end - 1);
          if (end < value.length && last >= 0xd800 && last <= 0xdbff) end -= 1;
          const piece = value.slice(offset, end);
          const pieceBytes = Buffer.byteLength(piece);
          if (dataBytes > 0 && dataBytes + pieceBytes > jsonChunkTargetBytes) flushJsonChunk(false);
          data += piece;
          dataBytes += pieceBytes;
          offset = end;
          if (dataBytes >= jsonChunkTargetBytes) flushJsonChunk(false);
        }
      };
      appendJson('[');
      for (let index = 0; index < messages.length; index += 1) {
        if (index > 0) appendJson(',');
        appendJson(JSON.stringify(messages[index]));
      }
      appendJson(']');
      flushJsonChunk(true);

      if (branchEntryIds !== undefined) {
        let ids: string[] = [];
        let idBytes = 2;
        let idOffset = 0;
        const flushIds = () => {
          if (ids.length === 0) return;
          const shell = JSON.stringify({ type: 'full_resync_branch_chunk', sessionId: pimoteSessionId, snapshotId, offset: idOffset });
          this.sendSerializedEvent(`${shell.slice(0, -1)},"ids":[${ids.join(',')}]}`);
          idOffset += ids.length;
          ids = [];
          idBytes = 2;
        };
        for (const entryId of branchEntryIds) {
          const encoded = JSON.stringify(entryId);
          const entryBytes = Buffer.byteLength(encoded) + (ids.length === 0 ? 0 : 1);
          if (ids.length > 0 && idBytes + entryBytes > maxChunkBytes) flushIds();
          ids.push(encoded);
          idBytes += entryBytes;
        }
        flushIds();
      }

      const sendJsonFieldChunks = (field: 'streamingMessage' | 'activeSubagentContent' | 'runningToolCallIds', serialized: string) => {
        let offset = 0;
        while (offset < serialized.length) {
          let end = Math.min(offset + 8192, serialized.length);
          const lastCodeUnit = serialized.charCodeAt(end - 1);
          if (end < serialized.length && lastCodeUnit >= 0xd800 && lastCodeUnit <= 0xdbff) end -= 1;
          this.sendEvent({
            type: 'full_resync_data_chunk',
            sessionId: pimoteSessionId,
            snapshotId,
            field,
            offset,
            data: serialized.slice(offset, end),
            final: end === serialized.length,
          });
          offset = end;
        }
      };
      if (streamingMessage !== undefined) sendJsonFieldChunks('streamingMessage', JSON.stringify(streamingMessage));
      if (activeSubagentContent !== undefined) sendJsonFieldChunks('activeSubagentContent', JSON.stringify(activeSubagentContent));
      if (runningToolCallIds !== undefined) sendJsonFieldChunks('runningToolCallIds', JSON.stringify(runningToolCallIds));
    }

    this.sendSubagentSnapshot(slot);
    // Always send panel snapshot so the client clears stale cards after reconnect
    this.sendEvent({ type: 'panel_update', sessionId: pimoteSessionId, cards: getMergedPanelCards(slot.sessionState.panelState) });
  }

  /** Fan out settings and panel state without replacing each observer's
   * transcript or client-local transient state. */
  private sendSessionSettingsToObservers(pimoteSessionId: string, slot: ManagedSlot): void {
    const settings = makeSessionSettingsEvent(pimoteSessionId, slot.session);
    const panelUpdate = { type: 'panel_update' as const, sessionId: pimoteSessionId, cards: getMergedPanelCards(slot.sessionState.panelState) };
    // Keep the direct send for a caller that has not opened the session yet,
    // then fan out to every other attached observer without duplicating it.
    this.sendEvent(settings);
    this.sendEvent(panelUpdate);
    sendSlotEvent(slot, settings, { exceptClientId: this.clientId });
    sendSlotEvent(slot, panelUpdate, { exceptClientId: this.clientId });
  }

  private makeSessionCommandsEvent(pimoteSessionId: string, slot: ManagedSlot): SessionCommandsChangedEvent {
    return {
      type: 'session_commands_changed',
      sessionId: pimoteSessionId,
      commands: getSessionCommands(slot.session),
    };
  }

  /** Reload the global Pimote extensions, then the Pi runtime, so the runtime
   * resyncs over the replacement folder sources. */
  private async reloadSession(sessionId: string, slot: ManagedSlot): Promise<void> {
    await this.reloadPimoteExtensions?.();
    await slot.session.reload();
    // The refresh targets this connection; a closed socket has nothing to show.
    if (this.ws.readyState !== 1) return;
    this.sendReloadToObservers(sessionId, slot);
    this.sendSilentDownloadSnapshot(slot);
  }

  /** Run a `/reload` that arrived mid-run once the session reaches idle. */
  private deferReloadUntilIdle(sessionId: string, slot: ManagedSlot): void {
    if (this.deferredReloads.has(slot)) return;
    this.deferredReloads.add(slot);
    void (async () => {
      try {
        await slot.session.waitForIdle();
        if (this.sessionManager.getSession(sessionId) !== slot) return;
        await this.reloadSession(sessionId, slot);
      } catch (error) {
        console.warn(`[WsHandler] Deferred reload failed for ${sessionId}:`, error);
      } finally {
        this.deferredReloads.delete(slot);
      }
    })();
  }

  /** Reload keeps the historical full transcript refresh for the requesting
   * observer. Other observers receive settings, commands, and panel updates,
   * so a reload cannot erase their local transient state. */
  private sendReloadToObservers(pimoteSessionId: string, slot: ManagedSlot): void {
    this.sendFullResyncForSession(pimoteSessionId, slot);
    const settings = makeSessionSettingsEvent(pimoteSessionId, slot.session);
    const commands = this.makeSessionCommandsEvent(pimoteSessionId, slot);
    const panelUpdate = { type: 'panel_update' as const, sessionId: pimoteSessionId, cards: getMergedPanelCards(slot.sessionState.panelState) };
    this.sendEvent(commands);
    sendSlotEvent(slot, settings, { exceptClientId: this.clientId });
    sendSlotEvent(slot, commands, { exceptClientId: this.clientId });
    sendSlotEvent(slot, panelUpdate, { exceptClientId: this.clientId });
  }

  /** Send only while the observer still owns this connected socket. */
  sendToObserver(ws: EventSocket, event: PimoteEvent): void {
    if (this.ws === ws && this.ws.readyState === 1) this.sendEvent(event);
  }

  /** Send an event to this client (public for broadcast use). */
  sendToClient(event: PimoteEvent): void {
    this.sendEvent(event);
  }

  /** Broadcast session availability to every connected client except the
   *  optional requester. A new UI open or takeover owns its response and must
   *  not receive a duplicate lifecycle push; manager callers omit the exclusion. */
  static async broadcastSessionOpened(
    sessionId: string,
    folderPath: string,
    sessionManager: PimoteSessionManager,
    folderRegistry: FolderRegistry | undefined,
    clientRegistry: ClientRegistry,
    excludeClientId?: string,
  ): Promise<FolderInfo> {
    const folder = await resolveFolderInfoForSession(folderPath, sessionManager, folderRegistry, true);
    const event: PimoteEvent = { type: 'session_opened', sessionId, folder };
    for (const [clientId, handler] of clientRegistry) {
      if (clientId === excludeClientId) continue;
      handler.sendToClient(event);
    }
    return folder;
  }

  /** Broadcast the `folders_changed` delta to ALL connected clients. Each
   *  mutation site reports the paths it touched; the folder listing service
   *  builds the delta (re-resolved rows + session-count enrichment + epoch
   *  bump) and this only sends it. Used after registry mutations (via the
   *  registry's onChange in server.ts), after create_folder (folder creation
   *  isn't a registry mutation), and after a repo-index refresh. The build,
   *  retry, and send run as one server-wide queued operation. */
  private static folderDeltaQueue: Promise<void> = Promise.resolve();

  static broadcastFoldersChanged(folderListing: FolderListingService | undefined, changedPaths: string[], removedPaths: string[], clientRegistry: ClientRegistry): void {
    if (!folderListing) return;
    // Capture mutation targets before waiting behind an older delta. Mutation
    // callbacks own these arrays and can reuse their storage after returning.
    const queuedChangedPaths = [...changedPaths];
    const queuedRemovedPaths = [...removedPaths];
    WsHandler.folderDeltaQueue = WsHandler.folderDeltaQueue
      .then(async () => {
        let event: PimoteEvent;
        try {
          event = await folderListing.buildDelta(queuedChangedPaths, queuedRemovedPaths);
        } catch {
          // One immediate retry: a transient registry failure must not drop
          // the delta outright — dropped deltas leave phantom rows that only a
          // purge (manual refresh, reconnect) can clear.
          try {
            event = await folderListing.buildDelta(queuedChangedPaths, queuedRemovedPaths);
          } catch (err) {
            console.warn('[WsHandler] folders_changed delta failed:', err instanceof Error ? err.message : String(err));
            return;
          }
        }

        for (const [, handler] of clientRegistry) {
          handler.sendToClient(event);
        }
      })
      .catch((err) => {
        // Keep the server-wide queue usable if a send or an unexpected error
        // escapes the build/retry path.
        console.warn('[WsHandler] folders_changed delta failed:', err instanceof Error ? err.message : String(err));
      });
  }

  /** The folder-management wiring required by folder commands. */
  private requireFolderDeps(): {
    repoIndex: RepoIndex;
    folderRegistry: FolderRegistry;
    folderListing?: FolderListingService;
  } {
    if (!this.repoIndex || !this.folderRegistry) {
      throw new Error('Folder management is not available on this connection');
    }
    return { repoIndex: this.repoIndex, folderRegistry: this.folderRegistry, folderListing: this.folderListing };
  }

  /** Broadcast a session_state_changed event to ALL connected clients. */
  /** Push the user's current profile set to their connections, excluding the
   *  given client id (no echo) or every client a predicate rejects. */
  static broadcastUserSessionsChanged(userProfiles: UserProfiles, clientRegistry: ClientRegistry, user: string, except?: string | ((clientId: string) => boolean)): void {
    for (const handler of clientRegistry.values()) {
      if (handler.user !== user) continue;
      if (typeof except === 'function' ? except(handler.clientId) : handler.clientId === except) continue;
      handler.sendToClient(WsHandler.userSessionsEvent(userProfiles, user));
    }
  }

  /** The user's profile as one wire event: the set, the order, the selection,
   *  and the order epoch travel together so a client reconciles them in one
   *  pass. */
  static userSessionsEvent(userProfiles: UserProfiles, user: string): UserSessionsChangedEvent {
    return {
      type: 'user_sessions_changed',
      sessions: userProfiles.get(user),
      order: userProfiles.order(user),
      selectedSessionId: userProfiles.selection(user),
      orderVersion: userProfiles.orderVersion(user),
      fresh: userProfiles.isFresh(user),
    };
  }

  static broadcastSidebarUpdate(sessionId: string, folderPath: string, sessionManager: PimoteSessionManager, clientRegistry: ClientRegistry): void {
    const slot = sessionManager.getSession(sessionId);

    // Compute folder aggregates
    const folderSessions = sessionManager.getAllSessions().filter((s) => s.folderPath === folderPath);
    const folderActiveSessionCount = folderSessions.length;
    let folderActiveStatus: 'working' | 'idle' | 'attention' | null = null;
    if (folderSessions.some((s) => s.sessionState.status === 'working')) {
      folderActiveStatus = 'working';
    } else if (folderSessions.some((s) => s.sessionState.needsAttention)) {
      folderActiveStatus = 'attention';
    } else if (folderSessions.length > 0) {
      folderActiveStatus = 'idle';
    }

    // Extract session metadata for sidebar display
    let sessionName: string | undefined;
    let firstMessage: string | undefined;
    let messageCount: number | undefined;
    if (slot) {
      const session = slot.session;
      // Empty string explicitly clears a previously displayed session name.
      sessionName = session.sessionName ?? '';
      messageCount = session.messages.length;
      const firstUserMsg = session.messages.find((m) => m.role === 'user');
      if (firstUserMsg) {
        const rawContent = firstUserMsg.content;
        firstMessage = typeof rawContent === 'string' ? rawContent : Array.isArray(rawContent) ? rawContent.find((c) => c.type === 'text')?.text : undefined;
      }
    }

    const event: SessionStateChangedEvent = {
      type: 'session_state_changed',
      sessionId,
      folderPath,
      liveStatus: slot ? slot.sessionState.status : null,
      connectedClientId: null,
      folderActiveSessionCount,
      folderActiveStatus,
      sessionName,
      firstMessage,
      messageCount,
      gitBranch: slot ? sessionManager.getLastKnownGitBranch(sessionId) : null,
    };

    for (const [, handler] of clientRegistry) {
      handler.sendToClient(event);
    }
  }

  /** The folder row that owns an edited file. Rows are keyed by folder roots,
   *  so a nested `folder/sub/AGENTS.md` resolves to its enclosing row
   *  `folder`; a file under no registered row (the global agent instructions)
   *  owns nothing. */
  private async resolveOwningFolderRow(filePath: string): Promise<string | undefined> {
    const folder = await resolveContainingFolder(filePath);
    const rows = this.folderRegistry ? await this.folderRegistry.listLazy() : undefined;
    let owner: string | undefined;
    for (const row of rows ?? []) {
      const prefix = row.path.endsWith(sep) ? row.path : row.path + sep;
      if (folder !== row.path && !folder.startsWith(prefix)) continue;
      if (owner === undefined || row.path.length > owner.length) owner = row.path;
    }
    return owner;
  }

  cleanup(): void {
    // If this connection had a login flow in flight, abort it and settle any
    // dangling input promises (mirror of `login_cancel`). The LoginOrchestrator
    // is single-flight and server-wide, so leaving it busy would wedge logins
    // for every client until restart.
    this.loginAbort?.abort();
    this.settlePendingLoginInputs('connection closed');
    for (const sid of this.subscribedSessions) {
      const slot = this.sessionManager.getSession(sid);
      this.sessionManager.detachObserver(sid, this.clientId, this.ws as unknown as EventSocket);
      if (slot?.subagentHost) {
        const tokenRecord = this.subagentConnectionTokens.get(slot);
        const token = tokenRecord?.host === slot.subagentHost ? tokenRecord.token : undefined;
        // A socket that never opened a child view has no host token. Do not
        // query the host during cleanup, or a displaced socket could obtain
        // its replacement's token and detach the replacement's views.
        if (token !== undefined) {
          try {
            slot.subagentHost.disconnect(this.clientId, token);
          } catch {
            // A replacement socket already advanced the token. Its views stay live.
          }
        }
        this.forgetSubagentConnectionToken(slot);
      }
      const listener = slot ? this.boundSubagentViewListeners.get(slot) : undefined;
      if (listener && slot?.subagentViewListeners?.get(this.clientId) === listener) slot.subagentViewListeners.delete(this.clientId);
      if (slot) this.boundSubagentViewListeners.delete(slot);
    }
    this.subscribedSessions.clear();
    this.viewedSessionId = null;
    // Release this connection's folder-order pins. Release is final in the
    // listing service: a folder command racing this close can no longer
    // attach owned pins to the connection.
    this.folderListing?.releaseConnection(this.folderConnectionId);
  }
}
