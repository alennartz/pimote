import { describe, expect, it, vi } from 'vitest';
import { createSessionResumeExtension, SESSION_IDLE_MARKER, SESSION_RESUME_MESSAGE } from './session-resume.js';

type Handler = (event: unknown, ctx: unknown) => void | Promise<void>;

const abortedTurn = {
  type: 'message',
  message: { role: 'assistant', content: [], stopReason: 'aborted' },
};

/**
 * A session whose transcript is the fake branch: `appendEntry` grows it the
 * way pi persists custom entries, so a test can see what a later load sees.
 */
function createSession(branch: unknown[], options: { sessionFile?: string | null; isRuntimeTeardown?: () => boolean } = {}) {
  const handlers = new Map<string, Handler>();
  const appendEntry = vi.fn((customType: string, data?: unknown) => {
    branch.push({ type: 'custom', customType, data });
  });
  const sendMessage = vi.fn();
  const pi = {
    on: (event: string, handler: Handler) => handlers.set(event, handler),
    appendEntry,
    sendMessage,
  };
  const ctx = {
    sessionManager: {
      getSessionFile: () => (options.sessionFile === undefined ? '/tmp/session.jsonl' : options.sessionFile),
      getEntries: () => branch,
      getBranch: () => branch,
    },
  };
  createSessionResumeExtension({ isRuntimeTeardown: options.isRuntimeTeardown ?? (() => false) })(pi as never);

  return {
    appendEntry,
    sendMessage,
    endTurn: () => handlers.get('agent_end')!({}, ctx),
    startSession: () => handlers.get('session_start')!({ type: 'session_start', reason: 'resume' }, ctx),
  };
}

describe('session resume', () => {
  it('marks a finished turn so the next load stays put', async () => {
    const session = createSession([]);

    await session.endTurn();

    expect(session.appendEntry).toHaveBeenCalledWith(SESSION_IDLE_MARKER, { at: expect.any(String) });
    await session.startSession();
    expect(session.sendMessage).not.toHaveBeenCalled();
  });

  it('leaves a turn pimote aborted during teardown resumable', async () => {
    const branch: unknown[] = [{ type: 'message', message: { role: 'user', content: 'run the tests' } }];
    const session = createSession(branch, { isRuntimeTeardown: () => true });

    // pi records the abort and ends the run while the server is going down.
    branch.push(abortedTurn);
    await session.endTurn();
    expect(session.appendEntry).not.toHaveBeenCalled();

    // The next server start reloads this transcript.
    await session.startSession();
    expect(session.sendMessage).toHaveBeenCalledWith({ customType: SESSION_RESUME_MESSAGE, content: '[session resumed]', display: false }, { triggerTurn: true });
  });

  it('resumes a session whose last turn never finished', async () => {
    const session = createSession([
      { type: 'custom', customType: SESSION_IDLE_MARKER, data: { at: '2026-11-16T21:36:23.896Z' } },
      { type: 'message', message: { role: 'user', content: 'continue' } },
    ]);

    await session.startSession();

    expect(session.sendMessage).toHaveBeenCalledTimes(1);
  });

  it.each([
    { prefix: '!', excludeFromContext: false },
    { prefix: '!!', excludeFromContext: true },
  ])('does not resume after an interrupted user bash command (%s)', async ({ excludeFromContext }) => {
    const session = createSession([
      { type: 'custom', customType: SESSION_IDLE_MARKER, data: { at: '2026-11-16T21:36:23.896Z' } },
      {
        type: 'message',
        message: { role: 'bashExecution', command: 'sleep 30', output: '', cancelled: true, excludeFromContext },
      },
    ]);

    await session.startSession();

    expect(session.sendMessage).not.toHaveBeenCalled();
  });

  it.each([
    { label: 'a session without a transcript file', sessionFile: null, branch: [] },
    { label: 'a session with no entries yet', sessionFile: '/tmp/session.jsonl', branch: [] },
  ])('does not resume $label', async ({ sessionFile, branch }) => {
    const session = createSession(branch, { sessionFile });

    await session.startSession();

    expect(session.sendMessage).not.toHaveBeenCalled();
  });
});
