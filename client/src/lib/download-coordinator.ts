import type { DownloadUpdateEvent } from '@pimote/shared';
import { buildDownloadToast, type DownloadToastModel } from './download-presentation.js';

/** Port implemented by the in-app toast surface. */
export interface DownloadToastSink {
  showDownloadToast(toast: DownloadToastModel): void;
}

/**
 * Turn a post-reducer download update into one visible in-app offer prompt.
 * Silent snapshots intentionally do not reach the toast surface.
 */
export function coordinateDownloadUpdate(_event: DownloadUpdateEvent, _sink: DownloadToastSink): void {
  throw new Error('not implemented');
}

export { buildDownloadToast };
