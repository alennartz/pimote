import { afterEach, expect, it, vi } from 'vitest';
import { connection } from './connection.svelte.js';
import { sessionRegistry } from './session-registry.svelte.js';

afterEach(() => {
  vi.restoreAllMocks();
  sessionRegistry.removeSession('race-investigation');
});

it('preserves a newer idle event when a reconnect snapshot finishes later', async () => {
  const sessionId = 'race-investigation';
  sessionRegistry.addSession(sessionId, '/repo', 'repo');
  sessionRegistry.handleEvent({ type: 'agent_start', sessionId, cursor: 1 } as never);
  sessionRegistry.startBash(sessionId, { id: 'pending-bash', command: 'pwd', excludeFromContext: false });
  let releaseState!: () => void;
  vi.spyOn(connection, 'send').mockImplementation(async (command) => {
    if (command.type === 'get_state') {
      await new Promise<void>((resolve) => {
        releaseState = resolve;
      });
      return {
        id: 'state',
        success: true,
        data: { state: { model: null, thinkingLevel: 'off', isStreaming: true, isCompacting: false, autoCompactionEnabled: false, messageCount: 0 } },
      };
    }
    if (command.type === 'get_messages') return { id: 'messages', success: true, data: { messages: [] } };
    if (command.type === 'get_commands') return { id: 'commands', success: true, data: { commands: [] } };
    return { id: 'other', success: true };
  });
  connection.onReconnected!();
  await Promise.resolve();
  sessionRegistry.handleEvent({ type: 'agent_end', sessionId, cursor: 2 } as never);
  sessionRegistry.handleEvent({ type: 'agent_settled', sessionId, cursor: 3 } as never);
  expect(sessionRegistry.sessions[sessionId].isStreaming).toBe(false);
  releaseState();
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(sessionRegistry.sessions[sessionId].isStreaming).toBe(false);
  expect(sessionRegistry.sessions[sessionId].status).toBe('idle');
});
