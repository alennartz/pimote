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
export function formatDownloadSize(sizeBytes: number): string {
  // Registration sizes come from a file stat, but keep this formatter total for
  // presentation seams and tests that pass boundary values. A negative,
  // non-finite value has no useful file-size representation, so render it as
  // zero rather than leaking `NaN`/`Infinity` into UI copy.
  const bytes = Number.isFinite(sizeBytes) && sizeBytes >= 0 ? sizeBytes : 0;
  const units = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'] as const;
  if (bytes < 1024) return `${Math.round(bytes)} B`;

  const unitIndex = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  const value = bytes / 1024 ** unitIndex;
  // Keep small values informative while avoiding noisy long decimals for
  // larger files. Number(...) removes insignificant trailing zeroes
  // deterministically (e.g. `1.0` becomes `1`).
  const precision = value >= 100 ? 0 : value >= 10 ? 1 : 2;
  const formatted = Number(value.toFixed(precision));
  return `${formatted} ${units[unitIndex]}`;
}

/** Create a toast only for a newly offered item; replay/removal causes are silent. */
export function buildDownloadToast(event: DownloadUpdateEvent): DownloadToastModel | undefined {
  if (event.cause !== 'offered') return undefined;

  const item = event.downloads.find((download) => download.id === event.offeredDownloadId);
  if (!item) return undefined;

  return {
    item,
    filename: item.filename,
    sizeLabel: formatDownloadSize(item.sizeBytes),
    href: item.href,
  };
}

/** Limit the fallback inbox to the currently viewed session's pending items. */
export function buildDownloadInbox(args: { viewedSessionId: string | null; sessionId: string; downloads: DownloadItem[] }): DownloadInboxModel {
  const visible = args.viewedSessionId === args.sessionId && args.downloads.length > 0;
  return {
    visible,
    items: visible ? args.downloads : [],
  };
}
