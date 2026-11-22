import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Value } from 'typebox/value';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ExtensionAPI, ExtensionContext, ToolDefinition } from '@earendil-works/pi-coding-agent';
import { AppService, createAppsExtension, FileAppStore, type AppRouteReconciler } from './index.js';

function createMockContext(sessionId = 'sess-123', cwd = '/srv/project'): ExtensionContext {
  return {
    cwd,
    sessionManager: {
      getSessionId: () => sessionId,
    },
  } as unknown as ExtensionContext;
}

describe('createAppsExtension', () => {
  let dir: string;
  let service: AppService;
  let tools: Map<string, ToolDefinition<any, any>>;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'pimote-apps-ext-'));
    const reconciler: AppRouteReconciler = { reconcile: async () => undefined };
    service = new AppService({
      config: {
        publicUrlTemplate: 'https://{slug}.apps.example.com',
        caddyAdminUrl: 'http://127.0.0.1:2019',
        caddyListen: '127.0.0.1:8080',
        caddyServerName: 'pimote_apps',
      },
      pimotePort: 3000,
      store: new FileAppStore(join(dir, 'apps.json')),
      reconciler,
    });
    await service.initialize();

    tools = new Map();
    const api = {
      registerTool: (def: ToolDefinition<any, any>) => {
        tools.set(def.name, def);
      },
    } as unknown as ExtensionAPI;

    createAppsExtension({ service })(api);
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('registers direct register, list, and remove tools with valid output schemas', async () => {
    expect([...tools.keys()].sort()).toEqual(['pimote_app_list', 'pimote_app_register', 'pimote_app_remove']);

    const registerTool = tools.get('pimote_app_register')!;
    const listTool = tools.get('pimote_app_list')!;
    const removeTool = tools.get('pimote_app_remove')!;

    expect(registerTool.exposure).toBe('direct');
    expect(listTool.exposure).toBe('direct');
    expect(removeTool.exposure).toBe('direct');

    const ctx = createMockContext();
    const regResult = await registerTool.execute('call-1', { slug: 'calc', title: 'Calculator', target: 'http://127.0.0.1:5173' }, undefined, undefined, ctx);
    expect(regResult.isError).toBeUndefined();
    expect(Value.Check(registerTool.outputSchema!, regResult.structuredContent)).toBe(true);
    expect(regResult.structuredContent).toMatchObject({
      app: {
        slug: 'calc',
        url: 'https://calc.apps.example.com',
        createdBySessionId: 'sess-123',
        folderPath: '/srv/project',
      },
      sync: { status: 'synced' },
    });

    const listResult = await listTool.execute('call-2', {}, undefined, undefined, ctx);
    expect(Value.Check(listTool.outputSchema!, listResult.structuredContent)).toBe(true);
    expect((listResult.structuredContent as { apps: unknown[] }).apps).toHaveLength(1);

    const removeResult = await removeTool.execute('call-3', { slug: 'calc' }, undefined, undefined, ctx);
    expect(Value.Check(removeTool.outputSchema!, removeResult.structuredContent)).toBe(true);
    expect(removeResult.structuredContent).toMatchObject({ removed: true, sync: { status: 'synced' } });
  });

  it('normalizes blank optional description in prepareArguments while keeping overwrite=false', () => {
    const registerTool = tools.get('pimote_app_register')!;
    const prepared = registerTool.prepareArguments!({
      slug: 'demo',
      title: 'Demo',
      target: 'http://127.0.0.1:5173',
      description: '   ',
      overwrite: false,
    });
    expect(prepared).toEqual({
      slug: 'demo',
      title: 'Demo',
      target: 'http://127.0.0.1:5173',
      overwrite: false,
    });
  });

  it('returns isError for validation failures and throws AbortError when cancelled', async () => {
    const registerTool = tools.get('pimote_app_register')!;
    const ctx = createMockContext();

    const blocked = await registerTool.execute('call-1', { slug: 'bad', title: 'Bad', target: 'http://127.0.0.1:3000' }, undefined, undefined, ctx);
    expect(blocked.isError).toBe(true);

    const controller = new AbortController();
    controller.abort();
    await expect(registerTool.execute('call-2', { slug: 'ok', title: 'Ok', target: 'http://127.0.0.1:5173' }, controller.signal, undefined, ctx)).rejects.toMatchObject({
      name: 'AbortError',
    });
  });
});
