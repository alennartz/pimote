// SessionStore — manages the active session's reactive state.
// Svelte 5 runes-based singleton.

import type { PimoteEvent, PimoteAgentMessage, SessionState } from '@pimote/shared';
import { connection } from './connection.svelte.js';

class SessionStore {
  messages: PimoteAgentMessage[] = $state([]);
  isStreaming: boolean = $state(false);
  isCompacting: boolean = $state(false);
  model: { provider: string; id: string; name: string } | null = $state(null);
  thinkingLevel: string = $state('off');
  sessionId: string | null = $state(null);
  sessionName: string | null = $state(null);
  streamingText: string = $state('');
  streamingThinking: string = $state('');
  activeToolCalls = $state(
    new Map<string, { name: string; args: unknown; partialResult: string }>()
  );
  autoCompactionEnabled: boolean = $state(false);
  messageCount: number = $state(0);

  handleEvent(event: PimoteEvent) {
    switch (event.type) {
      case 'session_opened': {
        this.sessionId = event.sessionId;
        // Request initial state and message history
        connection.send({ type: 'get_state', sessionId: event.sessionId }).then((res) => {
          if (res.success && res.data) {
            this.applyState((res.data as any).state as SessionState);
          }
        });
        connection.send({ type: 'get_messages', sessionId: event.sessionId }).then((res) => {
          if (res.success && res.data) {
            this.messages = (res.data as any).messages as PimoteAgentMessage[];
          }
        });
        break;
      }

      case 'agent_start': {
        this.isStreaming = true;
        break;
      }

      case 'agent_end': {
        this.isStreaming = false;
        break;
      }

      case 'message_start': {
        // Could track role for current streaming message; no state change needed
        break;
      }

      case 'message_update': {
        if (event.content.type === 'thinking') {
          this.streamingThinking += event.content.text;
        } else {
          this.streamingText += event.content.text;
        }
        break;
      }

      case 'message_end': {
        this.messages = [...this.messages, event.message];
        this.streamingText = '';
        this.streamingThinking = '';
        this.messageCount = this.messages.length;
        break;
      }

      case 'tool_execution_start': {
        const updated = new Map(this.activeToolCalls);
        updated.set(event.toolCallId, {
          name: event.toolName,
          args: event.args,
          partialResult: ''
        });
        this.activeToolCalls = updated;
        break;
      }

      case 'tool_execution_update': {
        const current = this.activeToolCalls.get(event.toolCallId);
        if (current) {
          const updated = new Map(this.activeToolCalls);
          updated.set(event.toolCallId, {
            ...current,
            partialResult: current.partialResult + event.content
          });
          this.activeToolCalls = updated;
        }
        break;
      }

      case 'tool_execution_end': {
        const updated = new Map(this.activeToolCalls);
        updated.delete(event.toolCallId);
        this.activeToolCalls = updated;
        break;
      }

      case 'turn_start':
      case 'turn_end': {
        // Lifecycle markers — no additional state changes needed
        break;
      }

      case 'auto_compaction_start': {
        this.isCompacting = true;
        break;
      }

      case 'auto_compaction_end': {
        this.isCompacting = false;
        break;
      }

      case 'buffered_events': {
        for (const e of event.events) {
          this.handleEvent(e);
        }
        break;
      }

      case 'full_resync': {
        this.applyState(event.state);
        this.messages = event.messages;
        this.messageCount = event.messages.length;
        break;
      }

      case 'session_closed': {
        this.reset();
        break;
      }

      case 'auto_retry_start':
      case 'auto_retry_end':
      case 'extension_error':
      case 'extension_ui_request':
      case 'connection_restored': {
        // Handled elsewhere or informational — no session state change
        break;
      }
    }
  }

  applyState(state: SessionState) {
    this.model = state.model;
    this.thinkingLevel = state.thinkingLevel;
    this.isStreaming = state.isStreaming;
    this.isCompacting = state.isCompacting;
    this.sessionId = state.sessionId;
    this.sessionName = state.sessionName ?? null;
    this.autoCompactionEnabled = state.autoCompactionEnabled;
    this.messageCount = state.messageCount;
  }

  reset() {
    this.messages = [];
    this.isStreaming = false;
    this.isCompacting = false;
    this.model = null;
    this.thinkingLevel = 'off';
    this.sessionId = null;
    this.sessionName = null;
    this.streamingText = '';
    this.streamingThinking = '';
    this.activeToolCalls = new Map();
    this.autoCompactionEnabled = false;
    this.messageCount = 0;
  }
}

export const sessionStore = new SessionStore();
