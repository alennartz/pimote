// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mount, tick, unmount } from 'svelte';
import type { ProjectInfo, RepoInfo, SessionInfo } from '@pimote/shared';

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
const { default: ProjectList } = await import('./ProjectList.svelte');
const { projectStore } = await import('$lib/stores/project-store.svelte.js');
const { sessionRegistry } = await import('$lib/stores/session-registry.svelte.js');

const alpha: ProjectInfo = {
  path: '/w/alpha',
  name: 'alpha',
  kind: 'single',
  activeSessionCount: 0,
  externalProcessCount: 0,
  tags: ['web'],
};

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

const multiRepo: RepoInfo = { path: '/w/one', name: 'one', branch: 'main', dirty: false, ahead: 0, behind: 0, missing: false };

const multi: ProjectInfo = {
  path: '/w/stack',
  name: 'stack',
  kind: 'multi',
  activeSessionCount: 0,
  externalProcessCount: 0,
  repos: [multiRepo],
};

let target: HTMLDivElement;

function render() {
  target = document.createElement('div');
  document.body.appendChild(target);
  const component = mount(ProjectList, { target });
  return () => unmount(component);
}

function rowNameButton(): HTMLButtonElement {
  const button = target.querySelector('[data-project-name]')?.closest('button');
  if (!(button instanceof HTMLButtonElement)) throw new Error('project row button not found');
  return button;
}

function menuItem(): Element | null {
  return document.querySelector('[data-slot="context-menu-item"]');
}

function shows(text: string): boolean {
  return (target.textContent ?? '').includes(text);
}

function openMenu() {
  rowNameButton().dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
}

beforeEach(() => {
  projectStore.projects = [alpha];
  projectStore.loading = false;
  projectStore.showArchived = false;
  projectStore.repos = [];
  projectStore.roots = [];
  projectStore.sessions.clear();
  projectStore.sessions.set(alpha.path, [idleSession, activeSession]);
  // Only the active session is open on this client.
  sessionRegistry.addSession(activeSession.id, alpha.path, alpha.name);
});

let destroy: (() => void) | null = null;
afterEach(() => {
  destroy?.();
  destroy = null;
  sessionRegistry.removeSession(activeSession.id);
  document.body.innerHTML = '';
});

describe('project rows', () => {
  it('defaults to half-open: only open sessions are listed', async () => {
    destroy = render();
    await tick();

    expect(shows('Active session')).toBe(true);
    // Idle is open nowhere: not on this client, not bound to another.
    expect(shows('Idle session')).toBe(false);
  });

  it('half-open includes sessions open but bound to other clients', async () => {
    projectStore.sessions.set(alpha.path, [idleSession, activeSession, remoteSession]);
    destroy = render();
    await tick();

    expect(shows('Remote session')).toBe(true);
    expect(shows('Idle session')).toBe(false);
  });

  it('from closed, half-open still applies when only another client holds a session open', async () => {
    sessionRegistry.removeSession(activeSession.id);
    projectStore.sessions.set(alpha.path, [idleSession, remoteSession]);
    destroy = render();
    await tick();

    expect(shows('Remote session')).toBe(true);
    expect(shows('Idle session')).toBe(false);

    // active → all → closed
    rowNameButton().click();
    await tick();
    expect(shows('Idle session')).toBe(true);
    rowNameButton().click();
    await tick();
    expect(shows('Idle session')).toBe(false);

    // closed → half-open, not all: the remote session is still open, so
    // half-open renders differently from closed.
    rowNameButton().click();
    await tick();
    expect(shows('Remote session')).toBe(true);
    expect(shows('Idle session')).toBe(false);
  });

  it('cycles half-open → all → closed → half-open on tap', async () => {
    destroy = render();
    await tick();

    // half-open → all
    rowNameButton().click();
    await tick();
    expect(shows('Active session')).toBe(true);
    expect(shows('Idle session')).toBe(true);

    // all → closed
    rowNameButton().click();
    await tick();
    expect(shows('Active session')).toBe(false);
    expect(shows('Idle session')).toBe(false);

    // closed → half-open
    rowNameButton().click();
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
    rowNameButton().click();
    await tick();
    expect(shows('Idle session')).toBe(true);
  });

  it('from closed, skips half-open when nothing would filter in', async () => {
    sessionRegistry.removeSession(activeSession.id);
    destroy = render();
    await tick();

    // active (empty) → all → closed
    rowNameButton().click();
    await tick();
    expect(shows('Idle session')).toBe(true);
    rowNameButton().click();
    await tick();
    expect(shows('Idle session')).toBe(false);

    // closed → straight to all: half-open would render identical to closed.
    // Every project session shows — open/closed state only gates half-open.
    rowNameButton().click();
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
    expect(connection.send).toHaveBeenCalledWith({ type: 'update_project', projectPath: '/w/alpha', favorite: true });

    (target.querySelector('button[title="New session in alpha"]') as HTMLElement).click();
    await tick();
    expect(shows('Idle session')).toBe(false);
    expect(connection.send).toHaveBeenCalledWith({ type: 'open_session', folderPath: '/w/alpha' });
  });

  it('the context menu offers Disband without expanding the row', async () => {
    projectStore.projects = [multi];
    projectStore.sessions.set(multi.path, [idleSession, activeSession]);
    sessionRegistry.addSession(activeSession.id, multi.path, multi.name);
    destroy = render();
    await tick();

    openMenu();
    await tick();
    const items = document.querySelectorAll('[data-slot="context-menu-item"]');
    expect(items.length).toBe(2);
    expect(document.body.textContent).toContain('Disband project');
    expect(shows('Idle session')).toBe(false);
    expect(shows('Active session')).toBe(true);

    (items[1] as HTMLElement).click();
    await tick();
    expect(document.body.textContent).toContain('Disband stack');
    expect(shows('Idle session')).toBe(false);
  });

  it('opens the project context menu on right-click / long-press', async () => {
    destroy = render();
    await tick();

    openMenu();
    await tick();
    expect(menuItem()).not.toBeNull();
    // Menu open leaves the default half-open state untouched.
    expect(shows('Idle session')).toBe(false);
  });

  it('swallows the release click that follows a long-press, then behaves normally', async () => {
    destroy = render();
    await tick();

    openMenu();
    await tick();
    expect(menuItem()).not.toBeNull();

    // The long-press fires while the finger is down; the release still emits a
    // click on the row. It must not advance the project behind the open menu.
    rowNameButton().click();
    await tick();
    expect(shows('Idle session')).toBe(false);

    // The suppression is one-shot: the next, deliberate tap works.
    rowNameButton().click();
    await tick();
    expect(shows('Idle session')).toBe(true);
  });

  it('opens the Add tag dialog from the menu item', async () => {
    destroy = render();
    await tick();

    openMenu();
    await tick();
    const item = menuItem();
    expect(item).not.toBeNull();

    item!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await tick();
    expect(document.body.textContent).toContain('Tag the project');
    expect(document.body.textContent).toContain('alpha');
    expect(shows('Idle session')).toBe(false);
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
