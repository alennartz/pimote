// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { flushSync, mount, unmount } from 'svelte';
import type { DownloadItem } from '@pimote/shared';
import { coordinateDownloadUpdate } from '$lib/download-coordinator.js';
import { downloadUi } from '$lib/stores/download-ui.svelte.js';

// The toast derives its offer from the viewed session; drive the registry
// seam through a mutable holder so each test sets it before mounting.
const { viewedSession } = vi.hoisted(() => ({ viewedSession: { value: null as { sessionId: string } | null } }));

vi.mock('$lib/stores/session-registry.svelte.js', () => ({
  sessionRegistry: {
    get viewed() {
      return viewedSession.value;
    },
  },
}));

const { default: DownloadToast } = await import('./DownloadToast.svelte');

let destroy: (() => void) | null = null;

function render() {
  const target = document.createElement('div');
  document.body.appendChild(target);
  const component = mount(DownloadToast, { target });
  destroy = () => unmount(component);
}

function offer(sessionId: string, item: DownloadItem): void {
  coordinateDownloadUpdate({ type: 'download_update', sessionId, cause: 'offered', offeredDownloadId: item.id, downloads: [item] }, downloadUi);
}

afterEach(() => {
  destroy?.();
  destroy = null;
  downloadUi.toastQueue = [];
  viewedSession.value = null;
});

describe('download offer toasts are scoped to their session', () => {
  it("renders only the viewed session's offer", () => {
    offer('background-session', { id: 'bg-1', filename: 'background-report.pdf', sizeBytes: 1, href: '/d/bg-1' });
    offer('viewed-session', { id: 'fg-1', filename: 'viewed-report.pdf', sizeBytes: 2, href: '/d/fg-1' });
    viewedSession.value = { sessionId: 'viewed-session' };
    render();
    flushSync();

    const text = document.body.textContent ?? '';
    expect(text).toContain('viewed-report.pdf');
    expect(text).not.toContain('background-report.pdf');
  });

  it('renders nothing when no session is viewed', () => {
    offer('background-session', { id: 'bg-2', filename: 'orphan-report.pdf', sizeBytes: 1, href: '/d/bg-2' });
    viewedSession.value = null;
    render();
    flushSync();

    expect(document.body.textContent ?? '').not.toContain('File ready to download');
  });
});
