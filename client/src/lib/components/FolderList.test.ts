// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mount, tick, unmount } from 'svelte';
import type { FolderInfo, RepoInfo, SessionInfo } from '@pimote/shared';

// bits-ui popper layers expect browser APIs jsdom doesn't ship.
class TestResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}
globalThis.ResizeObserver ??= TestResizeObserver as unknown as typeof ResizeObserver;
Element.prototype.scrollIntoView ??= () => {};

vi.mock('$lib/stores/connection.svelte.js', () => {
  // Module-scope stores register listeners (onEvent/onDisconnect/…) at import
  // time; answer any such call with a no-op spy.
  const base: Record<string, unknown> = { status: 'connected', send: vi.fn(async () => ({ success: true, data: {} })) };
  const connection = new Proxy(base, {
    get(target, prop) {
      if (typeof prop !== 'string') return undefined;
      if (prop in target) return target[prop];
      const fn = vi.fn();
      target[prop] = fn;
      return fn;
    },
  });
  return { connection };
});

const { connection } = await import('$lib/stores/connection.svelte.js');
const { default: FolderList } = await import('./FolderList.svelte');
const { folderStore } = await import('$lib/stores/folder-store.svelte.js');
const { sessionRegistry } = await import('$lib/stores/session-registry.svelte.js');

function makeFolder(overrides: Partial<FolderInfo> & Pick<FolderInfo, 'path' | 'name'>): FolderInfo {
  return {
    nature: 'code',
    shortcutCount: 0,
    favorite: false,
    archived: false,
    tags: [],
    missing: false,
    activeSessionCount: 0,
    externalProcessCount: 0,
    ...overrides,
  };
}

const alpha = makeFolder({ path: '/w/alpha', name: 'alpha', tags: ['web', 'ci'], userTags: ['web'] });

const activeSession: SessionInfo = {
  id: 'sess-active',
  name: 'Active session',
  created: '2026-01-01T00:00:00.000Z',
  modified: '2026-01-01T00:00:00.000Z',
  messageCount: 3,
};

const idleSession: SessionInfo = {
  id: 'sess-idle',
  name: 'Idle session',
  created: '2025-12-01T00:00:00.000Z',
  modified: '2025-12-01T00:00:00.000Z',
  messageCount: 1,
};

// Open in the server's memory, but bound to a different client's connection.
const remoteSession: SessionInfo = {
  id: 'sess-remote',
  name: 'Remote session',
  created: '2026-01-02T00:00:00.000Z',
  modified: '2026-01-02T00:00:00.000Z',
  messageCount: 2,
  liveStatus: 'working',
  isOwnedByMe: false,
};

const memberRepo: RepoInfo = { path: '/w/one', name: 'one', branch: 'main', dirty: false, ahead: 0, behind: 0, missing: false };

// Registry/source hub: `repos` marks disband-eligible membership.
const hub = makeFolder({ path: '/w/stack', name: 'stack', shortcutCount: 2, repos: [memberRepo] });

// Generic shortcut-bearing folder: hub icon, no registry membership, no disband rights.
const shortcutHub = makeFolder({ path: '/w/links', name: 'links', shortcutCount: 1 });

const persona = makeFolder({
  path: '/w/personas/ada-dir',
  name: 'ada-dir',
  nature: 'persona',
  persona: { name: 'Ada', description: 'Research assistant' },
});

const personaHub = makeFolder({
  path: '/w/personas/team',
  name: 'team',
  nature: 'persona',
  persona: { name: 'Team personas' },
  shortcutCount: 3,
});

let target: HTMLDivElement;

function render(props: { search?: string } = {}) {
  target = document.createElement('div');
  document.body.appendChild(target);
  const component = mount(FolderList, { target, props });
  return () => unmount(component);
}

function nameButton(path: string): HTMLButtonElement {
  const button = target.querySelector(`[data-folder-path="${path}"]`)?.closest('button');
  if (!(button instanceof HTMLButtonElement)) throw new Error(`folder row button not found: ${path}`);
  return button;
}

