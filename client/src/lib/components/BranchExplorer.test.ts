// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mount, tick, unmount } from 'svelte';
import type { PimoteTreeNode } from '@pimote/shared';

vi.mock('$lib/stores/connection.svelte.js', () => {
  const base: Record<string, unknown> = {
    status: 'connected',
    send: vi.fn(async () => ({ id: 'response', success: true, data: {} })),
  };
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

const { default: BranchExplorer } = await import('./BranchExplorer.svelte');
const { branchTreeStore } = await import('$lib/stores/branch-tree-store.svelte.js');
const { sessionRegistry } = await import('$lib/stores/session-registry.svelte.js');

const SESSION_ID = 'branch-session';
const TIMESTAMP = '2026-04-11T10:00:00.000Z';
let mounted: ReturnType<typeof mount> | undefined;

function node(id: string, text: string): PimoteTreeNode {
  return {
    id,
    type: 'message',
    role: 'user',
    preview: text,
    conversationText: text,
    timestamp: TIMESTAMP,
    children: [],
  };
}

function render(tree: PimoteTreeNode[]) {
  branchTreeStore.state.open = true;
  branchTreeStore.state.sessionId = SESSION_ID;
  branchTreeStore.state.tree = tree;
  branchTreeStore.state.currentLeafId = tree.at(-1)?.id ?? null;
  branchTreeStore.state.expandedSegmentIds = new Set();
  branchTreeStore.state.selectedId = null;
  branchTreeStore.state.searchQuery = '';
  branchTreeStore.state.searchScope = 'anchors';
  branchTreeStore.state.searchMatches = [];
  branchTreeStore.state.error = null;

  const target = document.createElement('div');
  document.body.append(target);
  mounted = mount(BranchExplorer, { target });
  return { target };
}

beforeEach(() => {
  sessionRegistry.addSession(SESSION_ID, '/workspace/project', 'project');
  sessionRegistry.switchTo(SESSION_ID);
});

afterEach(async () => {
  if (mounted) await unmount(mounted);
  mounted = undefined;
  branchTreeStore.close();
  sessionRegistry.sessions = {};
  sessionRegistry.viewedSessionId = null;
  document.body.replaceChildren();
});

describe('branch explorer message previews', () => {
  it('only offers expansion above the long-message threshold', async () => {
    const view = render([node('short', 's'.repeat(160)), node('long', 'l'.repeat(161))]);
    await tick();

    const rows = [...view.target.querySelectorAll<HTMLElement>('.message-row')];
    expect(rows).toHaveLength(2);
    expect(rows[0].querySelector('button.preview-toggle')).toBeNull();
    expect(rows[1].querySelector<HTMLButtonElement>('button.preview-toggle')).not.toBeNull();
  });

  it('expands and collapses one row without changing other rows', async () => {
    const longText = 'long message '.repeat(20);
    const view = render([node('first', longText), node('second', longText)]);
    await tick();

    const rows = [...view.target.querySelectorAll<HTMLElement>('.message-row')];
    const firstPreview = rows[0].querySelector<HTMLElement>('.preview')!;
    const secondPreview = rows[1].querySelector<HTMLElement>('.preview')!;
    const toggle = rows[0].querySelector<HTMLButtonElement>('button.preview-toggle')!;

    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    expect(branchTreeStore.state.selectedId).toBeNull();
    expect(firstPreview.classList.contains('preview-expanded')).toBe(false);
    expect(secondPreview.classList.contains('preview-expanded')).toBe(false);

    toggle.click();
    await tick();
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    expect(toggle.getAttribute('aria-label')).toBe('Collapse message preview');
    expect(branchTreeStore.state.selectedId).toBeNull();
    expect(firstPreview.classList.contains('preview-expanded')).toBe(true);
    expect(secondPreview.classList.contains('preview-expanded')).toBe(false);

    toggle.click();
    await tick();
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    expect(toggle.getAttribute('aria-label')).toBe('Expand message preview');
    expect(firstPreview.classList.contains('preview-expanded')).toBe(false);
  });
});
