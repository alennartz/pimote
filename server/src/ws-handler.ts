import type { WebSocket } from 'ws';
import { execFileSync } from 'node:child_process';
import type {
  PimoteCommand,
  PimoteResponse,
  PimoteEvent,
  PimoteSessionEvent,

  SessionState,
  SessionMeta,
  BufferedEventsEvent,
  ConnectionRestoredEvent,
  FullResyncEvent,
} from '@pimote/shared';
import type { PimoteSessionManager, ManagedSession } from './session-manager.js';
import type { FolderIndex } from './folder-index.js';
import { createExtensionUIBridge } from './extension-ui-bridge.js';
import { findExternalPiProcesses, killExternalPiProcesses } from './takeover.js';
import type { PushNotificationService } from './push-notification.js';
import { mapAgentMessages } from './message-mapper.js';

/** Resolve the current git branch for a directory. Returns null if not a git repo. */
function getGitBranch(cwd: string): string | null {
  try {
    return execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], {
      cwd,
      encoding: 'utf-8',
      timeout: 2000,
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim() || null;
  } catch {
    return null;
  }
}

/** Client ID → WsHandler lookup for cross-client communication (e.g. displacement notifications) */
export type ClientRegistry = Map<string, WsHandler>;

export class WsHandler {
  private readonly pendingUiResponses = new Map<string, { resolve: (value: any) => void; sessionId: string }>();
  private subscribedSessions = new Set<string>();
  private viewedSessionId: string | null = null;
  readonly clientId: string;

