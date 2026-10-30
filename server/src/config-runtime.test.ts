import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ConfigRuntime } from './config-runtime.js';
import type { PimoteConfig } from './config.js';

let dir: string;
let path: string;
const initial: PimoteConfig = { roots: ['/roots'], managerRoot: '/manager', port: 3000, idleTimeout: 1000, bufferSize: 100, tagSnippets: ['old'] };
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'config-runtime-'));
  path = join(dir, 'config.json');
  await writeFile(path, JSON.stringify(initial));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});
const runtime = () => new ConfigRuntime({ configPath: path, config: initial });

describe('Native config runtime', () => {
  it.each(['{', '[]', '{"roots":[]}', '{"roots":["/roots"],"settingsFiles":[3]}', '{"roots":["/roots"],"tagSnippets":[3]}'])(
    'rejects invalid native config %s without changing disk or live state',
    async (content) => {
      const config = runtime();
      await expect(config.putFile(path, content)).rejects.toThrow();
      expect(await readFile(path, 'utf8')).toBe(JSON.stringify(initial));
      expect(config.snapshot().tagSnippets).toEqual(['old']);
    },
  );

  it('accepts omitted settingsFiles and preserves configured order when present', () => {
    const config = runtime();
    expect(config.validate('{"roots":["/roots"]}').settingsFiles).toBeUndefined();
    expect(config.validate('{"roots":["/roots"],"settingsFiles":["b.md","a.md"]}').settingsFiles).toEqual(['b.md', 'a.md']);
  });

  it('reloads settings, future-session defaults, idle policy, and new-buffer policy', () => {
    const config = runtime();
    const candidate = {
      ...initial,
      settingsFiles: ['extra.md'],
      tagSnippets: ['new'],
      defaultProvider: 'provider',
      defaultModel: 'model',
      defaultThinkingLevel: 'high',
      defaultInterpreterModel: 'voice/model',
      defaultWorkerModel: 'worker/model',
      idleTimeout: 2000,
      bufferSize: 200,
    };
    const applied = config.apply(candidate);
    for (const field of [
      'settingsFiles',
      'tagSnippets',
      'defaultProvider',
      'defaultModel',
      'defaultThinkingLevel',
      'defaultInterpreterModel',
      'defaultWorkerModel',
      'idleTimeout',
      'bufferSize',
    ] as const) {
      expect(applied[field]).toEqual(candidate[field]);
    }
  });

  it('preserves startup-only roots, manager, listener, VAPID, and voice transport', () => {
    const original = {
      ...initial,
      vapidPublicKey: 'public',
      vapidPrivateKey: 'private',
      vapidEmail: 'old@example.com',
      voice: { speechmuxSignalUrl: 'wss://old', speechmuxLlmWsUrl: 'ws://old' },
    };
    const config = new ConfigRuntime({ configPath: path, config: original });
    const applied = config.apply({
      ...original,
      roots: ['/changed'],
      managerRoot: '/changed',
      port: 9999,
      vapidPublicKey: 'changed',
      vapidPrivateKey: 'changed',
      vapidEmail: 'new@example.com',
      voice: { speechmuxSignalUrl: 'wss://new' },
    });
    for (const field of ['roots', 'managerRoot', 'port', 'vapidPublicKey', 'vapidPrivateKey', 'vapidEmail', 'voice'] as const) expect(applied[field]).toEqual(original[field]);
  });

  it('identifies the native target through symlinks without treating Pi or third-party settings as native', async () => {
    const alias = join(dir, 'alias.json');
    await symlink(path, alias);
    const config = runtime();
    expect(await config.isNativeConfig(alias)).toBe(true);
    expect(await config.isNativeConfig(join(dir, 'pi/settings.json'))).toBe(false);
    expect(await config.isNativeConfig(join(dir, 'third-party.json'))).toBe(false);
  });

  it('writes validated native contents and advertises the reloaded tag palette', async () => {
    const config = runtime();
    const content = JSON.stringify({ ...initial, tagSnippets: ['purpose', 'context'], settingsFiles: ['extra.md'] });
    await config.putFile(path, content);
    expect(await readFile(path, 'utf8')).toBe(content);
    expect(config.capabilities().tagSnippets).toEqual(['purpose', 'context']);
    expect(config.snapshot().settingsFiles).toEqual(['extra.md']);
  });

  it('retains generic last-write-wins writes for non-native files without config validation or reload', async () => {
    const config = runtime();
    const ordinary = join(dir, 'settings.json');
    await config.putFile(ordinary, 'not JSON');
    await config.putFile(ordinary, 'last contents');
    expect(await readFile(ordinary, 'utf8')).toBe('last contents');
    expect(config.capabilities().tagSnippets).toEqual(['old']);
  });

  it('advertises voice availability and an empty palette when snippets are absent', () => {
    const config = new ConfigRuntime({ configPath: path, config: { ...initial, tagSnippets: undefined } });
    expect(config.capabilities()).toMatchObject({ type: 'server_capabilities', voice: false, tagSnippets: [] });
  });
});
