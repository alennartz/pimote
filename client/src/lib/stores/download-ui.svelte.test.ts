import { describe, expect, it } from 'vitest';
import type { DownloadItem, DownloadUpdateEvent } from '@pimote/shared';
import { coordinateDownloadUpdate } from '../download-coordinator.js';
import { DownloadUiStore } from './download-ui.svelte.js';

const itemA: DownloadItem = { id: 'offer-a', filename: 'report-a.pdf', sizeBytes: 42, href: '/d/offer-a' };
const itemB: DownloadItem = { id: 'offer-b', filename: 'report-b.pdf', sizeBytes: 43, href: '/d/offer-b' };

function offered(sessionId: string, item: DownloadItem): DownloadUpdateEvent {
  return { type: 'download_update', sessionId, cause: 'offered', offeredDownloadId: item.id, downloads: [item] };
}

function snapshot(sessionId: string, downloads: DownloadItem[]): DownloadUpdateEvent {
  return { type: 'download_update', sessionId, cause: 'consumed', downloads };
}

describe('DownloadUiStore toast scoping', () => {
  it("surfaces the viewed session's offer even when another session's heads the queue", () => {
    const store = new DownloadUiStore();
    coordinateDownloadUpdate(offered('session-b', itemB), store);
    coordinateDownloadUpdate(offered('session-a', itemA), store);

    expect(store.currentToastFor('session-a')?.item.id).toBe('offer-a');
    expect(store.currentToastFor('session-b')?.item.id).toBe('offer-b');
    expect(store.currentToastFor('session-c')).toBeNull();
    expect(store.currentToastFor(null)).toBeNull();
  });

  it('dismisses by offer id wherever the offer sits in the queue', () => {
    const store = new DownloadUiStore();
    coordinateDownloadUpdate(offered('session-b', itemB), store);
    coordinateDownloadUpdate(offered('session-a', itemA), store);

    store.dismissDownloadToast('offer-a');

    expect(store.currentToastFor('session-a')).toBeNull();
    expect(store.currentToastFor('session-b')?.item.id).toBe('offer-b');
  });

  it("keeps other sessions' offers when one session's snapshot consumes them", () => {
    const store = new DownloadUiStore();
    coordinateDownloadUpdate(offered('session-b', itemB), store);
    coordinateDownloadUpdate(offered('session-a', itemA), store);

    store.reconcileDownloadUpdate(snapshot('session-b', []));

    expect(store.currentToastFor('session-b')).toBeNull();
    expect(store.currentToastFor('session-a')?.item.id).toBe('offer-a');
  });
});
