import { describe, expect, it, vi } from 'vitest';
import { createManagerExtension } from './extension.js';
import type { ManagerToolContext } from './types.js';

type UserSummary = { name: string; sessionCount: number };
type ThemeAssignment = {
  user: string;
  selectedThemeId: string | null;
  activeThemeId: string;
  themeName: string;
  colorScheme: 'light' | 'dark';
  source: 'builtin' | 'extension' | 'user';
};
type ThemeDemoBundle = {
  folderPath: string;
  title: string;
  themeIds: string[];
  diagnostics: Array<{ path: string; message: string; themeId?: string; source?: 'builtin' | 'extension' | 'user' }>;
};

type ThemePort = {
  listKnownUsers: () => UserSummary[];
  setKnownUserTheme: (user: string, themeId: string | null) => Promise<ThemeAssignment>;
  prepareDemo: (themeFile: string) => Promise<ThemeDemoBundle>;
};

type FakeTool = {
  name: string;
  exposure?: string;
  parameters: { additionalProperties?: boolean; properties?: Record<string, unknown> };
  execute: (...args: unknown[]) => Promise<{ structuredContent: any; isError?: boolean }>;
};

type FakePi = {
  tools: FakeTool[];
  api: any;
  activeTools: string[];
  sessionStart: (() => void | Promise<void>) | undefined;
};

function makeFakePi(): FakePi {
  const tools: FakeTool[] = [];
  const activeTools = ['read', 'bash', 'edit', 'write'];
  const fake: FakePi = { tools, api: undefined, activeTools, sessionStart: undefined };
  fake.api = {
    registerTool(def: FakeTool) {
      tools.push(def);
    },
    on(event: string, handler: () => void | Promise<void>) {
      if (event === 'session_start') fake.sessionStart = handler;
    },
    getActiveTools: vi.fn(() => [...activeTools]),
    setActiveTools: vi.fn((next: string[]) => {
      activeTools.splice(0, activeTools.length, ...next);
    }),
    events: { emit() {}, on: () => () => {} },
  };
  return fake;
}

function toolNamed(tools: FakeTool[], name: string): FakeTool {
  const tool = tools.find((candidate) => candidate.name === name);
  if (!tool) throw new Error(`${name} was not registered`);
  return tool;
}

function registerThemeTools(themePort: ThemePort): FakePi {
  const fake = makeFakePi();
  createManagerExtension({ themes: themePort } as unknown as ManagerToolContext)(fake.api);
  return fake;
}

function assignment(user: string, selectedThemeId: string | null): ThemeAssignment {
  return {
    user,
    selectedThemeId,
    activeThemeId: selectedThemeId ?? 'pimote/light',
    themeName: selectedThemeId === 'pimote/dark' ? 'Pimote Dark' : 'Pimote Light',
    colorScheme: selectedThemeId === 'pimote/dark' ? 'dark' : 'light',
    source: 'builtin',
  };
}

