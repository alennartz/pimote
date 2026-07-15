import type { ExtensionAPI, ExtensionContext, ExtensionFactory } from '@earendil-works/pi-coding-agent';
import { Type } from 'typebox';
import type { DownloadManager, DownloadUpdateEvent } from './manager.js';
import { executeCancelFileSendTool, executeSendFileTool, type CancelFileSendToolInput, type FileDownloadToolContext, type SendFileToolInput } from './tools.js';
import { FILE_DOWNLOAD_TOOL_DESCRIPTION } from './prompt.js';

export interface CreateFileDownloadExtensionOptions {
  manager: DownloadManager;
}

/** Build the pi extension adapter for session-scoped file downloads. */
export function createFileDownloadExtension(options: CreateFileDownloadExtensionOptions): ExtensionFactory {
  const { manager } = options;

  function toolContext(ctx: ExtensionContext): FileDownloadToolContext {
    return {
      manager,
      // Resolve both values at execution time. Session replacement can happen
      // after the extension factory was created, and the pi context is the
      // authoritative owner/cwd for each lifecycle or tool invocation.
      sessionId: ctx.sessionManager.getSessionId(),
      workspaceRoot: ctx.cwd,
    };
  }

  function publishUpdate(pi: ExtensionAPI, update: DownloadUpdateEvent): void {
    pi.events.emit('pimote:downloads', update);
  }

  return (pi: ExtensionAPI) => {
    pi.registerTool({
      name: 'pimote_send_file',
      label: 'Offer file download',
      description: FILE_DOWNLOAD_TOOL_DESCRIPTION,
      parameters: Type.Object({
        path: Type.String({ description: 'Path to the file, relative to the current project directory or an absolute contained path.' }),
      }),
      execute: async (_callId: string, input: SendFileToolInput, _signal: AbortSignal | undefined, _onUpdate: unknown, ctx: ExtensionContext) => {
        const out = await executeSendFileTool(input, toolContext(ctx));
        return { content: [{ type: 'text', text: JSON.stringify(out) }], details: out };
      },
    } as unknown as Parameters<ExtensionAPI['registerTool']>[0]);

    pi.registerTool({
      name: 'pimote_cancel_file_send',
      label: 'Cancel offered file download',
      description: 'Cancel a pending file download offer by its registration id before the user downloads it.',
      parameters: Type.Object({
        id: Type.String({ description: 'Opaque id returned by pimote_send_file.' }),
      }),
      execute: async (_callId: string, input: CancelFileSendToolInput, _signal: AbortSignal | undefined, _onUpdate: unknown, ctx: ExtensionContext) => {
        const out = await executeCancelFileSendTool(input, toolContext(ctx));
        return { content: [{ type: 'text', text: JSON.stringify(out) }], details: out };
      },
    } as unknown as Parameters<ExtensionAPI['registerTool']>[0]);

    pi.on('session_start', async (_event: unknown, ctx: ExtensionContext) => {
      const sessionId = ctx.sessionManager.getSessionId();
      await manager.activate(sessionId, (update) => publishUpdate(pi, update));
    });

    pi.on('session_shutdown', (_event: unknown, ctx: ExtensionContext) => {
      manager.deactivate(ctx.sessionManager.getSessionId());
    });
  };
}

export type {
  DownloadClaim,
  DownloadItem,
  DownloadManager,
  DownloadOfferedUpdateEvent,
  DownloadSnapshotUpdateEvent,
  DownloadStoreDocument,
  DownloadStoreEntry,
  DownloadUpdateCause,
  DownloadUpdateEvent,
  OfferDownloadInput,
} from './manager.js';
export { createDownloadManager } from './manager.js';
export type { CancelFileSendToolInput, CancelFileSendToolOutput, SendFileToolInput, SendFileToolOutput } from './tools.js';
export { serveFileDownloadRoute } from './http-handler.js';
