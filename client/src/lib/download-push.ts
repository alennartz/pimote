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
export function planDownloadPushDelivery(args: { payload: DownloadPushPayload; appInFocus: boolean }): DownloadPushDelivery {
  if (args.appInFocus) {
    return { kind: 'none' };
  }

  const { payload } = args;
  const title = payload.sessionName || payload.projectName || 'Pimote';

  return {
    kind: 'system',
    title,
    body: `File ready to download: ${payload.download.filename}`,
    tag: `pimote-${payload.sessionId}`,
    data: {
      sessionId: payload.sessionId,
      folderPath: payload.folderPath,
      openDownloads: true,
    },
  };
}
