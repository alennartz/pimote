import { describe, expect, it } from 'vitest';
import type { AgentSessionEvent } from '@earendil-works/pi-coding-agent';
import type { BorrowedAgentSession } from '@pimote/sdk/subagents';
import type { PimoteSessionEvent } from '../../shared/dist/index.js';
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
      return [recent.message];
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
    async prompt(text: string, options?: { preflightResult?: (value: 'started') => void }) {
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
  return { surface, data, publish };
}

function assistantEnd(text: string): AgentSessionEvent {
  return { type: 'message_end', message: message('assistant', text) } as AgentSessionEvent;
}

describe('SessionSurface', () => {
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
