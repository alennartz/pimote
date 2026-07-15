import type { DownloadUpdateEvent } from '@pimote/shared';
import { buildDownloadToast, type DownloadToastModel } from './download-presentation.js';

/** Port implemented by the in-app toast surface. */
export interface DownloadToastSink {
  showDownloadToast(toast: DownloadToastModel): void;
  /** Reconcile queued offers against each authoritative full snapshot. */
  reconcileDownloadUpdate?(event: DownloadUpdateEvent): void;
}

/**
 * Turn a post-reducer download update into one visible in-app offer prompt.
 * Silent snapshots intentionally do not reach the toast surface.
 */
export function coordinateDownloadUpdate(event: DownloadUpdateEvent, sink: DownloadToastSink): void {
  // Reconcile first so consumed/revoked/resync snapshots remove stale actions
  // before a newly offered item from the same replacement is queued.
  sink.reconcileDownloadUpdate?.(event);
  const toast = buildDownloadToast(event);
  if (toast) sink.showDownloadToast(toast);
}

export { buildDownloadToast };
