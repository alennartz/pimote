import type { WebSocket } from 'ws';
import { execFileSync } from 'node:child_process';
import type {
  PimoteCommand,
  PimoteResponse,
  PimoteEvent,
  SessionState,
  SessionMeta,
  BufferedEventsEvent,
  ConnectionRestoredEvent,
  FullResyncEvent,
  SessionStateChangedEvent,
} from '@pimote/shared';
import type { PimoteSessionManager, ManagedSession } from './session-manager.js';
import { resolveAllManagedPendingUi, resolveManagedPendingUi, replayManagedPendingUiRequests } from './session-manager.js';
import type { FolderIndex } from './folder-index.js';
import { createExtensionUIBridge } from './extension-ui-bridge.js';
import { findExternalPiProcesses, killExternalPiProcesses } from './takeover.js';
import type { PushNotificationService } from './push-notification.js';
import { mapAgentMessages } from './message-mapper.js';
import type { AgentSession, ExtensionCommandContextActions, PromptOptions } from '@mariozechner/pi-coding-agent';

/**
 * Create command context actions for extension commands.
 * Captures the ManagedSession (stable lifetime), not a transient handler.
 * Session resets are routed through managed.onSessionReset which the
 * current handler sets on claim and clears on cleanup.
 */
function createCommandContextActions(managed: ManagedSession): ExtensionCommandContextActions {
  const session = managed.session;
  return {
    waitForIdle: () => {
      if (!session.isStreaming) return Promise.resolve();
      return new Promise<void>((resolve) => {
        const unsubscribe = session.subscribe((event) => {
          if (event.type === 'agent_end') {
            unsubscribe();
            resolve();
          }
        });
      });
    },
    newSession: async (options) => {
      const result = await session.newSession(options);
      if (result) await managed.onSessionReset?.(managed);
      return { cancelled: !result };
    },
    fork: async (entryId) => {
      const result = await session.fork(entryId);
      if (!result.cancelled) await managed.onSessionReset?.(managed);
      return { cancelled: result.cancelled };
    },
    navigateTree: async (targetId, options) => {
      const result = await session.navigateTree(targetId, options);
      if (!result.cancelled) await managed.onSessionReset?.(managed);
      return { cancelled: result.cancelled };
    },
    switchSession: async (sessionPath) => {
      const result = await session.switchSession(sessionPath);
      if (result) await managed.onSessionReset?.(managed);
      return { cancelled: !result };
    },
    reload: () => session.reload(),
  };
}

