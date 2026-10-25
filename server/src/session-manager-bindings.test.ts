import { describe, expect, it, vi, beforeEach } from 'vitest';
import type { CreateAgentSessionRuntimeFactory } from '@earendil-works/pi-coding-agent';
import type { PimoteConfig } from './config.js';
import type { PushNotificationService } from './push-notification.js';

const harness = vi.hoisted(() => {
  const sessions: any[] = [];
  const runtimes: any[] = [];
  const bindCalls: any[] = [];
  let sequence = 0;
  let nextSessionId: string | undefined;
  let nextBind: (() => Promise<void>) | undefined;
  let nextBindAction: ((bindings: any) => Promise<void>) | undefined;

  const makeSession = (sessionId: string, sessionManager: any): any => {
    const session: any = {
      sessionId,
      sessionFile: sessionManager.getSessionFile?.() ?? `/tmp/${sessionId}.jsonl`,
      isStreaming: false,
      messages: [],
      model: undefined,
      thinkingLevel: 'default',
      autoCompactionEnabled: true,
      getAvailableThinkingLevels: () => ['default'],
      sessionManager,
      subscribe: vi.fn(() => () => {}),
      setSteeringMode: vi.fn(),
      setFollowUpMode: vi.fn(),
      waitForIdle: vi.fn(async () => {}),
      reload: vi.fn(async () => {}),
      bindExtensions: vi.fn(async (bindings: unknown) => {
        bindCalls.push({ session, bindings });
        if (nextBind) {
          const gate = nextBind;
          nextBind = undefined;
          await gate();
        }
        if (nextBindAction) {
          const action = nextBindAction;
          nextBindAction = undefined;
          await action(bindings);
        }
      }),
      createReplacedSessionContext: () => ({ session }),
    };
    sessions.push(session);
    return session;
  };

  return {
    sessions,
    runtimes,
    bindCalls,
    makeSession,
    modelRuntime: { getAvailable: vi.fn(async () => []) },
    modelRuntimeCreate: vi.fn(async () => ({ getAvailable: vi.fn(async () => []) })),
    nextSessionId: (id?: string) => {
      nextSessionId = id;
    },
    gateNextBind: (gate: () => Promise<void>) => {
      nextBind = gate;
    },
    runNextBindAction: (action: (bindings: any) => Promise<void>) => {
      nextBindAction = action;
    },
    clearPending: () => {
      nextBind = undefined;
      nextBindAction = undefined;
    },
    createAgentSessionRuntime: vi.fn(async (factory: CreateAgentSessionRuntimeFactory, options: any) => {
      const created = await factory({ ...options, agentDir: '/agent', sessionStartEvent: { type: 'session_start', reason: 'startup' } });
      const runtime: any = {
        session: created.session,
        services: created.services,
        dispose: vi.fn(async () => {}),
        setBeforeSessionInvalidate: vi.fn((callback: () => void) => {
          runtime.beforeSessionInvalidate = callback;
        }),
        beforeSessionInvalidate: undefined,
        beforeReplacementAction: undefined,
        failNextSession: undefined,
        setRebindSession: vi.fn((callback: () => Promise<void>) => {
          runtime.rebind = callback;
        }),
        rebind: undefined,
        newSession: vi.fn(async (replacementOptions?: { withSession?: (ctx: unknown) => Promise<void> }) => {
          runtime.beforeSessionInvalidate?.();
          await runtime.beforeReplacementAction?.();
          if (runtime.failNextSession) {
            const failure = runtime.failNextSession;
            runtime.failNextSession = undefined;
            throw failure;
          }
          const id = nextSessionId ?? `session-${++sequence}`;
          nextSessionId = undefined;
          runtime.session = makeSession(id, options.sessionManager);
          await runtime.rebind?.();
          await replacementOptions?.withSession?.(runtime.session.createReplacedSessionContext());
          return { cancelled: false };
        }),
      };
      runtimes.push(runtime);
      return runtime;
    }),
    createAgentSessionServices: vi.fn(async (args: any) => ({ ...args, diagnostics: [] })),
    createAgentSessionFromServices: vi.fn(async ({ sessionManager }: any) => ({ session: makeSession(nextSessionId ?? `session-${++sequence}`, sessionManager) })),
  };
});

