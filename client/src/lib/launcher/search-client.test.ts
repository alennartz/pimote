import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FolderInfo, LauncherSessionHit, SearchLauncherResponseData } from '@pimote/shared';
import { createLauncherSearch } from './search-client.js';
import type { LauncherCommand, LauncherSearchTransport } from './contracts.js';

function folder(path: string, name: string): FolderInfo {
  return {
    path,
    name,
    nature: 'code',
    shortcutCount: 0,
    favorite: false,
    archived: false,
    tags: [],
    missing: false,
    activeSessionCount: 0,
    externalProcessCount: 0,
  };
}

function sessionHit(sessionId: string, name: string, folderPath = '/w/pimote'): LauncherSessionHit {
  return {
    sessionId,
    folderPath,
    folderName: 'pimote',
    name,
    firstMessage: name,
    modified: 1_700_000_000_000,
    archived: false,
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const sampleCommands: LauncherCommand[] = [
  { id: 'settings', label: 'Open Settings', keywords: ['config'], group: 'app', run: vi.fn() },
  { id: 'home', label: 'Go to Home', group: 'navigation', run: vi.fn() },
];

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('createLauncherSearch contract', () => {
  it('loads immediately on open and updates local commands synchronously on setQuery', async () => {
    const search = vi.fn<LauncherSearchTransport['search']>(async () => ({
      folders: [folder('/w/pimote', 'pimote')],
      sessions: [sessionHit('s1', 'keyboard work')],
    }));
    const controller = createLauncherSearch({
      transport: { search },
      getCommands: () => sampleCommands,
      debounceMs: 120,
    });

    controller.open();
    expect(search).toHaveBeenCalledTimes(1);
    expect(search).toHaveBeenLastCalledWith({ query: '', scope: 'all', limit: 10 });
    expect(controller.snapshot.commands.map((c) => c.id)).toEqual(['settings', 'home']);

    await vi.runAllTimersAsync();
    expect(controller.snapshot.loading).toBe(false);
    expect(controller.snapshot.folders.map((f) => f.path)).toEqual(['/w/pimote']);
    expect(controller.snapshot.sessions.map((s) => s.sessionId)).toEqual(['s1']);

    // Local commands filter synchronously before the debounce fires.
    controller.setQuery('conf');
    expect(controller.snapshot.commands.map((c) => c.id)).toEqual(['settings']);
    expect(search).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(120);
    expect(search).toHaveBeenCalledTimes(2);
    expect(search).toHaveBeenLastCalledWith({ query: 'conf', scope: 'all', limit: 10 });
    controller.dispose();
  });

  it('issues zero server calls in commands mode and clears folder/session results immediately', async () => {
    const search = vi.fn<LauncherSearchTransport['search']>(async () => ({
      folders: [folder('/w/pimote', 'pimote')],
      sessions: [sessionHit('s1', 'keyboard work')],
    }));
    const controller = createLauncherSearch({
      transport: { search },
      getCommands: () => sampleCommands,
      debounceMs: 120,
    });

    controller.open();
    await vi.runAllTimersAsync();
    expect(search).toHaveBeenCalledTimes(1);

    controller.setQuery('> set');
    expect(controller.snapshot.query.category).toBe('commands');
    expect(controller.snapshot.folders).toEqual([]);
    expect(controller.snapshot.sessions).toEqual([]);
    expect(controller.snapshot.commands.map((c) => c.id)).toEqual(['settings']);
    expect(controller.snapshot.loading).toBe(false);
    expect(controller.snapshot.error).toBeNull();

    await vi.advanceTimersByTimeAsync(500);
    expect(search).toHaveBeenCalledTimes(1);
    controller.dispose();
  });

  it('clears excluded categories immediately when narrowing to folders or sessions', async () => {
    const pending = deferred<SearchLauncherResponseData>();
    const search = vi
      .fn<LauncherSearchTransport['search']>()
      .mockResolvedValueOnce({
        folders: [folder('/w/pimote', 'pimote')],
        sessions: [sessionHit('s1', 'keyboard work')],
      })
      .mockReturnValueOnce(pending.promise)
      .mockReturnValueOnce(deferred<SearchLauncherResponseData>().promise);

    const controller = createLauncherSearch({
      transport: { search },
      getCommands: () => sampleCommands,
      debounceMs: 100,
    });

    controller.open();
    await vi.runAllTimersAsync();

    controller.setQuery('# pi');
    expect(controller.snapshot.sessions).toEqual([]);
    expect(controller.snapshot.commands).toEqual([]);

    await vi.advanceTimersByTimeAsync(100);
    expect(search).toHaveBeenLastCalledWith({ query: 'pi', scope: 'folders', limit: 10 });

    pending.resolve({ folders: [folder('/w/pimote', 'pimote')], sessions: [] });
    await Promise.resolve();

    controller.setQuery('@ key');
    expect(controller.snapshot.folders).toEqual([]);
    expect(controller.snapshot.commands).toEqual([]);
    await vi.advanceTimersByTimeAsync(100);
    expect(search).toHaveBeenLastCalledWith({ query: 'key', scope: 'sessions', limit: 10 });
    controller.dispose();
  });

  it('drops stale out-of-order responses and late rejections after newer queries or reset', async () => {
    const first = deferred<SearchLauncherResponseData>();
    const second = deferred<SearchLauncherResponseData>();
    const search = vi.fn<LauncherSearchTransport['search']>().mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);

    const controller = createLauncherSearch({
      transport: { search },
      getCommands: () => sampleCommands,
      debounceMs: 50,
    });

    controller.setQuery('alpha');
    await vi.advanceTimersByTimeAsync(50);

    controller.setQuery('beta');
    await vi.advanceTimersByTimeAsync(50);

    second.resolve({ folders: [folder('/w/beta', 'beta')], sessions: [] });
    await Promise.resolve();
    expect(controller.snapshot.folders.map((f) => f.path)).toEqual(['/w/beta']);

    // Stale first response arrives later and must be ignored.
    first.resolve({ folders: [folder('/w/alpha', 'alpha')], sessions: [] });
    await Promise.resolve();
    expect(controller.snapshot.folders.map((f) => f.path)).toEqual(['/w/beta']);

    // Reset invalidates any further pending work.
    const third = deferred<SearchLauncherResponseData>();
    search.mockReturnValueOnce(third.promise);
    controller.setQuery('gamma');
    await vi.advanceTimersByTimeAsync(50);
    controller.reset();

    third.reject(new Error('network lost'));
    await Promise.resolve();
    expect(controller.snapshot.error).toBeNull();
    expect(controller.snapshot.folders).toEqual([]);
    controller.dispose();
  });

  it('contains transport errors while keeping local commands usable and clears error on next query', async () => {
    const search = vi
      .fn<LauncherSearchTransport['search']>()
      .mockRejectedValueOnce(new Error('socket offline'))
      .mockResolvedValueOnce({ folders: [folder('/w/pimote', 'pimote')], sessions: [] });

    const controller = createLauncherSearch({
      transport: { search },
      getCommands: () => sampleCommands,
      debounceMs: 50,
    });

    controller.setQuery('set');
    await vi.advanceTimersByTimeAsync(50);
    await Promise.resolve();

    expect(controller.snapshot.loading).toBe(false);
    expect(controller.snapshot.error).toBeTruthy();
    expect(controller.snapshot.commands.map((c) => c.id)).toEqual(['settings']);

    controller.setQuery('pimote');
    expect(controller.snapshot.error).toBeNull();
    await vi.advanceTimersByTimeAsync(50);
    await Promise.resolve();
    expect(controller.snapshot.folders.map((f) => f.path)).toEqual(['/w/pimote']);
    controller.dispose();
  });
});
