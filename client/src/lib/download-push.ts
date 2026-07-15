import type { DownloadNotificationIntent } from './download-notification-intent.js';

/** The download-only subset of the VAPID JSON payload consumed by the service worker. */
export interface DownloadPushPayload {
  reason: 'download';
  sessionId: string;
  folderPath: string;
  sessionName?: string;
  projectName?: string;
  download: {
    downloadId: string;
    filename: string;
    sizeBytes: number;
  };
}

export type DownloadPushDelivery =
  | { kind: 'none' }
  | {
      kind: 'system';
      title: string;
      body: string;
      tag: string;
      data: DownloadNotificationIntent;
    };

/**
 * Focused clients already receive the live download_update toast. Background
 * clients receive an OS notification that opens an inbox, never a href.
 */
export function planDownloadPushDelivery(_args: { payload: DownloadPushPayload; appInFocus: boolean }): DownloadPushDelivery {
  throw new Error('not implemented');
}
