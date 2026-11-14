import { describe, expect, it } from 'vitest';
import type { AgentSessionEvent } from '@earendil-works/pi-coding-agent';
import type { BorrowedAgentSession } from '@pimote/sdk/subagents';
import type { PimoteSessionEvent, PimoteTreeNode } from '../../shared/dist/index.js';
import { createSessionSurface, type SessionSurfaceCapabilities, type SessionSurfaceCommand, type SessionSurfaceOptions } from './session-surface.js';

function message(role: 'user' | 'assistant', text: string) {
  return { role, content: [{ type: 'text', text }], timestamp: 1 };
}

function entry(id: string, parentId: string | null, text: string) {
  return { type: 'message', id, parentId, timestamp: '2026-01-01T00:00:00.000Z', message: message('user', text) };
}

function fixture() {
  const old = entry('old', null, 'Before compaction');
  const recent = entry('recent', 'old', 'After compaction');
  const compacted = {
    type: 'compaction',
    id: 'compaction',
    parentId: 'recent',
    timestamp: '2026-01-01T00:00:00.000Z',
    summary: 'Earlier discussion',
    firstKeptEntryId: 'recent',
    tokensBefore: 1000,
  };
  const saved = [old, recent, compacted];
  const listeners = new Set<(event: AgentSessionEvent) => void>();
  const data = {
    model: { provider: 'test', id: 'model-a', name: 'Model A' },
    thinkingLevel: 'off',
    autoCompactionEnabled: true,
    streaming: false,
    leaf: 'compaction',
    label: undefined as string | undefined,
    snapshotEvent: undefined as AgentSessionEvent | undefined,
    steering: [] as string[],
    followUp: [] as string[],
    branch: saved,
    messages: [recent.message] as unknown[],
  };
  const publish = (event: AgentSessionEvent) => {
    for (const listener of listeners) listener(event);
  };
  const snapshotRead = () => {
    if (data.snapshotEvent) {
      const event = data.snapshotEvent;
      data.snapshotEvent = undefined;
      publish(event);
    }
  };
  const native = {
    sessionId: 'child-session',
    sessionFile: '/saved/child.jsonl',
    get messages() {
      snapshotRead();
      return data.messages;
    },
    get model() {
      return data.model;
    },
    get thinkingLevel() {
      return data.thinkingLevel;
    },
    get isStreaming() {
      return data.streaming;
    },
    get isIdle() {
      return !data.streaming;
    },
    isCompacting: false,
    state: {
      streamingMessage: undefined,
      pendingToolCalls: new Set<string>(),
      errorMessage: undefined,
    },
    subscribe(listener: (event: AgentSessionEvent) => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    async prompt(text: string, options?: { streamingBehavior?: 'steer' | 'followUp'; preflightResult?: (value: 'started' | 'queued') => void }) {
      if (data.streaming && options?.streamingBehavior) {
        (options.streamingBehavior === 'steer' ? data.steering : data.followUp).push(text);
        publish({ type: 'queue_update', steering: data.steering, followUp: data.followUp });
        options.preflightResult?.('queued');
        return;
      }
      options?.preflightResult?.('started');
      const next = entry('prompt', data.leaf, text);
      data.branch = [...data.branch, next];
      data.leaf = next.id;
      data.streaming = true;
      publish({ type: 'message_end', message: next.message } as AgentSessionEvent);
    },
    async steer(text: string) {
      data.steering.push(text);
      publish({ type: 'queue_update', steering: data.steering, followUp: data.followUp });
      return 'queued';
    },
    async followUp(text: string) {
      data.followUp.push(text);
      publish({ type: 'queue_update', steering: data.steering, followUp: data.followUp });
      return 'queued';
    },
    async abort() {
      data.streaming = false;
    },
    async setModel(model: typeof data.model) {
      data.model = model;
    },
    async cycleModel() {
      data.model = { provider: 'test', id: 'model-c', name: 'Model C' };
      return { model: data.model, thinkingLevel: data.thinkingLevel, isScoped: false };
    },
    setThinkingLevel(level: string) {
      data.thinkingLevel = level;
    },
    cycleThinkingLevel() {
      data.thinkingLevel = 'off';
      return data.thinkingLevel;
    },
    setAutoCompactionEnabled(enabled: boolean) {
      data.autoCompactionEnabled = enabled;
    },
    async compact(instructions?: string) {
      return { summary: `Summary: ${instructions}` };
    },
    async navigateTree(targetId: string) {
      data.leaf = targetId;
      return { cancelled: false };
    },
    getContextUsage: () => null,
    getSessionStats: () => ({ cost: 0, tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }),
    sessionManager: {
      getEntries() {
        const result = data.branch;
        snapshotRead();
        return result;
      },
      getBranch() {
        const result = data.branch;
        snapshotRead();
        return result;
      },
      buildContextEntries: () => [compacted, recent],
      getTree: () => [{ entry: old, label: data.label, children: [{ entry: recent, children: [] }] }],
      getLeafId: () => data.leaf,
      appendLabelChange: (_id: string, label?: string) => {
        data.label = label;
      },
    },
  } as unknown as BorrowedAgentSession;
  const capabilities: SessionSurfaceCapabilities = {
    resolveModel: async (provider, id) =>
      provider === 'test' && id === 'model-b'
        ? ({ provider: 'test', id: 'model-b', name: 'Model B' } as Awaited<ReturnType<SessionSurfaceCapabilities['resolveModel']>>)
        : undefined,
    getSettings: () => ({ availableThinkingLevels: ['off', 'high'], autoCompactionEnabled: data.autoCompactionEnabled }),
    getCommands: async () => [{ name: 'review', description: 'Review changes', hasArgCompletions: true }],
    completeArgs: async () => [{ value: 'src', label: 'src' }],
    completeFileRefs: async () => [{ value: '@src/main.ts', label: 'src/main.ts' }],
    executeBash: async (command) => ({ output: `ran ${command}` }),
    getGitBranch: () => null,
  };
  const stop = async (..._args: readonly unknown[]) => undefined;
  const surface = createSessionSurface({
    sessionId: 'child-session',
    session: native,
    kind: 'child',
    capabilities,
    parentCursor: 17,
    stop,
  } as SessionSurfaceOptions & { stop: typeof stop });
  return { surface, data, publish, native, capabilities };
}

function assistantEnd(text: string): AgentSessionEvent {
  return { type: 'message_end', message: message('assistant', text) } as AgentSessionEvent;
}

describe('SessionSurface', () => {
  it.each(['root', 'child'] as const)('holds the %s first snapshot until provider hydration and stages its events', async (kind) => {
    const f = fixture();
    f.data.branch = [
      {
        type: 'message',
        id: 'assistant-entry',
        parentId: null,
        timestamp: '2026-01-01T00:00:00.000Z',
        message: { role: 'assistant', content: [{ type: 'toolCall', id: 'send-call', name: 'send', arguments: { message: 'native hidden' } }], timestamp: 1 },
      },
    ] as unknown as typeof f.data.branch;
    let release!: () => void;
    let hydrationStarted!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const started = new Promise<void>((resolve) => {
      hydrationStarted = resolve;
    });
    const cursor = { epoch: 'epoch-1', sequence: 1 };
    const event = {
      type: 'subagent_snapshot_event',
      eventId: 'saved',
      cursor,
      target: {
        operationId: 'send-call',
        kind: 'send',
        path: kind === 'root' ? [] : ['worker'],
        placement: { toolCallId: 'send-call', contentIndex: 0, entryId: 'assistant-entry' },
      },
      state: 'complete',
      data: { operation: 'send', parameters: { to: ['worker'], message: 'Check' }, result: { response: 'Done' } },
    } as const;
    const listeners = new Set<(event: import('@pimote/sdk/subagents').SubagentProviderEvent) => void>();
    const provider = {
      snapshot: () => ({ manifest: { hiddenToolNames: ['send'], hiddenCustomTypes: [] }, nodes: [], cursor, activeOperations: [] }),
      subscribe: (listener: (event: import('@pimote/sdk/subagents').SubagentProviderEvent) => void) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
      replay: () => ({ kind: 'events' as const, cursor, events: [event] }),
      rehydrate: async (input: { session: BorrowedAgentSession; path: readonly string[] }) => {
        expect(input.session).toBe(f.native);
        expect(input.path).toEqual(kind === 'root' ? [] : ['worker']);
        listeners.forEach((listener) => listener(event));
        hydrationStarted();
        await gate;
      },
    };
    const surface = createSessionSurface({
      sessionId: 'child-session',
      session: f.native,
      kind,
      capabilities: f.capabilities,
      subagentProvider: provider,
      subagentPath: kind === 'root' ? [] : ['worker'],
    });
    const live: PimoteSessionEvent[] = [];
    surface.subscribe((item) => live.push(item));
    let released = false;
    const first = surface.initialize().then((snapshot) => {
      released = true;
      return snapshot;
    });
    const didStart = await Promise.race([started.then(() => true), first.then(() => false)]);
    expect(didStart).toBe(true);
    expect(released).toBe(false);
    expect(live).toEqual([]);
    release();
    const snapshot = await first;
    expect(snapshot.messages).toContainEqual(
      expect.objectContaining({
        content: expect.arrayContaining([
          expect.objectContaining({ type: 'subagent', data: { operation: 'send', parameters: { to: ['worker'], message: 'Check' }, result: { response: 'Done' } } }),
        ]),
      }),
    );
    expect(JSON.stringify(snapshot)).not.toContain('native hidden');
    surface.close();
  });

  it.each(['delegation', 'resurrect'] as const)('attributes a nested %s to the spawning child across live delivery and reload', async (operation) => {
    const root = fixture();
    const child = fixture();
    const toolName = operation === 'delegation' ? 'subagent' : 'resurrect';
    const path = ['worker', 'scout'];
    const data =
      operation === 'delegation'
        ? ({ operation, parameters: { agents: [{ id: 'scout', task: 'Inspect' }] }, result: { children: [{ path, task: 'Inspect' }] } } as const)
        : ({
            operation,
            parameters: { agents: [{ id: 'scout', sessionId: 'saved-scout' }] },
            result: {
              affectedAgents: [
                { path, sessionId: 'saved-scout', incarnation: 'scout-2', state: 'running', usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 } },
              ],
            },
          } as const);
    child.data.branch = [
      {
        type: 'message',
        id: 'child-assistant',
        parentId: null,
        timestamp: '2026-01-01T00:00:00.000Z',
        message: { role: 'assistant', content: [{ type: 'toolCall', id: 'nested-call', name: toolName, arguments: {} }], timestamp: 1 },
      },
    ] as unknown as typeof child.data.branch;
    const cursor = { epoch: 'epoch-1', sequence: 1 };
    const event = {
      type: 'subagent_snapshot_event',
      eventId: 'nested-event',
      cursor,
      target: { operationId: 'nested-call', kind: operation, path: ['worker'], placement: { toolCallId: 'nested-call', contentIndex: 0, entryId: 'child-assistant' } },
      state: 'complete',
      data,
    } as const;
    const listeners = new Set<(event: import('@pimote/sdk/subagents').SubagentProviderEvent) => void>();
    let saved = false;
    const provider = {
      snapshot: () => ({ manifest: { hiddenToolNames: ['subagent', 'resurrect'], hiddenCustomTypes: [] }, nodes: [], cursor, activeOperations: [] }),
      subscribe: (listener: (event: import('@pimote/sdk/subagents').SubagentProviderEvent) => void) => {
        listeners.add(listener);
        return () => {
          listeners.delete(listener);
        };
      },
      replay: () => ({ kind: 'events' as const, cursor, events: [] }),
      rehydrate: async ({ path: owner }: { session: BorrowedAgentSession; path: readonly string[] }) => {
        if (saved && owner.length === 1 && owner[0] === 'worker') listeners.forEach((listener) => listener(event));
      },
    };
    const rootSurface = createSessionSurface({
      sessionId: 'root',
      session: root.native,
      kind: 'root',
      capabilities: root.capabilities,
      subagentProvider: provider,
      subagentPath: [],
    });
    const makeChildSurface = () =>
      createSessionSurface({
        sessionId: 'child-session',
        session: child.native,
        kind: 'child',
        capabilities: child.capabilities,
        subagentProvider: provider,
        subagentPath: ['worker'],
      });
    const childSurface = makeChildSurface();
    await rootSurface.initialize();
    await childSurface.initialize();
    listeners.forEach((listener) => listener(event));
    const childMessages = childSurface.snapshot().messages;
    expect(childMessages).toContainEqual(
      expect.objectContaining({
        entryId: 'child-assistant',
        content: expect.arrayContaining([expect.objectContaining({ type: 'subagent', subagentKind: operation, data })]),
      }),
    );
    expect(rootSurface.snapshot().messages.flatMap((message) => message.content)).not.toContainEqual(expect.objectContaining({ type: 'subagent', operationId: 'nested-call' }));

    childSurface.close();
    saved = true;
    const reopened = makeChildSurface();
    expect((await reopened.initialize()).messages).toContainEqual(
      expect.objectContaining({
        entryId: 'child-assistant',
        content: expect.arrayContaining([expect.objectContaining({ type: 'subagent', subagentKind: operation, data })]),
      }),
    );
    reopened.close();
    rootSurface.close();
  });

  it('shows a control resurrection at its saved parent entry live and after reopening', async () => {
    const f = fixture();
    const path = ['restored'];
    const data = {
      operation: 'resurrect',
      parameters: { agents: [{ id: 'restored', task: 'continue', sessionId: 'saved' }] },
      result: { affectedAgents: [{ path, sessionId: 'saved', state: 'running' }] },
    } as const;
    const payload = { operationId: 'control-resurrect', kind: 'resurrect', source: 'custom_entry', state: 'complete', data };
    const savedEntry = {
      type: 'custom',
      id: 'resurrection-entry',
      parentId: 'old',
      timestamp: '2026-01-01T00:00:00.000Z',
      customType: 'subagents',
      data: { subagentContent: [payload] },
    };
    const cursor = { epoch: 'epoch-1', sequence: 1 };
    const event = {
      type: 'subagent_snapshot_event',
      eventId: 'resurrect-event',
      cursor,
      target: { operationId: payload.operationId, kind: 'resurrect', path: [], placement: { entryId: savedEntry.id } },
      state: 'complete',
      data,
    } as const;
    (f.native as unknown as { extensionRunner: unknown }).extensionRunner = { getEntryRenderer: () => undefined };
    (f.native.sessionManager as unknown as { buildContextEntries: () => unknown }).buildContextEntries = () => f.data.branch;
    f.data.branch = [entry('old', null, 'before')];
    const listeners = new Set<(event: import('@pimote/sdk/subagents').SubagentProviderEvent) => void>();
    let saved = false;
    const provider = {
      snapshot: () => ({ manifest: { hiddenToolNames: [], hiddenCustomTypes: ['subagents'] }, nodes: [], cursor, activeOperations: [] }),
      subscribe: (listener: (event: import('@pimote/sdk/subagents').SubagentProviderEvent) => void) => {
        listeners.add(listener);
        return () => {
          listeners.delete(listener);
        };
      },
      replay: () => ({ kind: 'events' as const, cursor, events: saved ? [event] : [] }),
      rehydrate: async () => {},
    };
    const create = () => createSessionSurface({ sessionId: 'root', session: f.native, kind: 'root', capabilities: f.capabilities, subagentProvider: provider });
    const live = create();
    await live.initialize();
    f.data.branch = [...f.data.branch, savedEntry, entry('after', savedEntry.id, 'after')] as unknown as typeof f.data.branch;
    f.publish({ type: 'entry_appended', entry: savedEntry } as unknown as AgentSessionEvent);
    listeners.forEach((listener) => listener(event));
    expect(live.snapshot().messages).toContainEqual(
      expect.objectContaining({ entryId: savedEntry.id, content: expect.arrayContaining([expect.objectContaining({ subagentKind: 'resurrect', data })]) }),
    );
    live.close();
    saved = true;
    const reopened = create();
    const messages = (await reopened.initialize()).messages;
    const index = messages.findIndex((item) => item.entryId === savedEntry.id);
    expect(index).toBeGreaterThan(0);
    expect(messages[index]).toMatchObject({ content: [expect.objectContaining({ subagentKind: 'resurrect', data })] });
    expect(messages[index + 1]).toMatchObject({ entryId: 'after' });
    reopened.close();
  });

  it('does not leak a hidden tail when message_end arrives empty', async () => {
    const f = fixture();
    f.data.messages = [
      {
        role: 'assistant',
        content: [{ type: 'toolCall', id: 'send-call', name: 'send', arguments: { message: 'secret native argument' } }],
      },
    ];
    f.data.branch = [
      {
        type: 'message',
        id: 'assistant-entry',
        parentId: null,
        timestamp: '2026-01-01T00:00:00.000Z',
        message: f.data.messages[0],
      },
    ] as unknown as typeof f.data.branch;
    const cursor = { epoch: 'epoch-1', sequence: 0 };
    const provider = {
      snapshot: () => ({ manifest: { hiddenToolNames: ['send'], hiddenCustomTypes: [] }, nodes: [], cursor, activeOperations: [] }),
      subscribe: () => () => {},
      replay: () => ({ kind: 'events' as const, cursor, events: [] }),
      rehydrate: async () => {},
    };
    const surface = createSessionSurface({
      sessionId: 'child-session',
      session: f.native,
      kind: 'child',
      capabilities: f.capabilities,
      subagentProvider: provider,
      subagentPath: ['worker'],
    });
    const live: PimoteSessionEvent[] = [];
    surface.subscribe((event) => live.push(event));
    await surface.initialize();
    f.publish({ type: 'message_end', message: { role: 'assistant', content: [] } } as AgentSessionEvent);
    expect(JSON.stringify(live)).not.toContain('secret native argument');
    expect(live.find((event) => event.type === 'message_end')).toBeUndefined();
  });

  it('keeps projected active content in the streaming snapshot row', async () => {
    const f = fixture();
    const hidden = { type: 'toolCall', id: 'send-call', name: 'send', arguments: { message: 'secret' } };
    f.data.branch = [
      {
        type: 'message',
        id: 'assistant-entry',
        parentId: null,
        timestamp: '2026-01-01T00:00:00.000Z',
        message: { role: 'assistant', content: [hidden] },
      },
    ] as unknown as typeof f.data.branch;
    f.data.streaming = true;
    f.data.messages = [{ role: 'assistant', content: [hidden] }];
    f.native.state.streamingMessage = { role: 'assistant', content: [{ type: 'toolCall', id: 'send-call', name: 'send', arguments: {} }] } as never;
    const cursor = { epoch: 'epoch-1', sequence: 0 };
    const active = {
      target: { operationId: 'send-call', kind: 'send', path: ['worker'], placement: { toolCallId: 'send-call', contentIndex: 0 } },
      data: { operation: 'send', parameters: { to: ['worker'], message: 'check' }, result: { response: '', phase: 'sending' } },
    } as const;
    const provider = {
      snapshot: () => ({ manifest: { hiddenToolNames: ['send'], hiddenCustomTypes: [] }, nodes: [], cursor, activeOperations: [active] }),
      subscribe: () => () => {},
      replay: () => ({ kind: 'events' as const, cursor, events: [] }),
      rehydrate: async () => {},
    };
    const surface = createSessionSurface({
      sessionId: 'child-session',
      session: f.native,
      kind: 'child',
      capabilities: f.capabilities,
      subagentProvider: provider,
      subagentPath: ['worker'],
    });
    const snapshot = await surface.initialize();
    expect(snapshot.messages.some((message) => message.content.some((block) => block.type === 'subagent'))).toBe(false);
    expect(snapshot.streamingMessage?.content).toContainEqual(expect.objectContaining({ type: 'subagent', operationId: 'send-call' }));
  });

  it('sends deltas live but restores accumulated active state instead of replaying deltas', async () => {
    const f = fixture();
    f.data.branch = [
      {
        type: 'message',
        id: 'assistant-entry',
        parentId: null,
        timestamp: '2026-01-01T00:00:00.000Z',
        message: { role: 'assistant', content: [{ type: 'toolCall', id: 'send-call', name: 'send', arguments: { message: 'hidden' } }], timestamp: 1 },
      },
    ] as unknown as typeof f.data.branch;
    const cursor = { epoch: 'epoch-1', sequence: 0 };
    const provider = {
      snapshot: () => ({ manifest: { hiddenToolNames: ['send'], hiddenCustomTypes: [] }, nodes: [], cursor, activeOperations: [] }),
      subscribe: () => () => {},
      replay: () => ({ kind: 'events' as const, cursor, events: [] }),
      rehydrate: async () => {},
    };
    const surface = createSessionSurface({
      sessionId: 'child-session',
      session: f.native,
      kind: 'child',
      capabilities: f.capabilities,
      subagentProvider: provider,
      subagentPath: ['worker'],
    });
    const live: PimoteSessionEvent[] = [];
    surface.subscribe((event) => live.push(event));
    const first = await surface.initialize();
    const target = { operationId: 'send-call', kind: 'send', path: ['worker'], placement: { toolCallId: 'send-call', contentIndex: 0, entryId: 'assistant-entry' } } as const;
    surface.acceptProviderEvent!({
      type: 'subagent_start',
      eventId: 'start',
      cursor: { ...cursor, sequence: 1 },
      target,
      data: { operation: 'send', parameters: { to: ['worker'], message: 'Check' }, result: { response: '', phase: 'sending' } },
    });
    surface.acceptProviderEvent!({
      type: 'subagent_delta',
      eventId: 'delta',
      cursor: { ...cursor, sequence: 2 },
      target,
      data: { operation: 'send', field: 'request', delta: ' config' },
    });
    expect(live).toContainEqual(expect.objectContaining({ type: 'subagent_content_delta', operationId: 'send-call' }));
    const replay = surface.replay(first.cursor);
    if (replay.kind === 'events') expect(replay.events).not.toContainEqual(expect.objectContaining({ type: 'subagent_content_delta' }));
    const snapshot = surface.refreshSnapshot();
    expect(snapshot.activeSubagentContent).toContainEqual(
      expect.objectContaining({ operationId: 'send-call', data: expect.objectContaining({ parameters: expect.objectContaining({ message: 'Check config' }) }) }),
    );
    surface.close();
  });

  it('delivers a native event injected during the initial snapshot and streams later events', async () => {
    const f = fixture();
    f.data.snapshotEvent = assistantEnd('At snapshot boundary');
    const live: PimoteSessionEvent[] = [];
    f.surface.subscribe((event) => live.push(event));
    const snapshot = await f.surface.initialize();
    const catchup = f.surface.replay(snapshot.cursor);
    const knownMessages = [
      ...snapshot.messages,
      ...live.filter((event) => event.type === 'message_end').map((event) => event.message),
      ...(catchup.kind === 'events' ? catchup.events.filter((event) => event.type === 'message_end').map((event) => event.message) : []),
    ];
    expect(knownMessages).toContainEqual(
      expect.objectContaining({
        role: 'assistant',
        content: expect.arrayContaining([expect.objectContaining({ text: 'At snapshot boundary' })]),
      }),
    );

    f.publish({ type: 'message_start', message: message('assistant', '') } as AgentSessionEvent);
    f.publish({
      type: 'message_update',
      message: message('assistant', 'Later'),
      assistantMessageEvent: {
        type: 'text_delta',
        contentIndex: 0,
        delta: 'Later',
      },
    } as AgentSessionEvent);
    expect(live).toContainEqual(expect.objectContaining({ type: 'message_update', content: expect.objectContaining({ text: 'Later' }) }));
  });

  it.each(['root', 'child'] as const)('includes metadata-only native branch IDs in %s snapshots', async (kind) => {
    const f = fixture();
    const branch = f.native.sessionManager.getBranch();
    f.native.sessionManager.getBranch = () => [
      ...branch,
      {
        type: 'thinking_level_change',
        id: 'hidden-metadata',
        parentId: 'compaction',
        timestamp: '2026-01-01T00:00:00.000Z',
        thinkingLevel: 'off',
      },
    ];
    const surface = kind === 'child' ? f.surface : createSessionSurface({ sessionId: 'child-session', session: f.native, kind, capabilities: f.capabilities });
    const snapshot = await surface.initialize();

    expect(snapshot).toMatchObject({ branchEntryIds: ['old', 'recent', 'compaction', 'hidden-metadata'] });
    expect(snapshot.messages.some((message) => message.entryId === 'hidden-metadata')).toBe(false);
  });

  it('returns the full saved branch instead of only the current compacted context', async () => {
    const f = fixture();
    const snapshot = await f.surface.initialize();
    expect(snapshot.messages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ content: expect.arrayContaining([expect.objectContaining({ text: 'Before compaction' })]) }),
        expect.objectContaining({ content: expect.arrayContaining([expect.objectContaining({ text: 'After compaction' })]) }),
      ]),
    );
    expect(await f.surface.getMessages()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ content: expect.arrayContaining([expect.objectContaining({ text: 'Before compaction' })]) }),
        expect.objectContaining({ content: expect.arrayContaining([expect.objectContaining({ text: 'After compaction' })]) }),
      ]),
    );
  });

  it('uses independent observer cursors and never adopts the parent cursor', async () => {
    const f = fixture();
    await f.surface.initialize();
    const first = await f.surface.attachObserver('connection-1');
    f.publish(assistantEnd('One'));
    const second = await f.surface.attachObserver('connection-2', first.cursor);
    expect(second.events).toContainEqual(
      expect.objectContaining({
        type: 'message_end',
        message: expect.objectContaining({
          content: expect.arrayContaining([expect.objectContaining({ text: 'One' })]),
        }),
      }),
    );
    first.release();
    f.publish(assistantEnd('Two'));
    const replay = f.surface.replay(second.cursor);
    expect(replay.kind).toBe('events');
    if (replay.kind === 'events')
      expect(replay.events).toContainEqual(
        expect.objectContaining({
          type: 'message_end',
          message: expect.objectContaining({
            content: expect.arrayContaining([expect.objectContaining({ text: 'Two' })]),
          }),
        }),
      );
    second.release();
  });

  it('routes root steer and follow-up through prompt preflight', async () => {
    const f = fixture();
    const root = createSessionSurface({ sessionId: 'root-session', session: f.native, kind: 'root', capabilities: f.capabilities });
    await root.initialize();
    await expect(root.dispatch({ type: 'steer', message: 'Start a root run' })).resolves.toMatchObject({ outcome: 'started' });
    f.data.streaming = false;
    await expect(root.dispatch({ type: 'follow_up', message: 'Continue the root run' })).resolves.toMatchObject({ outcome: 'started' });
    expect(f.data.steering).toEqual([]);
    expect(f.data.followUp).toEqual([]);
    expect(f.data.branch.filter((saved) => 'message' in saved).map((saved) => (saved as { message: { content: unknown } }).message.content)).toEqual(
      expect.arrayContaining([
        expect.arrayContaining([expect.objectContaining({ text: 'Start a root run' })]),
        expect.arrayContaining([expect.objectContaining({ text: 'Continue the root run' })]),
      ]),
    );
  });

  it('supports chat and Stop on the same child session', async () => {
    const f = fixture();
    await f.surface.initialize();
    const live: PimoteSessionEvent[] = [];
    f.surface.subscribe((event) => live.push(event));
    await expect(f.surface.dispatch({ type: 'prompt', message: 'Inspect the callback', clientMessageId: 'message-1' })).resolves.toMatchObject({ outcome: 'started' });
    expect(live).toContainEqual(expect.objectContaining({ type: 'message_end', clientMessageId: 'message-1' }));
    expect(await f.surface.getState()).toMatchObject({ sessionId: 'child-session', isStreaming: true });
    await f.surface.dispatch({ type: 'steer', message: 'Check ownership' });
    await f.surface.dispatch({ type: 'follow_up', message: 'Report findings' });
    expect(await f.surface.getMessages()).toEqual(
      expect.arrayContaining([expect.objectContaining({ content: expect.arrayContaining([expect.objectContaining({ text: 'Inspect the callback' })]) })]),
    );
    expect(live).toContainEqual(
      expect.objectContaining({
        type: 'queue_update',
        steering: ['Check ownership'],
        followUp: ['Report findings'],
      }),
    );
    await f.surface.dispatch({ type: 'abort' });
    expect(await f.surface.getState()).toMatchObject({ sessionId: 'child-session', isStreaming: false });
  });

  it('applies model, thinking, compaction, and tree changes without replacing the child', async () => {
    const f = fixture();
    await f.surface.initialize();
    await f.surface.dispatch({ type: 'set_model', provider: 'test', modelId: 'model-b' });
    await f.surface.dispatch({ type: 'set_thinking_level', level: 'high' });
    await f.surface.dispatch({ type: 'set_auto_compaction', enabled: false });
    expect(await f.surface.getState()).toMatchObject({
      sessionId: 'child-session',
      model: { provider: 'test', id: 'model-b' },
      thinkingLevel: 'high',
      autoCompactionEnabled: false,
    });
    await f.surface.dispatch({ type: 'cycle_model' });
    await f.surface.dispatch({ type: 'cycle_thinking_level' });
    expect(await f.surface.getState()).toMatchObject({ model: { id: 'model-c' }, thinkingLevel: 'off' });
    await expect(f.surface.dispatch({ type: 'compact', customInstructions: 'Keep decisions' })).resolves.toMatchObject({ result: { summary: 'Summary: Keep decisions' } });
    await f.surface.dispatch({ type: 'navigate_tree', targetId: 'old' });
    await f.surface.dispatch({ type: 'set_tree_label', entryId: 'old', label: 'checkpoint' });
    await expect(f.surface.dispatch({ type: 'get_tree' })).resolves.toMatchObject({
      currentLeafId: 'old',
      tree: expect.arrayContaining([expect.objectContaining({ label: 'checkpoint' })]),
    });
    expect(await f.surface.getState()).toMatchObject({ sessionId: 'child-session' });
  });

  it.each(['root', 'child'] as const)('returns complete deep trees through the %s surface', async (kind) => {
    const f = fixture();
    const tree: ReturnType<BorrowedAgentSession['sessionManager']['getTree']> = [];
    let children = tree;
    for (let index = 0; index < 10_000; index += 1) {
      const node = { entry: entry(`entry-${index}`, index === 0 ? null : `entry-${index - 1}`, `node ${index}`), children: [] };
      children.push(node as (typeof tree)[number]);
      children = node.children;
    }
    f.native.sessionManager.getTree = () => tree;
    f.native.sessionManager.getLeafId = () => 'entry-9999';
    const surface = createSessionSurface({ sessionId: f.native.sessionId, session: f.native, kind, capabilities: f.capabilities });
    const result = (await surface.dispatch({ type: 'get_tree' })) as { tree: PimoteTreeNode[]; currentLeafId: string };

    expect(result.currentLeafId).toBe('entry-9999');
    let node = result.tree[0];
    for (let index = 1; index < 10_000; index += 1) node = node.children[0];
    expect(node.id).toBe('entry-9999');
    expect(node.conversationText).toBe('node 9999');
    expect(node.children).toEqual([]);
    surface.close();
  });

  it('invalidates the old replay position when a transcript snapshot is refreshed', async () => {
    const f = fixture();
    await f.surface.initialize();
    f.publish(assistantEnd('Before navigation'));
    const before = f.surface.currentCursor;
    const snapshot = f.surface.refreshSnapshot();
    expect(snapshot.cursor).toBeGreaterThan(before);
    expect(f.surface.replay(before)).toMatchObject({ kind: 'snapshot_required' });
    expect(snapshot.messages).toEqual(
      expect.arrayContaining([expect.objectContaining({ content: expect.arrayContaining([expect.objectContaining({ text: 'Before compaction' })]) })]),
    );
  });

  it('serves session-local metadata and completion results', async () => {
    const f = fixture();
    await f.surface.initialize();
    await expect(f.surface.getMeta()).resolves.toMatchObject({ lifetimeCostUsd: 0 });
    await expect(f.surface.getCommands()).resolves.toContainEqual(expect.objectContaining({ name: 'review' }));
    await expect(f.surface.completeArgs('review', 's')).resolves.toContainEqual(expect.objectContaining({ value: 'src' }));
    await expect(f.surface.completeFileRefs('@src')).resolves.toContainEqual(expect.objectContaining({ value: '@src/main.ts' }));
    await expect(f.surface.dispatch({ type: 'bash', command: 'pwd' })).resolves.toMatchObject({ result: { output: 'ran pwd' } });
  });

  it.each(['new_session', 'open_session', 'resume', 'switch_session', 'fork', 'reload', 'archive_session', 'delete_session', 'set_profile', 'call_bind', 'call_end', 'teardown'])(
    'rejects the forbidden %s command at runtime',
    async (type) => {
      const f = fixture();
      await f.surface.initialize();
      await expect(f.surface.dispatch({ type } as SessionSurfaceCommand)).rejects.toThrow();
      expect(await f.surface.getState()).toMatchObject({ sessionId: 'child-session' });
    },
  );
});
