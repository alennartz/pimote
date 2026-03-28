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
      // Request initial state and messages
      connection.send({ type: 'get_state', sessionId: event.sessionId }).then((res) => {
        if (res.success && res.data) {
          const state = (res.data as any).state;
          // Apply state to the session in registry
          sessionRegistry.handleEvent({
            type: 'full_resync',
            sessionId: event.sessionId,
            state,
            messages: [], // Messages fetched separately
          });
        }
      });
      connection.send({ type: 'get_messages', sessionId: event.sessionId }).then((res) => {
        if (res.success && res.data) {
          const messages = (res.data as any).messages;
          const session = sessionRegistry.sessions.get(event.sessionId);
          if (session) {
            session.messages = messages;
            session.messageCount = messages.length;
          }
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
