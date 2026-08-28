import { afterEach, describe, expect, it, vi } from 'vitest';
import { InMemoryStaticHostRegistry } from './static-host/registry.js';
import type { DownloadManager } from './file-download/manager.js';
import { createServer, type PimoteServer } from './server.js';
import type { UpdateStatus } from './update-check.js';

function makeDownloads(): DownloadManager {
  return {
    activate: vi.fn(),
    deactivate: vi.fn(),
    offer: vi.fn(),
    cancel: vi.fn(),
    claim: vi.fn(),
    snapshot: vi.fn(() => []),
  };
}

const status: UpdateStatus = {
  currentVersion: '1.0.0',
  latestVersion: '1.2.0',
  releaseUrl: 'https://github.com/alennartz/pimote/releases/tag/pimote-v1.2.0',
};

describe('createServer — update notification wiring', () => {
  let server: PimoteServer | undefined;

  afterEach(async () => {
    await server?.close();
  });

  it('checks after the version gate and sends a non-null update to the accepted connection', async () => {
    const getStatus = vi.fn(async () => status);
    const wsHandlers = new Map<string, (...args: any[]) => void>();
    const ws = {
      readyState: 1,
      send: vi.fn(),
      on: vi.fn((event: string, handler: (...args: any[]) => void) => {
        wsHandlers.set(event, handler);
      }),
    };

    server = await createServer(
      { roots: [], idleTimeout: 60_000, bufferSize: 10, port: 0 },
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      undefined,
      new InMemoryStaticHostRegistry(),
      makeDownloads(),
      { getStatus },
    );
    await server.start(0);

    server.wss.emit('connection', ws as any, { url: '/ws?clientId=client-1' } as any);
    await Promise.resolve();
    await Promise.resolve();

    expect(getStatus).toHaveBeenCalledOnce();
    const sentEvents = ws.send.mock.calls.map(([payload]) => JSON.parse(payload as string));
    expect(sentEvents).toContainEqual({ type: 'update_available', ...status });
  });

  it('does not emit an update event when no checker is configured', async () => {
    const wsHandlers = new Map<string, (...args: any[]) => void>();
    const ws = {
      readyState: 1,
      send: vi.fn(),
      on: vi.fn((event: string, handler: (...args: any[]) => void) => {
        wsHandlers.set(event, handler);
      }),
    };

    server = await createServer(
      { roots: [], idleTimeout: 60_000, bufferSize: 10, port: 0 },
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      undefined,
      new InMemoryStaticHostRegistry(),
      makeDownloads(),
    );
    await server.start(0);

    server.wss.emit('connection', ws as any, { url: '/ws?clientId=client-without-checker' } as any);
    await Promise.resolve();
    await Promise.resolve();

    expect(server.clientRegistry.has('client-without-checker')).toBe(true);
    expect(ws.send).not.toHaveBeenCalled();
  });
});