vi.mock('./git-branch.js', () => ({ getGitBranch: vi.fn(async () => null) }));
vi.mock('@earendil-works/pi-coding-agent', () => ({
  ModelRuntime: { create: harness.modelRuntimeCreate },
  getAgentDir: () => '/agent',
  createCodemodeExtension: () => () => {},
  createToolSearchExtension: () => () => {},
  createMcpExtension: () => () => {},
  createEventBus: () => ({ on: vi.fn(() => () => {}), emit: vi.fn(), clear: vi.fn() }),
  createAgentSessionServices: harness.createAgentSessionServices,
  createAgentSessionFromServices: harness.createAgentSessionFromServices,
  createAgentSessionRuntime: harness.createAgentSessionRuntime,
  SessionManager: {
    create: (cwd: string) => ({ getCwd: () => cwd, getBranch: () => [], getSessionFile: () => `/tmp/${cwd.replaceAll('/', '_')}.jsonl` }),
    open: (path: string) => ({ getCwd: () => '/project', getBranch: () => [], getSessionFile: () => path }),
  },
}));

import { PimoteSessionManager } from './session-manager.js';

const config: PimoteConfig = { roots: ['/tmp'], managerRoot: '/tmp/manager', idleTimeout: 1000, bufferSize: 20, port: 0 };
const push = { notify: vi.fn(async () => {}) } as unknown as PushNotificationService;

beforeEach(() => {
  harness.sessions.length = 0;
  harness.runtimes.length = 0;
  harness.bindCalls.length = 0;
  harness.modelRuntimeCreate.mockClear();
  harness.createAgentSessionRuntime.mockClear();
  harness.nextSessionId();
  harness.clearPending();
});