  constructor(
    private readonly sessionManager: PimoteSessionManager,
    private readonly folderIndex: FolderIndex,
    private readonly ws: WebSocket,
    private readonly pushNotificationService: PushNotificationService,
    clientId: string,
    private readonly clientRegistry: ClientRegistry,
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
            const folderSessions = activeSessions.filter(
              (s) => s.folderPath === folder.path,
            );
            folder.activeSessionCount = folderSessions.length;
            if (folderSessions.some(s => s.status === 'working')) {
              folder.activeStatus = 'working';
            } else if (folderSessions.some(s => s.needsAttention)) {
              folder.activeStatus = 'attention';
            } else if (folderSessions.length > 0) {
              folder.activeStatus = 'idle';
            } else {
              folder.activeStatus = null;
            }
          }
          this.sendResponse(id, true, { folders });
          break;
        }

        case 'list_sessions': {
          const sessions = await this.folderIndex.listSessions(command.folderPath);

          // Build lookup from session file path to managed session for ownership enrichment
          const activeSessions = this.sessionManager.getAllSessions();
          const managedByPath = new Map<string, ManagedSession>();
          for (const ms of activeSessions) {
            const filePath = ms.sessionFilePath ?? ms.session.sessionFile;
            if (filePath) {
              managedByPath.set(filePath, ms);
            }
          }

          // Enrich each session with ownership and live status
          const enriched = sessions.map(s => {
            const ms = managedByPath.get(s.path);
            return {
              ...s,
              isOwnedByMe: ms ? ms.connectedClientId === this.clientId : false,
              liveStatus: ms ? ms.status : null,
            };
          });

          this.sendResponse(id, true, { sessions: enriched });
          break;
        }

        case 'open_session': {
          const sendLive = (event: PimoteSessionEvent): void => {
            this.sendEvent(event);
          };

          const onStatusChange = this.createStatusChangeCallback();

          const sessionId = await this.sessionManager.openSession(
            command.folderPath,
            command.sessionPath,
            sendLive,
            onStatusChange,
          );

          const managed = this.sessionManager.getSession(sessionId)!;
          managed.connectedClientId = this.clientId;
          this.subscribedSessions.add(sessionId);
          this.viewedSessionId = sessionId;

          // Bind extension UI bridge
          const waitForResponse = (requestId: string): Promise<any> => {
            return new Promise<any>((resolve) => {
              this.pendingUiResponses.set(requestId, { resolve, sessionId });
            });
          };

          const sendToClient = (event: PimoteEvent): void => {
            // Enrich extension UI events with the session ID
            if (event.type === 'extension_ui_request' && !event.sessionId) {
              (event as any).sessionId = sessionId;
            }
            this.sendEvent(event);
          };

          const uiContext = createExtensionUIBridge(sendToClient, waitForResponse);
          await managed.session.bindExtensions({ uiContext });

          // Send session_opened event
          this.sendEvent({
            type: 'session_opened',
            sessionId,
            sessionFilePath: managed.session.sessionFile,
            folder: {
              path: managed.folderPath,
              name: managed.folderPath.split('/').pop() ?? managed.folderPath,
              activeSessionCount: 1,
              externalProcessCount: 0,
              activeStatus: 'idle',
            },
          });

          // Check for conflicting external pi processes and remote pimote sessions
          const openConflictPids = await findExternalPiProcesses(command.folderPath);
          const allSessions = this.sessionManager.getAllSessions();
          const remoteSessions = allSessions
            .filter(s => s.folderPath === command.folderPath && s.connectedClientId !== this.clientId && s.id !== sessionId)
            .map(s => ({ sessionId: s.id, status: s.status }));

          if (openConflictPids.length > 0 || remoteSessions.length > 0) {
            this.sendEvent({
              type: 'session_conflict',
              sessionId,
              processes: openConflictPids.map(pid => ({ pid, command: 'pi' })),
              remoteSessions,
            });
          }

          this.sendResponse(id, true, { sessionId });
          break;
        }

        case 'close_session': {
          const closeSessionId = command.sessionId;
          if (!closeSessionId) {
            this.sendResponse(id, false, undefined, 'sessionId is required');
            break;
          }

          // Resolve only pending extension UI responses for the closed session
          for (const [key, pending] of this.pendingUiResponses) {
            if (pending.sessionId === closeSessionId) {
              pending.resolve(undefined);
              this.pendingUiResponses.delete(key);
            }
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

        case 'reconnect': {
          const managed = this.sessionManager.getSession(command.sessionId);
          if (!managed) {
            this.sendResponse(id, false, undefined, 'session_expired');
            break;
          }

          // Displacement check: different client owns this session?
          if (managed.connectedClientId && managed.connectedClientId !== this.clientId) {
            const oldHandler = this.clientRegistry.get(managed.connectedClientId);
            if (oldHandler) {
              // Old client is still connected
              if (!command.force) {
                this.sendResponse(id, false, undefined, 'session_owned');
                break;
              }
              // Force takeover — notify old client of displacement
              oldHandler.sendDisplacedEvent(command.sessionId);
            }
            // If old client not in registry, they disconnected — silent rebind
          }

          const replayResult = managed.eventBuffer.replay(command.lastCursor);

          if (replayResult !== null) {
            // Incremental replay — send buffered events then connection_restored
            const bufferedEventsEvent: BufferedEventsEvent = {
              type: 'buffered_events',
              sessionId: command.sessionId,
              events: replayResult,
            };
            this.sendEvent(bufferedEventsEvent);

            const connectionRestoredEvent: ConnectionRestoredEvent = {
              type: 'connection_restored',
              sessionId: command.sessionId,
            };
            this.sendEvent(connectionRestoredEvent);
          } else {
            // Cursor too old — full resync required
            const session = managed.session;
            const model = session.model;
            const state: SessionState = {
              model: model
                ? { provider: model.provider, id: model.id, name: model.name }
                : null,
              thinkingLevel: session.thinkingLevel,
              isStreaming: session.isStreaming,
              isCompacting: session.isCompacting,
              sessionFile: session.sessionFile,
              sessionId: session.sessionId,
              sessionName: session.sessionName,
              autoCompactionEnabled: session.autoCompactionEnabled,
              messageCount: session.messages.length,
            };

            const messages = mapAgentMessages(session.messages);

            const fullResyncEvent: FullResyncEvent = {
              type: 'full_resync',
              sessionId: command.sessionId,
              state,
              messages,
            };
            this.sendEvent(fullResyncEvent);
          }

          // Re-attach WebSocket and update mutable callbacks to use this WsHandler
          managed.connectedClientId = this.clientId;
          managed.lastActivity = Date.now();
          managed.sendLive = (event: PimoteSessionEvent) => { this.sendEvent(event); };
          managed.onStatusChange = this.createStatusChangeCallback();
          this.subscribedSessions.add(command.sessionId);
          // Don't overwrite viewedSessionId here — the client reconnects ALL
          // subscribed sessions in a loop, so the last one would win arbitrarily.
          // The client sends an explicit view_session after reconnect to set this.

          this.sendResponse(id, true);
          break;
        }

        case 'takeover_folder': {
          const killedCount = await killExternalPiProcesses(command.folderPath);

          // Now open a session for that folder (same logic as open_session)
          const takeoverSendLive = (event: PimoteSessionEvent): void => {
            this.sendEvent(event);
          };

          const takeoverOnStatusChange = this.createStatusChangeCallback();

          const takeoverSessionId = await this.sessionManager.openSession(
            command.folderPath,
            undefined,
            takeoverSendLive,
            takeoverOnStatusChange,
          );

          const takeoverManaged = this.sessionManager.getSession(takeoverSessionId)!;
          takeoverManaged.connectedClientId = this.clientId;
          this.subscribedSessions.add(takeoverSessionId);
          this.viewedSessionId = takeoverSessionId;

          // Bind extension UI bridge
          const takeoverWaitForResponse = (requestId: string): Promise<any> => {
            return new Promise<any>((resolve) => {
              this.pendingUiResponses.set(requestId, { resolve, sessionId: takeoverSessionId });
            });
          };

          const takeoverSendToClient = (event: PimoteEvent): void => {
            if (event.type === 'extension_ui_request' && !event.sessionId) {
              (event as any).sessionId = takeoverSessionId;
            }
            this.sendEvent(event);
          };

          const takeoverUiContext = createExtensionUIBridge(takeoverSendToClient, takeoverWaitForResponse);
          await takeoverManaged.session.bindExtensions({ uiContext: takeoverUiContext });

          // Send session_opened event
          this.sendEvent({
            type: 'session_opened',
            sessionId: takeoverSessionId,
            folder: {
              path: takeoverManaged.folderPath,
              name: takeoverManaged.folderPath.split('/').pop() ?? takeoverManaged.folderPath,
              activeSessionCount: 1,
              externalProcessCount: 0,
              activeStatus: 'idle',
            },
          });

          this.sendResponse(id, true, { sessionId: takeoverSessionId, killedProcesses: killedCount });
          break;
        }

        // ---- Extension UI ----
        case 'extension_ui_response': {
          const pending = this.pendingUiResponses.get(command.requestId);
          if (pending) {
            this.pendingUiResponses.delete(command.requestId);
            if (command.cancelled) {
              pending.resolve(undefined);
            } else if (typeof command.confirmed === 'boolean') {
              pending.resolve(command.confirmed);
            } else if (command.value !== undefined) {
              pending.resolve(command.value);
            } else {
              pending.resolve(undefined);
            }
          }
          this.sendResponse(id, true);
          break;
        }

        // ---- Multi-session & push commands ----
        case 'view_session': {
          this.viewedSessionId = command.sessionId;
          const viewedManaged = this.sessionManager.getSession(command.sessionId);
          if (viewedManaged) {
            viewedManaged.needsAttention = false;
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
            const targetManaged = this.sessionManager.getSession(targetSessionId);
            if (!targetManaged) continue;

            // Notify the owning client if still connected
            if (targetManaged.connectedClientId) {
              const ownerHandler = this.clientRegistry.get(targetManaged.connectedClientId);
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
        case 'get_commands':
        case 'set_session_name': {
          await this.handleSessionCommand(command, id);
          break;
        }

        default: {
          this.sendResponse(id, false, undefined, `Unknown command type: ${(command as any).type}`);
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

    const managed = this.sessionManager.getSession(sessionId);
    if (!managed) {
      this.sendResponse(id, false, undefined, `Session not found: ${sessionId}`);
      return;
    }

    const session = managed.session;

    switch (command.type) {
      case 'prompt': {
        session.prompt(command.message, { images: command.images as any }).catch((err) => {
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

      case 'follow_up': {
        session.followUp(command.message).catch((err) => {
          console.error(`[WsHandler] followUp error:`, err);
        });
        this.sendResponse(id, true);
        break;
      }

      case 'abort': {
        await session.abort();
        this.sendResponse(id, true);
        break;
      }

      case 'set_model': {
        const models = managed.session.modelRegistry.getAvailable();
        const model = models.find(
          (m) => m.provider === command.provider && m.id === command.modelId,
        );
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
        const models = managed.session.modelRegistry.getAvailable();
        const mapped = models.map((m) => ({
          provider: m.provider,
          id: m.id,
          name: m.name,
        }));
        this.sendResponse(id, true, { models: mapped });
        break;
      }

      case 'set_thinking_level': {
        session.setThinkingLevel(command.level as any);
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
          model: model
            ? { provider: model.provider, id: model.id, name: model.name }
            : null,
          thinkingLevel: session.thinkingLevel,
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
        this.sendResponse(id, true, { messages });
        break;
      }

      case 'new_session': {
        const success = await session.newSession();
        this.sendResponse(id, true, { success });
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
          gitBranch: getGitBranch(managed.folderPath),
          contextUsage: contextUsage
            ? { percent: contextUsage.percent, contextWindow: contextUsage.contextWindow }
            : null,
        };
        this.sendResponse(id, true, { meta });
        break;
      }

      case 'get_commands': {
        // Placeholder — will be implemented later
        this.sendResponse(id, true, { commands: [] });
        break;
      }

      case 'set_session_name': {
        session.setSessionName(command.name);
        this.sendResponse(id, true);
        break;
      }
    }
  }

  /**
   * Create a status change callback that uses this WsHandler's current state.
   * Stored on ManagedSession so it can be replaced on reconnect.
   */
  private createStatusChangeCallback(): (sid: string, status: 'idle' | 'working') => void {
    return (sid: string, status: 'idle' | 'working') => {
      if (status === 'idle') {
        const managed = this.sessionManager.getSession(sid);
        if (managed && this.viewedSessionId !== sid) {
          managed.needsAttention = true;
          const firstMessage = this.extractFirstMessage(managed);
          this.pushNotificationService.notifySessionIdle({
            projectName: managed.folderPath.split('/').pop() ?? 'Unknown',
            firstMessage,
            sessionId: sid,
          }).catch(err => console.error('[WsHandler] Push notification error:', err));
        }
      }
    };
  }

  /**
   * Extract the first user message's text from a session for push notification context.
   */
  private extractFirstMessage(managed: ManagedSession): string | undefined {
    const messages = managed.session.messages ?? [];
    for (const msg of messages) {
      if ((msg as any).role !== 'user') continue;
      const content = (msg as any).content;
      if (typeof content === 'string') return content.slice(0, 100);
      if (Array.isArray(content)) {
        const textItem = content.find((c: any) => c.type === 'text');
        if (textItem?.text) return textItem.text.slice(0, 100);
      }
      break;
    }
    return undefined;
  }

  /** Send a session_closed event with reason 'displaced' to this client's WebSocket */
  sendDisplacedEvent(sessionId: string): void {
    this.sendEvent({
      type: 'session_closed',
      sessionId,
      reason: 'displaced',
    });
  }

  /** Send a session_closed event with reason 'killed' to this client's WebSocket */
  sendKilledEvent(sessionId: string): void {
    this.sendEvent({
      type: 'session_closed',
      sessionId,
      reason: 'killed',
    });
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

  cleanup(): void {
    for (const sid of this.subscribedSessions) {
      const managed = this.sessionManager.getSession(sid);
      if (managed) {
        managed.connectedClientId = null;
        managed.sendLive = () => {};
        managed.onStatusChange = null;
        managed.lastActivity = Date.now();
      }
    }
    this.subscribedSessions.clear();
    this.viewedSessionId = null;

    // Resolve all pending UI responses with undefined
    for (const [, pending] of this.pendingUiResponses) {
      pending.resolve(undefined);
    }
    this.pendingUiResponses.clear();
  }
}