function iconKind(path: string): string | null {
  return nameButton(path).querySelector('[data-folder-icon]')?.getAttribute('data-folder-icon') ?? null;
}

function menuItem(): Element | null {
  return document.querySelector('[data-slot="context-menu-item"]');
}

function shows(text: string): boolean {
  return (target.textContent ?? '').includes(text);
}

function openMenu(path: string) {
  nameButton(path).dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
}

beforeEach(() => {
  folderStore.folders = [alpha];
  folderStore.loading = false;
  folderStore.showArchived = false;
  folderStore.repos = [];
  folderStore.roots = [];
  folderStore.sessions.clear();
  folderStore.sessions.set(alpha.path, [idleSession, activeSession]);
  // Only the active session is open on this client.
  sessionRegistry.addSession(activeSession.id, alpha.path, alpha.name);
});

let destroy: (() => void) | null = null;
afterEach(() => {
  destroy?.();
  destroy = null;
  sessionRegistry.removeSession(activeSession.id);
  vi.mocked(connection.send).mockImplementation(async () => ({ id: '1', success: true, data: {} }));
  document.body.innerHTML = '';
});

describe('folder row icons', () => {
  it('selects the icon from nature × shortcutCount only', async () => {
    folderStore.folders = [alpha, hub, persona, personaHub];
    destroy = render();
    await tick();

    expect(iconKind(alpha.path)).toBe('code');
    expect(iconKind(hub.path)).toBe('code-hub');
    expect(iconKind(persona.path)).toBe('persona');
    expect(iconKind(personaHub.path)).toBe('persona-hub');
  });

  it('a shortcut-bearing folder shows the hub icon even without registry membership', async () => {
    folderStore.folders = [shortcutHub];
    destroy = render();
    await tick();

    expect(iconKind(shortcutHub.path)).toBe('code-hub');
  });
});

describe('folder row identity', () => {
  it('persona rows show the persona name with the description as subtitle', async () => {
    folderStore.folders = [persona];
    destroy = render();
    await tick();

    expect(shows('Ada')).toBe(true);
    expect(shows('Research assistant')).toBe(true);
    // The row name is the persona display name, not the folder basename.
    expect(shows('ada-dir')).toBe(false);
  });

  it('persona rows without a description show no subtitle line', async () => {
    folderStore.folders = [personaHub];
    destroy = render();
    await tick();

    expect(shows('Team personas')).toBe(true);
    expect(target.querySelectorAll('[data-folder-icon="persona-hub"]')).toHaveLength(1);
  });

  it('code rows keep the basename', async () => {
    folderStore.folders = [alpha];
    destroy = render();
    await tick();

    expect(shows('alpha')).toBe(true);
  });

  it('archived rows carry the Archived badge', async () => {
    folderStore.folders = [makeFolder({ path: '/w/old', name: 'old', archived: true })];
    folderStore.showArchived = true;
    destroy = render();
    await tick();

    expect(shows('Archived')).toBe(true);
  });
});

describe('folder search', () => {
  it('persona display names are discoverable in the homepage search', async () => {
    folderStore.folders = [persona, alpha];
    folderStore.sessions.set(persona.path, [idleSession]);
    destroy = render({ search: 'ada' });
    await tick();

    expect(shows('Ada')).toBe(true);
    expect(shows('alpha')).toBe(false);
  });

  it('session-level matches show only the matching sessions (semantics unchanged)', async () => {
    destroy = render({ search: 'idle' });
    await tick();

    expect(shows('alpha')).toBe(true);
    expect(shows('Idle session')).toBe(true);
    expect(shows('Active session')).toBe(false);
  });
});

