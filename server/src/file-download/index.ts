import type { ExtensionAPI, ExtensionContext, ExtensionFactory } from '@earendil-works/pi-coding-agent';
import { Type } from 'typebox';
import type { DownloadManager, DownloadUpdateEvent } from './manager.js';
import { executeCancelFileSendTool, executeSendFileTool, CancelFileSendToolOutputSchema, SendFileToolOutputSchema, type FileDownloadToolContext } from './tools.js';
import { jsonToolResult } from '../tool-result.js';
import {
  FILE_DOWNLOAD_TOOL_DESCRIPTION,
  FILE_DOWNLOAD_TOOL_GUIDELINES,
  FILE_DOWNLOAD_TOOL_SNIPPET,
  CANCEL_FILE_SEND_TOOL_DESCRIPTION,
  CANCEL_FILE_SEND_TOOL_SNIPPET,
} from './prompt.js';

export interface CreateFileDownloadExtensionOptions {
  manager: DownloadManager;
  retainOnShutdown?: boolean;
  /** Snapshot a file before offering it from an ephemeral workspace. */
  preparePath?: (path: string, workspaceRoot: string) => Promise<string>;
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
      promptSnippet: FILE_DOWNLOAD_TOOL_SNIPPET,
      promptGuidelines: FILE_DOWNLOAD_TOOL_GUIDELINES,
      exposure: 'direct',
      parameters: Type.Object({
        path: Type.String({ description: 'Regular-file path, absolute or relative to the current working directory.' }),
      }),
      outputSchema: SendFileToolOutputSchema,
      execute: async (_callId, input, _signal, _onUpdate, ctx) => {
        const path = options.preparePath ? await options.preparePath(input.path, ctx.cwd) : input.path;
        return jsonToolResult(await executeSendFileTool({ path }, toolContext(ctx)));
      },
    });

    pi.registerTool({
      name: 'pimote_cancel_file_send',
      label: 'Cancel offered file download',
      description: CANCEL_FILE_SEND_TOOL_DESCRIPTION,
      promptSnippet: CANCEL_FILE_SEND_TOOL_SNIPPET,
      promptGuidelines: [],
      exposure: 'direct',
      parameters: Type.Object({
        id: Type.String({ description: 'Opaque offer id returned by pimote_send_file.' }),
      }),
      annotations: { idempotentHint: true },
      outputSchema: CancelFileSendToolOutputSchema,
      execute: async (_callId, input, _signal, _onUpdate, ctx) => {
        return jsonToolResult(await executeCancelFileSendTool(input, toolContext(ctx)));
      },
    });

    pi.on('session_start', async (_event: unknown, ctx: ExtensionContext) => {
      const sessionId = ctx.sessionManager.getSessionId();
      await manager.activate(sessionId, (update) => publishUpdate(pi, update));
    });

    pi.on('session_shutdown', (_event: unknown, ctx: ExtensionContext) => {
      const sessionId = ctx.sessionManager.getSessionId();
      if (options.retainOnShutdown) manager.detach(sessionId);
      else manager.deactivate(sessionId);
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
