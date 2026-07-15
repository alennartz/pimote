import type { DownloadItem, DownloadUpdateEvent } from '@pimote/shared';

/** Presentation model for the one-click in-app offer toast. */
export interface DownloadToastModel {
  item: DownloadItem;
  filename: string;
  sizeLabel: string;
  href: string;
}

/** Presentation model for the viewed-session fallback inbox. */
export interface DownloadInboxModel {
  visible: boolean;
  items: DownloadItem[];
}

/** Format the registration-time informational size for client copy. */
export function formatDownloadSize(_sizeBytes: number): string {
  throw new Error('not implemented');
}

/** Create a toast only for a newly offered item; replay/removal causes are silent. */
export function buildDownloadToast(_event: DownloadUpdateEvent): DownloadToastModel | undefined {
  throw new Error('not implemented');
}

/** Limit the fallback inbox to the currently viewed session's pending items. */
export function buildDownloadInbox(_args: { viewedSessionId: string | null; sessionId: string; downloads: DownloadItem[] }): DownloadInboxModel {
  throw new Error('not implemented');
}
