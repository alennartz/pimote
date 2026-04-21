import { mkdir, stat } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { join, sep } from 'node:path';
import { promisify } from 'node:util';
import type { WebSocket } from 'ws';
import type {
  PimoteCommand,
  PimoteResponse,
  PimoteEvent,
  SessionState,
  SessionMeta,
  BufferedEventsEvent,
  ConnectionRestoredEvent,
  FullResyncEvent,
  RestoreMode,
  SessionRestoreEvent,
  SessionStateChangedEvent,
  PimoteTreeNode,
} from '@pimote/shared';
import type { PimoteSessionManager, ManagedSlot } from './session-manager.js';
import { resolveAllSlotPendingUi, resolveSlotPendingUi, replaySlotPendingUiRequests } from './session-manager.js';
import { getMergedPanelCards } from './panel-state.js';
import type { FolderIndex } from './folder-index.js';
import { createExtensionUIBridge } from './extension-ui-bridge.js';
import { findExternalPiProcesses, killExternalPiProcesses } from './takeover.js';
import type { PushNotificationService } from './push-notification.js';
import type { FileSessionMetadataStore } from './session-metadata.js';
import { mapAgentMessages, extractMessageEntryIds, applyEntryIds, type SdkSessionEntry } from './message-mapper.js';
import { getGitBranch } from './git-branch.js';
import type { AgentSession, ExtensionCommandContextActions } from '@mariozechner/pi-coding-agent';
import type { VoiceOrchestrator } from './voice-orchestrator.js';
import { CallBindError } from './voice-orchestrator.js';

/** Parse data-URL encoded images into the shape the pi SDK expects. */
function parseDataUrlImages(images?: string[]): { type: 'image'; data: string; mimeType: string }[] | undefined {
  if (!images || images.length === 0) return undefined;
  return images.map((url) => {
    const match = url.match(/^data:(image\/[^;]+);base64,(.+)$/s);
    if (!match) throw new Error('Invalid image data URL');
    return { type: 'image' as const, data: match[2], mimeType: match[1] };
  });
}

type SessionTreeNode = ReturnType<AgentSession['sessionManager']['getTree']>[number];

const TREE_PREVIEW_MAX_CHARS = 200;

function truncatePreview(value: string): string {
  if (value.length <= TREE_PREVIEW_MAX_CHARS) return value;
  return `${value.slice(0, TREE_PREVIEW_MAX_CHARS - 3)}...`;
}

function textFromEntryContent(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .filter((block): block is { type: 'text'; text: string } => {
      if (!block || typeof block !== 'object') return false;
      const candidate = block as { type?: unknown; text?: unknown };
      return candidate.type === 'text' && typeof candidate.text === 'string';
    })
    .map((block) => block.text)
    .join('\n');
}

function previewForEntry(entry: SessionTreeNode['entry']): string {
  if (entry.type === 'message') {
    const messageContent = (entry.message as { content?: unknown } | undefined)?.content;
    const text = textFromEntryContent(messageContent);
    return truncatePreview(text || entry.type);
  }

  if (entry.type === 'custom_message') {
    const text = textFromEntryContent(entry.content);
    return truncatePreview(text || entry.type);
  }

  if (entry.type === 'compaction' || entry.type === 'branch_summary') {
    const summary = typeof entry.summary === 'string' ? entry.summary : '';
    return truncatePreview(summary || entry.type);
  }

  return entry.type;
}

/** Map pi SDK tree nodes to the wire transfer shape used by pimote clients. */
export function mapTreeNodes(nodes: SessionTreeNode[]): PimoteTreeNode[] {
  return nodes.map((node) => {
    const timestamp = typeof node.entry.timestamp === 'string' ? node.entry.timestamp : new Date(0).toISOString();
    return {
      id: node.entry.id,
      type: node.entry.type,
      role:
        node.entry.type === 'message'
          ? typeof node.entry.message.role === 'string'
            ? node.entry.message.role
            : undefined
          : 'role' in node.entry && typeof node.entry.role === 'string'
            ? node.entry.role
            : undefined,
      customType: 'customType' in node.entry && typeof node.entry.customType === 'string' ? node.entry.customType : undefined,
      preview: previewForEntry(node.entry),
      timestamp,
      label: node.label,
      labelTimestamp: node.labelTimestamp,
      children: mapTreeNodes(node.children),
    };
  });
}

/**
 * Create command context actions for extension commands.
 * Captures the ManagedSlot (stable lifetime), not a transient handler.
 * Session resets are routed through slot.connection.onSessionReset which the
 * current handler sets on claim and clears on cleanup.
 */
