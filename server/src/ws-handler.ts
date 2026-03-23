import type { WebSocket } from 'ws';
import type {
  PimoteCommand,
  PimoteResponse,
  PimoteEvent,
  PimoteSessionEvent,
  PimoteAgentMessage,
  PimoteMessageContent,
  SessionState,
} from '@pimote/shared';
import type { PimoteSessionManager, ManagedSession } from './session-manager.js';
import type { FolderIndex } from './folder-index.js';
import { createExtensionUIBridge } from './extension-ui-bridge.js';

export class WsHandler {
  private readonly pendingUiResponses = new Map<string, { resolve: (value: any) => void }>();
  private activeSessionId: string | null = null;

  constructor(
    private readonly sessionManager: PimoteSessionManager,
    private readonly folderIndex: FolderIndex,
    private readonly ws: WebSocket,
  ) {}

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
            folder.hasActiveSessions = activeSessions.some(
              (s) => s.folderPath === folder.path,
            );
          }
          this.sendResponse(id, true, { folders });
          break;
        }

        case 'list_sessions': {
          const sessions = await this.folderIndex.listSessions(command.folderPath);
          this.sendResponse(id, true, { sessions });
          break;
        }

        case 'open_session': {
          const sendLive = (event: PimoteSessionEvent): void => {
            this.sendEvent(event);
          };

          const sessionId = await this.sessionManager.openSession(
            command.folderPath,
            command.sessionPath,
            sendLive,
          );

          const managed = this.sessionManager.getSession(sessionId)!;
          managed.connectedClient = this.ws;
          this.activeSessionId = sessionId;

          // Bind extension UI bridge
          const waitForResponse = (requestId: string): Promise<any> => {
            return new Promise<any>((resolve) => {
              this.pendingUiResponses.set(requestId, { resolve });
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
            folder: {
              path: managed.folderPath,
              name: managed.folderPath.split('/').pop() ?? managed.folderPath,
              hasActiveSessions: true,
            },
          });

          this.sendResponse(id, true, { sessionId });
          break;
        }

        case 'close_session': {
          const sessionId = command.sessionId ?? this.activeSessionId;
          if (!sessionId) {
            this.sendResponse(id, false, undefined, 'No active session');
            break;
          }

          await this.sessionManager.closeSession(sessionId);

          if (this.activeSessionId === sessionId) {
            this.activeSessionId = null;
          }

          this.sendEvent({
            type: 'session_closed',
            sessionId,
          });

          this.sendResponse(id, true);
          break;
        }

        case 'reconnect': {
          this.sendResponse(id, false, undefined, 'Reconnect not yet implemented');
          break;
        }

        case 'takeover_folder': {
          this.sendResponse(id, false, undefined, 'Takeover not yet implemented');
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
    const sessionId = command.sessionId ?? this.activeSessionId;
    if (!sessionId) {
      this.sendResponse(id, false, undefined, 'No active session');
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
    if (this.activeSessionId) {
      const managed = this.sessionManager.getSession(this.activeSessionId);
      if (managed) {
        managed.connectedClient = null;
        managed.lastActivity = Date.now();
      }
    }

    // Resolve all pending UI responses with undefined
    for (const [, pending] of this.pendingUiResponses) {
      pending.resolve(undefined);
    }
    this.pendingUiResponses.clear();

    this.activeSessionId = null;
  }
}

/**
 * Map pi SDK AgentMessage[] to PimoteAgentMessage[] for wire transfer.
 */
function mapAgentMessages(messages: any[]): PimoteAgentMessage[] {
  return messages.map((msg) => {
    const role = msg.role ?? 'unknown';
    const content: PimoteMessageContent[] = [];

    if (typeof msg.content === 'string') {
      content.push({ type: 'text', text: msg.content });
    } else if (Array.isArray(msg.content)) {
      for (const item of msg.content) {
        switch (item.type) {
          case 'text':
            content.push({ type: 'text', text: item.text ?? '' });
            break;
          case 'thinking':
            content.push({ type: 'thinking', text: item.thinking ?? '' });
            break;
          case 'toolCall':
            content.push({
              type: 'tool_call',
              toolCallId: item.id,
              toolName: item.name,
              args: item.arguments,
            });
            break;
          case 'image':
            // Images in user messages — map as text placeholder
            content.push({ type: 'text', text: '[image]' });
            break;
          default:
            // Unknown content type — pass through as text
            content.push({ type: 'text', text: item.text ?? JSON.stringify(item) });
            break;
        }
      }
    }

    // Handle tool result messages
    if (role === 'toolResult') {
      const resultContent: PimoteMessageContent[] = [];
      if (Array.isArray(msg.content)) {
        for (const item of msg.content) {
          if (item.type === 'text') {
            resultContent.push({ type: 'text', text: item.text ?? '' });
          }
        }
      }
      return {
        role,
        content: [{
          type: 'tool_result' as const,
          toolCallId: msg.toolCallId,
          toolName: msg.toolName,
          result: resultContent.length > 0 ? resultContent[0].text : undefined,
        }],
      };
    }

    return { role, content };
  });
}
