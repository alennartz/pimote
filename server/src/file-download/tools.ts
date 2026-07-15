import type { DownloadItem, DownloadManager } from './manager.js';

export interface SendFileToolInput {
  path: string;
}

/** Agent-facing metadata; the one-shot href is reserved for the client event. */
export type SendFileToolOutput = Pick<DownloadItem, 'id' | 'filename' | 'sizeBytes'>;

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
export async function executeSendFileTool(input: SendFileToolInput, context: FileDownloadToolContext): Promise<SendFileToolOutput> {
  const offered = await context.manager.offer({
    sessionId: context.sessionId,
    workspaceRoot: context.workspaceRoot,
    path: input.path,
  });

  // The href is deliberately withheld from the agent. It is a one-shot
  // capability intended for the client-side user-approval flow, while the
  // agent only needs the server-derived presentation metadata.
  const { id, filename, sizeBytes } = offered;
  return { id, filename, sizeBytes };
}

/** Adapter boundary for the `pimote_cancel_file_send` tool. */
export async function executeCancelFileSendTool(input: CancelFileSendToolInput, context: FileDownloadToolContext): Promise<CancelFileSendToolOutput> {
  return context.manager.cancel(context.sessionId, input.id);
}
