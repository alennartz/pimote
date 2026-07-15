import { describe, expect, it, vi } from 'vitest';
import { coordinateDownloadUpdate } from './download-coordinator.js';

const older = { id: 'opaque-old', filename: 'older.txt', sizeBytes: 1, href: '/d/opaque-old' };
const offered = { id: 'opaque-new', filename: 'report.pdf', sizeBytes: 42, href: '/d/opaque-new' };

describe('coordinateDownloadUpdate', () => {
  it('turns the exact offered member of a full snapshot into one actionable in-app toast', () => {
    const showDownloadToast = vi.fn();

    coordinateDownloadUpdate(
      {
        type: 'download_update',
        sessionId: 'session-1',
        cause: 'offered',
        offeredDownloadId: 'opaque-new',
        downloads: [older, offered],
      },
      { showDownloadToast },
    );

    expect(showDownloadToast).toHaveBeenCalledTimes(1);
    expect(showDownloadToast).toHaveBeenCalledWith({
      item: offered,
      filename: 'report.pdf',
      sizeLabel: expect.any(String),
      href: '/d/opaque-new',
    });
  });

  it.each(['restored', 'consumed', 'revoked'] as const)('keeps a %s replacement snapshot silent', (cause) => {
    const showDownloadToast = vi.fn();

    coordinateDownloadUpdate({ type: 'download_update', sessionId: 'session-1', cause, downloads: [offered] }, { showDownloadToast });

    expect(showDownloadToast).not.toHaveBeenCalled();
  });
});
