import type { DownloadUpdateEvent } from '@pimote/shared';
import type { DownloadToastSink } from '../download-coordinator.js';
import type { DownloadToastModel } from '../download-presentation.js';

/**
 * Ephemeral UI state for offered downloads.
 *
 * Download snapshots remain owned by SessionRegistry. This holder only queues
 * actionable toast models (surfaced only while their owning session is viewed)
 * and carries a one-session request to open the viewed session's fallback inbox.
 */
export class DownloadUiStore implements DownloadToastSink {
  toastQueue: DownloadToastModel[] = $state([]);
  inboxOpenSessionId: string | null = $state(null);
  // Toast models intentionally stay presentation-focused (and keep their
  // existing test/UI shape), so retain ownership in a private index for
  // session-removal pruning.
  // eslint-disable-next-line svelte/prefer-svelte-reactivity -- internal ownership index, not template state
  private readonly toastSessionIds = new Map<string, string>();

  /** First queued offer owned by the viewed session. Offers from background
   *  sessions stay queued but hidden until their session is viewed. */
  currentToastFor(viewedSessionId: string | null): DownloadToastModel | null {
    if (!viewedSessionId) return null;
    return this.toastQueue.find((toast) => this.toastSessionIds.get(toast.item.id) === viewedSessionId) ?? null;
  }

  showDownloadToast(toast: DownloadToastModel): void {
    this.toastQueue = [...this.toastQueue, toast];
  }

  reconcileDownloadUpdate(event: DownloadUpdateEvent): void {
    // eslint-disable-next-line svelte/prefer-svelte-reactivity -- ephemeral comparison set, not UI state
    const liveIds = new Set(event.downloads.map((item) => item.id));
    for (const item of event.downloads) {
      this.toastSessionIds.set(item.id, event.sessionId);
    }

    // Every protocol update is a full replacement snapshot. Remove only
    // queued offers belonging to this session that are no longer actionable;
    // offers from other sessions remain visible.
    this.toastQueue = this.toastQueue.filter((toast) => {
      const owner = this.toastSessionIds.get(toast.item.id);
      return owner !== event.sessionId || liveIds.has(toast.item.id);
    });

    for (const [id, owner] of this.toastSessionIds) {
      if (owner === event.sessionId && !liveIds.has(id)) this.toastSessionIds.delete(id);
    }
  }

  /** Remove actionable offers when their owning session leaves the registry. */
  clearSession(sessionId: string): void {
    this.toastQueue = this.toastQueue.filter((toast) => this.toastSessionIds.get(toast.item.id) !== sessionId);
    for (const [id, owner] of this.toastSessionIds) {
      if (owner === sessionId) this.toastSessionIds.delete(id);
    }
    if (this.inboxOpenSessionId === sessionId) this.inboxOpenSessionId = null;
  }

  /** Dismiss the offer identified by id, wherever it sits in the queue. */
  dismissDownloadToast(toastId: string): void {
    this.toastQueue = this.toastQueue.filter((toast) => toast.item.id !== toastId);
  }

  openDownloadInbox(sessionId: string): void {
    this.inboxOpenSessionId = sessionId;
  }

  /**
   * Claim a notification-driven open request only when its owner is viewed.
   * A compact desktop and mobile presenter can both exist, so the active
   * viewport claims the request before it opens its own dropdown.
   */
  takeDownloadInboxOpenRequest(sessionId: string): boolean {
    if (this.inboxOpenSessionId !== sessionId) return false;
    this.inboxOpenSessionId = null;
    return true;
  }
}

export const downloadUi = new DownloadUiStore();