describe('folder rows', () => {
  it('defaults to half-open: only open sessions are listed', async () => {
    destroy = render();
    await tick();

    expect(shows('Active session')).toBe(true);
    // Idle is open nowhere: not on this client, not bound to another.
    expect(shows('Idle session')).toBe(false);
  });

  it('half-open includes sessions open but bound to other clients', async () => {
    folderStore.sessions.set(alpha.path, [idleSession, activeSession, remoteSession]);
    destroy = render();
    await tick();

    expect(shows('Remote session')).toBe(true);
    expect(shows('Idle session')).toBe(false);
  });

  it('from closed, half-open still applies when only another client holds a session open', async () => {
    sessionRegistry.removeSession(activeSession.id);
    folderStore.sessions.set(alpha.path, [idleSession, remoteSession]);
    destroy = render();
    await tick();

    expect(shows('Remote session')).toBe(true);
    expect(shows('Idle session')).toBe(false);

    // active → all → closed
    nameButton(alpha.path).click();
    await tick();
    expect(shows('Idle session')).toBe(true);
    nameButton(alpha.path).click();
    await tick();
    expect(shows('Idle session')).toBe(false);

    // closed → half-open, not all: the remote session is still open, so
    // half-open renders differently from closed.
    nameButton(alpha.path).click();
    await tick();
    expect(shows('Remote session')).toBe(true);
    expect(shows('Idle session')).toBe(false);
  });

  it('cycles half-open → all → closed → half-open on tap', async () => {
    destroy = render();
    await tick();

    // half-open → all
    nameButton(alpha.path).click();
    await tick();
    expect(shows('Active session')).toBe(true);
    expect(shows('Idle session')).toBe(true);

    // all → closed
    nameButton(alpha.path).click();
    await tick();
    expect(shows('Active session')).toBe(false);
    expect(shows('Idle session')).toBe(false);

    // closed → half-open
    nameButton(alpha.path).click();
    await tick();
    expect(shows('Active session')).toBe(true);
    expect(shows('Idle session')).toBe(false);
  });

  it('half-open with nothing open lists nothing', async () => {
    sessionRegistry.removeSession(activeSession.id);
    destroy = render();
    await tick();

    expect(shows('Active session')).toBe(false);
    expect(shows('Idle session')).toBe(false);

    // The next tap still advances to the full list.
    nameButton(alpha.path).click();
    await tick();
    expect(shows('Idle session')).toBe(true);
  });

  it('from closed, skips half-open when nothing would filter in', async () => {
    sessionRegistry.removeSession(activeSession.id);
    destroy = render();
    await tick();

    // active (empty) → all → closed
    nameButton(alpha.path).click();
    await tick();
    expect(shows('Idle session')).toBe(true);
    nameButton(alpha.path).click();
    await tick();
    expect(shows('Idle session')).toBe(false);

    // closed → straight to all: half-open would render identical to closed.
    // Every folder session shows — open/closed state only gates half-open.
    nameButton(alpha.path).click();
    await tick();
    expect(shows('Idle session')).toBe(true);
    expect(shows('Active session')).toBe(true);
  });

  it('expands when clicking the row, not just the name', async () => {
    destroy = render();
    await tick();

    // The second row (git status + tags) is inside the trigger but outside
    // the name button — a dead zone before the row carried the click handler.
    (target.querySelector('.chips') as HTMLElement).click();
    await tick();
    expect(shows('Idle session')).toBe(true);
    expect(shows('Active session')).toBe(true);
  });

  it('row controls handle their action without expanding the row', async () => {
    destroy = render();
    await tick();

    (target.querySelector('button[title="Favorite"]') as HTMLElement).click();
    await tick();
    expect(shows('Idle session')).toBe(false);
    expect(shows('Active session')).toBe(true);
    expect(connection.send).toHaveBeenCalledWith({ type: 'update_folder', folderPath: '/w/alpha', favorite: true });

    (target.querySelector('button[title="New session in alpha"]') as HTMLElement).click();
    await tick();
    expect(shows('Idle session')).toBe(false);
    expect(connection.send).toHaveBeenCalledWith({ type: 'open_session', folderPath: '/w/alpha' });
  });

  it('the context menu offers Disband hub without expanding the row', async () => {
    folderStore.folders = [hub];
    folderStore.sessions.set(hub.path, [idleSession, activeSession]);
    sessionRegistry.addSession(activeSession.id, hub.path, hub.name);
    destroy = render();
    await tick();

    openMenu(hub.path);
    await tick();
    const items = document.querySelectorAll('[data-slot="context-menu-item"]');
    expect(items.length).toBe(2);
    expect(document.body.textContent).toContain('Disband hub');
    expect(shows('Idle session')).toBe(false);
    expect(shows('Active session')).toBe(true);

    (items[1] as HTMLElement).click();
    await tick();
    expect(document.body.textContent).toContain('Disband stack');
    expect(shows('Idle session')).toBe(false);

    sessionRegistry.removeSession(activeSession.id);
  });

  it('opens the folder context menu on right-click / long-press', async () => {
    destroy = render();
    await tick();

    openMenu(alpha.path);
    await tick();
    expect(menuItem()).not.toBeNull();
    // Menu open leaves the default half-open state untouched.
    expect(shows('Idle session')).toBe(false);
  });

  it('swallows the release click that follows a long-press, then behaves normally', async () => {
    destroy = render();
    await tick();

    openMenu(alpha.path);
    await tick();
    expect(menuItem()).not.toBeNull();

    // The long-press fires while the finger is down; the release still emits a
    // click on the row. It must not advance the folder behind the open menu.
    nameButton(alpha.path).click();
    await tick();
    expect(shows('Idle session')).toBe(false);

    // The suppression is one-shot: the next, deliberate tap works.
    nameButton(alpha.path).click();
    await tick();
    expect(shows('Idle session')).toBe(true);
  });

  it('opens the Add tag dialog from the menu item', async () => {
    destroy = render();
    await tick();

    openMenu(alpha.path);
    await tick();
    const item = menuItem();
    expect(item).not.toBeNull();

    item!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await tick();
    expect(document.body.textContent).toContain('Tag the folder');
    expect(document.body.textContent).toContain('alpha');
    expect(shows('Idle session')).toBe(false);
  });
});

