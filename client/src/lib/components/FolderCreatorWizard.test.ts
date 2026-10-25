// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mount, tick, unmount } from 'svelte';
import type { FolderInfo } from '@pimote/shared';

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
const { default: FolderCreatorWizard } = await import('./FolderCreatorWizard.svelte');
const { folderStore } = await import('$lib/stores/folder-store.svelte.js');

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

const alpha = makeFolder({ path: '/roots/alpha', name: 'alpha' });
const ada = makeFolder({ path: '/roots/ada', name: 'ada', nature: 'persona' });

function shows(text: string): boolean {
  return (document.body.textContent ?? '').includes(text);
}

function button(text: string): HTMLButtonElement {
  const found = [...document.body.querySelectorAll('button')].find((b) => b.textContent?.trim() === text);
  if (!(found instanceof HTMLButtonElement)) throw new Error(`button not found: ${text}`);
  return found;
}

function kindButton(kind: string): HTMLElement {
  const icon = document.querySelector(`[data-folder-icon="${kind}"]`);
  if (!icon) throw new Error(`kind icon not found: ${kind}`);
  return (icon.closest('button') ?? icon) as HTMLElement;
}

function fillName(name: string): void {
  const input = document.body.querySelector('input[placeholder="Folder name"]') as HTMLInputElement;
  if (!input) throw new Error('name input not found');
  input.value = name;
  input.dispatchEvent(new Event('input', { bubbles: true }));
}

function fillText(text: string): void {
  const textarea = document.body.querySelector('textarea');
  if (!(textarea instanceof HTMLTextAreaElement)) throw new Error('text step field not found');
  textarea.value = text;
  textarea.dispatchEvent(new Event('input', { bubbles: true }));
}

function checkboxRows(): HTMLElement[] {
  return [...document.querySelectorAll<HTMLElement>('button, label')].filter((el) => el.querySelector('input[type="checkbox"]'));
}

function checkboxRow(name: string): HTMLElement {
  const found = checkboxRows().find((el) => el.textContent?.includes(name));
  if (!found) throw new Error(`picker row not found: ${name}`);
  return found;
}

function render() {
  const target = document.createElement('div');
  document.body.appendChild(target);
  const component = mount(FolderCreatorWizard, { target, props: {} });
  return () => unmount(component);
}

let destroy: (() => void) | null = null;

beforeEach(() => {
  vi.mocked(connection.send).mockClear();
  folderStore.folders = [alpha, ada];
  folderStore.roots = ['/roots'];
  vi.mocked(connection.send).mockImplementation(async (command: any) => {
    if (['create_folder', 'create_persona_folder', 'create_hub'].includes(command.type)) {
      return { id: '1', success: true, data: { folderPath: `/roots/${command.name}` } };
    }
    return { id: '1', success: true, data: {} };
  });
});

afterEach(() => {
  destroy?.();
  destroy = null;
  document.body.innerHTML = '';
});

describe('FolderCreatorWizard — kind icon row', () => {
  it('offers the four folder kinds as FolderNatureIcon glyphs', () => {
    destroy = render();

    for (const kind of ['code', 'persona', 'code-hub', 'persona-hub']) {
      expect(document.querySelector(`[data-folder-icon="${kind}"]`)).toBeTruthy();
    }
  });

  it('starts every flow with the identity step (name and root)', async () => {
    destroy = render();
    await tick();

    kindButton('code').click();
    await tick();

    expect(document.body.querySelector('input[placeholder="Folder name"]')).toBeTruthy();
    expect(shows('/roots')).toBe(true);
  });
});

describe('FolderCreatorWizard — steps composed by kind', () => {
  it('code kinds move identity → a text step titled "Vision" with no member picker', async () => {
    destroy = render();
    await tick();

    kindButton('code').click();
    await tick();
    fillName('beta');
    button('Next').click();
    await tick();

    expect(shows('Vision')).toBe(true);
    expect(checkboxRows()).toHaveLength(0);
  });

  it('hub variants include a member picker step', async () => {
    destroy = render();
    await tick();

    kindButton('code-hub').click();
    await tick();
    fillName('beta');
    button('Next').click();
    await tick();

    expect(checkboxRow('alpha')).toBeTruthy();
  });

  it('persona kinds title the text step "Persona"', async () => {
    destroy = render();
    await tick();

    kindButton('persona').click();
    await tick();
    fillName('beta');
    button('Next').click();
    await tick();

    expect(shows('Persona')).toBe(true);
  });
});

