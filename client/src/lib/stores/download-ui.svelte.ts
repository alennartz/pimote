import type { DownloadToastSink } from '../download-coordinator.js';
import type { DownloadToastModel } from '../download-presentation.js';

/**
 * Ephemeral UI state for offered downloads.
 *
 * Download snapshots remain owned by SessionRegistry. This holder only queues
 * actionable toast models and carries a one-session request to open the
 * viewed session's fallback inbox.
 */
export class DownloadUiStore implements DownloadToastSink {
  toastQueue: DownloadToastModel[] = $state([]);
  inboxOpenSessionId: string | null = $state(null);

  get currentToast(): DownloadToastModel | null {
    return this.toastQueue[0] ?? null;
  }

  showDownloadToast(toast: DownloadToastModel): void {
    this.toastQueue = [...this.toastQueue, toast];
  }

  dismissDownloadToast(toastId?: string): void {
    const currentToast = this.currentToast;
    if (!currentToast || (toastId && currentToast.item.id !== toastId)) return;
    this.toastQueue = this.toastQueue.slice(1);
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
