import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WebSocket } from 'ws';
import type { ThemeCatalogSnapshot } from '../../shared/dist/index.js';
import { resolvedTheme } from '../../shared/test/theme-fixtures.js';
import { createServer, type PimoteServer } from './server.js';
import { InMemoryStaticHostRegistry } from './static-host/registry.js';
import type { ThemeCatalogListener } from './theme-catalog.js';
import { UserProfiles } from './user-profiles.js';

interface Message {
  type?: string;
  id?: string;
  [key: string]: unknown;
}

class Connection {
  readonly messages: Message[] = [];
  private readonly waiters = new Set<(message: Message) => void>();

  constructor(readonly ws: WebSocket) {
    ws.on('message', (raw) => {
      const message = JSON.parse(String(raw)) as Message;
      this.messages.push(message);
      for (const waiter of this.waiters) waiter(message);
    });
  }

  waitFor(predicate: (message: Message) => boolean, from = 0): Promise<Message> {
    const found = this.messages.slice(from).find(predicate);
    if (found) return Promise.resolve(found);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiters.delete(onMessage);
        reject(new Error('timed out waiting for WebSocket message'));
      }, 1500);
      const onMessage = (message: Message) => {
        if (!predicate(message)) return;
        clearTimeout(timer);
        this.waiters.delete(onMessage);
        resolve(message);
      };
      this.waiters.add(onMessage);
    });
  }

  async command(command: Record<string, unknown> & { id: string }): Promise<Message> {
    const response = this.waitFor((message) => message.id === command.id);
    this.ws.send(JSON.stringify(command));
    return response;
  }
}