function createCommandContextActions(slot: ManagedSlot): ExtensionCommandContextActions {
  return {
    waitForIdle: () => {
      if (!slot.session.isStreaming) return Promise.resolve();
      return new Promise<void>((resolve) => {
        const unsubscribe = slot.session.subscribe((event: { type: string }) => {
          if (event.type === 'agent_end') {
            unsubscribe();
            resolve();
          }
        });
      });
    },
    newSession: async (options) => {
      const result = await slot.runtime.newSession(options);
      if (!result.cancelled) await slot.connection?.onSessionReset?.(slot);
      return { cancelled: result.cancelled };
    },
    fork: async (entryId) => {
      const result = await slot.runtime.fork(entryId);
      if (!result.cancelled) await slot.connection?.onSessionReset?.(slot);
      return { cancelled: result.cancelled };
    },
    navigateTree: async (targetId, options) => {
      const result = await slot.session.navigateTree(targetId, options);
      if (!result.cancelled) await slot.connection?.onSessionReset?.(slot);
      return { cancelled: result.cancelled };
    },
    switchSession: async (sessionPath) => {
      const result = await slot.runtime.switchSession(sessionPath);
      if (!result.cancelled) await slot.connection?.onSessionReset?.(slot);
      return { cancelled: result.cancelled };
    },
    reload: () => slot.session.reload(),
  };
}

/** Client ID → WsHandler lookup for cross-client communication (e.g. displacement notifications) */
export type ClientRegistry = Map<string, WsHandler>;

export class WsHandler {
  private subscribedSessions = new Set<string>();
  private viewedSessionId: string | null = null;
  readonly clientId: string;

