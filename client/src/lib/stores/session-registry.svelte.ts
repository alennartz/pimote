import { SessionRegistry } from './session-registry.js';
import { connection } from './connection.svelte.js';

// Create a reactive singleton wrapped in $state for deep reactivity
export const sessionRegistry = $state(new SessionRegistry());

// Subscribe to connection events and route to the registry
connection.onEvent((event) => {
  switch (event.type) {
    case 'session_opened': {
      const folder = (event as any).folder;
      const projectName = folder?.name ?? 'Unknown';
      sessionRegistry.addSession(event.sessionId, folder?.path ?? '', projectName);
      connection.addSubscribedSession(event.sessionId);
      sessionRegistry.switchTo(event.sessionId);
      // Request initial state and messages atomically to avoid race conditions
      Promise.all([
        connection.send({ type: 'get_state', sessionId: event.sessionId }),
        connection.send({ type: 'get_messages', sessionId: event.sessionId }),
      ]).then(([stateRes, msgRes]) => {
        const session = sessionRegistry.sessions.get(event.sessionId);
        if (!session) return;
        if (stateRes.success && stateRes.data) {
          const state = (stateRes.data as any).state;
          session.model = state.model;
          session.thinkingLevel = state.thinkingLevel;
          session.isStreaming = state.isStreaming;
          session.isCompacting = state.isCompacting;
          session.autoCompactionEnabled = state.autoCompactionEnabled;
          session.messageCount = state.messageCount;
          session.status = state.isStreaming ? 'working' : 'idle';
        }
        if (msgRes.success && msgRes.data) {
          const messages = (msgRes.data as any).messages;
          session.messages = messages;
          session.messageCount = messages.length;
        }
      });
      break;
    }
    case 'session_closed': {
      sessionRegistry.removeSession(event.sessionId);
      connection.removeSubscribedSession(event.sessionId);
      break;
    }
    default: {
      // Route all other events with sessionId to the registry
      if ('sessionId' in event) {
        sessionRegistry.handleEvent(event);
      }
      break;
    }
  }
});

// Helper that also sends view_session to server
export function switchToSession(sessionId: string): void {
  sessionRegistry.switchTo(sessionId);
  connection.send({ type: 'view_session', sessionId }).catch(() => {});
}
