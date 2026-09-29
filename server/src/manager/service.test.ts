import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { AgentSession } from '@earendil-works/pi-coding-agent';
import { ManagerService, type ManagerSession, type ManagerSessionFactory } from './service.js';
import type { ManagerToolContext } from './types.js';

let clock: number;

beforeEach(() => {
  clock = 1_000;
});

function fakeContext(): ManagerToolContext {
  return {
    sessions: { getAllSessions: () => [] },
    projects: { list: async () => [] },
    repos: { list: async () => [] },
    config: { roots: ['/tmp'], idleTimeout: 1_000, bufferSize: 10, port: 3000 },
  };
}

function makeFakeSession(): ManagerSession {
  return {
    session: {} as AgentSession,
    onEvent: () => () => {},
    dispose: vi.fn(),
  };
}

function makeService(factory: ManagerSessionFactory, options: { idleTimeoutMs?: number } = {}): ManagerService {
  return new ManagerService({
    context: fakeContext(),
    factory,
    options: { now: () => clock, idleTimeoutMs: 5_000, ...options },
  });
}

describe('ManagerService.getOrCreate()', () => {
  it('creates the manager session on first use and reuses it for the same connection', async () => {
    const factory = vi.fn<ManagerSessionFactory>(async () => makeFakeSession());
    const service = makeService(factory);

    const first = await service.getOrCreate('client-1');
    const second = await service.getOrCreate('client-1');

    expect(second).toBe(first);
    expect(factory).toHaveBeenCalledTimes(1);
    expect(factory).toHaveBeenCalledWith({ clientId: 'client-1' });
  });

  it('keeps a separate manager session per connection', async () => {
    const factory = vi.fn<ManagerSessionFactory>(async () => makeFakeSession());
    const service = makeService(factory);

    const forClient1 = await service.getOrCreate('client-1');
    const forClient2 = await service.getOrCreate('client-2');

    expect(forClient2).not.toBe(forClient1);
    expect(factory).toHaveBeenCalledTimes(2);
  });
});

describe('ManagerService.disposeClient()', () => {
  it('disposes the session on disconnect and recreates it on next use', async () => {
    const first = makeFakeSession();
    const second = makeFakeSession();
    const factory = vi.fn<ManagerSessionFactory>().mockResolvedValueOnce(first).mockResolvedValueOnce(second);
    const service = makeService(factory);

    await service.getOrCreate('client-1');
    service.disposeClient('client-1');

    expect(first.dispose).toHaveBeenCalledTimes(1);

    const recreated = await service.getOrCreate('client-1');
    expect(recreated).toBe(second);
    expect(factory).toHaveBeenCalledTimes(2);
  });

  it('tolerates disposing a connection that never used the manager', () => {
    const service = makeService(vi.fn<ManagerSessionFactory>(async () => makeFakeSession()));
    expect(() => service.disposeClient('client-never-seen')).not.toThrow();
  });
});

describe('ManagerService.sweepIdle()', () => {
  it('reaps manager sessions idle beyond the timeout', async () => {
    const idle = makeFakeSession();
    const fresh = makeFakeSession();
    const factory = vi.fn<ManagerSessionFactory>().mockResolvedValueOnce(idle).mockResolvedValueOnce(fresh);
    const service = makeService(factory);

    await service.getOrCreate('client-1');

    clock = 1_000 + 3_000;
    service.sweepIdle();
    expect(idle.dispose).not.toHaveBeenCalled();

    clock = 1_000 + 6_000;
    service.sweepIdle();
    expect(idle.dispose).toHaveBeenCalledTimes(1);

    const recreated = await service.getOrCreate('client-1');
    expect(recreated).toBe(fresh);
  });

  it('does not reap sessions that were used recently', async () => {
    const session = makeFakeSession();
    const factory = vi.fn<ManagerSessionFactory>(async () => session);
    const service = makeService(factory);

    await service.getOrCreate('client-1');
    clock = 1_000 + 4_999;
    service.sweepIdle();

    expect(session.dispose).not.toHaveBeenCalled();
  });
});