function catalog() {
  let current: ThemeCatalogSnapshot = {
    revision: 1,
    defaultThemeId: 'pimote/light',
    themes: [resolvedTheme('pimote/light'), resolvedTheme('pimote/dark'), resolvedTheme('alice/custom', 'Custom', 'user')],
    diagnostics: [],
  };
  const listeners = new Set<ThemeCatalogListener>();
  return {
    snapshot: () => current,
    onChange: (listener: ThemeCatalogListener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    change: (next: ThemeCatalogSnapshot) => {
      current = next;
      for (const listener of listeners) listener(next);
    },
  };
}

describe('theme WebSocket protocol', () => {
  let server: PimoteServer;
  let directory: string;
  let port: number;
  let themes: ReturnType<typeof catalog>;

  beforeEach(async () => {
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    directory = await mkdtemp(join(tmpdir(), 'pimote-ws-themes-'));
    const profiles = new UserProfiles(join(directory, 'profiles.json'));
    await profiles.load();
    themes = catalog();
    server = await createServer(
      { roots: [], managerRoot: directory, idleTimeout: 60_000, bufferSize: 10, port: 0 },
      { getAllSessions: () => [] } as any,
      {} as any,
      {} as any,
      {} as any,
      undefined,
      new InMemoryStaticHostRegistry(),
      { snapshot: () => [] } as any,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      profiles,
      themes,
    );
    await server.start(0);
    port = (server.httpServer.address() as AddressInfo).port;
  });

  afterEach(async () => {
    await server?.close();
    if (directory) await rm(directory, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  async function connect(clientId: string, user: string): Promise<Connection> {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws?clientId=${encodeURIComponent(clientId)}&user=${encodeURIComponent(user)}`);
    const connection = new Connection(ws);
    await connection.waitFor((message) => message.type === 'user_sessions_changed');
    return connection;
  }

  it('keeps the catalog out of capabilities and the connect snapshot', async () => {
    const alice = await connect('alice-a', 'alice');
    expect(alice.messages.some((message) => message.type === 'server_capabilities')).toBe(true);
    expect(alice.messages.some((message) => message.type === 'user_sessions_changed')).toBe(true);
    expect(JSON.stringify(alice.messages)).not.toContain('alice/custom');
    expect(alice.messages.some((message) => message.type === 'theme_catalog_changed')).toBe(false);
  });

  it('returns the catalog on request', async () => {
    const alice = await connect('alice-a', 'alice');
    const response = await alice.command({ type: 'get_theme_catalog', id: 'catalog-1' });
    expect(response).toMatchObject({ id: 'catalog-1', success: true });
    expect(response.data).toMatchObject(themes.snapshot());
  });

  it('broadcasts a revision-only event and serves the updated catalog on request', async () => {
    const alice = await connect('alice-a', 'alice');
    const bob = await connect('bob-a', 'bob');
    const next: ThemeCatalogSnapshot = {
      ...themes.snapshot(),
      revision: 2,
      defaultThemeId: 'pimote/dark',
      themes: [...themes.snapshot().themes, resolvedTheme('example/new', 'New', 'extension')],
    };
    themes.change(next);

    const [aliceEvent, bobEvent] = await Promise.all([
      alice.waitFor((message) => message.type === 'theme_catalog_changed'),
      bob.waitFor((message) => message.type === 'theme_catalog_changed'),
    ]);
    expect(aliceEvent).toEqual({ type: 'theme_catalog_changed', revision: 2 });
    expect(bobEvent).toEqual({ type: 'theme_catalog_changed', revision: 2 });
    const response = await alice.command({ type: 'get_theme_catalog', id: 'catalog-2' });
    expect(response).toMatchObject({ id: 'catalog-2', success: true });
    expect(response.data).toMatchObject(next);
  });

  it('shares a selection across devices of the same user without changing another user', async () => {
    const aliceA = await connect('alice-a', 'alice');
    const aliceB = await connect('alice-b', 'alice');
    const bob = await connect('bob-a', 'bob');
    expect(await aliceA.waitFor((message) => message.type === 'user_sessions_changed')).toMatchObject({ selectedThemeId: null });
    expect(await bob.waitFor((message) => message.type === 'user_sessions_changed')).toMatchObject({ selectedThemeId: null });

    expect(await bob.command({ type: 'set_theme', id: 'bob-set', themeId: 'pimote/dark' })).toMatchObject({ id: 'bob-set', success: true });
    expect(await aliceA.command({ type: 'set_theme', id: 'alice-set', themeId: 'alice/custom' })).toMatchObject({ id: 'alice-set', success: true });
    expect(await aliceB.waitFor((message) => message.type === 'user_sessions_changed' && message.selectedThemeId === 'alice/custom')).toMatchObject({
      selectedThemeId: 'alice/custom',
    });

    // A request on Bob's connection establishes a delivery barrier before checking its received profile events.
    expect(await bob.command({ type: 'get_theme_catalog', id: 'bob-barrier' })).toMatchObject({ success: true });
    expect(bob.messages.filter((message) => message.type === 'user_sessions_changed')).not.toContainEqual(expect.objectContaining({ selectedThemeId: 'alice/custom' }));
    const bobReconnect = await connect('bob-b', 'bob');
    expect(await bobReconnect.waitFor((message) => message.type === 'user_sessions_changed')).toMatchObject({ selectedThemeId: 'pimote/dark' });
    const aliceReconnect = await connect('alice-c', 'alice');
    expect(await aliceReconnect.waitFor((message) => message.type === 'user_sessions_changed')).toMatchObject({ selectedThemeId: 'alice/custom' });

    const beforeClear = aliceB.messages.length;
    expect(await aliceA.command({ type: 'set_theme', id: 'alice-clear', themeId: null })).toMatchObject({ id: 'alice-clear', success: true });
    expect(await aliceB.waitFor((message) => message.type === 'user_sessions_changed' && message.selectedThemeId === null, beforeClear)).toMatchObject({ selectedThemeId: null });
    const bobAfterClear = await connect('bob-c', 'bob');
    expect(await bobAfterClear.waitFor((message) => message.type === 'user_sessions_changed')).toMatchObject({ selectedThemeId: 'pimote/dark' });
  });
});
