import { describe, it, expect, vi } from 'vitest';
import type { PimoteCommand, PimoteResponse } from '@pimote/shared';
import { FileEditorStore, parseTagSnippets, type SendCommand } from './file-editor.svelte.js';

function fileGetResponse(content: string, exists = true): PimoteResponse {
  return { id: '1', success: true, data: { path: '/home/u/.pi/agent/AGENTS.md', exists, content } };
}

/** Fake transport: routes each command through `handler`, which may inspect the store mid-flight. */
function fakeSend(handler: (command: PimoteCommand) => PimoteResponse | Promise<PimoteResponse>): {
  send: SendCommand;
  calls: PimoteCommand[];
} {
  const calls: PimoteCommand[] = [];
  const send = vi.fn(async (command: PimoteCommand): Promise<PimoteResponse> => {
    calls.push(command);
    return handler(command);
  });
  return { send: send as unknown as SendCommand, calls };
}

/** A send that answers file_get for the target file and the config file separately. */
function routingSend(target: PimoteResponse | (() => Promise<PimoteResponse>), config?: PimoteResponse | (() => Promise<PimoteResponse>)) {
  return fakeSend(async (command) => {
    if (command.type !== 'file_get') return { id: command.id ?? '', success: true, data: {} };
    if (command.path === '~/.config/pimote/config.json') {
      return config ? (typeof config === 'function' ? config() : config) : { id: command.id ?? '', success: true, data: { path: '/c', exists: false, content: '' } };
    }
    return typeof target === 'function' ? target() : target;
  });
}

describe('parseTagSnippets', () => {
  it('returns the tagSnippets array of a valid config', () => {
    expect(parseTagSnippets('{"tagSnippets": ["note", "tip"]}')).toEqual(['note', 'tip']);
  });

  it('returns [] for invalid JSON, missing key, or a non-array key', () => {
    expect(parseTagSnippets('not json {')).toEqual([]);
    expect(parseTagSnippets('{}')).toEqual([]);
    expect(parseTagSnippets('{"tagSnippets": "note"}')).toEqual([]);
    expect(parseTagSnippets('')).toEqual([]);
  });

  it('drops non-string entries and invalid tag names', () => {
    expect(parseTagSnippets('{"tagSnippets": ["ok", 3, null, "1bad", "bad name", "has-dash_2"]}')).toEqual(['ok', 'has-dash_2']);
  });
});

describe('openFile', () => {
  it('opens the dialog immediately and loads existing content', async () => {
    const { send } = routingSend(fileGetResponse('# Agents\n'));
    const store = new FileEditorStore(send);

    const pending = store.openFile('~/.pi/agent/AGENTS.md', 'Agent instructions');
    // Dialog is open and loading before the response arrives.
    expect(store.open).toBe(true);
    expect(store.loading).toBe(true);

    await pending;
    expect(store.loading).toBe(false);
    expect(store.exists).toBe(true);
    expect(store.content).toBe('# Agents\n');
    expect(store.resolvedPath).toBe('/home/u/.pi/agent/AGENTS.md');
    expect(store.dirty).toBe(false);
    expect(store.error).toBeNull();
  });

  it('opens on a missing file with empty content (will-create flow)', async () => {
    const { send } = routingSend(fileGetResponse('', false));
    const store = new FileEditorStore(send);

    await store.openFile('~/.pi/agent/AGENTS.md', 'Agent instructions');
    expect(store.open).toBe(true);
    expect(store.exists).toBe(false);
    expect(store.content).toBe('');
    expect(store.dirty).toBe(false);
  });

  it('surfaces a read failure as an error while keeping the dialog open', async () => {
    const { send } = routingSend({ id: '1', success: false, error: 'EACCES' });
    const store = new FileEditorStore(send);

    await store.openFile('~/.pi/agent/AGENTS.md', 'Agent instructions');
    expect(store.open).toBe(true);
    expect(store.error).toBe('EACCES');
    expect(store.content).toBe('');
  });

  it('ignores a stale response from a superseded open', async () => {
    let resolveFirst: (r: PimoteResponse) => void = () => {};
    const first = new Promise<PimoteResponse>((resolve) => (resolveFirst = resolve));
    let call = 0;
    const { send } = routingSend(() => {
      call += 1;
      return call === 1 ? first : Promise.resolve(fileGetResponse('second'));
    });
    const store = new FileEditorStore(send);

    const stale = store.openFile('a.md', 'A');
    const fresh = store.openFile('b.md', 'B');
    resolveFirst(fileGetResponse('first'));
    await fresh;
    await stale;

    expect(store.content).toBe('second');
    expect(store.title).toBe('B');
  });
});