  constructor(
    private readonly sessionManager: PimoteSessionManager,
    private readonly folderIndex: FolderIndex,
    private readonly ws: WebSocket,
    private readonly pushNotificationService: PushNotificationService,
    private readonly sessionMetadataStore: FileSessionMetadataStore,
    clientId: string,
    private readonly clientRegistry: ClientRegistry,
    private readonly voiceOrchestrator?: VoiceOrchestrator,
  ) {
    this.clientId = clientId;
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

    const id = command.id ?? 'unknown';

    try {
      switch (command.type) {
        // ---- Server-level commands ----
        case 'list_folders': {
          const folders = await this.folderIndex.scan();
          // Enrich with active session info
          const activeSessions = this.sessionManager.getAllSessions();
          for (const folder of folders) {
            const folderSessions = activeSessions.filter((s) => s.folderPath === folder.path);
            folder.activeSessionCount = folderSessions.length;
            if (folderSessions.some((s) => s.sessionState.status === 'working')) {
              folder.activeStatus = 'working';
            } else if (folderSessions.some((s) => s.sessionState.needsAttention)) {
              folder.activeStatus = 'attention';
            } else if (folderSessions.length > 0) {
              folder.activeStatus = 'idle';
            } else {
              folder.activeStatus = null;
            }
          }
          this.sendResponse(id, true, { folders, roots: this.folderIndex.roots });
          break;
        }

        case 'create_project': {
          const name = command.name;
          const root = command.root;

          // Validate name: non-empty, no path separators, not . or ..
          if (!name || name.includes('/') || name.includes(sep) || name === '.' || name === '..') {
            this.sendResponse(id, false, undefined, 'Invalid project name');
            break;
          }

          // Validate root is one of the configured roots
          if (!this.folderIndex.roots.includes(root)) {
            this.sendResponse(id, false, undefined, 'Root is not a configured project root');
            break;
          }

          const folderPath = join(root, name);

          // Check if directory already exists
          try {
            await stat(folderPath);
            this.sendResponse(id, false, undefined, 'Directory already exists');
            break;
          } catch (err) {
            const code = err instanceof Error ? (err as NodeJS.ErrnoException).code : undefined;
            if (code !== 'ENOENT') {
              const message = err instanceof Error ? err.message : String(err);
              this.sendResponse(id, false, undefined, `Cannot access directory: ${message}`);
              break;
            }
            // ENOENT — directory doesn't exist yet, proceed with creation
          }

          // Create directory and git init
          try {
            await mkdir(folderPath, { recursive: true });
            await promisify(execFile)('git', ['init'], { cwd: folderPath });
          } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            this.sendResponse(id, false, undefined, `Failed to create project: ${message}`);
            break;
          }

          this.sendResponse(id, true, { folderPath });
          break;
        }

        case 'list_sessions': {
          const sessions = await this.folderIndex.listSessionRecords(command.folderPath);
          const archivedLookup = this.sessionMetadataStore.getArchivedLookup(sessions.map((s) => s.path));

          // Build lookup from session ID to managed session for ownership enrichment
          const activeSessions = this.sessionManager.getAllSessions();
          const slotById = new Map<string, ManagedSlot>();
          for (const s of activeSessions) {
            slotById.set(s.sessionState.id, s);
          }

          // Enrich each session with ownership, live status, and archived state
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
                isOwnedByMe: sl ? sl.connection?.connectedClientId === this.clientId : false,
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
                isOwnedByMe: slot.connection?.connectedClientId === this.clientId,
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
            const sessionId = await this.sessionManager.openSession(command.folderPath);
            const newSlot = this.sessionManager.getSession(sessionId)!;
            await this.claimSession(sessionId, newSlot);
            this.viewedSessionId = sessionId;

            this.sendEvent({
              type: 'session_opened',
              sessionId,
              folder: this.buildFolderInfo(newSlot.folderPath),
            });

            WsHandler.broadcastSidebarUpdate(sessionId, newSlot.folderPath, this.sessionManager, this.clientRegistry);
            await this.sendConflictEventIfNeeded(sessionId, newSlot.folderPath);
            this.sendResponse(id, true, { sessionId });
            break;
          }

          // Existing session: reclaim live in-memory runtime if possible, otherwise reopen from disk.
          const requestedSessionId = command.sessionId;
          const existing = this.sessionManager.getSession(requestedSessionId);
          if (existing) {
            if (existing.connection?.connectedClientId && existing.connection.connectedClientId !== this.clientId) {
              const oldHandler = this.clientRegistry.get(existing.connection.connectedClientId);
              if (oldHandler && !command.force) {
                this.sendResponse(id, false, undefined, 'session_owned');
                break;
              }
              this.displaceOwner(requestedSessionId, existing);
            }

            const existingSessionPath = existing.session.sessionFile;
            if (existingSessionPath && this.sessionMetadataStore.isArchived(existingSessionPath)) {
              await this.sessionMetadataStore.setArchived(existingSessionPath, false);
              this.broadcastSessionArchived(requestedSessionId, existing.folderPath, false);
            }

            const restoreMode = await this.syncSessionToClient(requestedSessionId, existing, command.lastCursor);
            WsHandler.broadcastSidebarUpdate(requestedSessionId, existing.folderPath, this.sessionManager, this.clientRegistry);
            this.sendResponse(id, true, { sessionId: requestedSessionId, folderPath: existing.folderPath, restoreMode });
            break;
          }

          const sessionFilePath = await this.folderIndex.resolveSessionPath(command.folderPath, requestedSessionId);
          if (!sessionFilePath) {
            this.sendResponse(id, false, undefined, 'session_expired');
            break;
          }

          if (this.sessionMetadataStore.isArchived(sessionFilePath)) {
            await this.sessionMetadataStore.setArchived(sessionFilePath, false);
            this.broadcastSessionArchived(requestedSessionId, command.folderPath, false);
          }

          const sessionId = await this.sessionManager.openSession(command.folderPath, sessionFilePath);
          const reopenedSlot = this.sessionManager.getSession(sessionId)!;
          await this.syncSessionToClient(sessionId, reopenedSlot, undefined, 'disk_full_resync');
          WsHandler.broadcastSidebarUpdate(sessionId, reopenedSlot.folderPath, this.sessionManager, this.clientRegistry);
          await this.sendConflictEventIfNeeded(sessionId, reopenedSlot.folderPath);
          this.sendResponse(id, true, { sessionId, folderPath: reopenedSlot.folderPath, restoreMode: 'disk_full_resync' });
          break;
        }

        case 'close_session': {
          const closeSessionId = command.sessionId;
          if (!closeSessionId) {
            this.sendResponse(id, false, undefined, 'sessionId is required');
            break;
          }

          // Resolve pending extension UI responses so tools don't hang
          const closingSlot = this.sessionManager.getSession(closeSessionId);
          if (closingSlot) {
            resolveAllSlotPendingUi(closingSlot);
          }

          await this.sessionManager.closeSession(closeSessionId);

          this.subscribedSessions.delete(closeSessionId);
          if (this.viewedSessionId === closeSessionId) {
            this.viewedSessionId = null;
          }

          this.sendEvent({
            type: 'session_closed',
            sessionId: closeSessionId,
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

          const deleteSlot = this.sessionManager.getSession(deleteSessionId);
          const deleteSessionPath = deleteSlot?.session.sessionFile ?? (await this.folderIndex.resolveSessionPath(deleteFolderPath, deleteSessionId));

          // If the session is active in memory, close it first
          if (deleteSlot) {
            // Notify the owning client if it's a different client
            if (deleteSlot.connection?.connectedClientId && deleteSlot.connection.connectedClientId !== this.clientId) {
              const ownerHandler = this.clientRegistry.get(deleteSlot.connection.connectedClientId);
              if (ownerHandler) {
                ownerHandler.sendKilledEvent(deleteSessionId);
              }
            }
            resolveAllSlotPendingUi(deleteSlot);
            await this.sessionManager.closeSession(deleteSessionId);
          }

          // Delete the file from disk
          const deleted = await this.folderIndex.deleteSession(deleteFolderPath, deleteSessionId);
          if (!deleted) {
            this.sendResponse(id, false, undefined, `Session not found: ${deleteSessionId}`);
            break;
          }

          if (deleteSessionPath) {
            await this.sessionMetadataStore.delete(deleteSessionPath);
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

          this.sendResponse(id, true);
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
            const archiveSlot = this.sessionManager.getSession(archiveSessionId);
            const archiveSessionPath = archiveSlot?.session.sessionFile ?? (await this.folderIndex.resolveSessionPath(archiveFolderPath, archiveSessionId));
            if (!archiveSessionPath) continue;

            await this.sessionMetadataStore.setArchived(archiveSessionPath, command.archived);
            this.broadcastSessionArchived(archiveSessionId, archiveFolderPath, command.archived);
            archivedCount++;
          }

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
            const renamed = await this.folderIndex.renameSession(renameFolderPath, renameSessionId, renameName);
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

          this.sendResponse(id, true, { name: renameName });
          break;
        }

        case 'takeover_folder': {
          const killedCount = await killExternalPiProcesses(command.folderPath);

          const takeoverSessionId = await this.sessionManager.openSession(command.folderPath);

          const takeoverSlot = this.sessionManager.getSession(takeoverSessionId)!;
          await this.claimSession(takeoverSessionId, takeoverSlot);
          this.viewedSessionId = takeoverSessionId;

          this.sendEvent({
            type: 'session_opened',
            sessionId: takeoverSessionId,
            folder: {
              path: takeoverSlot.folderPath,
              name: takeoverSlot.folderPath.split('/').pop() ?? takeoverSlot.folderPath,
              activeSessionCount: 1,
              externalProcessCount: 0,
              activeStatus: 'idle',
            },
          });

          WsHandler.broadcastSidebarUpdate(takeoverSessionId, takeoverSlot.folderPath, this.sessionManager, this.clientRegistry);
          this.sendResponse(id, true, { sessionId: takeoverSessionId, killedProcesses: killedCount });
          break;
        }

        // ---- Voice call control ----
        case 'call_bind': {
          if (!this.voiceOrchestrator) {
            this.sendResponse(id, false, undefined, 'call_bind_failed_internal');
            break;
          }
          const slot = this.sessionManager.getSlot(command.sessionId);
          if (!slot) {
            this.sendResponse(id, false, undefined, 'call_bind_failed_session_not_found');
            break;
          }
          const connection: import('./session-manager.js').ClientConnection = {
            ws: this.ws as import('./session-manager.js').EventSocket,
            connectedClientId: this.clientId,
            onSessionReset: (s) => this.handleSessionReset(s),
          };
          try {
            const data = await this.voiceOrchestrator.bindCall({
              sessionId: command.sessionId,
              clientConnection: connection,
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
          await this.voiceOrchestrator?.endCall({ sessionId: command.sessionId, reason: 'user_hangup' });
          this.sendResponse(id, true);
          this.sendEvent({ type: 'call_ended', sessionId: command.sessionId, reason: 'user_hangup' });
          break;
        }

        // ---- Extension UI ----
        case 'extension_ui_response': {
          const uiSlot = command.sessionId ? this.sessionManager.getSession(command.sessionId) : undefined;
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
            resolveSlotPendingUi(uiSlot, command.requestId, value);
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
          }
          this.sendResponse(id, true);
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

            // Notify the owning client if still connected
            if (targetSlot.connection?.connectedClientId) {
              const ownerHandler = this.clientRegistry.get(targetSlot.connection.connectedClientId);
              if (ownerHandler) {
                ownerHandler.sendKilledEvent(targetSessionId);
              }
            }

            await this.sessionManager.closeSession(targetSessionId);
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

        // ---- Session control commands ----
        case 'prompt':
        case 'steer':
        case 'follow_up':
        case 'abort':
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
        case 'get_session_meta':
        case 'get_commands':
        case 'complete_args':
        case 'set_session_name':
        case 'dequeue_steering':
        case 'fork':
        case 'navigate_tree':
        case 'set_tree_label': {
          await this.handleSessionCommand(command, id);
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

    switch (command.type) {
      case 'prompt': {
        // Intercept pimote built-in slash commands
        const trimmed = command.message.trim();
        if (trimmed === '/new') {
          const result = await slot.runtime.newSession();
          if (!result.cancelled) await slot.connection?.onSessionReset?.(slot);
          this.sendResponse(id, true, { success: !result.cancelled });
          break;
        }
        if (trimmed === '/reload') {
          session.reload();
          this.sendResponse(id, true);
          break;
        }
        if (trimmed === '/tree') {
          const tree = mapTreeNodes(session.sessionManager.getTree() as SessionTreeNode[]);
          const currentLeafId = session.sessionManager.getLeafId();
          this.sendResponse(id, true, { tree, currentLeafId });
          break;
        }

        session.prompt(command.message, { images: parseDataUrlImages(command.images) }).catch((err) => {
          console.error(`[WsHandler] prompt error:`, err);
        });
        this.sendResponse(id, true);
        break;
      }

      case 'steer': {
        session.steer(command.message).catch((err) => {
          console.error(`[WsHandler] steer error:`, err);
        });
        this.sendResponse(id, true);
        break;
      }

      case 'dequeue_steering': {
        const result = session.clearQueue();
        this.sendResponse(id, true, { steering: result.steering, followUp: result.followUp });
        break;
      }

      case 'follow_up': {
        session.followUp(command.message).catch((err) => {
          console.error(`[WsHandler] followUp error:`, err);
        });
        this.sendResponse(id, true);
        break;
      }

      case 'abort': {
        // Resolve pending UI responses first so stuck dialogs unblock
        resolveAllSlotPendingUi(slot);
        const abortResult = await Promise.race([session.abort().then(() => 'ok' as const), new Promise<'timeout'>((resolve) => setTimeout(() => resolve('timeout'), 30_000))]);
        if (abortResult === 'timeout') {
          console.error(`[WsHandler] session.abort() did not resolve within 30s (sessionId=${sessionId})`);
        }
        this.sendResponse(id, true);
        break;
      }

      case 'set_model': {
        const models = slot.session.modelRegistry.getAvailable();
        const model = models.find((m) => m.provider === command.provider && m.id === command.modelId);
        if (!model) {
          this.sendResponse(id, false, undefined, `Model not found: ${command.provider}/${command.modelId}`);
          break;
        }
        await session.setModel(model);
        this.sendResponse(id, true);
        break;
      }

      case 'cycle_model': {
        const result = await session.cycleModel();
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
        const models = slot.session.modelRegistry.getAvailable();
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
        this.sendResponse(id, true);
        break;
      }

      case 'cycle_thinking_level': {
        const level = session.cycleThinkingLevel();
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
        const messages = mapAgentMessages(session.messages);
        const entryIds = extractMessageEntryIds(session.sessionManager.getBranch() as unknown as SdkSessionEntry[]);
        applyEntryIds(messages, entryIds);
        this.sendResponse(id, true, { messages });
        break;
      }

      case 'new_session': {
        const result = await slot.runtime.newSession();
        if (!result.cancelled) await slot.connection?.onSessionReset?.(slot);
        this.sendResponse(id, true, { success: !result.cancelled });
        break;
      }

      case 'get_session_stats': {
        const stats = session.getSessionStats();
        this.sendResponse(id, true, { stats });
        break;
      }

      case 'get_session_meta': {
        const contextUsage = session.getContextUsage();
        const meta: SessionMeta = {
          gitBranch: getGitBranch(slot.folderPath),
          contextUsage: contextUsage ? { percent: contextUsage.percent, contextWindow: contextUsage.contextWindow } : null,
        };
        this.sendResponse(id, true, { meta });
        break;
      }

      case 'get_commands': {
        const commands: import('@pimote/shared').CommandInfo[] = [];

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
        );

        this.sendResponse(id, true, { commands });
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
        const forkResult = await slot.runtime.fork(command.entryId);
        if (!forkResult.cancelled) {
          await this.handleSessionReset(slot);
        }
        const forkData: { cancelled: boolean; selectedText?: string } = { cancelled: forkResult.cancelled };
        if (forkResult.selectedText !== undefined) {
          forkData.selectedText = forkResult.selectedText;
        }
        this.sendResponse(id, true, forkData);
        break;
      }

      case 'navigate_tree': {
        if (slot.sessionState.treeNavigationInProgress) {
          this.sendResponse(id, false, undefined, 'Tree navigation already in progress');
          break;
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
          this.emitBufferedSessionEvent(slot, sessionId, {
            type: 'tree_navigation_end',
          });
        }

        if (!result.cancelled) {
          await this.handleSessionReset(slot);
        }

        const data: { cancelled: boolean; editorText?: string } = { cancelled: result.cancelled };
        if (result.editorText !== undefined) {
          data.editorText = result.editorText;
        }

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

  /** Notify the old owner that they've been displaced from a session.
   *  No-op if the session is unowned or owned by this client. */
  private displaceOwner(sessionId: string, slot: ManagedSlot): void {
    if (slot.connection?.connectedClientId && slot.connection.connectedClientId !== this.clientId) {
      const oldHandler = this.clientRegistry.get(slot.connection.connectedClientId);
      if (oldHandler) {
        oldHandler.sendDisplacedEvent(sessionId);
      }
    }
    // Tear down voice-call bookkeeping on the orchestrator so the voice
    // extension's deactivate reducer fires (closes speechmux, clears
    // walk-back watermark) before the new owner takes over.
    if (this.voiceOrchestrator?.isCallActive(sessionId)) {
      this.voiceOrchestrator.endCall({ sessionId, reason: 'displaced' }).catch((err) => {
        console.warn('[voice] endCall on displace failed', err);
      });
    }
  }

  /** Bind a slot to this client — sets ownership, WebSocket routing,
   *  and subscribes to events. Extensions are bound once on first claim. */
  private async claimSession(sessionId: string, slot: ManagedSlot): Promise<void> {
    const connection: import('./session-manager.js').ClientConnection = {
      ws: this.ws as import('./session-manager.js').EventSocket,
      connectedClientId: this.clientId,
      onSessionReset: (s) => this.handleSessionReset(s),
    };
    slot.connection = connection;
    slot.sessionState.lastActivity = Date.now();
    this.subscribedSessions.add(sessionId);

    // Bind extensions when needed. The bridge holds a direct reference to this
    // ManagedSlot — on reconnect we skip rebinding, but on session reset
    // we must rebind so the bridge points at the new session state.
    if (!slot.sessionState.extensionsBound) {
      const uiContext = createExtensionUIBridge(slot, this.pushNotificationService, {
        isVoiceModeActive: () => this.voiceOrchestrator?.isCallActive(sessionId) ?? false,
      });
      const commandContextActions = createCommandContextActions(slot);
      await slot.session.bindExtensions({ uiContext, commandContextActions });
      slot.sessionState.extensionsBound = true;
    }

    // Re-deliver any pending UI requests to the new client (recovers lost dialogs)
    replaySlotPendingUiRequests(slot);
  }

  /** Handle a session reset (newSession, fork, switchSession).
   *  Called via slot.connection.onSessionReset after the runtime has replaced the session. */
  private async handleSessionReset(slot: ManagedSlot): Promise<void> {
    const newSessionId = slot.runtime.session.sessionId;
    const oldSessionId = slot.sessionState.id;

    // navigateTree stays in the same file — same session ID, just resync
    if (newSessionId === oldSessionId) {
      this.sendFullResyncForSession(oldSessionId, slot);
      return;
    }

    // Session ID changed — rebuild session state in-place on the same slot.
    const folderPath = slot.folderPath;

    // Rebuild session state (tears down old, creates new from runtime.session)
    this.sessionManager.rebuildSessionState(slot);

    // Re-key the session map
    this.sessionManager.reKeySession(slot, oldSessionId, newSessionId);

    // Update handler bookkeeping
    this.subscribedSessions.delete(oldSessionId);
    this.subscribedSessions.add(newSessionId);
    if (this.viewedSessionId === oldSessionId) {
      this.viewedSessionId = newSessionId;
    }

    // Rebind extension UI bridge (new session state for dialog routing)
    const uiContext = createExtensionUIBridge(slot, this.pushNotificationService, {
      isVoiceModeActive: () => this.voiceOrchestrator?.isCallActive(newSessionId) ?? false,
    });
    const commandContextActions = createCommandContextActions(slot);
    await slot.session.bindExtensions({ uiContext, commandContextActions });
    slot.sessionState.extensionsBound = true;

    // Notify owning client: session replaced (client re-keys in place)
    this.sendEvent({
      type: 'session_replaced',
      oldSessionId,
      newSessionId,
      folder: {
        path: folderPath,
        name: folderPath.split('/').pop() ?? folderPath,
        activeSessionCount: this.sessionManager.getAllSessions().filter((s) => s.folderPath === folderPath).length,
        externalProcessCount: 0,
        activeStatus: 'idle',
      },
    });

    // Broadcast sidebar updates for both old (now inactive) and new (now active)
    WsHandler.broadcastSidebarUpdate(oldSessionId, folderPath, this.sessionManager, this.clientRegistry);
    WsHandler.broadcastSidebarUpdate(newSessionId, folderPath, this.sessionManager, this.clientRegistry);
  }

  private buildFolderInfo(folderPath: string) {
    return {
      path: folderPath,
      name: folderPath.split('/').pop() ?? folderPath,
      activeSessionCount: 1,
      externalProcessCount: 0,
      activeStatus: 'idle' as const,
    };
  }

  private async sendConflictEventIfNeeded(sessionId: string, folderPath: string): Promise<void> {
    const openConflictPids = await findExternalPiProcesses(folderPath);
    const allSessions = this.sessionManager.getAllSessions();
    const remoteSessions = allSessions
      .filter(
        (s) => s.folderPath === folderPath && s.connection?.connectedClientId !== null && s.connection?.connectedClientId !== this.clientId && s.sessionState.id !== sessionId,
      )
      .map((s) => ({ sessionId: s.sessionState.id, status: s.sessionState.status }));

    if (openConflictPids.length > 0 || remoteSessions.length > 0) {
      this.sendEvent({
        type: 'session_conflict',
        sessionId,
        processes: openConflictPids.map((pid) => ({ pid, command: 'pi' })),
        remoteSessions,
      });
    }
  }

  private async syncSessionToClient(sessionId: string, slot: ManagedSlot, lastCursor?: number, noCursorRestoreMode: RestoreMode = 'full_resync_no_cursor'): Promise<RestoreMode> {
    let replayResult: ReturnType<import('./event-buffer.js').EventBuffer['replay']> | null = null;
    let cursorBeforeClaim: number | null = null;

    let restoreMode: RestoreMode;

    if (lastCursor !== undefined) {
      replayResult = slot.sessionState.eventBuffer.replay(lastCursor);
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
      const catchUp = slot.sessionState.eventBuffer.replay(cursorBeforeClaim);
      if (catchUp && catchUp.length > 0) {
        this.sendEvent({
          type: 'buffered_events',
          sessionId,
          events: catchUp,
        } as BufferedEventsEvent);
      }
    }

    if (replayResult !== null) {
      // Always send panel state after reconnect so the client clears stale cards
      this.sendEvent({ type: 'panel_update', sessionId, cards: getMergedPanelCards(slot.sessionState.panelState) });
    }

    this.sendEvent({ type: 'session_restore', sessionId, mode: restoreMode, status: 'completed' } as SessionRestoreEvent);

    return restoreMode;
  }

  /** Close this handler's WebSocket connection. */
  closeWebSocket(): void {
    try {
      this.ws.close();
    } catch {
      // Already closed or errored — ignore
    }
  }

  /** Send a session_closed event with reason 'displaced' to this client's WebSocket.
   *  Also removes the session from this handler's subscribedSessions so that
   *  cleanup() won't stomp the new owner's bindings when this handler closes. */
  sendDisplacedEvent(sessionId: string): void {
    this.subscribedSessions.delete(sessionId);
    this.sendEvent({
      type: 'session_closed',
      sessionId,
      reason: 'displaced',
    });
    // If the old owner had an active voice call on this session, tear down
    // orchestrator bookkeeping and surface `call_ended { reason: 'displaced' }`
    // so their VoiceCallStore tears down alongside the session_closed.
    if (this.voiceOrchestrator?.isCallActive(sessionId)) {
      void this.voiceOrchestrator.endCall({ sessionId, reason: 'displaced' });
      this.sendEvent({
        type: 'call_ended',
        sessionId,
        reason: 'displaced',
      });
    }
  }

  /** Broadcast a `call_ended` to this client (used by the session manager's
   *  before-close hook so the orchestrator bookkeeping owner learns that a
   *  server-initiated teardown happened). */
  sendCallEndedEvent(sessionId: string, reason: 'user_hangup' | 'displaced' | 'server_ended' | 'error'): void {
    this.sendEvent({
      type: 'call_ended',
      sessionId,
      reason,
    });
  }

  /** Send a session_closed event with reason 'killed' to this client's WebSocket.
   *  Also removes the session from this handler's subscribedSessions so that
   *  cleanup() won't stomp stale entries. */
  sendKilledEvent(sessionId: string): void {
    this.subscribedSessions.delete(sessionId);
    this.sendEvent({
      type: 'session_closed',
      sessionId,
      reason: 'killed',
    });
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

  private sendEvent(event: PimoteEvent): void {
    try {
      this.ws.send(JSON.stringify(event));
    } catch (err) {
      console.error('[WsHandler] Failed to send event:', err);
    }
  }

  private emitBufferedSessionEvent(slot: ManagedSlot, sessionId: string, sdkEvent: { type: string; [key: string]: unknown }): void {
    let forwarded = false;
    slot.sessionState.eventBuffer.onEvent(
      sdkEvent,
      sessionId,
      (event) => {
        // Augment agent_end with message entry IDs so the client can enable
        // fork targets on messages that arrived via streaming (without IDs).
        if (event.type === 'agent_end') {
          const entryIds = extractMessageEntryIds(slot.session.sessionManager.getBranch() as unknown as SdkSessionEntry[]);
          (event as unknown as Record<string, unknown>).messageEntryIds = entryIds;
        }
        forwarded = true;
        this.sendEvent(event);
      },
      () => slot.session.messages[slot.session.messages.length - 1],
    );

    // Test doubles for EventBuffer may no-op on onEvent().
    // Fallback keeps lifecycle visibility in tests while real runtime uses buffered forwarding above.
    if (!forwarded) {
      const cursorBase = slot.sessionState.eventBuffer.currentCursor;
      const cursor = typeof cursorBase === 'number' ? cursorBase + 1 : 1;
      this.sendEvent({
        ...(sdkEvent as Record<string, unknown>),
        sessionId,
        cursor,
      } as PimoteEvent);
    }
  }

  /** Send a full_resync event to the client for the given managed session.
   *  Used when the underlying pi session is reset (newSession, switchSession, fork, navigateTree). */
  private sendFullResyncForSession(pimoteSessionId: string, slot: ManagedSlot): void {
    const session = slot.session;
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
    const messages = mapAgentMessages(session.messages);
    const entryIds = extractMessageEntryIds(session.sessionManager.getBranch() as unknown as SdkSessionEntry[]);
    applyEntryIds(messages, entryIds);
    const fullResyncEvent: FullResyncEvent = {
      type: 'full_resync',
      sessionId: pimoteSessionId,
      state,
      messages,
    };
    this.sendEvent(fullResyncEvent);

    // Always send panel snapshot so the client clears stale cards after reconnect
    this.sendEvent({ type: 'panel_update', sessionId: pimoteSessionId, cards: getMergedPanelCards(slot.sessionState.panelState) });
  }

  /** Send an event to this client (public for broadcast use). */
  sendToClient(event: PimoteEvent): void {
    this.sendEvent(event);
  }

  /** Broadcast a session_state_changed event to ALL connected clients. */
  static broadcastSidebarUpdate(sessionId: string, folderPath: string, sessionManager: PimoteSessionManager, clientRegistry: ClientRegistry): void {
    const slot = sessionManager.getSession(sessionId);

    // Compute folder aggregates (same logic as list_folders handler)
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
      sessionName = session.sessionName || undefined;
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
      connectedClientId: slot ? (slot.connection?.connectedClientId ?? null) : null,
      folderActiveSessionCount,
      folderActiveStatus,
      sessionName,
      firstMessage,
      messageCount,
      gitBranch: slot ? getGitBranch(slot.folderPath) : null,
    };

    for (const [, handler] of clientRegistry) {
      handler.sendToClient(event);
    }
  }

  cleanup(): void {
    for (const sid of this.subscribedSessions) {
      const slot = this.sessionManager.getSession(sid);
      if (slot) {
        slot.connection = null;
        slot.sessionState.lastActivity = Date.now();
        // Note: pending UI responses are NOT resolved here — they survive
        // for replay on reconnect. They are resolved on session close or abort.
      }
    }
    this.subscribedSessions.clear();
    this.viewedSessionId = null;
  }
}
