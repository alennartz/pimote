// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mount, tick, unmount } from 'svelte';
import type { PimoteTreeNode } from '@pimote/shared';
import TreeDialog from './TreeDialog.svelte';
import { connection } from '$lib/stores/connection.svelte.js';
import { sessionRegistry } from '$lib/stores/session-registry.svelte.js';
import { treeDialogStore } from '$lib/stores/tree-dialog.svelte.js';

function setupSession() {
  sessionRegistry.addSession('s1', '/workspace/project', 'project');
  sessionRegistry.switchTo('s1');
  connection.ready = true;
  return sessionRegistry.sessions.s1;
}

afterEach(() => {
  vi.restoreAllMocks();
  treeDialogStore.closeDialog();
  sessionRegistry.sessions = {};
  sessionRegistry.viewedSessionId = null;
  connection.ready = false;
});

describe('TreeDialog draft restoration', () => {
  it('persists returned editor text when the composer is unmounted', async () => {
    const session = setupSession();
    const tree: PimoteTreeNode[] = [{ id: 'entry-1', type: 'user', role: 'user', preview: 'Tree entry', timestamp: '2026-01-01T00:00:00.000Z', children: [] }];
    treeDialogStore.openDialog('s1', tree, null);
    vi.spyOn(connection, 'send').mockResolvedValue({ id: 'navigate-1', success: true, data: { editorText: 'tree instructions' } } as never);

    const target = document.createElement('div');
    const component = mount(TreeDialog, { target });
    await tick();

    target.querySelector<HTMLElement>('[tabindex="0"]')!.click();
    await tick();
    const navigate = Array.from(target.querySelectorAll<HTMLButtonElement>('button')).find((button) => button.textContent?.trim() === 'Navigate');
    expect(navigate).not.toBeUndefined();
    navigate!.click();
    await Promise.resolve();
    await tick();

    expect(session.draftText).toBe('tree instructions');
    expect(treeDialogStore.state.open).toBe(false);
    await unmount(component);
  });
});
