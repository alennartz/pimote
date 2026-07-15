import type { DownloadItem, DownloadManager } from './manager.js';

export interface SendFileToolInput {
  path: string;
}

export type SendFileToolOutput = DownloadItem;

export interface CancelFileSendToolInput {
  id: string;
}

export interface CancelFileSendToolOutput {
  cancelled: boolean;
}

export interface FileDownloadToolContext {
  manager: DownloadManager;
  sessionId: string;
  workspaceRoot: string;
}

/** Adapter boundary for the `pimote_send_file` tool. */
export function executeSendFileTool(_input: SendFileToolInput, _context: FileDownloadToolContext): Promise<SendFileToolOutput> {
  throw new Error('not implemented');
}

/** Adapter boundary for the `pimote_cancel_file_send` tool. */
export function executeCancelFileSendTool(_input: CancelFileSendToolInput, _context: FileDownloadToolContext): Promise<CancelFileSendToolOutput> {
  throw new Error('not implemented');
}