describe('missing rows', () => {
  it('a missing folder offers open-with-materialization instead of expanding', async () => {
    const missingFolder = makeFolder({ path: '/w/gone', name: 'gone', missing: true });
    folderStore.folders = [missingFolder];
    folderStore.sessions.set(missingFolder.path, [idleSession]);
    destroy = render();
    await tick();

    const button = nameButton(missingFolder.path);
    expect(button.getAttribute('title')).toBe('Open — its source will create this folder');

    button.click();
    await tick();
    await vi.waitFor(() => expect(connection.send).toHaveBeenCalledWith({ type: 'open_session', folderPath: '/w/gone' }));
    expect(shows('Idle session')).toBe(false);
  });
});

describe('chips and tags', () => {
  it('hub rows render member chips, including missing members', async () => {
    const missingMember: RepoInfo = { ...memberRepo, path: '/w/two', name: 'two', missing: true };
    folderStore.folders = [makeFolder({ ...hub, repos: [memberRepo, missingMember] })];
    destroy = render();
    await tick();

    expect(shows('one')).toBe(true);
    expect(shows('main')).toBe(true);
    expect(shows('two')).toBe(true);
    expect(shows('missing')).toBe(true);
  });

  it('plain code rows render their git chip from the repo index', async () => {
    folderStore.repos = [{ path: alpha.path, name: 'alpha', branch: 'main', dirty: true, ahead: 2, behind: 1 }];
    destroy = render();
    await tick();

    expect(shows('main')).toBe(true);
    expect(shows('↑2↓1')).toBe(true);
  });

  it('user tags are removable, source tags are not', async () => {
    destroy = render();
    await tick();

    expect(target.querySelector('button[aria-label="Remove tag web"]')).not.toBeNull();
    expect(target.querySelector('button[aria-label="Remove tag ci"]')).toBeNull();

    (target.querySelector('button[aria-label="Remove tag web"]') as HTMLElement).click();
    await tick();
    expect(connection.send).toHaveBeenCalledWith({ type: 'update_folder', folderPath: '/w/alpha', removeTags: ['web'] });
  });
});