describe('manager theme tools', () => {
  it('registers theme tools as deferred and activates tool search after all extensions load', async () => {
    const themePort: ThemePort = {
      listKnownUsers: vi.fn(() => []),
      setKnownUserTheme: vi.fn(async (user, themeId) => assignment(user, themeId)),
      prepareDemo: vi.fn(async () => ({ folderPath: '/tmp/theme-demo', title: 'Theme demo', themeIds: [], diagnostics: [] })),
    };
    const fake = registerThemeTools(themePort);

    expect(toolNamed(fake.tools, 'pimote_set_theme').exposure).toBe('deferred');
    expect(toolNamed(fake.tools, 'pimote_theme_demo').exposure).toBe('deferred');
    expect(fake.sessionStart).toBeDefined();

    await fake.sessionStart?.();
    expect(fake.api.setActiveTools).toHaveBeenCalledWith(['read', 'bash', 'edit', 'write', 'tool_search']);
  });

  it('sets an explicitly named known user', async () => {
    const themePort: ThemePort = {
      listKnownUsers: vi.fn(() => [{ name: 'alice', sessionCount: 2 }]),
      setKnownUserTheme: vi.fn(async (user, themeId) => assignment(user, themeId)),
      prepareDemo: vi.fn(),
    };
    const tool = toolNamed(registerThemeTools(themePort).tools, 'pimote_set_theme');

    const result = await tool.execute('call-1', { user: 'alice', themeId: 'pimote/dark' }, undefined, undefined, {});

    expect(themePort.setKnownUserTheme).toHaveBeenCalledWith('alice', 'pimote/dark');
    expect(result.structuredContent).toEqual(assignment('alice', 'pimote/dark'));
    expect(result.isError).toBeUndefined();
  });

  it('uses default when it is the sole known user and user is omitted', async () => {
    const themePort: ThemePort = {
      listKnownUsers: vi.fn(() => [{ name: 'default', sessionCount: 1 }]),
      setKnownUserTheme: vi.fn(async (user, themeId) => assignment(user, themeId)),
      prepareDemo: vi.fn(),
    };
    const tool = toolNamed(registerThemeTools(themePort).tools, 'pimote_set_theme');

    await tool.execute('call-1', { themeId: 'pimote/dark' }, undefined, undefined, {});

    expect(themePort.setKnownUserTheme).toHaveBeenCalledWith('default', 'pimote/dark');
  });

  it('rejects an explicitly blank user even when default is the sole known user', async () => {
    const users = [{ name: 'default', sessionCount: 1 }];
    const themePort: ThemePort = {
      listKnownUsers: vi.fn(() => users),
      setKnownUserTheme: vi.fn(),
      prepareDemo: vi.fn(),
    };
    const tool = toolNamed(registerThemeTools(themePort).tools, 'pimote_set_theme');

    const result = await tool.execute('call-1', { user: ' ', themeId: 'pimote/dark' }, undefined, undefined, {});

    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({ users, error: expect.stringMatching(/known user/i) });
    expect(themePort.setKnownUserTheme).not.toHaveBeenCalled();
  });

  it.each([
    ['no known users', []],
    [
      'multiple known users',
      [
        { name: 'alice', sessionCount: 1 },
        { name: 'bob', sessionCount: 1 },
      ],
    ],
    ['one non-default known user', [{ name: 'alice', sessionCount: 1 }]],
  ])('rejects omitted user with %s and returns the known users', async (_label, users) => {
    const themePort: ThemePort = {
      listKnownUsers: vi.fn(() => users),
      setKnownUserTheme: vi.fn(),
      prepareDemo: vi.fn(),
    };
    const tool = toolNamed(registerThemeTools(themePort).tools, 'pimote_set_theme');

    const result = await tool.execute('call-1', { themeId: 'pimote/dark' }, undefined, undefined, {});

    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({ users });
    expect(result.structuredContent.error).toMatch(/specify.*user/i);
    expect(themePort.setKnownUserTheme).not.toHaveBeenCalled();
  });

  it('rejects an explicit unknown user without calling the theme port', async () => {
    const users = [{ name: 'alice', sessionCount: 2 }];
    const themePort: ThemePort = {
      listKnownUsers: vi.fn(() => users),
      setKnownUserTheme: vi.fn(),
      prepareDemo: vi.fn(),
    };
    const tool = toolNamed(registerThemeTools(themePort).tools, 'pimote_set_theme');

    const result = await tool.execute('call-1', { user: 'bob', themeId: null }, undefined, undefined, {});

    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({ users, error: expect.stringMatching(/known user/i) });
    expect(themePort.setKnownUserTheme).not.toHaveBeenCalled();
  });

  it('returns the known-user list when the theme port rejects a valid user request', async () => {
    const users = [{ name: 'alice', sessionCount: 2 }];
    const themePort: ThemePort = {
      listKnownUsers: vi.fn(() => users),
      setKnownUserTheme: vi.fn(async () => {
        throw new Error('Unknown theme: alice/missing');
      }),
      prepareDemo: vi.fn(),
    };
    const tool = toolNamed(registerThemeTools(themePort).tools, 'pimote_set_theme');

    const result = await tool.execute('call-1', { user: 'alice', themeId: 'alice/missing' }, undefined, undefined, {});

    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({ users, error: expect.stringMatching(/unknown theme/i) });
  });

  it('prepares a theme demo and delegates bundle hosting to the existing static-host tool', async () => {
    const bundle: ThemeDemoBundle = {
      folderPath: '/tmp/theme-demo-draft',
      title: 'Theme demo: draft.json',
      themeIds: ['alice/custom'],
      diagnostics: [{ path: '/tmp/draft.json', message: 'one invalid entry', themeId: 'alice/broken', source: 'user' }],
    };
    const themePort: ThemePort = {
      listKnownUsers: vi.fn(() => []),
      setKnownUserTheme: vi.fn(),
      prepareDemo: vi.fn(async () => bundle),
    };
    const fake = registerThemeTools(themePort);
    const executeTool = vi.fn(async (name: string, args: Record<string, unknown>) => {
      expect(name).toBe('pimote_static_host');
      expect(args).toEqual(expect.objectContaining({ folder: bundle.folderPath, title: bundle.title }));
      return { result: { structuredContent: { slug: 'theme-demo', url: '/s/theme-demo/' } } };
    });
    const tool = toolNamed(fake.tools, 'pimote_theme_demo');

    const result = await tool.execute('call-1', { path: '/tmp/draft.json' }, undefined, undefined, { executeTool });

    expect(themePort.prepareDemo).toHaveBeenCalledWith('/tmp/draft.json', undefined);
    expect(executeTool).toHaveBeenCalledTimes(1);
    expect(result.structuredContent).toEqual({
      slug: 'theme-demo',
      url: '/s/theme-demo/',
      themeIds: bundle.themeIds,
      diagnostics: bundle.diagnostics,
    });
  });
});
