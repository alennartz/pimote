import { describe, it, expect, vi } from 'vitest';
import { createManagerExtension } from './extension.js';
import type { ManagerToolContext } from './types.js';

// Minimal fake ExtensionAPI: records registerTool defs and hands back
// observable port-routing behavior when the tests drive `execute` directly.
function makeFakePi(): { toolDefs: Array<{ name: string; execute: (...args: unknown[]) => unknown }>; api: any } {
  const toolDefs: Array<{ name: string; execute: (...args: unknown[]) => unknown }> = [];
  const api = {
    registerTool(def: any) {
      toolDefs.push(def);
    },
    on() {},
    events: { emit() {}, on: () => () => {} },
  };
  return { toolDefs, api: api as any };
}

const MANAGER_TOOL_NAMES = ['pimote_list_projects', 'pimote_list_repos', 'pimote_list_sessions'];

function spyPorts() {
  return {
    sessions: { getAllSessions: vi.fn(() => []) },
    projects: { list: vi.fn(async () => []) },
    repos: { list: vi.fn(async () => []) },
  };
}

function makeContext(ports: ReturnType<typeof spyPorts>): ManagerToolContext {
  return { ...ports, config: { roots: ['/tmp'], idleTimeout: 1_000, bufferSize: 10, port: 3000 } };
}

describe('createManagerExtension()', () => {
  it('registers exactly the pinned pimote toolset on the extension API', () => {
    const { toolDefs, api } = makeFakePi();
    const factory = createManagerExtension(makeContext(spyPorts()));

    factory(api);

    expect(toolDefs.map((t) => t.name)).toEqual(MANAGER_TOOL_NAMES);
  });

  it('routes each listing tool through the injected context ports', async () => {
    const ports = spyPorts();
    const { toolDefs, api } = makeFakePi();
    createManagerExtension(makeContext(ports))(api);

    for (const name of MANAGER_TOOL_NAMES) {
      const def = toolDefs.find((t) => t.name === name);
      expect(def, name).toBeDefined();
      await def!.execute('call-1', {}, undefined, undefined, {});
    }

    expect(ports.projects.list).toHaveBeenCalledTimes(1);
    expect(ports.repos.list).toHaveBeenCalledTimes(1);
    expect(ports.sessions.getAllSessions).toHaveBeenCalledTimes(1);
  });
});