describe('hub dialogs', () => {
  it('the create-hub dialog sends create_hub with root and memberPaths', async () => {
    folderStore.roots = ['/roots'];
    folderStore.repos = [memberRepo];
    vi.mocked(connection.send).mockImplementation(async (command: any) => {
      if (command.type === 'list_repos') return { id: '1', success: true, data: { repos: [memberRepo] } };
      return { id: '1', success: true, data: {} };
    });
    destroy = render();
    await tick();

    (target.querySelector('button[title="More folder actions"]') as HTMLElement).click();
    await tick();
    const createItem = [...document.querySelectorAll('[data-slot="dropdown-menu-item"]')].find((el) => el.textContent?.includes('Create hub…'));
    expect(createItem).toBeDefined();
    createItem!.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    await tick();

    const input = document.body.querySelector('input[placeholder="Hub name"]') as HTMLInputElement;
    input.value = 'stack2';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    await tick();

    const rootButton = [...document.body.querySelectorAll('button')].find((b) => b.textContent?.includes('/roots'));
    expect(rootButton).toBeDefined();
    rootButton!.click();
    await tick();

    const memberButton = [...document.body.querySelectorAll('button')].find((b) => b.querySelector('input[type="checkbox"]') && b.textContent?.includes('one'));
    expect(memberButton).toBeDefined();
    memberButton!.click();
    await tick();

    const createButton = [...document.body.querySelectorAll('button')].find((b) => b.textContent?.trim() === 'Create hub');
    expect(createButton).toBeDefined();
    createButton!.click();

    await vi.waitFor(() => expect(connection.send).toHaveBeenCalledWith({ type: 'create_hub', name: 'stack2', root: '/roots', memberPaths: ['/w/one'] }));
  });

  it('the disband dialog sends disband_hub with the folder path', async () => {
    folderStore.folders = [hub];
    destroy = render();
    await tick();

    openMenu(hub.path);
    await tick();
    const items = document.querySelectorAll('[data-slot="context-menu-item"]');
    (items[1] as HTMLElement).click();
    await tick();

    const disbandButton = [...document.body.querySelectorAll('button')].find((b) => b.textContent?.trim() === 'Disband');
    expect(disbandButton).toBeDefined();
    disbandButton!.click();

    await vi.waitFor(() => expect(connection.send).toHaveBeenCalledWith({ type: 'disband_hub', folderPath: '/w/stack' }));
  });
});

describe('hub menu eligibility', () => {
  it('a generic shortcut hub gets the hub icon but no disband menu entry', async () => {
    folderStore.folders = [shortcutHub];
    destroy = render();
    await tick();

    expect(iconKind(shortcutHub.path)).toBe('code-hub');

    openMenu(shortcutHub.path);
    await tick();
    const items = document.querySelectorAll('[data-slot="context-menu-item"]');
    expect(items.length).toBe(1);
    expect(document.body.textContent).not.toContain('Disband hub');
  });

  it('registry/source hubs (repos present) are disband-eligible', async () => {
    folderStore.folders = [hub];
    destroy = render();
    await tick();

    openMenu(hub.path);
    await tick();
    expect(document.body.textContent).toContain('Disband hub');
  });
});

const { fileEditorStore } = await import('$lib/stores/file-editor.svelte.js');

describe('agent instructions entry', () => {
  it('opens the config-file editor on ~/.pi/agent/AGENTS.md from the header button', async () => {
    fileEditorStore.close();
    vi.mocked(connection.send).mockImplementation(async (command) => {
      if (command.type === 'file_get') return { id: '1', success: true, data: { path: '/p/AGENTS.md', exists: false, content: '' } };
      return { id: '1', success: true, data: {} };
    });
    destroy = render();
    await tick();

    const entry = target.querySelector<HTMLButtonElement>('button[aria-label="Agent instructions"]');
    expect(entry).not.toBeNull();
    entry!.click();

    await vi.waitFor(() => expect(fileEditorStore.open).toBe(true));
    expect(fileEditorStore.title).toBe('Agent instructions');
    // Will-create flow: the file is missing, the editor opens empty.
    expect(fileEditorStore.exists).toBe(false);
    expect(vi.mocked(connection.send)).toHaveBeenCalledWith(expect.objectContaining({ type: 'file_get', path: '~/.pi/agent/AGENTS.md' }));
    fileEditorStore.close();
  });
});
