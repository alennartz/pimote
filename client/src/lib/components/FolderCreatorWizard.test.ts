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
  folderStore.folders = [alpha];
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

describe('FolderCreatorWizard — flows end in a session', () => {
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

  it('the text step is skippable — the flow still creates and opens a session without text', async () => {
    destroy = render();
    await tick();

    kindButton('code').click();
    await tick();
    fillName('beta');
    button('Next').click();
    await tick();
    button('Create').click();
    await vi.waitFor(() => expect(connection.send).toHaveBeenCalledWith(expect.objectContaining({ type: 'create_folder', name: 'beta' })));
    await vi.waitFor(() => expect(connection.send).toHaveBeenCalledWith(expect.objectContaining({ type: 'open_session', folderPath: '/roots/beta' })));
  });
});