describe('manager-owned extension startup', () => {
  it('binds extensions before openSession resolves without observers', async () => {
    const manager = await PimoteSessionManager.create(config, push);
    const id = await manager.openSession('/project');
    const slot = manager.getSlot(id)!;

    expect(harness.bindCalls).toHaveLength(1);
    expect(slot.sessionState.extensionsBound).toBe(true);
    expect(slot.sessionState.sessionIdentity).toBe(slot.session);
  });

  it('coalesces persisted concurrent opens while startup is in flight', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    harness.gateNextBind(async () => gate);
    const manager = await PimoteSessionManager.create(config, push);
    const first = manager.openSession('/project', '/tmp/concurrent.jsonl');
    await Promise.resolve();
    const second = manager.openSession('/project', '/tmp/concurrent.jsonl');
    await vi.waitFor(() => expect(manager.getAllSessions()).toHaveLength(1));
    expect(harness.bindCalls).toHaveLength(1);
    release();
    const ids = await Promise.all([first, second]);
    expect(ids[1]).toBe(ids[0]);
    expect(harness.createAgentSessionRuntime).toHaveBeenCalledOnce();
  });

  it('rebinds a replacement before the command action and keeps no-observer slots live', async () => {
    const manager = await PimoteSessionManager.create(config, push);
    const id = await manager.openSession('/project');
    const slot = manager.getSlot(id)!;
    const firstSession = slot.session;
    const actions = harness.bindCalls[0].bindings.commandContextActions;

    harness.nextSessionId('replacement');
    let withSessionSawBound = false;
    await actions.newSession({
      withSession: async () => {
        withSessionSawBound = slot.sessionState.extensionsBound && slot.sessionState.sessionIdentity === slot.session;
      },
    });

    const replacement = slot.session;
    expect(replacement).not.toBe(firstSession);
    expect(withSessionSawBound).toBe(true);
    expect(manager.getSlot('replacement')).toBe(slot);
    expect(slot.sessionState.extensionsBound).toBe(true);
    expect(slot.sessionState.sessionIdentity).toBe(replacement);
    expect(harness.bindCalls.map((entry) => entry.session)).toEqual([firstSession, replacement]);
  });

  it('binds same-ID replacement by AgentSession identity', async () => {
    const manager = await PimoteSessionManager.create(config, push);
    const id = await manager.openSession('/project');
    const slot = manager.getSlot(id)!;
    const firstSession = slot.session;
    const actions = harness.bindCalls[0].bindings.commandContextActions;

    harness.nextSessionId(id);
    await actions.newSession();

    expect(slot.session).not.toBe(firstSession);
    expect(manager.getSlot(id)).toBe(slot);
    expect(harness.bindCalls).toHaveLength(2);
  });

  it('rejects a concurrent guarded runtime replacement before a second factory starts', async () => {
    const manager = await PimoteSessionManager.create(config, push);
    await manager.openSession('/project');
    const actions = harness.bindCalls[0].bindings.commandContextActions;
    const runtime = harness.runtimes[0];
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    harness.gateNextBind(async () => gate);

    const first = actions.newSession();
    await vi.waitFor(() => expect(harness.bindCalls).toHaveLength(2));
    const second = actions.newSession();

    await expect(second).rejects.toThrow('session_reset_in_progress');
    expect(runtime.newSession).toHaveBeenCalledOnce();
    release();
    await first;
    await manager.dispose();
  });

  it('rejects a nested reset from the pre-apply runtime phase', async () => {
    const manager = await PimoteSessionManager.create(config, push);
    await manager.openSession('/project');
    const actions = harness.bindCalls[0].bindings.commandContextActions;
    const runtime = harness.runtimes[0];
    runtime.beforeReplacementAction = async () => {
      await expect(actions.newSession()).rejects.toThrow('session_reset_in_progress');
    };

    await actions.newSession();

    expect(runtime.newSession).toHaveBeenCalledOnce();
    await manager.dispose();
  });

  it('rejects a direct root-runtime nested reset before apply', async () => {
    const manager = await PimoteSessionManager.create(config, push);
    const id = await manager.openSession('/project');
    const slot = manager.getSlot(id)!;
    const runtime = harness.runtimes[0];
    runtime.beforeReplacementAction = async () => {
      await expect(slot.runtime.newSession()).rejects.toThrow('session_reset_in_progress');
    };

    await slot.runtime.newSession();

    expect(runtime.newSession).toHaveBeenCalledOnce();
    await manager.dispose();
  });

  it('closes the slot when replacement setup fails before the rebind callback', async () => {
    const manager = await PimoteSessionManager.create(config, push);
    const id = await manager.openSession('/project');
    const runtime = harness.runtimes[0];
    const failure = new Error('replacement setup failed');
    runtime.failNextSession = failure;

    await expect(harness.bindCalls[0].bindings.commandContextActions.newSession()).rejects.toBe(failure);
    expect(runtime.dispose).toHaveBeenCalledOnce();
    expect(manager.getSlot(id)).toBeNull();
  });

  it('allows one nested extension reset and rejects a same-context sibling', async () => {
    const manager = await PimoteSessionManager.create(config, push);
    await manager.openSession('/project');
    const actions = harness.bindCalls[0].bindings.commandContextActions;
    const runtime = harness.runtimes[0];

    harness.runNextBindAction(async (bindings: any) => {
      const first = bindings.commandContextActions.newSession();
      const second = bindings.commandContextActions.newSession();
      await expect(second).rejects.toThrow('session_reset_in_progress');
      await first;
    });

    await actions.newSession();

    expect(runtime.newSession).toHaveBeenCalledTimes(2);
    expect(harness.bindCalls).toHaveLength(3);
    await manager.dispose();
  });

  it('invalidates same-session navigation replay without rebuilding or rebinding', async () => {
    const manager = await PimoteSessionManager.create(config, push);
    const id = await manager.openSession('/project');
    const slot = manager.getSlot(id)!;
    const state = slot.sessionState;
    const actions = harness.bindCalls[0].bindings.commandContextActions;
    const navigateTree = vi.fn(async () => ({ cancelled: false }));
    (slot.session as any).navigateTree = navigateTree;
    const invalidateReplay = vi.spyOn(state.eventBuffer, 'invalidateReplay');
    const rebuildSessionState = vi.spyOn(manager, 'rebuildSessionState');

    await actions.navigateTree('entry-1');

    expect(navigateTree).toHaveBeenCalledWith('entry-1', undefined);
    expect(invalidateReplay).toHaveBeenCalledOnce();
    expect(rebuildSessionState).not.toHaveBeenCalled();
    expect(slot.sessionState).toBe(state);
    expect(harness.bindCalls).toHaveLength(1);
  });

  it('does not invalidate replay for cancelled same-session navigation', async () => {
    const manager = await PimoteSessionManager.create(config, push);
    const id = await manager.openSession('/project');
    const slot = manager.getSlot(id)!;
    const actions = harness.bindCalls[0].bindings.commandContextActions;
    const navigateTree = vi.fn(async () => ({ cancelled: true }));
    (slot.session as any).navigateTree = navigateTree;
    const invalidateReplay = vi.spyOn(slot.sessionState.eventBuffer, 'invalidateReplay');
    const rebuildSessionState = vi.spyOn(manager, 'rebuildSessionState');

    await actions.navigateTree('entry-cancel');

    expect(navigateTree).toHaveBeenCalledWith('entry-cancel', undefined);
    expect(invalidateReplay).not.toHaveBeenCalled();
    expect(rebuildSessionState).not.toHaveBeenCalled();
    expect(harness.bindCalls).toHaveLength(1);
  });

  it('cleans up the replacing slot when collision disposal fails before rekey', async () => {
    const manager = await PimoteSessionManager.create(config, push);
    const firstId = await manager.openSession('/first');
    const secondId = await manager.openSession('/second');
    const firstSlot = manager.getSlot(firstId)!;
    const occupant = manager.getSlot(secondId)!;
    const failure = new Error('occupant dispose failed');
    occupant.runtime.dispose = vi.fn(async () => {
      throw failure;
    });

    const firstActions = harness.bindCalls.find((entry) => entry.session === firstSlot.session)!.bindings.commandContextActions;
    harness.nextSessionId(secondId);
    await expect(firstActions.newSession()).rejects.toBe(failure);
    expect(manager.getAllSessions()).toHaveLength(0);
  });

  it('uses a dynamic slot predicate for voice UI rejection across replacement IDs', async () => {
    const seenIds: string[] = [];
    const manager = await PimoteSessionManager.create(config, push, {
      isVoiceModeActive: (slot) => {
        seenIds.push(slot.sessionState.id);
        return true;
      },
    });
    const id = await manager.openSession('/project');
    const slot = manager.getSlot(id)!;
    await expect(harness.bindCalls[0].bindings.uiContext.select('Pick', ['one'])).rejects.toThrow();

    const actions = harness.bindCalls[0].bindings.commandContextActions;
    harness.nextSessionId('voice-replacement');
    await actions.newSession();
    await expect(harness.bindCalls[1].bindings.uiContext.select('Pick', ['one'])).rejects.toThrow();

    expect(seenIds).toEqual([id, 'voice-replacement']);
    expect(slot.sessionState.id).toBe('voice-replacement');
  });

  it('disposes a published slot when startup binding fails', async () => {
    const manager = await PimoteSessionManager.create(config, push);
    const failure = new Error('bind failed');
    harness.gateNextBind(async () => {
      throw failure;
    });

    await expect(manager.openSession('/project')).rejects.toBe(failure);
    expect(manager.getAllSessions()).toHaveLength(0);
    expect(harness.runtimes[0].dispose).toHaveBeenCalledOnce();
  });
});