/** Resolve the current git branch for a directory. Returns null if not a git repo. */
function getGitBranch(cwd: string): string | null {
  try {
    return (
      execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], {
        cwd,
        encoding: 'utf-8',
        timeout: 2000,
        stdio: ['ignore', 'pipe', 'ignore'],
      }).trim() || null
    );
  } catch {
    return null;
  }
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
            const folderSessions = activeSessions.filter((s) => s.folderPath === folder.path);
            folder.activeSessionCount = folderSessions.length;
            if (folderSessions.some((s) => s.status === 'working')) {
              folder.activeStatus = 'working';
            } else if (folderSessions.some((s) => s.needsAttention)) {
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

          // Build lookup from session ID to managed session for ownership enrichment
          const activeSessions = this.sessionManager.getAllSessions();
          const managedById = new Map<string, ManagedSession>();
          for (const ms of activeSessions) {
            managedById.set(ms.id, ms);
          }

          // Enrich each session with ownership and live status
          const enriched = sessions.map((s) => {
            const ms = managedById.get(s.id);
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
          // Check if this session is already loaded in memory (only when resuming by ID)
          if (command.sessionId) {
            const existing = this.sessionManager.getSession(command.sessionId);
            if (existing) {
              // Session already loaded — check ownership
              if (existing.connectedClientId && existing.connectedClientId !== this.clientId) {
                const oldHandler = this.clientRegistry.get(existing.connectedClientId);
                if (oldHandler && !command.force) {
                  // Another live client owns it — ask user to confirm takeover
                  this.sendResponse(id, false, undefined, 'session_owned');
                  break;
                }
                // Force takeover or old client disconnected — displace and reclaim
                this.displaceOwner(command.sessionId, existing);
              }

              // Reclaim the existing managed session
              await this.claimSession(command.sessionId, existing);
              this.viewedSessionId = command.sessionId;

              this.sendEvent({
                type: 'session_opened',
                sessionId: command.sessionId,
                folder: {
                  path: existing.folderPath,
                  name: existing.folderPath.split('/').pop() ?? existing.folderPath,
                  activeSessionCount: 1,
                  externalProcessCount: 0,
                  activeStatus: 'idle',
                },
              });

              WsHandler.broadcastSidebarUpdate(command.sessionId, existing.folderPath, this.sessionManager, this.clientRegistry);
              this.sendResponse(id, true, { sessionId: command.sessionId });
              break;
            }
          }

          // Session not loaded — resolve ID to file path and create a new managed session
          let sessionFilePath: string | undefined;
          if (command.sessionId) {
            sessionFilePath = await this.folderIndex.resolveSessionPath(command.folderPath, command.sessionId);
            if (!sessionFilePath) {
              this.sendResponse(id, false, undefined, `Session not found: ${command.sessionId}`);
              break;
            }
          }

          const sessionId = await this.sessionManager.openSession(command.folderPath, sessionFilePath);

          const managed = this.sessionManager.getSession(sessionId)!;
          await this.claimSession(sessionId, managed);
          this.viewedSessionId = sessionId;

          // Send session_opened event
          this.sendEvent({
            type: 'session_opened',
            sessionId,
            folder: {
              path: managed.folderPath,
              name: managed.folderPath.split('/').pop() ?? managed.folderPath,
              activeSessionCount: 1,
              externalProcessCount: 0,
              activeStatus: 'idle',
            },
          });

          WsHandler.broadcastSidebarUpdate(sessionId, managed.folderPath, this.sessionManager, this.clientRegistry);

          // Check for conflicting external pi processes and remote pimote sessions
          const openConflictPids = await findExternalPiProcesses(command.folderPath);
          const allSessions = this.sessionManager.getAllSessions();
          const remoteSessions = allSessions
            .filter((s) => s.folderPath === command.folderPath && s.connectedClientId !== null && s.connectedClientId !== this.clientId && s.id !== sessionId)
            .map((s) => ({ sessionId: s.id, status: s.status }));

          if (openConflictPids.length > 0 || remoteSessions.length > 0) {
            this.sendEvent({
              type: 'session_conflict',
              sessionId,
              processes: openConflictPids.map((pid) => ({ pid, command: 'pi' })),
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

          // Resolve pending extension UI responses so tools don't hang
          const closingManaged = this.sessionManager.getSession(closeSessionId);
          if (closingManaged) {
            resolveAllManagedPendingUi(closingManaged);
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

          // Ownership check: different client owns this session?
          if (managed.connectedClientId && managed.connectedClientId !== this.clientId) {
            const oldHandler = this.clientRegistry.get(managed.connectedClientId);
            if (oldHandler) {
              // Another live client owns it — reject (use open_session with force to takeover)
              this.sendResponse(id, false, undefined, 'session_owned');
              break;
            }
            // Old client no longer connected — silent rebind
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
            this.sendFullResyncForSession(command.sessionId, managed);
          }

          // Capture the buffer cursor before claimSession. Events emitted between
          // the replay above and claimSession restoring sendLive (e.g. from a
          // pending select resolved by cleanup) are buffered but missed both the
          // replay and the live path. A catch-up replay after claim closes this gap.
          const cursorBeforeClaim = managed.eventBuffer.currentCursor;

          // Claim session — rebinds ownership, sendLive, and extension UI bridge
          await this.claimSession(command.sessionId, managed);

          // Catch-up: replay any events that were buffered between the initial
          // replay and the completion of claimSession (sendLive restoration).
          if (replayResult !== null) {
            const catchUp = managed.eventBuffer.replay(cursorBeforeClaim);
            if (catchUp && catchUp.length > 0) {
              this.sendEvent({
                type: 'buffered_events',
                sessionId: command.sessionId,
                events: catchUp,
              } as BufferedEventsEvent);
            }
          }

          // Don't overwrite viewedSessionId here — the client reconnects ALL
          // subscribed sessions in a loop, so the last one would win arbitrarily.
          // The client sends an explicit view_session after reconnect to set this.

          WsHandler.broadcastSidebarUpdate(command.sessionId, managed.folderPath, this.sessionManager, this.clientRegistry);
          this.sendResponse(id, true, { folderPath: managed.folderPath });
          break;
        }

        case 'takeover_folder': {
          const killedCount = await killExternalPiProcesses(command.folderPath);

          const takeoverSessionId = await this.sessionManager.openSession(command.folderPath);

          const takeoverManaged = this.sessionManager.getSession(takeoverSessionId)!;
          await this.claimSession(takeoverSessionId, takeoverManaged);
          this.viewedSessionId = takeoverSessionId;

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

          WsHandler.broadcastSidebarUpdate(takeoverSessionId, takeoverManaged.folderPath, this.sessionManager, this.clientRegistry);
          this.sendResponse(id, true, { sessionId: takeoverSessionId, killedProcesses: killedCount });
          break;
        }

        // ---- Extension UI ----
        case 'extension_ui_response': {
          const uiManaged = command.sessionId ? this.sessionManager.getSession(command.sessionId) : undefined;
          if (uiManaged) {
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
            resolveManagedPendingUi(uiManaged, command.requestId, value);
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
        case 'get_session_meta':
        case 'get_commands':
        case 'complete_args':
        case 'set_session_name':
        case 'dequeue_steering': {
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

    const managed = this.sessionManager.getSession(sessionId);
    if (!managed) {
      this.sendResponse(id, false, undefined, `Session not found: ${sessionId}`);
      return;
    }

    const session = managed.session;

    switch (command.type) {
      case 'prompt': {
        session.prompt(command.message, { images: command.images as unknown as PromptOptions['images'] }).catch((err) => {
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
        resolveAllManagedPendingUi(managed);
        await session.abort();
        this.sendResponse(id, true);
        break;
      }

      case 'set_model': {
        const models = managed.session.modelRegistry.getAvailable();
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
        const items = cmd.getArgumentCompletions(command.prefix);
        this.sendResponse(id, true, { items: items ?? null });
        break;
      }

      case 'set_session_name': {
        session.setSessionName(command.name);
        this.sendResponse(id, true);
        break;
      }
    }
  }

  /** Notify the old owner that they've been displaced from a session.
   *  No-op if the session is unowned or owned by this client. */
  private displaceOwner(sessionId: string, managed: ManagedSession): void {
    if (managed.connectedClientId && managed.connectedClientId !== this.clientId) {
      const oldHandler = this.clientRegistry.get(managed.connectedClientId);
      if (oldHandler) {
        oldHandler.sendDisplacedEvent(sessionId);
      }
    }
  }

  /** Bind a managed session to this client — sets ownership, WebSocket routing,
   *  and subscribes to events. Extensions are bound once on first claim. */
  private async claimSession(sessionId: string, managed: ManagedSession): Promise<void> {
    managed.connectedClientId = this.clientId;
    managed.lastActivity = Date.now();
    managed.ws = this.ws;
    managed.onSessionReset = (m) => this.handleSessionReset(m);
    this.subscribedSessions.add(sessionId);

    // Bind extensions once — the bridge references the ManagedSession (stable),
    // not the handler (transient), so it doesn't need to be recreated on reconnect.
    if (!managed.extensionsBound) {
      const uiContext = createExtensionUIBridge(managed);
      const commandContextActions = createCommandContextActions(managed);
      await managed.session.bindExtensions({ uiContext, commandContextActions });
      managed.extensionsBound = true;
    }

    // Re-deliver any pending UI requests to the new client (recovers lost dialogs)
    replayManagedPendingUiRequests(managed);
  }

  /** Handle a session reset (newSession, fork, switchSession).
   *  Called via managed.onSessionReset — receives the managed session directly. */
  private async handleSessionReset(oldManaged: ManagedSession): Promise<void> {
    const newSessionId = oldManaged.session.sessionId;
    const oldSessionId = oldManaged.id;

    // navigateTree stays in the same file — same session ID, just resync
    if (newSessionId === oldSessionId) {
      this.sendFullResyncForSession(oldSessionId, oldManaged);
      return;
    }

    // Session ID changed — detach old managed session, adopt as new
    const folderPath = oldManaged.folderPath;
    this.sessionManager.detachSession(oldSessionId);
    this.sessionManager.adoptSession(oldManaged.session, folderPath);

    const newManaged = this.sessionManager.getSession(newSessionId)!;

    // Update handler bookkeeping
    this.subscribedSessions.delete(oldSessionId);
    if (this.viewedSessionId === oldSessionId) {
      this.viewedSessionId = newSessionId;
    }

    // Resolve pending UI responses for the old session
    resolveAllManagedPendingUi(oldManaged);

    // Claim the new managed session (sets ownership, routes WebSocket)
    await this.claimSession(newSessionId, newManaged);

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

  /** Send a full_resync event to the client for the given managed session.
   *  Used when the underlying pi session is reset (newSession, switchSession, fork, navigateTree). */
  private sendFullResyncForSession(pimoteSessionId: string, managed: ManagedSession): void {
    const session = managed.session;
    const model = session.model;
    const state: SessionState = {
      model: model ? { provider: model.provider, id: model.id, name: model.name } : null,
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
      sessionId: pimoteSessionId,
      state,
      messages,
    };
    this.sendEvent(fullResyncEvent);
  }

  /** Send an event to this client (public for broadcast use). */
  sendToClient(event: PimoteEvent): void {
    this.sendEvent(event);
  }

  /** Broadcast a session_state_changed event to ALL connected clients. */
  static broadcastSidebarUpdate(sessionId: string, folderPath: string, sessionManager: PimoteSessionManager, clientRegistry: ClientRegistry): void {
    const managed = sessionManager.getSession(sessionId);

    // Compute folder aggregates (same logic as list_folders handler)
    const folderSessions = sessionManager.getAllSessions().filter((s) => s.folderPath === folderPath);
    const folderActiveSessionCount = folderSessions.length;
    let folderActiveStatus: 'working' | 'idle' | 'attention' | null = null;
    if (folderSessions.some((s) => s.status === 'working')) {
      folderActiveStatus = 'working';
    } else if (folderSessions.some((s) => s.needsAttention)) {
      folderActiveStatus = 'attention';
    } else if (folderSessions.length > 0) {
      folderActiveStatus = 'idle';
    }

    const event: SessionStateChangedEvent = {
      type: 'session_state_changed',
      sessionId,
      folderPath,
      liveStatus: managed ? managed.status : null,
      connectedClientId: managed ? managed.connectedClientId : null,
      folderActiveSessionCount,
      folderActiveStatus,
    };

    for (const [, handler] of clientRegistry) {
      handler.sendToClient(event);
    }
  }

  cleanup(): void {
    for (const sid of this.subscribedSessions) {
      const managed = this.sessionManager.getSession(sid);
      if (managed) {
        managed.connectedClientId = null;
        managed.ws = null;
        managed.onSessionReset = null;
        managed.lastActivity = Date.now();
        // Note: pending UI responses are NOT resolved here — they survive
        // for replay on reconnect. They are resolved on session close or abort.
      }
    }
    this.subscribedSessions.clear();
    this.viewedSessionId = null;
  }
}