describe('FolderCreatorWizard — boundaries and failures', () => {
  it('offers persona members in the hub picker', async () => {
    destroy = render();
    kindButton('code-hub').click();
    await tick();
    fillName('beta');
    button('Next').click();
    await tick();
    expect(checkboxRow('ada')).toBeTruthy();
  });

  it('offers folders that are not on disk yet as hub members and sends them on create', async () => {
    const virtual = makeFolder({ path: '/roots/virtual', name: 'virtual', missing: true });
    folderStore.folders = [alpha, ada, virtual];
    destroy = render();
    await tick();
    kindButton('code-hub').click();
    await tick();
    fillName('beta');
    button('Next').click();
    await tick();
    expect(checkboxRow('virtual')).toBeTruthy();

    checkboxRow('virtual').click();
    button('Next').click();
    await tick();
    button('Create').click();
    await vi.waitFor(() =>
      expect(connection.send).toHaveBeenCalledWith(expect.objectContaining({ type: 'create_hub', root: '/roots', name: 'beta', memberPaths: ['/roots/virtual'] })),
    );
  });

  it('uses the selected configured root when two roots exist', async () => {
    folderStore.roots = ['/roots', '/other'];
    destroy = render();
    kindButton('code').click();
    await tick();
    const root = [...document.querySelectorAll('button, option')].find((el) => el.textContent?.trim() === '/other');
    if (root instanceof HTMLOptionElement) {
      const select = root.parentElement as HTMLSelectElement;
      select.value = root.value;
      select.dispatchEvent(new Event('change', { bubbles: true }));
    } else {
      expect(root).toBeTruthy();
      (root as HTMLElement).click();
    }
    fillName('beta');
    button('Next').click();
    await tick();
    button('Create').click();
    await vi.waitFor(() => expect(connection.send).toHaveBeenCalledWith(expect.objectContaining({ type: 'create_folder', root: '/other' })));
  });

  it('prevents creation with an empty name', async () => {
    destroy = render();
    kindButton('code').click();
    await tick();
    button('Next').click();
    await tick();
    document.querySelectorAll('button').forEach((el) => {
      if (el.textContent?.trim() === 'Create') el.click();
    });
    await tick();
    expect(connection.send).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'create_folder' }));
  });

  it.each([
    ['code', 'create_folder'],
    ['persona', 'create_persona_folder'],
    ['code-hub', 'create_hub'],
    ['persona-hub', 'create_hub'],
    ['code', 'open_session'],
  ])('shows a server rejection for %s from %s', async (kind, failureType) => {
    vi.mocked(connection.send).mockImplementation(async (command: any) => {
      if (command.type === failureType) return { id: '1', success: false, error: 'Server refused the operation' };
      return { id: '1', success: true, data: { folderPath: '/roots/beta' } };
    });
    destroy = render();
    kindButton(kind).click();
    await tick();
    fillName('beta');
    button('Next').click();
    await tick();
    if (kind.endsWith('-hub')) {
      checkboxRow('ada').click();
      button('Next').click();
      await tick();
    }
    button('Create').click();
    await vi.waitFor(() => expect(shows('Server refused the operation')).toBe(true));
    if (failureType !== 'open_session') {
      expect(connection.send).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'open_session' }));
    }
  });
});