describe('snippet transport', () => {
  it('loads tagSnippets from the pimote config file', async () => {
    const { send } = routingSend(fileGetResponse('body'), {
      id: '1',
      success: true,
      data: { path: '/c', exists: true, content: '{"tagSnippets": ["note", "tip"]}' },
    });
    const store = new FileEditorStore(send);

    await store.openFile('~/.pi/agent/AGENTS.md', 'Agent instructions');
    await vi.waitFor(() => expect(store.snippets).toEqual(['note', 'tip']));
  });

  it('yields no snippets on missing config, invalid JSON, or absent key', async () => {
    for (const config of [fileGetResponse('', false), fileGetResponse('nope {'), fileGetResponse('{}')]) {
      const { send } = routingSend(fileGetResponse('body'), config);
      const store = new FileEditorStore(send);
      await store.openFile('~/.pi/agent/AGENTS.md', 'Agent instructions');
      await vi.waitFor(() => expect(store.snippets).toEqual([]));
    }
  });

  it('never blocks the editor when the config fetch fails', async () => {
    const { send } = routingSend(fileGetResponse('body'), () => Promise.reject(new Error('offline')));
    const store = new FileEditorStore(send);

    await store.openFile('~/.pi/agent/AGENTS.md', 'Agent instructions');
    await vi.waitFor(() => expect(store.snippets).toEqual([]));
    expect(store.content).toBe('body');
    expect(store.error).toBeNull();
    expect(store.open).toBe(true);
  });
});

describe('dirty tracking', () => {
  it('marks dirty on edit and clean again when content returns to baseline', async () => {
    const { send } = routingSend(fileGetResponse('base'));
    const store = new FileEditorStore(send);
    await store.openFile('~/.pi/agent/AGENTS.md', 'Agent instructions');

    store.content = 'edited';
    expect(store.dirty).toBe(true);
    store.content = 'base';
    expect(store.dirty).toBe(false);
  });

  it('resets to a clean baseline on every open', async () => {
    const { send } = routingSend(fileGetResponse('base'));
    const store = new FileEditorStore(send);
    await store.openFile('~/.pi/agent/AGENTS.md', 'Agent instructions');
    store.content = 'edited';

    await store.openFile('~/.pi/agent/AGENTS.md', 'Agent instructions');
    expect(store.content).toBe('base');
    expect(store.dirty).toBe(false);
  });
});

describe('save', () => {
  it('writes the full content with file_put and closes on success', async () => {
    const { send, calls } = fakeSend(async (command) => {
      if (command.type === 'file_put') {
        expect(store.saving).toBe(true);
        expect(store.open).toBe(true);
      }
      return command.type === 'file_get' ? fileGetResponse('base') : { id: command.id ?? '', success: true, data: { path: '/home/u/.pi/agent/AGENTS.md' } };
    });
    const store = new FileEditorStore(send);
    await store.openFile('~/.pi/agent/AGENTS.md', 'Agent instructions');
    store.content = 'edited';

    const saved = await store.save();
    expect(saved).toBe(true);
    expect(calls.filter((c) => c.type === 'file_put')).toEqual([{ type: 'file_put', path: '~/.pi/agent/AGENTS.md', content: 'edited' }]);
    expect(store.open).toBe(false);
    expect(store.saving).toBe(false);
    expect(store.dirty).toBe(false);
  });

  it('keeps the dialog open with an error and stays dirty when the write fails', async () => {
    const { send } = fakeSend(async (command) => (command.type === 'file_get' ? fileGetResponse('base') : { id: command.id ?? '', success: false, error: 'disk full' }));
    const store = new FileEditorStore(send);
    await store.openFile('~/.pi/agent/AGENTS.md', 'Agent instructions');
    store.content = 'edited';

    const saved = await store.save();
    expect(saved).toBe(false);
    expect(store.open).toBe(true);
    expect(store.saving).toBe(false);
    expect(store.error).toBe('disk full');
    expect(store.dirty).toBe(true);
  });

  it('sends a single write when save is clicked twice', async () => {
    let resolvePut: (r: PimoteResponse) => void = () => {};
    const put = new Promise<PimoteResponse>((resolve) => (resolvePut = resolve));
    const { send, calls } = fakeSend(async (command) => {
      if (command.type === 'file_get') return fileGetResponse('base');
      return put;
    });
    const store = new FileEditorStore(send);
    await store.openFile('~/.pi/agent/AGENTS.md', 'Agent instructions');
    store.content = 'edited';

    const first = store.save();
    const second = store.save();
    resolvePut({ id: '1', success: true, data: { path: '/p' } });
    expect(await first).toBe(true);
    expect(await second).toBe(false);
    expect(calls.filter((c) => c.type === 'file_put')).toHaveLength(1);
  });

  it('does nothing when the dialog is closed', async () => {
    const { send, calls } = routingSend(fileGetResponse('base'));
    const store = new FileEditorStore(send);

    expect(await store.save()).toBe(false);
    expect(calls).toEqual([]);
  });
});

describe('close', () => {
  it('resets the dialog state', async () => {
    const { send } = routingSend(fileGetResponse('base'));
    const store = new FileEditorStore(send);
    await store.openFile('~/.pi/agent/AGENTS.md', 'Agent instructions');
    store.content = 'edited';
    store.error = 'boom';

    store.close();
    expect(store.open).toBe(false);
    expect(store.content).toBe('');
    expect(store.dirty).toBe(false);
    expect(store.error).toBeNull();
    expect(store.loading).toBe(false);
    expect(store.saving).toBe(false);
  });
});
