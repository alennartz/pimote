import { describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ExtensionFactory, ModelRuntime } from '@earendil-works/pi-coding-agent';
import type { PimoteConfig } from './config.js';
import type { PushNotificationService } from './push-notification.js';

const modelRuntime = new Proxy(
  {
    getAvailable: async () => [],
    getAvailableSnapshot: () => [],
    getAllAvailable: async () => [],
    getModels: () => [],
    getAllModels: () => [],
    getError: () => undefined,
    hasConfiguredAuth: () => false,
  } as Record<string, unknown>,
  {
    get(target, property) {
      if (property === 'then') return undefined;
      if (property in target) return target[property];
      return (..._args: unknown[]) => undefined;
    },
  },
) as unknown as ModelRuntime;

vi.mock('./git-branch.js', () => ({ getGitBranch: vi.fn(async () => null) }));
vi.mock('@earendil-works/pi-coding-agent', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@earendil-works/pi-coding-agent')>();
  return {
    ...actual,
    ModelRuntime: { create: vi.fn(async () => modelRuntime) },
  };
});

import { PimoteSessionManager } from './session-manager.js';

const config: PimoteConfig = {
  roots: [],
  managerRoot: '/tmp/pimote-real-bindings-manager',
  idleTimeout: 300_000,
  bufferSize: 100,
  port: 0,
};
const push = { notify: vi.fn(async () => {}) } as unknown as PushNotificationService;

describe('real SDK manager extension startup', () => {
  it('runs session_start and resource discovery before an unobserved open, once per runtime', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pimote-real-bindings-'));
    let starts = 0;
    let discoveries = 0;
    const probe: ExtensionFactory = (pi) => {
      pi.on('resources_discover', () => {
        discoveries++;
        return {};
      });
      pi.on('session_start', () => {
        starts++;
      });
    };

    const manager = await PimoteSessionManager.create(config, push, { staticHostFactory: probe });
    try {
      const id = await manager.openSession(root);
      expect(starts).toBe(1);
      expect(discoveries).toBe(1);
      expect(manager.getSlot(id)?.sessionState.extensionsBound).toBe(true);
      await manager.attachObserver(id, {
        clientId: 'real-test-client',
        ws: { readyState: 1, send: vi.fn() },
        cursor: 0,
        onSessionReset: null,
      });
      expect(starts).toBe(1);

      const slot = manager.getSlot(id)!;
      await slot.runtime.newSession();
      expect(starts).toBe(2);
      expect(discoveries).toBe(2);
      expect(slot.sessionState.extensionsBound).toBe(true);
    } finally {
      await manager.dispose();
      await rm(root, { recursive: true, force: true });
    }
  });
});