describe('FolderCreatorWizard — flows end in a session', () => {
  it('suppresses expected cancellation and retries the created folder without recreating it', async () => {
    let createCount = 0;
    let openCount = 0;
    vi.mocked(connection.send).mockImplementation(async (command: any) => {
      if (command.type === 'create_folder') {
        createCount += 1;
        return { id: '1', success: true, data: { folderPath: '/roots/beta' } };
      }
      if (command.type === 'open_session') {
        openCount += 1;
        if (openCount === 1) return { id: '1', success: false, error: 'session_open_cancelled' };
      }
      return { id: '1', success: true, data: {} };
    });
    destroy = render();
    await tick();

    kindButton('code').click();
    await tick();
    fillName('beta');
    button('Next').click();
    await tick();
    button('Create').click();
    await vi.waitFor(() => expect(openCount).toBe(1));
    expect(shows('session_open_cancelled')).toBe(false);

    button('Create').click();
    await vi.waitFor(() => expect(openCount).toBe(2));
    expect(createCount).toBe(1);
  });

  it('the code flow seeds the text as the AGENTS.md body, then opens the session', async () => {
    destroy = render();
    await tick();

    kindButton('code').click();
    await tick();
    fillName('beta');
    button('Next').click();
    await tick();
    fillText('We build the widget.');
    button('Create').click();
    await vi.waitFor(() =>
      expect(connection.send).toHaveBeenCalledWith(expect.objectContaining({ type: 'create_folder', root: '/roots', name: 'beta', body: 'We build the widget.' })),
    );
    await vi.waitFor(() => expect(connection.send).toHaveBeenCalledWith(expect.objectContaining({ type: 'open_session', folderPath: '/roots/beta' })));
  });

  it('opens the canonical path returned by creation without rewriting it to the alias', async () => {
    const canonicalPath = '/real-roots/beta';
    vi.mocked(connection.send).mockImplementation(async (command: any) => {
      if (command.type === 'create_folder') return { id: '1', success: true, data: { folderPath: canonicalPath } };
      return { id: '1', success: true, data: {} };
    });
    destroy = render();
    await tick();

    kindButton('code').click();
    await tick();
    fillName('beta');
    button('Next').click();
    await tick();
    button('Create').click();

    await vi.waitFor(() => expect(connection.send).toHaveBeenCalledWith(expect.objectContaining({ type: 'open_session', folderPath: canonicalPath })));
    expect(connection.send).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'open_session', folderPath: '/roots/beta' }));
  });

  it('the persona flow sends create_persona_folder carrying personaText, then opens the session', async () => {
    destroy = render();
    await tick();

    kindButton('persona').click();
    await tick();
    fillName('beta');
    button('Next').click();
    await tick();
    fillText('You are a research assistant.');
    button('Create').click();
    await vi.waitFor(() =>
      expect(connection.send).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'create_persona_folder', root: '/roots', name: 'beta', personaText: 'You are a research assistant.' }),
      ),
    );
    await vi.waitFor(() => expect(connection.send).toHaveBeenCalledWith(expect.objectContaining({ type: 'open_session', folderPath: '/roots/beta' })));
  });

  it('the code-hub flow sends create_hub carrying the chosen members, then opens the session', async () => {
    destroy = render();
    await tick();

    kindButton('code-hub').click();
    await tick();
    fillName('beta');
    button('Next').click();
    await tick();
    checkboxRow('alpha').click();
    button('Next').click();
    await tick();
    button('Create').click();
    await vi.waitFor(() =>
      expect(connection.send).toHaveBeenCalledWith(expect.objectContaining({ type: 'create_hub', root: '/roots', name: 'beta', memberPaths: ['/roots/alpha'] })),
    );
    await vi.waitFor(() => expect(connection.send).toHaveBeenCalledWith(expect.objectContaining({ type: 'open_session', folderPath: '/roots/beta' })));
  });

  it('the persona-hub flow carries personaText on create_hub, then opens the session', async () => {
    destroy = render();
    await tick();

    kindButton('persona-hub').click();
    await tick();
    fillName('beta');
    button('Next').click();
    await tick();
    checkboxRow('alpha').click();
    button('Next').click();
    await tick();
    fillText('Coordinate the team.');
    button('Create').click();
    await vi.waitFor(() =>
      expect(connection.send).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'create_hub', root: '/roots', name: 'beta', memberPaths: ['/roots/alpha'], personaText: 'Coordinate the team.' }),
      ),
    );
    await vi.waitFor(() => expect(connection.send).toHaveBeenCalledWith(expect.objectContaining({ type: 'open_session', folderPath: '/roots/beta' })));
  });

  it.each(['code', 'persona', 'code-hub', 'persona-hub'])('the %s text step is skippable and still opens a session', async (kind) => {
    destroy = render();
    await tick();

    kindButton(kind).click();
    await tick();
    fillName('beta');
    button('Next').click();
    await tick();
    if (kind.endsWith('-hub')) {
      checkboxRow('ada').click();
      button('Next').click();
      await tick();
    }
    button('Create').click();
    const type = kind.endsWith('-hub') ? 'create_hub' : kind === 'persona' ? 'create_persona_folder' : 'create_folder';
    await vi.waitFor(() => expect(connection.send).toHaveBeenCalledWith(expect.objectContaining({ type, name: 'beta' })));
    const command = vi.mocked(connection.send).mock.calls.find(([command]) => command.type === type)![0];
    if (kind.startsWith('persona')) expect(command).toMatchObject({ personaText: '' });
    await vi.waitFor(() => expect(connection.send).toHaveBeenCalledWith(expect.objectContaining({ type: 'open_session', folderPath: '/roots/beta' })));
  });
});
