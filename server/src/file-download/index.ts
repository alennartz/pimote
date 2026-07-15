import type { ExtensionFactory } from '@earendil-works/pi-coding-agent';
import type { DownloadManager } from './manager.js';

export interface CreateFileDownloadExtensionOptions {
  manager: DownloadManager;
}

/** Build the pi extension adapter for session-scoped file downloads. */
export function createFileDownloadExtension(_options: CreateFileDownloadExtensionOptions): ExtensionFactory {
  throw new Error('not implemented');
}

export type {
  DownloadClaim,
  DownloadItem,
  DownloadManager,
  DownloadStoreDocument,
  DownloadStoreEntry,
  DownloadUpdateCause,
  DownloadUpdateEvent,
  OfferDownloadInput,
} from './manager.js';
export { createDownloadManager } from './manager.js';
export type { CancelFileSendToolInput, CancelFileSendToolOutput, SendFileToolInput, SendFileToolOutput } from './tools.js';
export { serveFileDownloadRoute } from './http-handler.js';
