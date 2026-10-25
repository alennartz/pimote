import { describe, expect, it, vi } from 'vitest';
import { createCommandContextActions, runSlotLifecycle, SessionLifecycleError, type ManagedSlot, type SessionState } from './session-manager.js';

function deferred<T = void>(): { promise: Promise<T>; resolve(value: T): void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((next) => {
    resolve = next;
  });
  return { promise, resolve };
}

function createSlot(runtime: any): ManagedSlot {
  const session = runtime.session;
  const state = {
    id: session.sessionId,
    eventBuffer: {} as any,
    status: 'idle',
    needsAttention: false,
    idleSince: Date.now(),
    unsubscribe: () => {},
    pendingUiResponses: new Map(),
    extensionsBound: true,
    sessionIdentity: session,
    panelState: new Map(),
    downloads: [],
    panelListenerUnsubs: [],
    panelThrottleTimer: null,
    treeNavigationInProgress: false,
    queueOwnership: {} as any,
  } satisfies SessionState;
  return {
    runtime,
    folderPath: '/tmp/project',
    eventBusRef: { current: null },
    observers: new Map(),
    sessionState: state,
    get session() {
      return this.runtime.session;
    },
  };
}

describe('slot lifecycle admission', () => {
  it.each(['newSession', 'fork', 'switchSession'] as const)('rejects a concurrent extension %s without entering the runtime', async (method) => {
    const gate = deferred();
    const runtime: any = {
      session: { sessionId: 'session-1', navigateTree: vi.fn(async () => ({ cancelled: false })) },
      [method]: vi.fn(async () => {
        await gate.promise;
        return { cancelled: false };
      }),
    };
    const slot = createSlot(runtime);
    const actions = createCommandContextActions(slot, { applySessionReset: vi.fn(async () => {}) } as any);

    const first = method === 'fork' ? actions.fork('entry-1') : method === 'switchSession' ? actions.switchSession('/tmp/other.jsonl') : actions.newSession();
    await Promise.resolve();
    const second = method === 'fork' ? actions.fork('entry-2') : method === 'switchSession' ? actions.switchSession('/tmp/third.jsonl') : actions.newSession();

    await expect(second).rejects.toBeInstanceOf(SessionLifecycleError);
    expect(runtime[method]).toHaveBeenCalledOnce();
    gate.resolve(undefined);
    await first;
  });

  it('rejects a concurrent extension tree action before a second navigation starts', async () => {
    const gate = deferred();
    const navigateTree = vi.fn(async () => {
      await gate.promise;
      return { cancelled: false };
    });
    const slot = createSlot({ session: { sessionId: 'session-1', navigateTree } });
    const actions = createCommandContextActions(slot, { applySessionReset: vi.fn(async () => {}) } as any);

    const first = actions.navigateTree('entry-1');
    await Promise.resolve();
    const second = actions.navigateTree('entry-2');

    await expect(second).rejects.toThrow('session_reset_in_progress');
    expect(navigateTree).toHaveBeenCalledOnce();
    gate.resolve(undefined);
    await first;
  });

  it('rejects same-context sibling resets', async () => {
    const gate = deferred();
    const slot = createSlot({ session: { sessionId: 'session-1' } });

    await runSlotLifecycle(
      slot,
      'reset',
      async () => {
        const first = runSlotLifecycle(
          slot,
          'reset',
          async () => {
            await gate.promise;
          },
          { allowPreparingNested: true },
        );
        const second = runSlotLifecycle(slot, 'reset', async () => {});

        await expect(second).rejects.toThrow('session_reset_in_progress');
        gate.resolve(undefined);
        await first;
      },
      { allowPreparingNested: true },
    );

    await expect(runSlotLifecycle(slot, 'reset', async () => 'next')).resolves.toBe('next');
  });

  it('releases a detached nested reset after it settles', async () => {
    const gate = deferred();
    const slot = createSlot({ session: { sessionId: 'session-1' } });
    let nested!: Promise<void>;

    await runSlotLifecycle(
      slot,
      'reset',
      async () => {
        nested = runSlotLifecycle(
          slot,
          'reset',
          async () => {
            await gate.promise;
          },
          { allowPreparingNested: true },
        );
      },
      { allowPreparingNested: true },
    );

    await expect(runSlotLifecycle(slot, 'reset', async () => {})).rejects.toThrow('session_reset_in_progress');
    gate.resolve(undefined);
    await nested;
    await expect(runSlotLifecycle(slot, 'reset', async () => 'next')).resolves.toBe('next');
  });

  it('rejects a stale inherited context after its frame completes', async () => {
    const slot = createSlot({ session: { sessionId: 'session-1' } });
    let staleAttempt!: Promise<unknown>;

    await runSlotLifecycle(slot, 'reset', async () => {
      await runSlotLifecycle(
        slot,
        'reset',
        async () => {
          staleAttempt = new Promise((resolve) => {
            setTimeout(async () => {
              try {
                await runSlotLifecycle(slot, 'reset', async () => {});
                resolve('allowed');
              } catch (error) {
                resolve(error);
              }
            }, 0);
          });
        },
        { allowPreparingNested: true },
      );

      const result = await staleAttempt;
      expect(result).toBeInstanceOf(SessionLifecycleError);
    });
  });

  it('rejects close while reset is active and admits the next reset after failure', async () => {
    const gate = deferred();
    const slot = createSlot({ session: { sessionId: 'session-1' } });
    const first = runSlotLifecycle(slot, 'reset', async () => {
      await gate.promise;
      throw new Error('factory failed');
    });

    await Promise.resolve();
    await expect(runSlotLifecycle(slot, 'close', async () => {})).rejects.toThrow('session_reset_in_progress');
    gate.resolve(undefined);
    await expect(first).rejects.toThrow('factory failed');

    await expect(runSlotLifecycle(slot, 'reset', async () => 'next')).resolves.toBe('next');
  });

  it('allows nested reset operations from the admitted extension context', async () => {
    const slot = createSlot({ session: { sessionId: 'session-1' } });
    const order: string[] = [];

    await runSlotLifecycle(
      slot,
      'reset',
      async () => {
        order.push('outer-start');
        await runSlotLifecycle(
          slot,
          'reset',
          async () => {
            order.push('inner');
          },
          { allowPreparingNested: true },
        );
        order.push('outer-end');
      },
      { allowPreparingNested: true },
    );

    expect(order).toEqual(['outer-start', 'inner', 'outer-end']);
  });
});
