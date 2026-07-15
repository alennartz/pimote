import { describe, it, expect, vi } from 'vitest';
import { executeCancelFileSendTool, executeSendFileTool, type FileDownloadToolContext } from './tools.js';
import type { DownloadManager } from './manager.js';

const offered = { id: 'opaque-1', filename: 'report.pdf', sizeBytes: 42, href: '/d/opaque-1' };

function makeManager(): DownloadManager & {
  offer: ReturnType<typeof vi.fn>;
  cancel: ReturnType<typeof vi.fn>;
} {
  return {
    activate: vi.fn(),
    deactivate: vi.fn(),
    offer: vi.fn(async () => offered),
    cancel: vi.fn(async () => ({ cancelled: true })),
    claim: vi.fn(),
    snapshot: vi.fn(() => []),
  };
}

describe('file-download agent tool adapters', () => {
  it('pimote_send_file accepts only a path and returns server-derived metadata', async () => {
    const manager = makeManager();
    const context: FileDownloadToolContext = { manager, sessionId: 'session-1', workspaceRoot: '/workspace/project' };
    await expect(executeSendFileTool({ path: 'reports/report.pdf' }, context)).resolves.toEqual(offered);
    expect(manager.offer).toHaveBeenCalledWith({
      sessionId: 'session-1',
      workspaceRoot: '/workspace/project',
      path: 'reports/report.pdf',
    });
  });

  it('pimote_send_file does not wait for a browser click before returning', async () => {
    const manager = makeManager();
    const context: FileDownloadToolContext = { manager, sessionId: 'session-1', workspaceRoot: '/workspace/project' };
    const result = await executeSendFileTool({ path: 'report.pdf' }, context);
    expect(result.id).toBe('opaque-1');
    expect(manager.offer).toHaveBeenCalledTimes(1);
  });

  it('pimote_cancel_file_send delegates the id with the owning session context', async () => {
    const manager = makeManager();
    const context: FileDownloadToolContext = { manager, sessionId: 'session-1', workspaceRoot: '/workspace/project' };
    await expect(executeCancelFileSendTool({ id: 'opaque-1' }, context)).resolves.toEqual({ cancelled: true });
    expect(manager.cancel).toHaveBeenCalledWith('session-1', 'opaque-1');
  });

  it('pimote_cancel_file_send reports false when the registration is unknown or not owned', async () => {
    const manager = makeManager();
    manager.cancel.mockResolvedValue({ cancelled: false });
    const context: FileDownloadToolContext = { manager, sessionId: 'session-2', workspaceRoot: '/workspace/project' };
    await expect(executeCancelFileSendTool({ id: 'missing' }, context)).resolves.toEqual({ cancelled: false });
  });
});
